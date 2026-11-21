import { resolve } from "node:path";
import type { DecisionResponse } from "../orchestrator/human-decision.ts";
import {
	buildProgressSnapshot,
	type DispatchMatterResult,
	type DispatchProgressEvent,
	type PromptFileAttachment,
	type PromptImageAttachment,
	type TeamOrchestrator,
} from "../orchestrator/team-orchestrator.ts";
import type { PersonalAgentStore } from "../storage/repositories.ts";
import type { CollaboratorRole, DeliverableType } from "../storage/types.ts";
import { canAccessMatter, canDispatchAiInOrg, canParticipateInMatter, canTargetMatterAi } from "./acl.ts";
import type { RequestActor } from "./auth.ts";
import { HttpRequestError } from "./http.ts";

export interface ActiveRunState {
	progress: DispatchProgressEvent;
	startedAt: number;
	accumulatedDelta: string;
	startedByUserId?: string | null;
	orgId?: string | null;
}

export interface BackgroundDispatchInput {
	matterId: string;
	interactionMode?: "dispatch" | "discussion" | "conversation";
	keepMatterLead?: boolean;
	existingUserMessageId?: string;
	decisionResponse?: DecisionResponse;
	title?: string;
	prompt: string;
	images?: PromptImageAttachment[];
	files?: PromptFileAttachment[];
	preferredMemberId?: string;
	workspaceId?: string;
	orgId?: string | null;
	observerMemberIds?: string[];
	deliverableTitle?: string;
	deliverableType?: DeliverableType;
	startedByUserId?: string | null;
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
	inheritsLocalPiResources: () => boolean;
}) {
	const { store, orchestrator, broadcast } = deps;
	const activeRuns = new Map<string, ActiveRunState>();

	const runDispatchInBackground = (input: BackgroundDispatchInput, actor: RequestActor): void => {
		// Uploads and body reads can yield after a route's first busy check. Reserve here before emitting events.
		if (activeRuns.has(input.matterId) || orchestrator.isMatterRunning(input.matterId))
			throw new HttpRequestError(409, "Matter already has an active turn");
		const isConversation = input.interactionMode === "conversation";
		const isDiscussion = input.interactionMode === "discussion" || isConversation;
		const validateConversationAccess = isConversation
			? (memberId?: string) => {
					const matter = store.getMatter(input.matterId);
					const currentUser =
						actor.authKind === "session" && actor.sessionTokenHash
							? store.getSessionAndUserByHash(actor.sessionTokenHash)?.user
							: actor.user;
					const currentActor = currentUser ? { ...actor, user: currentUser } : actor;
					if (
						(actor.authKind === "session" && !currentUser) ||
						!matter ||
						!canAccessMatter(store, currentActor, matter) ||
						!canParticipateInMatter(store, currentActor, matter) ||
						!canDispatchAiInOrg(store, currentActor, matter.orgId) ||
						(memberId && !canTargetMatterAi(store, currentActor, matter.orgId, memberId))
					)
						throw new HttpRequestError(403, "当前权限不允许继续处理这条 AI 消息");
				}
			: undefined;
		const activeEntry: ActiveRunState = {
			progress: {
				stage: "starting",
				sourceUserMessageId: input.existingUserMessageId,
				label: isConversation ? "正在理解消息…" : isDiscussion ? "正在接入团队讨论..." : "正在准备执行环境...",
			},
			startedAt: Date.now(),
			accumulatedDelta: "",
			startedByUserId: input.startedByUserId ?? null,
			orgId: input.orgId ?? null,
		};
		activeRuns.set(input.matterId, activeEntry);
		broadcast("matter_started", { matterId: input.matterId });
		let accumulatedDelta = "";
		void orchestrator
			.dispatchMatter({
				matterId: input.matterId,
				interactionMode: input.interactionMode,
				keepMatterLead: input.keepMatterLead,
				existingUserMessageId: input.existingUserMessageId,
				validateConversationAccess,
				decisionResponse: input.decisionResponse,
				title: input.title,
				prompt: input.prompt,
				images: input.images,
				files: input.files,
				preferredMemberId: input.preferredMemberId,
				workspaceId: input.workspaceId,
				orgId: input.orgId,
				actorUserId: input.startedByUserId ?? null,
				inheritLocalPiResources:
					input.interactionMode !== "discussion" &&
					actor.authKind === "loopback" &&
					deps.inheritsLocalPiResources(),
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
				if (result.rosterMessage) {
					broadcast("matter_message", { matterId: result.matter.id, message: result.rosterMessage });
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
				const snapshotMemberId = lastActive?.progress.speakerMemberId ?? currentMatter?.leadMemberId;
				const snapshotMember = snapshotMemberId ? store.getMember(snapshotMemberId) : null;
				const messages = store.listMessages(input.matterId, "user");
				const sourceId = lastActive?.progress.sourceUserMessageId ?? input.existingUserMessageId;
				const sourceMessage = sourceId ? store.getMessage(sourceId) : null;
				const resolvedWorkspaceId =
					sourceMessage?.metadata && "workspaceId" in sourceMessage.metadata
						? ((sourceMessage.metadata.workspaceId as string | null) ?? null)
						: (input.workspaceId ?? currentMatter?.workspaceId ?? null);
				const workspaceLink = resolvedWorkspaceId ? store.getWorkspace(resolvedWorkspaceId) : null;
				const resolvedRepoPath =
					typeof sourceMessage?.metadata?.repoPath === "string"
						? sourceMessage.metadata.repoPath
						: resolve(workspaceLink?.repoPath ?? process.cwd());
				const progressSnapshot = lastActive
					? buildProgressSnapshot({
							outcome: "failed",
							progress: lastActive.progress,
							startedAtMs: lastActive.startedAt,
							leadMember: snapshotMember,
						})
					: undefined;
				store.appendMessage({
					matterId: input.matterId,
					channel: "notice",
					senderType: "system",
					senderId: "orchestrator",
					content: JSON.stringify({ method: "error", message }),
				});
				const hasSavedReply =
					isDiscussion &&
					sourceMessage &&
					messages.some(
						(msg) => msg.senderType === "member" && msg.metadata?.sourceUserMessageId === sourceMessage.id,
					);
				const partialText = hasSavedReply ? "" : accumulatedDelta.trim();
				const partialNote = partialText ? `${partialText}\n\n---\n\n` : "";
				store.appendMessage({
					matterId: input.matterId,
					channel: "user",
					senderType: "system",
					senderId: "orchestrator",
					content: isConversation
						? `${partialNote}⚠️ AI 未能处理这条消息（${message}）。消息已保留。`
						: isDiscussion
							? `${partialNote}⚠️ AI 讨论未完成（${message}）。讨论消息已保留。`
							: `${partialNote}⚠️ 本次执行未完成（${message}）。你可以直接追问继续，或拆分任务范围后重试。`,
					metadata: {
						failed: true,
						error: message,
						workspaceId: resolvedWorkspaceId,
						repoPath: resolvedRepoPath,
						...(isDiscussion ? { discussionTurn: true } : {}),
						...(sourceMessage ? { sourceUserMessageId: sourceMessage.id } : {}),
						...(progressSnapshot ? { progressSnapshot } : {}),
					},
				});
				if (!isDiscussion) store.updateMatterStatus(input.matterId, "open");
				broadcast("matter_failed", {
					matterId: input.matterId,
					error: message,
					...(progressSnapshot ? { progressSnapshot } : {}),
				});
			});
	};

	return { activeRuns, runDispatchInBackground };
}
