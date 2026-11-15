import { resolve } from "node:path";
import type { PromptRunResult } from "../rpc/pi-rpc-worker.ts";
import type { ImageContent } from "../rpc/types.ts";
import type { PersonalAgentStore } from "../storage/repositories.ts";
import type { Matter, MatterMessage, TeamMember, WorkspaceLink } from "../storage/types.ts";
import { buildObserverTaskPrompt } from "./prompts.ts";
import {
	type DispatchProgressEvent,
	type ExecutionEffects,
	emptyEffects,
	isObserverSilentReply,
	type MatterRun,
	mapChildStageLabel,
	pushRunLog,
	summarizeObserverProgress,
	truncateInline,
} from "./types.ts";

export interface ObserverExecuteWorkerInput {
	matterId: string;
	member: TeamMember;
	workspace: WorkspaceLink | null;
	taskPrompt: string;
	images?: ImageContent[];
	sessionMode: "observer";
	excludeMessageIds: string[];
	run: MatterRun;
	chain: string[];
	signal: AbortSignal;
	effectsTarget: ExecutionEffects;
	onProgress: (progress: DispatchProgressEvent) => void;
}

export interface ObserverRunnerDeps {
	store: PersonalAgentStore;
	defaultCwd: string;
	executeWithWorker: (input: ObserverExecuteWorkerInput) => Promise<PromptRunResult>;
}

/** Run proactive observer evaluations in parallel after lead settlement. */
export async function runObserversPass(
	deps: ObserverRunnerDeps,
	input: {
		matter: Matter;
		assignedMember: TeamMember;
		workspace: WorkspaceLink | null;
		userPrompt: string;
		userImages?: ImageContent[];
		leadReply: string;
		leadMessageId: string;
		observers: TeamMember[];
		run: MatterRun;
		signal: AbortSignal;
		onProgress?: (progress: DispatchProgressEvent) => void;
	},
): Promise<MatterMessage[]> {
	const createdMessages: MatterMessage[] = [];
	const taskPrompt = buildObserverTaskPrompt({
		leadMember: input.assignedMember,
		userPrompt: input.userPrompt,
		leadReply: input.leadReply,
		imageCount: input.userImages?.length ?? 0,
	});
	const observerNames = input.observers.map((member) => member.displayName).join("、");
	pushRunLog(input.run, "旁听席", `${observerNames}正在审视本轮讨论`);
	for (const observer of input.observers) {
		input.run.activeDelegations.set(`obs:${observer.id}`, {
			memberId: observer.id,
			memberName: observer.displayName,
			stageLabel: "旁听审视中",
		});
	}
	input.onProgress?.({
		stage: "thinking",
		label: summarizeObserverProgress(input.run.activeDelegations),
		activeDelegations: [...input.run.activeDelegations.values()],
		recentLogs: [...input.run.recentLogs],
		collabUpdated: true,
	});

	await Promise.allSettled(
		input.observers.map(async (observer) => {
			const observerKey = `obs:${observer.id}`;
			try {
				if (input.signal.aborted || input.run.cancelled) return;
				const result = await deps.executeWithWorker({
					matterId: input.matter.id,
					member: observer,
					workspace: input.workspace,
					taskPrompt,
					images: input.userImages,
					sessionMode: "observer",
					excludeMessageIds: [input.run.userMessageId, input.leadMessageId],
					run: input.run,
					chain: [input.assignedMember.id, observer.id],
					signal: input.signal,
					effectsTarget: emptyEffects(),
					onProgress: (childProgress) => {
						const stageLabel = mapChildStageLabel(childProgress, "旁听审视中");
						input.run.activeDelegations.set(observerKey, {
							memberId: observer.id,
							memberName: observer.displayName,
							stageLabel,
						});
						input.onProgress?.({
							stage: childProgress.stage === "waiting_user" ? "waiting_user" : "thinking",
							label:
								childProgress.stage === "waiting_user"
									? childProgress.label
									: summarizeObserverProgress(input.run.activeDelegations, observer.displayName, stageLabel),
							toolName: childProgress.toolName,
							activeDelegations: [...input.run.activeDelegations.values()],
							recentLogs: [...input.run.recentLogs],
						});
					},
				});
				input.run.activeDelegations.delete(observerKey);
				if (result.aborted || input.run.cancelled || input.signal.aborted) return;
				const text = result.assistantText.trim();
				if (isObserverSilentReply(text)) {
					pushRunLog(input.run, observer.displayName, "旁听已阅，暂无补充");
					input.onProgress?.({
						stage: "thinking",
						label: summarizeObserverProgress(input.run.activeDelegations),
						activeDelegations: [...input.run.activeDelegations.values()],
						recentLogs: [...input.run.recentLogs],
					});
					return;
				}
				const msg = deps.store.appendMessage({
					matterId: input.matter.id,
					channel: "user",
					senderType: "member",
					senderId: observer.id,
					content: text,
					metadata: {
						observerIntervention: true,
						inReplyToUserMessageId: input.run.userMessageId,
						leadMemberId: input.assignedMember.id,
						toolsUsed: result.toolExecutions.map((tool) => tool.toolName),
						workspaceId: input.workspace?.id ?? null,
						repoPath: resolve(input.workspace?.repoPath ?? deps.defaultCwd),
					},
				});
				createdMessages.push(msg);
				pushRunLog(input.run, observer.displayName, `旁听补充：${truncateInline(text, 44)}`);
				input.onProgress?.({
					stage: "finalizing",
					label: `${observer.displayName}补充了意见`,
					activeDelegations: [...input.run.activeDelegations.values()],
					recentLogs: [...input.run.recentLogs],
					collabUpdated: true,
				});
			} catch (error) {
				input.run.activeDelegations.delete(observerKey);
				if (input.run.cancelled || input.signal.aborted) return;
				const msg = error instanceof Error ? error.message : String(error);
				pushRunLog(input.run, observer.displayName, `旁听跳过：${truncateInline(msg, 36)}`);
				deps.store.appendMessage({
					matterId: input.matter.id,
					channel: "notice",
					senderType: "system",
					senderId: observer.id,
					content: `旁听评估未完成：${msg}`,
					metadata: { observerFailed: true, leadMemberId: input.assignedMember.id },
				});
				input.onProgress?.({
					stage: "thinking",
					label: summarizeObserverProgress(input.run.activeDelegations),
					activeDelegations: [...input.run.activeDelegations.values()],
					recentLogs: [...input.run.recentLogs],
				});
			}
		}),
	);
	return createdMessages;
}
