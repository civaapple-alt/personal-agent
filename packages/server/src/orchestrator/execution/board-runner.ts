import { resolve } from "node:path";
import type { BoardMemberDto, BoardPostKind, BoardPostSummaryDto, MatterEventDto } from "@pa/contracts/board";
import type { PromptRunResult } from "../../rpc/pi-rpc-worker.ts";
import type { BoardMemberRecord, BoardPostRecord, MatterEventRecord } from "../../storage/repos/board-repo.ts";
import type { PersonalAgentStore } from "../../storage/repositories.ts";
import type { CollaboratorRole, Matter, TeamMember, WorkspaceLink } from "../../storage/types.ts";
import {
	buildProgressSnapshot,
	type DispatchMatterInput,
	type DispatchMatterResult,
	type DispatchProgressEvent,
	type MatterRun,
	truncateInline,
} from "../types.ts";
import { buildLeadToBoardHandoffBlock } from "./mode-handoff.ts";
import type { BoardWorkerToolCall, ExecuteWorkerInput } from "./worker-runner.ts";

export interface BoardRunnerDeps {
	store: PersonalAgentStore;
	defaultCwd: string;
	requireMatter: (matterId: string) => Matter;
	executeWithWorker: (input: ExecuteWorkerInput) => Promise<PromptRunResult>;
}

export interface RunBoardCollaborationContext {
	matter: Matter;
	workspace: WorkspaceLink | null;
	coordinatorBaseMember: TeamMember;
	effectiveOrgId: string | null;
	input: DispatchMatterInput;
	run: MatterRun;
	emitDispatchProgress: (progress: DispatchProgressEvent) => void;
	author?: {
		collaboratorId: string;
		name: string;
		roleTitle: string;
		permissionRole: CollaboratorRole;
	};
}

function toBoardPostSummaryDto(post: BoardPostRecord): BoardPostSummaryDto {
	return {
		id: post.id,
		matterId: post.matterId,
		postNo: post.postNo,
		authorType: post.authorType,
		authorId: post.authorId,
		kind: post.kind,
		mentions: post.mentions,
		refPostNos: post.refPostNos,
		summary: post.summary,
		hasBody: Boolean(post.body && post.body.length > 0),
		artifacts: post.artifacts,
		verification: post.verification,
		orgId: post.orgId,
		workspaceId: post.workspaceId,
		createdAt: post.createdAt,
	};
}

function toBoardMemberDto(member: BoardMemberRecord): BoardMemberDto {
	return {
		matterId: member.matterId,
		agentId: member.agentId,
		sourceMemberId: member.sourceMemberId,
		displayName: member.displayName,
		boardRole: member.boardRole,
		brief: member.brief,
		skills: member.skills,
		status: member.status,
		ownedScope: member.ownedScope,
		acceptanceCriteria: member.acceptanceCriteria,
		lastReadPostNo: member.lastReadPostNo,
		activePostNo: member.activePostNo,
		modelOverride: member.modelOverride,
		worktreePath: member.worktreePath,
		metrics: member.metrics,
		updatedAt: member.updatedAt,
	};
}

function toMatterEventDto(event: MatterEventRecord): MatterEventDto {
	return {
		id: event.id,
		matterId: event.matterId,
		runId: event.runId,
		agentId: event.agentId,
		boardPostNo: event.boardPostNo,
		eventType: event.eventType as MatterEventDto["eventType"],
		payload: event.payload,
		createdAt: event.createdAt,
	};
}

function formatBoardRoster(members: BoardMemberRecord[]): string {
	if (members.length === 0) return "No dynamic board agents spawned yet.";
	return members
		.map((m) => {
			const scope = m.ownedScope.length > 0 ? ` scope=[${m.ownedScope.join(", ")}]` : "";
			return `- ${m.agentId} (${m.displayName}, role=${m.boardRole}, status=${m.status}${scope})`;
		})
		.join("\n");
}

function formatUnreadPostSummaries(posts: BoardPostSummaryRecordLike[]): string {
	if (posts.length === 0) return "No unread board posts.";
	return posts
		.map((post) => {
			const mentions = post.mentions.length > 0 ? ` -> ${post.mentions.map((m) => `@${m}`).join(", ")}` : "";
			const refs = post.refPostNos.length > 0 ? ` (refs: ${post.refPostNos.map((n) => `#${n}`).join(", ")})` : "";
			const bodyHint = post.hasBody ? " [has full body: call read_board_post if needed]" : "";
			const verHint = post.verification
				? ` [verification=${post.verification.verdict} target=${post.verification.target}${post.verification.authorAgentId ? ` author=${post.verification.authorAgentId}` : ""}]`
				: "";
			return `- #${post.postNo} [${post.kind}] ${post.authorType}:${post.authorId}${mentions}${refs}: ${post.summary}${verHint}${bodyHint}`;
		})
		.join("\n");
}

type BoardPostSummaryRecordLike = ReturnType<PersonalAgentStore["listBoardPostSummaries"]>[number];

function abortableDelay(ms: number, signal: AbortSignal): Promise<"timeout" | "aborted"> {
	if (signal.aborted) return Promise.resolve("aborted");
	return new Promise((resolvePromise) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolvePromise("timeout");
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			resolvePromise("aborted");
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function normalizeMonitorSilenceMs(explicitMs?: number): number {
	if (typeof explicitMs === "number" && Number.isFinite(explicitMs) && explicitMs > 0) {
		return explicitMs;
	}
	const rawEnv = process.env.PA_BOARD_MONITOR_SILENCE_MS;
	if (rawEnv) {
		const parsed = Number(rawEnv);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
	return 30_000;
}

/**
 * Orchestrates 0.9.0 Board collaboration mode:
 * - Dynamic Coordinator-driven agent spawning (`spawn_board_agent`)
 * - Asynchronous `@mention` wakeup with incremental cursor (`last_read_post_no`) & summary-only injection
 * - Observe-by-default Coordinator filtering (Builder<->Verifier loops do not wake Coordinator)
 * - Read/test-only Verifier boundary & anti-self-verification guard
 * - HITL `clarification @user` pause & `@monitor` stall detection
 */
export async function runBoardCollaborationTurn(
	deps: BoardRunnerDeps,
	ctx: RunBoardCollaborationContext,
): Promise<DispatchMatterResult> {
	const { matter, workspace, coordinatorBaseMember, effectiveOrgId, input, run, emitDispatchProgress } = ctx;
	const repoPath = resolve(workspace?.repoPath ?? deps.defaultCwd);
	const silenceThresholdMs = normalizeMonitorSilenceMs(input.boardMonitorSilenceMs);
	const maxTotalSteps = 48;

	const emitMember = (member: BoardMemberRecord) => {
		input.onBoardMemberUpdated?.({ matterId: matter.id, member: toBoardMemberDto(member) });
	};
	const emitPost = (post: BoardPostRecord) => {
		input.onBoardPostCreated?.({ matterId: matter.id, post: toBoardPostSummaryDto(post) });
	};
	const emitEvent = (event: MatterEventRecord) => {
		input.onMatterEventAppended?.({ matterId: matter.id, event: toMatterEventDto(event) });
	};

	let coordinatorRecord = deps.store.getBoardMember(matter.id, "coordinator");
	if (!coordinatorRecord) {
		coordinatorRecord = deps.store.upsertBoardMember({
			matterId: matter.id,
			agentId: "coordinator",
			sourceMemberId: coordinatorBaseMember.id,
			displayName: coordinatorBaseMember.displayName,
			boardRole: "coordinator",
			brief: "Matter Coordinator: decompose tasks, dynamically spawn builders/verifiers with ownedScope and acceptanceCriteria, observe by default, intervene on exceptions, and deliver final verified summary.",
			status: "waiting",
			lastReadPostNo: 0,
		});
		emitMember(coordinatorRecord);
	}

	const wakeQueue: string[] = [];
	const queuedSet = new Set<string>();
	const pendingRewake = new Set<string>();
	const activeWorkers = new Map<string, Promise<void>>();
	const unresolvedTargets = new Set<string>();
	const nudgeCounts = new Map<string, number>();

	let pausedForHuman = false;
	let clarificationSummary = "";
	let coordinatorSummarized = false;
	let needsCoordinatorSummary = false;
	let lastCoordinatorResult: PromptRunResult | null = null;
	let lastCoordinatorText = "";
	const summaryState: { post: BoardPostRecord | null } = { post: null };
	let lastActivityAt = Date.now();
	let totalSteps = 0;

	const enqueueAgent = (agentId: string) => {
		const normalized = agentId.trim().replace(/^@+/, "");
		if (!normalized) return;
		if (activeWorkers.has(normalized)) {
			pendingRewake.add(normalized);
			return;
		}
		if (queuedSet.has(normalized)) return;
		const member = deps.store.getBoardMember(matter.id, normalized);
		if (!member || member.status === "stopped" || member.status === "retired" || member.status === "blocked_human") {
			return;
		}
		queuedSet.add(normalized);
		wakeQueue.push(normalized);
	};

	const shouldWakeCoordinatorOnPost = (post: BoardPostRecord): boolean => {
		if (post.authorType === "agent" && post.authorId === "coordinator") return false;
		if (post.mentions.includes("coordinator") || post.mentions.includes("all")) return true;
		if (post.kind === "escalate" || post.kind === "summary") return true;
		if (
			post.kind === "clarification" &&
			post.authorType === "agent" &&
			!post.mentions.includes("user") &&
			post.mentions.length === 0
		) {
			return true;
		}
		return false;
	};

	const routePostCreated = (post: BoardPostRecord) => {
		lastActivityAt = Date.now();
		emitPost(post);

		if (post.authorType === "agent") {
			if (
				post.kind === "handoff" ||
				post.kind === "verify_pass" ||
				post.kind === "verify_rework" ||
				post.kind === "escalate" ||
				post.kind === "summary"
			) {
				unresolvedTargets.delete(post.authorId);
			}
			if (post.kind === "verify_pass") {
				needsCoordinatorSummary = true;
			}
			if (post.authorId === "coordinator" && post.kind === "summary") {
				coordinatorSummarized = true;
				needsCoordinatorSummary = false;
				summaryState.post = post;
			}
		}

		if (post.kind === "clarification" && post.mentions.includes("user")) {
			pausedForHuman = true;
			clarificationSummary = post.summary;
			if (post.authorType === "agent") {
				const blocked = deps.store.updateBoardMemberState(matter.id, post.authorId, { status: "blocked_human" });
				if (blocked) emitMember(blocked);
			}
			deps.store.updateMatterStatus(matter.id, "waiting_user");
			input.onMatterStatusUpdated?.({ matterId: matter.id, status: "waiting_user" });
			deps.store.appendMessage({
				matterId: matter.id,
				channel: "user",
				senderType: "member",
				senderId: coordinatorBaseMember.id,
				content: post.body ? `${post.summary}\n\n${post.body}` : post.summary,
				metadata: {
					workspaceId: workspace?.id ?? null,
					repoPath,
					orgId: effectiveOrgId,
					sourceUserMessageId: run.userMessageId,
					boardPostNo: post.postNo,
					humanDecision: {
						version: 1,
						status: "pending",
						revision: 1,
						requests: [
							{
								id: `bclar_${post.postNo}`,
								kind: "clarification",
								question: post.summary,
								context: post.body || undefined,
							},
						],
					},
				},
			});
			emitDispatchProgress({
				stage: "waiting_user",
				label: `等待人工确认：${truncateInline(post.summary, 48)}`,
			});
			return;
		}

		const members = deps.store.listBoardMembers(matter.id);
		const memberMap = new Map(members.map((m) => [m.agentId, m]));

		if (post.kind === "assign" || post.kind === "handoff" || post.kind === "verify_rework") {
			for (const target of post.mentions) {
				const targetMember = memberMap.get(target);
				if (targetMember && targetMember.agentId !== "coordinator") {
					unresolvedTargets.add(targetMember.agentId);
				}
			}
		}

		const targetsToWake = new Set<string>();
		if (post.mentions.includes("all")) {
			for (const member of members) {
				if (member.agentId === post.authorId) continue;
				if (member.agentId === "coordinator") {
					if (shouldWakeCoordinatorOnPost(post)) targetsToWake.add("coordinator");
				} else {
					targetsToWake.add(member.agentId);
				}
			}
		} else {
			for (const mention of post.mentions) {
				if (mention === "user") continue;
				if (mention === post.authorId) continue;
				if (mention === "coordinator") {
					if (shouldWakeCoordinatorOnPost(post)) targetsToWake.add("coordinator");
				} else if (memberMap.has(mention)) {
					targetsToWake.add(mention);
				}
			}
		}
		if (!targetsToWake.has("coordinator") && shouldWakeCoordinatorOnPost(post)) {
			targetsToWake.add("coordinator");
		}
		for (const targetId of targetsToWake) {
			enqueueAgent(targetId);
		}
	};

	const validateAndExecuteToolCall = async (callerAgentId: string, call: BoardWorkerToolCall): Promise<unknown> => {
		lastActivityAt = Date.now();
		if (call.tool === "spawn_board_agent") {
			const caller = deps.store.getBoardMember(matter.id, callerAgentId);
			if (!caller || caller.boardRole !== "coordinator") {
				throw new Error("Only the coordinator can invoke spawn_board_agent");
			}
			if (
				call.agentId === "coordinator" ||
				call.agentId === "user" ||
				call.agentId === "monitor" ||
				call.agentId === "all"
			) {
				throw new Error(`Reserved board agentId: ${call.agentId}`);
			}
			const sourceMember = call.sourceMemberId ? deps.store.getMember(call.sourceMemberId) : null;
			if (call.sourceMemberId && !sourceMember) {
				throw new Error(`Unknown sourceMemberId: ${call.sourceMemberId}`);
			}
			const existing = deps.store.getBoardMember(matter.id, call.agentId);
			const spawned = deps.store.upsertBoardMember({
				matterId: matter.id,
				agentId: call.agentId,
				sourceMemberId: sourceMember?.id ?? existing?.sourceMemberId ?? coordinatorBaseMember.id,
				displayName: call.displayName ?? sourceMember?.displayName ?? call.agentId,
				boardRole: call.boardRole,
				brief: call.brief,
				skills: call.skills ?? existing?.skills ?? [],
				ownedScope: call.ownedScope ?? existing?.ownedScope ?? [],
				acceptanceCriteria: call.acceptanceCriteria ?? existing?.acceptanceCriteria ?? "",
				status: existing?.status === "stopped" || existing?.status === "retired" ? existing.status : "waiting",
				lastReadPostNo: existing?.lastReadPostNo ?? 0,
				activePostNo: existing?.activePostNo ?? null,
				modelOverride: call.modelOverride ?? existing?.modelOverride ?? null,
			});
			emitMember(spawned);
			return { spawned: true, member: toBoardMemberDto(spawned) };
		}

		if (call.tool === "read_board_post") {
			const post = deps.store.getBoardPost(matter.id, call.postNo);
			if (!post) {
				throw new Error(`Board post #${call.postNo} not found`);
			}
			return { post };
		}

		// post_to_board
		const caller = deps.store.getBoardMember(matter.id, callerAgentId);
		if (!caller) {
			throw new Error(`Unknown board agent: ${callerAgentId}`);
		}
		const isVerificationKind: boolean =
			call.kind === "verify_pass" || call.kind === "verify_rework" || Boolean(call.verification);
		if (isVerificationKind) {
			if (caller.boardRole === "builder") {
				throw new Error("Builders cannot post verification verdicts (use handoff to request verification)");
			}
			if (call.verification?.authorAgentId && call.verification.authorAgentId === callerAgentId) {
				throw new Error("Self-verification is forbidden: author cannot verify their own work");
			}
			for (const refNo of call.refPostNos ?? []) {
				const refPost = deps.store.getBoardPost(matter.id, refNo);
				if (refPost && refPost.authorType === "agent" && refPost.authorId === callerAgentId) {
					throw new Error(
						`Self-verification is forbidden: agent '${callerAgentId}' authored referenced post #${refNo}`,
					);
				}
			}
		}

		const created = deps.store.createBoardPost({
			matterId: matter.id,
			authorType: "agent",
			authorId: callerAgentId,
			kind: call.kind as BoardPostKind,
			mentions: call.mentions,
			refPostNos: call.refPostNos,
			summary: call.summary,
			body: call.body ?? "",
			artifacts: call.artifacts ?? null,
			verification: call.verification ?? null,
			orgId: effectiveOrgId,
			workspaceId: workspace?.id ?? null,
		});
		routePostCreated(created);
		return { posted: true, post: toBoardPostSummaryDto(created) };
	};

	const launchBoardAgentTurn = (agentId: string): Promise<void> => {
		const memberRow = deps.store.getBoardMember(matter.id, agentId);
		if (!memberRow) return Promise.resolve();

		const baseMember =
			(memberRow.sourceMemberId ? deps.store.getMember(memberRow.sourceMemberId) : null) ?? coordinatorBaseMember;
		const unreadSummaries = deps.store.listBoardPostSummaries(matter.id, {
			afterPostNo: memberRow.lastReadPostNo,
			order: "asc",
		});
		const maxSeenPostNo = unreadSummaries.at(-1)?.postNo ?? memberRow.lastReadPostNo;
		const workingRecord = deps.store.updateBoardMemberState(matter.id, agentId, {
			status: "working",
			activePostNo: unreadSummaries.at(-1)?.postNo ?? memberRow.activePostNo,
		});
		if (workingRecord) emitMember(workingRecord);

		const allMembers = deps.store.listBoardMembers(matter.id);
		const turnPromptContext = [
			"## Current Board Roster",
			formatBoardRoster(allMembers),
			"",
			`## Unread Board Post Summaries (since post #${memberRow.lastReadPostNo})`,
			formatUnreadPostSummaries(unreadSummaries),
			"",
			"Use `read_board_post` to inspect full post details when `hasBody` is indicated, and `post_to_board` to communicate asynchronously via `@mention`.",
		].join("\n");

		const leadHandoffContext =
			agentId === "coordinator" && memberRow.lastReadPostNo === 0 && unreadSummaries.length === 0
				? buildLeadToBoardHandoffBlock(deps.store, matter.id, run.userMessageId)
				: "";
		const baseInitialPrompt = input.prompt.trim() || "Coordinate this matter on the collaboration board.";
		const taskPrompt =
			agentId === "coordinator" && unreadSummaries.length === 0
				? [baseInitialPrompt, leadHandoffContext].filter(Boolean).join("\n\n")
				: `Process your board wakeup for unread posts since #${memberRow.lastReadPostNo}.${agentId === "coordinator" && input.prompt.trim() ? `\n\n[User Request Context]\n${input.prompt.trim()}` : ""}`;

		emitDispatchProgress({
			stage: "thinking",
			speakerMemberId: baseMember.id,
			label: `${memberRow.displayName}正在处理公告板动态`,
		});

		const runPromise = (async () => {
			const finalizedPostNo = maxSeenPostNo;
			try {
				const result = await deps.executeWithWorker({
					matterId: matter.id,
					member: baseMember,
					workspace,
					taskPrompt,
					run,
					chain: [baseMember.id],
					signal: run.controller.signal,
					effectsTarget: run.effects,
					sessionMode: memberRow.boardRole === "verifier" ? "verifier" : "internal",
					boardContext: {
						agentId: memberRow.agentId,
						boardRole: memberRow.boardRole,
						displayName: memberRow.displayName,
						brief: memberRow.brief,
						skills: memberRow.skills,
						ownedScope: memberRow.ownedScope,
						acceptanceCriteria: memberRow.acceptanceCriteria,
						modelOverride: memberRow.modelOverride,
						turnPromptContext,
						onToolCall: (call) => validateAndExecuteToolCall(memberRow.agentId, call),
						onEventAppended: (ev) => emitEvent(ev),
					},
					onTextDelta: agentId === "coordinator" ? input.onTextDelta : undefined,
					onProgress: (p) =>
						emitDispatchProgress({
							...p,
							speakerMemberId: baseMember.id,
						}),
				});
				if (agentId === "coordinator") {
					lastCoordinatorResult = result;
					if (result.assistantText.trim()) {
						lastCoordinatorText = result.assistantText.trim();
					}
				}
			} finally {
				lastActivityAt = Date.now();
				const latestMember = deps.store.getBoardMember(matter.id, agentId);
				if (latestMember) {
					const nextLastRead = Math.max(latestMember.lastReadPostNo, finalizedPostNo);
					const preserveStatus =
						latestMember.status === "blocked_human" ||
						latestMember.status === "stopped" ||
						latestMember.status === "retired";
					const settled = deps.store.updateBoardMemberState(matter.id, agentId, {
						status: preserveStatus ? latestMember.status : "waiting",
						lastReadPostNo: nextLastRead,
						activePostNo: null,
					});
					if (settled) emitMember(settled);
				}
				activeWorkers.delete(agentId);
				if (pendingRewake.delete(agentId) && !pausedForHuman) {
					enqueueAgent(agentId);
				}
			}
		})();

		activeWorkers.set(agentId, runPromise);
		return runPromise;
	};

	// Bootstrap wakeup
	if (input.resumeFromBoardPostNo) {
		const triggerPost = deps.store.getBoardPost(matter.id, input.resumeFromBoardPostNo);
		if (triggerPost) {
			routePostCreated(triggerPost);
		} else {
			enqueueAgent("coordinator");
		}
	} else {
		enqueueAgent("coordinator");
	}

	const checkAndRunMonitor = async (): Promise<boolean> => {
		const elapsed = Date.now() - lastActivityAt;
		if (elapsed < silenceThresholdMs) {
			const delayResult = await abortableDelay(silenceThresholdMs - elapsed, run.controller.signal);
			if (delayResult === "aborted") return false;
		}
		if (run.cancelled || run.controller.signal.aborted || pausedForHuman) return false;
		if (wakeQueue.length > 0 || activeWorkers.size > 0) return true;
		if (unresolvedTargets.size === 0) return false;

		const stalledId = [...unresolvedTargets][0]!;
		const nextNudge = (nudgeCounts.get(stalledId) ?? 0) + 1;
		nudgeCounts.set(stalledId, nextNudge);

		const alertEvent = deps.store.appendEvent({
			matterId: matter.id,
			runId: run.userMessageId || "board",
			agentId: stalledId,
			eventType: "monitor_alert",
			payload: {
				targetAgentId: stalledId,
				nudgeCount: nextNudge,
				silenceThresholdMs,
				reason: nextNudge <= 2 ? "silent_stall_nudge" : "silent_stall_escalate",
			},
		});
		emitEvent(alertEvent);

		if (nextNudge <= 2) {
			const nudgePost = deps.store.createBoardPost({
				matterId: matter.id,
				authorType: "monitor",
				authorId: "monitor",
				kind: "progress",
				mentions: [stalledId],
				summary: `@monitor 提醒 @${stalledId}：已静默超过阈值，请补充进度、发起 handoff 或说明阻塞原因（第 ${nextNudge} 次）。`,
				body: "",
				orgId: effectiveOrgId,
				workspaceId: workspace?.id ?? null,
			});
			routePostCreated(nudgePost);
			return true;
		}

		unresolvedTargets.delete(stalledId);
		const escalatePost = deps.store.createBoardPost({
			matterId: matter.id,
			authorType: "monitor",
			authorId: "monitor",
			kind: "escalate",
			mentions: ["coordinator"],
			summary: `@monitor 升级告警：@${stalledId} 连续 ${nextNudge - 1} 次催促未交接，请 @coordinator 介入重新分工或接管。`,
			body: "",
			orgId: effectiveOrgId,
			workspaceId: workspace?.id ?? null,
		});
		routePostCreated(escalatePost);
		return true;
	};

	while (!run.cancelled && !run.controller.signal.aborted && totalSteps < maxTotalSteps) {
		while (wakeQueue.length > 0 && !pausedForHuman && totalSteps < maxTotalSteps) {
			const nextAgentId = wakeQueue.shift()!;
			queuedSet.delete(nextAgentId);
			if (activeWorkers.has(nextAgentId)) {
				pendingRewake.add(nextAgentId);
				continue;
			}
			const memberRow = deps.store.getBoardMember(matter.id, nextAgentId);
			if (
				!memberRow ||
				memberRow.status === "stopped" ||
				memberRow.status === "retired" ||
				memberRow.status === "blocked_human"
			) {
				continue;
			}
			totalSteps += 1;
			void launchBoardAgentTurn(nextAgentId);
		}

		if (activeWorkers.size > 0) {
			const anySettled = Promise.race([...activeWorkers.values()]);
			await Promise.race([anySettled, abortableDelay(Math.min(silenceThresholdMs, 5000), run.controller.signal)]);
			continue;
		}

		if (pausedForHuman) break;
		if (wakeQueue.length > 0) continue;

		if (unresolvedTargets.size === 0) {
			if (needsCoordinatorSummary && !coordinatorSummarized) {
				coordinatorSummarized = true;
				enqueueAgent("coordinator");
				continue;
			}
			break;
		}

		const nudged = await checkAndRunMonitor();
		if (!nudged && wakeQueue.length === 0 && activeWorkers.size === 0) break;
	}

	if (activeWorkers.size > 0) {
		await Promise.allSettled([...activeWorkers.values()]);
	}

	const lastSummaryPost = summaryState.post;
	const summaryText =
		lastCoordinatorText ||
		(lastSummaryPost ? lastSummaryPost.body || lastSummaryPost.summary : "") ||
		clarificationSummary ||
		"已完成本轮看板协同。";

	const replyText = pausedForHuman ? `需要你确认后再继续推进：${clarificationSummary}` : summaryText;

	const currentMatter = deps.store.getMatter(matter.id) ?? matter;
	const finalStatus = pausedForHuman ? "waiting_user" : "open";
	if (!pausedForHuman && currentMatter.status === "waiting_user") {
		deps.store.updateMatterStatus(matter.id, "open");
		input.onMatterStatusUpdated?.({ matterId: matter.id, status: "open" });
	}

	const finalMatter = deps.store.updateMatterStatus(matter.id, finalStatus, replyText.slice(0, 240));
	if (!pausedForHuman) {
		deps.store.appendMessage({
			matterId: matter.id,
			channel: "user",
			senderType: "member",
			senderId: coordinatorBaseMember.id,
			content: replyText,
			metadata: {
				workspaceId: workspace?.id ?? null,
				repoPath,
				orgId: effectiveOrgId,
				sourceUserMessageId: run.userMessageId,
				...(lastSummaryPost ? { boardPostNo: lastSummaryPost.postNo } : {}),
				...(run.effects.savedDocuments.length > 0 ? { spaceDocuments: run.effects.savedDocuments } : {}),
				...(run.effects.skillProposals.length > 0 ? { skillProposals: run.effects.skillProposals } : {}),
				progressSnapshot: buildProgressSnapshot({
					outcome: "completed",
					progress: run.lastProgress,
					startedAtMs: run.startedAt,
					leadMember: coordinatorBaseMember,
				}),
			},
		});
	}

	return {
		matter: finalMatter,
		assignedMember: coordinatorBaseMember,
		workspace,
		replyText,
		runResult: lastCoordinatorResult ?? {
			disposition: "started",
			aborted: Boolean(run.cancelled),
			assistantText: replyText,
			assistantMessages: [],
			toolExecutions: [],
			notices: [],
			dialogs: [],
			events: [],
		},
	};
}
