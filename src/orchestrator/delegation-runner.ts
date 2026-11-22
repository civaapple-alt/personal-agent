import type { PromptRunResult } from "../rpc/pi-rpc-worker.ts";
import type { VerificationOutcome } from "../rpc/team-verification.ts";
import type { PersonalAgentStore } from "../storage/repositories.ts";
import type { WorkspaceLink } from "../storage/types.ts";
import { prepareVerification, readVerificationOutcome, verificationPrompt } from "./independent-verification.ts";
import {
	type DelegateInput,
	type DelegateResult,
	type DelegationContext,
	type DispatchProgressEvent,
	type ExecutionEffects,
	emptyEffects,
	type MatterRun,
	mapChildStageLabel,
	mergeEffects,
	pushRunLog,
	summarizeActiveDelegations,
	truncateInline,
} from "./types.ts";
import type { ExecuteWorkerInput } from "./worker-runner.ts";

export interface DelegationRunnerDeps {
	store: PersonalAgentStore;
	executeWithWorker: (input: ExecuteWorkerInput) => Promise<PromptRunResult>;
}

/** Coordinate an internal member-to-member delegation turn with deduplication and progress updates. */
export async function delegateBetweenMembers(
	deps: DelegationRunnerDeps,
	input: DelegateInput,
	run: MatterRun,
	workspace: WorkspaceLink | null,
	chain: string[],
	signal: AbortSignal,
	effectsTarget: ExecutionEffects,
	onProgress?: (progress: DispatchProgressEvent) => void,
	options?: DelegationContext,
): Promise<DelegateResult> {
	signal.throwIfAborted();
	const fromMember = deps.store.getMember(input.fromMemberId);
	const rawToMember = deps.store.getMember(input.toMemberId);
	if (!fromMember || !rawToMember) throw new Error("Delegation requires existing team members");
	const matterRecord = deps.store.getMatter(input.matterId);
	let toMember = rawToMember;
	if (rawToMember.roleScope === "personal") {
		if (!run.startedByUserId || run.startedByUserId !== rawToMember.ownerUserId) {
			throw new Error("The requested personal role is unavailable to the current user");
		}
	} else if (matterRecord?.orgId) {
		const orgMembers = deps.store.resolveEffectiveOrgMembers(matterRecord.orgId);
		const matchedOrgMember = orgMembers.find((m) => m.id === rawToMember.id);
		if (!matchedOrgMember) {
			throw new Error(`Team member ${rawToMember.displayName} is not enabled in this organization`);
		}
		toMember = matchedOrgMember;
	}
	if (matterRecord && matterRecord.aiMemberIds !== null && !matterRecord.aiMemberIds.includes(toMember.id)) {
		throw new Error(`Team member ${toMember.displayName} has been removed from this matter`);
	}
	if (
		matterRecord &&
		matterRecord.consultMemberIds != null &&
		toMember.id !== matterRecord.leadMemberId &&
		!matterRecord.consultMemberIds.includes(toMember.id)
	) {
		throw new Error(`Team member ${toMember.displayName} is unavailable for on-demand consultation in this matter`);
	}
	if (chain.includes(toMember.id)) throw new Error("Delegation cycle: cannot call yourself or an ancestor");
	if (chain.length >= 3) throw new Error("Delegation depth limit reached (3 members)");
	const verification = options?.verification;
	const subject = verification
		? await prepareVerification(
				deps.store,
				run,
				{
					matterId: input.matterId,
					verifierId: toMember.id,
					cwd: workspace?.repoPath,
					verification,
					deliveries: effectsTarget.deliveries,
					savedDocuments: effectsTarget.savedDocuments,
				},
				signal,
			)
		: undefined;
	const key = JSON.stringify([
		fromMember.id,
		toMember.id,
		input.question.trim(),
		verification,
		subject?.target.digest,
	]);
	const cached = run.delegations.get(key);
	if (cached) return await cached;
	if (run.delegationCount >= 8) throw new Error("Delegation limit reached (8 per user turn)");
	run.delegationCount += 1;
	const delegationNumber = run.delegationCount;
	const review = subject
		? {
				target: subject.target,
				sourceAssignmentId: subject.relatedRequest?.id,
				criteria: verification?.criteria,
			}
		: undefined;
	const draftReview =
		subject?.target.kind === "draft"
			? { digest: subject.target.digest, verdict: "inconclusive" as const }
			: undefined;
	if (draftReview && subject) run.draftVerifications.set(subject.target.reference, draftReview);
	const scope = {
		sourceUserMessageId: run.userMessageId || null,
		workspaceId: workspace?.id ?? null,
	};
	const operation = (async () => {
		const requestMessage = deps.store.appendMessage({
			matterId: input.matterId,
			channel: "internal_collab",
			senderType: "member",
			senderId: fromMember.id,
			content: `@${toMember.displayName}: ${input.question}`,
			metadata: {
				...scope,
				toMemberId: toMember.id,
				delegationNumber,
				...(review ? { verification: review } : {}),
				...(options?.parentRequestMessageId ? { parentRequestMessageId: options.parentRequestMessageId } : {}),
			},
		});
		const delegationKey = requestMessage.id;
		const edge = {
			kind: "delegation" as const,
			requestMessageId: delegationKey,
			parentRequestMessageId: options?.parentRequestMessageId,
			delegationNumber,
			...(review ? { verification: true as const } : {}),
			fromMemberId: fromMember.id,
			fromMemberName: fromMember.displayName,
			memberId: toMember.id,
			memberName: toMember.displayName,
		};
		pushRunLog(run, fromMember.displayName, `委托${toMember.displayName}：${truncateInline(input.question, 44)}`);
		const initialLabel = review ? "开始独立验收" : "已接入任务";
		run.activeDelegations.set(delegationKey, { ...edge, stageLabel: initialLabel });
		onProgress?.({
			stage: "tool",
			label: summarizeActiveDelegations(run.activeDelegations, toMember.displayName, initialLabel),
			toolName: "delegate_to_member",
			activeDelegations: [...run.activeDelegations.values()],
			recentLogs: [...run.recentLogs],
			collabUpdated: true,
		});
		let childTextBuf = "";
		let lastStreamBroadcastAt = 0;
		try {
			const effects = emptyEffects();
			const assignment = `Internal delegation from ${fromMember.displayName}:\nAssignment #${delegationNumber} for this turn.\n${input.question}`;
			const result = await deps.executeWithWorker({
				effectsTarget: effects,
				matterId: input.matterId,
				member: toMember,
				workspace,
				taskPrompt: subject && verification ? verificationPrompt(subject, verification, assignment) : assignment,
				isInternalDelegation: true,
				...(subject ? { sessionMode: "verifier" as const } : {}),
				delegationRequestId: delegationKey,
				discussionMode: options?.discussionMode,
				run,
				chain: [...chain, toMember.id],
				signal,
				onTextDelta: (delta) => {
					childTextBuf += delta;
					const now = Date.now();
					if (now - lastStreamBroadcastAt < 1200) return;
					const lines = childTextBuf
						.split(/\r?\n/)
						.map((line) => line.replace(/^[#*\-\s>`]+/, "").trim())
						.filter(Boolean);
					const snippet = lines.at(-1);
					if (!snippet) return;
					lastStreamBroadcastAt = now;
					const label = `撰写结论：${truncateInline(snippet, 28)}`;
					run.activeDelegations.set(delegationKey, { ...edge, stageLabel: label });
					onProgress?.({
						stage: "tool",
						label: summarizeActiveDelegations(run.activeDelegations, toMember.displayName, label),
						toolName: "delegate_to_member",
						activeDelegations: [...run.activeDelegations.values()],
						recentLogs: [...run.recentLogs],
					});
				},
				onProgress: (childProgress) => {
					const childIsActive = [...run.activeDelegations.values()].some(
						(entry) => entry.kind === "delegation" && entry.parentRequestMessageId === delegationKey,
					);
					const stageLabel = childIsActive ? "等待下游回报" : mapChildStageLabel(childProgress);
					run.activeDelegations.set(delegationKey, { ...edge, stageLabel });
					onProgress?.({
						stage: childProgress.stage === "waiting_user" ? "waiting_user" : "tool",
						label:
							childProgress.stage === "waiting_user"
								? childProgress.label
								: summarizeActiveDelegations(run.activeDelegations, toMember.displayName, stageLabel),
						toolName: childProgress.toolName ?? "delegate_to_member",
						activeDelegations: [...run.activeDelegations.values()],
						recentLogs: [...run.recentLogs],
						collabUpdated: childProgress.collabUpdated,
					});
				},
			});
			signal.throwIfAborted();
			if (result.aborted) throw new Error("Colleague execution was aborted");
			let outcome: VerificationOutcome | undefined;
			if (subject) {
				outcome = readVerificationOutcome(result, subject.requiresWorkspaceEvidence);
				try {
					await subject.assertCurrent?.();
				} catch {
					outcome = {
						verdict: "inconclusive",
						summary: "验收对象已变更或无法读取，请对最新版本复验。",
						evidence: [],
					};
				}
				signal.throwIfAborted();
				run.delegations.delete(key);
				if (draftReview && run.draftVerifications.get(subject.target.reference) === draftReview) {
					run.draftVerifications.set(subject.target.reference, { ...draftReview, verdict: outcome.verdict });
				}
			}
			const clarification = result.clarification && {
				...result.clarification,
				source: result.clarification.source ?? {
					memberId: toMember.id,
					assignmentNumber: delegationNumber,
					messageId: requestMessage.id,
				},
			};
			const answerText = outcome
				? [outcome.summary, ...outcome.evidence.map((item) => `- ${item}`)].join("\n")
				: result.assistantText.trim() || clarification?.question || "";
			if (!answerText) throw new Error("Colleague returned no answer");
			mergeEffects(effectsTarget, effects);
			const responseMessage = deps.store.appendMessage({
				matterId: input.matterId,
				channel: "internal_collab",
				senderType: "member",
				senderId: toMember.id,
				content: answerText,
				metadata: {
					...scope,
					replyToMemberId: fromMember.id,
					...(clarification ? { clarification } : {}),
					requestMessageId: requestMessage.id,
					...(outcome ? { verification: outcome } : {}),
				},
			});
			if (clarification) {
				run.completedClarifications ??= new Map();
				run.completedClarifications.set(delegationNumber, {
					toDelegatorId: fromMember.id,
					source: clarification.source,
				});
			}
			run.activeDelegations.delete(delegationKey);
			pushRunLog(run, toMember.displayName, clarification ? "已将待澄清问题回传委托者" : "已完成委托并返回结论");
			const remaining = [...run.activeDelegations.values()];
			onProgress?.({
				stage: remaining.length > 0 ? "tool" : "thinking",
				label:
					remaining.length > 0
						? summarizeActiveDelegations(run.activeDelegations)
						: `${toMember.displayName}已返回结果，${fromMember.displayName}正在整合`,
				toolName: remaining.length > 0 ? "delegate_to_member" : undefined,
				activeDelegations: remaining,
				recentLogs: [...run.recentLogs],
				collabUpdated: true,
			});
			return {
				fromMember,
				toMember,
				delegationNumber,
				requestMessage,
				responseMessage,
				answerText,
				clarification,
				verification: outcome,
			};
		} catch (error) {
			run.delegations.delete(key);
			deps.store.appendMessage({
				matterId: input.matterId,
				channel: "internal_collab",
				senderType: "system",
				senderId: toMember.id,
				content: `内部委托未完成：${error instanceof Error ? error.message : String(error)}`,
				metadata: { ...scope, requestMessageId: requestMessage.id, failed: true },
			});
			const errMessage = error instanceof Error ? error.message : String(error);
			const abortedOrCancelled = signal.aborted || run.cancelled;
			if (!abortedOrCancelled) {
				run.activeDelegations.delete(delegationKey);
			}
			pushRunLog(
				run,
				toMember.displayName,
				run.cancelled ? "委托已中止" : `委托未完成：${truncateInline(errMessage, 36)}`,
			);
			const active = [...run.activeDelegations.values()];
			onProgress?.({
				stage: active.length > 0 ? "tool" : "thinking",
				label: abortedOrCancelled
					? (run.lastProgress?.label ??
						summarizeActiveDelegations(
							run.activeDelegations,
							toMember.displayName,
							run.cancelled ? "已中止" : "未完成",
						))
					: active.length > 0
						? summarizeActiveDelegations(run.activeDelegations)
						: `${toMember.displayName}未完成委托，${fromMember.displayName}正在处理`,
				toolName: active.length > 0 ? "delegate_to_member" : undefined,
				activeDelegations: active,
				recentLogs: [...run.recentLogs],
				collabUpdated: true,
			});
			throw error;
		}
	})();
	run.delegations.set(key, operation);
	return await operation;
}
