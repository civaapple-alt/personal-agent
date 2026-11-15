import { resolve } from "node:path";
import {
	buildProgressSnapshot,
	type DispatchMatterResult,
	type DispatchProgressEvent,
	type PromptImageAttachment,
	type TeamOrchestrator,
} from "../orchestrator/team-orchestrator.ts";
import type { PersonalAgentStore } from "../storage/repositories.ts";
import type { CollaboratorRole, DeliverableType } from "../storage/types.ts";
import { HttpRequestError } from "./http.ts";

export interface ActiveRunState {
	progress: DispatchProgressEvent;
	startedAt: number;
	accumulatedDelta: string;
}

export interface BackgroundDispatchInput {
	matterId: string;
	title?: string;
	prompt: string;
	images?: PromptImageAttachment[];
	preferredMemberId?: string;
	workspaceId?: string;
	observerMemberIds?: string[];
	deliverableTitle?: string;
	deliverableType?: DeliverableType;
	author?: {
		collaboratorId: string;
		name: string;
		roleTitle: string;
		permissionRole: CollaboratorRole;
	};
}

/** Tracks in-flight matter dispatches, streams progress events, and persists readable failures. */
export function createDispatchRunner(deps: {
	store: PersonalAgentStore;
	orchestrator: TeamOrchestrator;
	broadcast: (eventName: string, payload: unknown) => void;
}) {
	const { store, orchestrator, broadcast } = deps;
	const activeRuns = new Map<string, ActiveRunState>();

	const runDispatchInBackground = (input: BackgroundDispatchInput): void => {
		// Uploads and body reads can yield after a route's first busy check. Reserve here before emitting events.
		if (activeRuns.has(input.matterId) || orchestrator.isMatterRunning(input.matterId))
			throw new HttpRequestError(409, "Matter already has an active turn");
		const activeEntry: ActiveRunState = {
			progress: { stage: "starting", label: "正在准备执行环境..." },
			startedAt: Date.now(),
			accumulatedDelta: "",
		};
		activeRuns.set(input.matterId, activeEntry);
		broadcast("matter_started", { matterId: input.matterId });
		let accumulatedDelta = "";
		void orchestrator
			.dispatchMatter({
				matterId: input.matterId,
				title: input.title,
				prompt: input.prompt,
				images: input.images,
				preferredMemberId: input.preferredMemberId,
				workspaceId: input.workspaceId,
				observerMemberIds: input.observerMemberIds,
				deliverableTitle: input.deliverableTitle,
				deliverableType: input.deliverableType,
				author: input.author,
				onTextDelta: (delta) => {
					accumulatedDelta += delta;
					activeEntry.accumulatedDelta = accumulatedDelta;
					broadcast("text_delta", { matterId: input.matterId, delta });
				},
				onProgress: (progress) => {
					activeEntry.progress = progress;
					broadcast("matter_progress", { matterId: input.matterId, ...progress });
				},
			})
			.then((result: DispatchMatterResult) => {
				activeRuns.delete(input.matterId);
				if (result.runResult.aborted) {
					broadcast("matter_aborted", {
						matterId: result.matter.id,
						matter: result.matter,
					});
					return;
				}
				broadcast("matter_settled", {
					matterId: result.matter.id,
					matter: result.matter,
					deliverable: result.deliverable,
					assignedMemberId: result.assignedMember.id,
				});
			})
			.catch((error: unknown) => {
				const lastActive = activeRuns.get(input.matterId);
				activeRuns.delete(input.matterId);
				const message = error instanceof Error ? error.message : String(error);
				const currentMatter = store.getMatter(input.matterId);
				const leadMember = currentMatter?.leadMemberId ? store.getMember(currentMatter.leadMemberId) : null;
				const lastUserMsg = [...store.listMessages(input.matterId, "user")]
					.reverse()
					.find((msg) => msg.senderType === "user");
				const resolvedWorkspaceId =
					lastUserMsg?.metadata && "workspaceId" in lastUserMsg.metadata
						? ((lastUserMsg.metadata.workspaceId as string | null) ?? null)
						: (input.workspaceId ?? currentMatter?.workspaceId ?? null);
				const workspaceLink = resolvedWorkspaceId ? store.getWorkspace(resolvedWorkspaceId) : null;
				const resolvedRepoPath =
					typeof lastUserMsg?.metadata?.repoPath === "string"
						? lastUserMsg.metadata.repoPath
						: resolve(workspaceLink?.repoPath ?? process.cwd());
				const progressSnapshot = lastActive
					? buildProgressSnapshot({
							outcome: "failed",
							progress: lastActive.progress,
							startedAtMs: lastActive.startedAt,
							leadMember,
						})
					: undefined;
				store.appendMessage({
					matterId: input.matterId,
					channel: "notice",
					senderType: "system",
					senderId: "orchestrator",
					content: JSON.stringify({ method: "error", message }),
				});
				const partialNote = accumulatedDelta.trim() ? `${accumulatedDelta.trim()}\n\n---\n\n` : "";
				store.appendMessage({
					matterId: input.matterId,
					channel: "user",
					senderType: "system",
					senderId: "orchestrator",
					content: `${partialNote}⚠️ 本次执行未完成（${message}）。你可以直接追问继续，或拆分任务范围后重试。`,
					metadata: {
						failed: true,
						error: message,
						workspaceId: resolvedWorkspaceId,
						repoPath: resolvedRepoPath,
						...(progressSnapshot ? { progressSnapshot } : {}),
					},
				});
				store.updateMatterStatus(input.matterId, "open");
				broadcast("matter_failed", {
					matterId: input.matterId,
					error: message,
					...(progressSnapshot ? { progressSnapshot } : {}),
				});
			});
	};

	return { activeRuns, runDispatchInBackground };
}
