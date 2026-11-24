import { resolve } from "node:path";
import { looksLikeWorkRequest } from "../../orchestrator/architect/conversation-intent.ts";
import { PiDecisionError } from "../../orchestrator/architect/pi-decision.ts";
import { resolveDiscussionMentionTargets } from "../../orchestrator/execution/prompts.ts";
import { messageMatchesContext } from "../../orchestrator/runtime/matter-context.ts";
import type { PromptFileAttachment, PromptImageAttachment } from "../../orchestrator/team-orchestrator.ts";
import { ROLE_ARCHITECT_MEMBER_ID } from "../../roles/role-architect.ts";
import { isExplicitRoleSetupRequest } from "../../roles/role-setup-intent.ts";
import type { Collaborator, Matter, MatterMessage, MatterVisibility } from "../../storage/types.ts";
import {
	canAccessMatter,
	canAccessOrganization,
	canAccessWorkspace,
	canActorUseMember,
	canDispatchAiInOrg,
	canManageOrganization,
	canParticipateInMatter,
} from "../acl.ts";
import { isSuperAdminActor, type RequestActor, requireActiveActor, toDispatchAuthor } from "../auth.ts";
import { readJsonBody, responseCancellation, sendError, sendJson } from "../http.ts";
import {
	loadStoredFilesFromRefs,
	loadStoredImagesFromRefs,
	parseIncomingFiles,
	parseIncomingImages,
	persistUploadedFiles,
	persistUploadedImages,
	recordStoredUploadsAcl,
} from "../uploads.ts";
import {
	auditActorAction,
	parseCollaboratorIds,
	parseObserverMemberIds,
	type RouteRequest,
	type ServerRouteContext,
} from "./context.ts";
import { ensureActorAllowedMembers, ensureOrgEnabledAiRequest, replyWithCurrentMatterRoster } from "./matter-roster.ts";
import { validateModelSelection } from "./model-settings.ts";

function countActiveDispatchesForUser(ctx: ServerRouteContext, userId: string): number {
	let count = 0;
	for (const run of ctx.activeRuns.values()) {
		if (run.startedByUserId === userId) count += 1;
	}
	return count;
}

export function hasUserDispatchQuotaAvailable(ctx: ServerRouteContext, actor: RequestActor): boolean {
	if (!actor.user || isSuperAdminActor(actor)) return true;
	return countActiveDispatchesForUser(ctx, actor.user.id) < actor.user.maxActiveDispatches;
}

export function checkUserDispatchQuota(ctx: ServerRouteContext, actor: RequestActor, res: { end: unknown }): boolean {
	if (hasUserDispatchQuotaAvailable(ctx, actor)) return true;
	sendError(
		res as Parameters<typeof sendError>[0],
		429,
		`当前并发执行中的 AI 任务已达上限（${actor.user!.maxActiveDispatches} 个），请等待完成或中止后再试`,
	);
	return false;
}

function resolveActorDefaultOrgId(ctx: ServerRouteContext, actor: RequestActor): string | null {
	if (actor.authKind === "session" && actor.user) {
		const orgs = ctx.store.listUserOrganizations(actor.user.id);
		return orgs.find((o) => o.isDefault)?.id ?? orgs[0]?.id ?? null;
	}
	return ctx.store.getDefaultOrganization()?.id ?? null;
}

function appendHumanMessage(
	ctx: ServerRouteContext,
	input: {
		matter: Matter;
		actorCollaborator: Collaborator;
		mode: "discussion" | "ai_request" | "conversation";
		prompt: string;
		workspaceId: string | undefined;
		preferredMemberId: string | undefined;
		images: PromptImageAttachment[];
		files: PromptFileAttachment[];
	},
) {
	const { store, orchestrator, broadcast } = ctx;
	const boundWorkspace = input.workspaceId ? store.getWorkspace(input.workspaceId) : null;
	const imageMetadataRefs = input.images.map((item, idx) => ({
		...(item.url ? { url: item.url } : {}),
		mimeType: item.mimeType,
		name: item.name || `image-${idx + 1}`,
	}));
	const fileMetadataRefs = input.files.map((item) => ({
		...(item.url ? { url: item.url } : {}),
		kind: item.kind,
		name: item.name,
		mimeType: item.mimeType,
		sizeBytes: item.sizeBytes,
		lineCount: item.lineCount,
		charCount: item.charCount,
		...(item.previewText ? { previewText: item.previewText } : {}),
	}));
	const message = store.appendMessage({
		matterId: input.matter.id,
		channel: "user",
		senderType: "user",
		senderId: input.actorCollaborator.id,
		content: input.prompt,
		metadata: {
			mode: input.mode,
			workspaceId: input.workspaceId ?? null,
			repoPath: resolve(boundWorkspace?.repoPath ?? orchestrator.getDefaultCwd()),
			authorId: input.actorCollaborator.id,
			authorName: input.actorCollaborator.name,
			authorRole: input.actorCollaborator.roleTitle,
			permissionRole: input.actorCollaborator.permissionRole,
			...(input.mode === "ai_request" ? { aiRequestStatus: "pending" } : {}),
			...(input.preferredMemberId ? { preferredMemberId: input.preferredMemberId } : {}),
			...(imageMetadataRefs.length > 0 ? { images: imageMetadataRefs } : {}),
			...(fileMetadataRefs.length > 0 ? { files: fileMetadataRefs } : {}),
		},
	});
	const refreshedMatter = store.getMatter(input.matter.id) ?? input.matter;
	broadcast(
		"matter_message",
		{ matterId: refreshedMatter.id, message, matter: refreshedMatter },
		{ matterId: refreshedMatter.id },
	);
	return { message, refreshedMatter };
}

function conversationModeForActor(
	ctx: ServerRouteContext,
	actor: RequestActor,
	orgId: string | null,
	prompt: string,
	humanOnly: boolean,
) {
	return !humanOnly && !canDispatchAiInOrg(ctx.store, actor, orgId) && looksLikeWorkRequest(prompt)
		? "ai_request"
		: "conversation";
}

function humanMentionCandidates(
	{ store }: ServerRouteContext,
	matter: Pick<Matter, "createdByUserId" | "collaboratorIds" | "orgId" | "visibility">,
) {
	const orgOwner =
		matter.orgId && matter.visibility !== "private"
			? store.listOrgMembers(matter.orgId).find((member) => member.orgRole === "org_owner")?.userId
			: undefined;
	const ids = new Set([...matter.collaboratorIds, matter.createdByUserId, orgOwner]);
	return [...ids].flatMap((id) => {
		if (!id) return [];
		const user = store.getUserById(id);
		if (user) {
			return user.status === "active" && (!matter.orgId || store.getOrgMembership(matter.orgId, id))
				? [{ id, displayName: user.displayName, kind: "human" as const }]
				: [];
		}
		return [];
	});
}

function conversationRecipients(ctx: ServerRouteContext, actor: RequestActor, matter: Matter, prompt: string) {
	if (!prompt.includes("@")) return { aiMemberIds: [], humanOnly: false };
	const aiMembers = ctx.orchestrator
		.listConversationAiMembers(matter, actor.user?.id ?? null)
		.map(({ id, displayName, roleTitle }) => ({ id, displayName, roleTitle, kind: "ai" as const }));
	const recipients = resolveDiscussionMentionTargets(prompt, [...humanMentionCandidates(ctx, matter), ...aiMembers]);
	const aiMemberIds = recipients.filter(({ kind }) => kind === "ai").map(({ id }) => id);
	return { aiMemberIds, humanOnly: recipients.length > 0 && aiMemberIds.length === 0 };
}

export async function settleMatterObserverPass(ctx: ServerRouteContext, matterId: string): Promise<void> {
	const previous = ctx.activeRuns.get(matterId);
	const stoppingObservers = ctx.orchestrator.stopObserverPass(matterId);
	if (stoppingObservers) {
		await stoppingObservers;
		await previous?.settled;
	}
}

async function startAiForMessage(
	ctx: ServerRouteContext,
	actor: RequestActor,
	matter: Matter,
	message: MatterMessage,
	images: PromptImageAttachment[],
	files: PromptFileAttachment[],
	preferredMemberId?: string,
) {
	const isConversation = message.metadata?.mode === "conversation";
	const recipients = isConversation ? conversationRecipients(ctx, actor, matter, message.content) : undefined;
	if (isConversation) {
		if (recipients?.humanOnly) return { aiDiscussionTriggered: false, aiDiscussionSkippedReason: "human_recipient" };
		if (!recipients?.aiMemberIds.length && /^@[^\s@]/u.test(message.content))
			return { aiDiscussionTriggered: false, aiDiscussionSkippedReason: "unavailable_recipient" };
	} else if (!matter.discussionAiEnabled) {
		return { aiDiscussionTriggered: false, aiDiscussionSkippedReason: "disabled" };
	}
	if (!canDispatchAiInOrg(ctx.store, actor, matter.orgId))
		return { aiDiscussionTriggered: false, aiDiscussionSkippedReason: "unauthorized" };
	if (
		!isConversation &&
		!preferredMemberId &&
		images.length === 0 &&
		files.length === 0 &&
		replyWithCurrentMatterRoster(ctx, matter, message)
	)
		return { aiDiscussionTriggered: false };
	if (isConversation) await settleMatterObserverPass(ctx, matter.id);
	const skippedReason =
		ctx.orchestrator.isMatterRunning(matter.id) || ctx.activeRuns.has(matter.id)
			? "matter_busy"
			: !hasUserDispatchQuotaAvailable(ctx, actor)
				? "quota_limit"
				: null;
	if (skippedReason) return { aiDiscussionTriggered: false, aiDiscussionSkippedReason: skippedReason };

	ctx.runDispatchInBackground(
		{
			matterId: matter.id,
			interactionMode: isConversation ? "conversation" : "discussion",
			existingUserMessageId: message.id,
			prompt: message.content,
			images,
			files,
			preferredMemberId,
			conversationMentionMemberIds: recipients?.aiMemberIds,
			workspaceId: matter.workspaceId ?? undefined,
			orgId: matter.orgId,
			startedByUserId: actor.user?.id ?? null,
			author: toDispatchAuthor(actor.collaborator),
		},
		actor,
	);
	return { aiDiscussionTriggered: true };
}

/** Assess new matters, accept messages, and dispatch or approve AI requests. */
export async function handleMatterMessageRoutes(ctx: ServerRouteContext, r: RouteRequest): Promise<boolean> {
	const { store, orchestrator, uploadsDir, memoryUploads, runDispatchInBackground, broadcast } = ctx;
	const { req, res, method, pathname, actor } = r;

	if (method === "POST" && pathname === "/api/matters/assess") {
		if (!requireActiveActor(res, actor)) return true;
		const body = await readJsonBody(req);
		const mode = body.mode === "model" || body.useModel === true ? "model" : "rules";
		const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
		const workspaceId =
			typeof body.workspaceId === "string" && body.workspaceId.trim().length > 0 ? body.workspaceId.trim() : null;
		const explicitOrgId = typeof body.orgId === "string" && body.orgId.trim().length > 0 ? body.orgId.trim() : null;
		const preferredMemberId =
			typeof body.preferredMemberId === "string" && body.preferredMemberId.trim().length > 0
				? body.preferredMemberId.trim()
				: undefined;
		const ws = workspaceId ? store.getWorkspace(workspaceId) : null;
		if (workspaceId && !ws) {
			sendError(res, 404, `Workspace not found: ${workspaceId}`);
			return true;
		}
		if (ws && !canAccessWorkspace(store, actor, ws)) {
			sendError(res, 403, "无权访问所选项目仓库");
			return true;
		}
		const effectiveOrgId = ws?.orgId ?? explicitOrgId ?? resolveActorDefaultOrgId(ctx, actor);
		if (effectiveOrgId && !canAccessOrganization(store, actor, effectiveOrgId)) {
			sendError(res, 403, "无权访问所选组织");
			return true;
		}
		if (!ensureActorAllowedMembers(res, ctx, actor, [preferredMemberId])) {
			return true;
		}
		if (mode === "model") {
			if (!canDispatchAiInOrg(store, actor, effectiveOrgId)) {
				sendError(res, 403, "无权在此组织调用 AI 模型预判");
				return true;
			}
			if (!prompt) {
				sendError(res, 400, "prompt is required when mode is model");
				return true;
			}
			const cancellation = responseCancellation(res);
			try {
				const assessment = await orchestrator.assessInitiationWithModel({
					prompt,
					hasImages: body.hasImages === true || body.hasFiles === true,
					workspaceId,
					orgId: effectiveOrgId,
					actorUserId: actor.user?.id ?? null,
					preferredMemberId,
					readRepo: body.readRepo === true,
					signal: cancellation.signal,
				});
				if (res.destroyed || cancellation.signal.aborted) return true;
				sendJson(res, 200, assessment);
			} catch (err) {
				if (res.destroyed || cancellation.signal.aborted) return true;
				if (err instanceof PiDecisionError) {
					sendError(res, err.kind === "aborted" ? 499 : 502, err.message);
					return true;
				}
				const message = err instanceof Error ? err.message : String(err);
				sendError(res, 502, message);
			} finally {
				cancellation.dispose();
			}
			return true;
		}
		const assessment = orchestrator.assessInitiation({
			prompt,
			hasImages: body.hasImages === true || body.hasFiles === true,
			hasWorkspace: Boolean(workspaceId),
			preferredMemberId,
			orgId: effectiveOrgId,
			actorUserId: actor.user?.id ?? null,
		});
		sendJson(res, 200, assessment);
		return true;
	}

	if (method === "POST" && (pathname === "/api/matters" || pathname === "/api/matters/conversation")) {
		if (!requireActiveActor(res, actor)) return true;
		const body = await readJsonBody(req);
		const requestedMode =
			pathname === "/api/matters/conversation"
				? "conversation"
				: body.mode === "discussion" || body.mode === "ai_request" || body.mode === "conversation"
					? body.mode
					: "dispatch";
		const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
		const parsedImages = parseIncomingImages(body.images);
		const parsedFiles = parseIncomingFiles(body.files);
		if (!prompt && parsedImages.length === 0 && parsedFiles.length === 0) {
			sendError(res, 400, "prompt, images, or files is required");
			return true;
		}
		const preferredMemberId =
			typeof body.preferredMemberId === "string" && body.preferredMemberId.length > 0
				? body.preferredMemberId
				: requestedMode === "dispatch" && isExplicitRoleSetupRequest(prompt)
					? ROLE_ARCHITECT_MEMBER_ID
					: undefined;
		const workspaceId =
			typeof body.workspaceId === "string" && body.workspaceId.length > 0 ? body.workspaceId : undefined;
		const boundWorkspace = workspaceId ? store.getWorkspace(workspaceId) : null;
		if (workspaceId && !boundWorkspace) {
			sendError(res, 404, `Workspace not found: ${workspaceId}`);
			return true;
		}
		if (boundWorkspace && !canAccessWorkspace(store, actor, boundWorkspace)) {
			sendError(res, 403, "无权在此项目仓库内发起事项");
			return true;
		}
		const hasExplicitOrg = Object.hasOwn(body, "orgId");
		if (hasExplicitOrg && body.orgId !== null && typeof body.orgId !== "string") {
			sendError(res, 400, "orgId must be a string or null");
			return true;
		}
		const requestedOrgId = typeof body.orgId === "string" && body.orgId.trim().length > 0 ? body.orgId.trim() : null;
		if (requestedOrgId && !store.getOrganization(requestedOrgId)) {
			sendError(res, 404, `Organization not found: ${requestedOrgId}`);
			return true;
		}
		const orgId = boundWorkspace
			? boundWorkspace.orgId
			: requestedOrgId !== null
				? requestedOrgId
				: hasExplicitOrg && !(actor.authKind === "session" && !isSuperAdminActor(actor))
					? null
					: resolveActorDefaultOrgId(ctx, actor);
		if (orgId && !canAccessOrganization(store, actor, orgId)) {
			sendError(res, 403, "无权在非所属组织内创建事项");
			return true;
		}
		if (!orgId && actor.authKind === "session" && !isSuperAdminActor(actor)) {
			sendError(res, 403, "请先创建或加入一个组织后再创建事项");
			return true;
		}
		const requestedCollaboratorIds = (parseCollaboratorIds(body.collaboratorIds, store) ?? []).filter(
			(id) => id !== actor.user?.id,
		);
		const visibility: MatterVisibility = body.visibility === "private" ? "private" : "org";
		const namesHuman =
			requestedMode === "conversation" &&
			prompt.includes("@") &&
			resolveDiscussionMentionTargets(
				prompt,
				humanMentionCandidates(ctx, {
					orgId,
					visibility,
					collaboratorIds: requestedCollaboratorIds,
					createdByUserId: actor.user?.id,
				}),
			).length > 0;
		const mode =
			requestedMode === "conversation"
				? conversationModeForActor(ctx, actor, orgId, prompt, namesHuman)
				: requestedMode;
		if (mode === "dispatch") {
			if (!canDispatchAiInOrg(store, actor, orgId)) {
				sendError(res, 403, "当前账号无权直接向 AI 派发任务，可使用「团队聊天讨论」或「提请 AI 处理」");
				return true;
			}
			if (!checkUserDispatchQuota(ctx, actor, res)) return true;
		} else {
			if (orgId && actor.authKind === "session") {
				const orgRole = ctx.store.getOrgMembership(orgId, actor.user!.id)?.orgRole;
				if (orgRole === "org_viewer") {
					sendError(res, 403, "只读成员（org_viewer）不能发起事项或讨论");
					return true;
				}
			}
		}

		const title = typeof body.title === "string" && body.title.trim().length > 0 ? body.title.trim() : undefined;
		const aiMemberIds = Object.hasOwn(body, "aiMemberIds")
			? body.aiMemberIds === null
				? null
				: parseObserverMemberIds(body.aiMemberIds, store)
			: undefined;
		const consultMemberIds = Object.hasOwn(body, "consultMemberIds")
			? body.consultMemberIds === null
				? null
				: parseObserverMemberIds(body.consultMemberIds, store)
			: undefined;
		if (Object.hasOwn(body, "consultMemberIds") && body.consultMemberIds !== null && consultMemberIds === undefined) {
			sendError(res, 400, "consultMemberIds must be null or an array of member IDs");
			return true;
		}
		const observersEnabled = typeof body.observersEnabled === "boolean" ? body.observersEnabled : undefined;
		const observerMemberIds = parseObserverMemberIds(body.observerMemberIds, store);
		if (Object.hasOwn(body, "discussionAiEnabled") && typeof body.discussionAiEnabled !== "boolean") {
			sendError(res, 400, "discussionAiEnabled must be a boolean");
			return true;
		}
		const discussionAiEnabled = body.discussionAiEnabled === true;
		const initialCollaboratorIds = [...requestedCollaboratorIds];
		if (
			!ensureOrgEnabledAiRequest(res, ctx, actor, orgId, preferredMemberId, [
				...(aiMemberIds ?? []),
				...(consultMemberIds ?? []),
				...(observerMemberIds ?? []),
			])
		) {
			return true;
		}
		if (body.modelSelection != null && !canDispatchAiInOrg(store, actor, orgId)) {
			sendError(res, 403, "无权为此事项配置模型");
			return true;
		}
		const modelSelection = Object.hasOwn(body, "modelSelection")
			? await validateModelSelection(ctx, body.modelSelection)
			: null;
		const images = await persistUploadedImages(parsedImages, uploadsDir, memoryUploads);
		const files = await persistUploadedFiles(parsedFiles, uploadsDir, memoryUploads);

		const leadMember = orchestrator.routeMemberForRequest(
			mode === "conversation" ? "" : prompt,
			preferredMemberId,
			aiMemberIds,
			orgId,
			{
				actorUserId: actor.user?.id ?? null,
			},
		);
		const fallbackTitle = prompt
			? prompt.slice(0, 60)
			: files.length > 0
				? files.length === 1
					? files[0]?.kind === "pasted_text"
						? `粘贴文本（${files[0].lineCount} 行）`
						: `文件：${files[0]?.name ?? "附件"}`.slice(0, 60)
					: `上传了 ${files.length} 个文件`
				: images.length === 1
					? `图片：${images[0]?.name ?? "上传图片"}`.slice(0, 60)
					: `上传了 ${images.length} 张图片`;
		const matter = store.createMatter({
			title: title ?? fallbackTitle,
			leadMemberId: mode === "conversation" && !preferredMemberId ? null : leadMember.id,
			workspaceId: workspaceId ?? null,
			orgId,
			createdByUserId: actor.user?.id ?? null,
			visibility,
			aiMemberIds,
			consultMemberIds,
			observersEnabled,
			observerMemberIds,
			discussionAiEnabled,
			modelSelection,
			collaboratorIds: initialCollaboratorIds,
		});
		recordStoredUploadsAcl(store, {
			orgId: matter.orgId,
			matterId: matter.id,
			uploaderUserId: actor.user?.id ?? null,
			images,
			files,
		});

		if (mode !== "dispatch") {
			const { message, refreshedMatter } = appendHumanMessage(ctx, {
				matter,
				actorCollaborator: actor.collaborator,
				mode,
				prompt,
				workspaceId,
				preferredMemberId,
				images,
				files,
			});
			const discussion =
				mode === "ai_request"
					? {}
					: await startAiForMessage(ctx, actor, refreshedMatter, message, images, files, preferredMemberId);
			sendJson(res, 201, { matter: refreshedMatter, message, mode, assignedMember: leadMember, ...discussion });
			return true;
		}

		runDispatchInBackground(
			{
				matterId: matter.id,
				title,
				prompt,
				images: images.length > 0 ? images : undefined,
				files: files.length > 0 ? files : undefined,
				preferredMemberId: leadMember.id,
				workspaceId,
				orgId: matter.orgId,
				startedByUserId: actor.user?.id ?? null,
				author: toDispatchAuthor(actor.collaborator),
			},
			actor,
		);

		sendJson(res, 202, { matter, assignedMember: leadMember, mode });
		return true;
	}

	const matterApproveAiMatch = pathname.match(/^\/api\/matters\/([^/]+)\/messages\/([^/]+)\/approve-ai$/);
	if (method === "POST" && matterApproveAiMatch) {
		if (!requireActiveActor(res, actor)) return true;
		const matterId = decodeURIComponent(matterApproveAiMatch[1]!);
		const messageId = decodeURIComponent(matterApproveAiMatch[2]!);
		const matter = store.getMatter(matterId);
		if (!matter) {
			sendError(res, 404, `Matter not found: ${matterId}`);
			return true;
		}
		if (!canAccessMatter(store, actor, matter)) {
			sendError(res, 403, "无权访问该事项");
			return true;
		}
		if (
			!isSuperAdminActor(actor) &&
			!(actor.authKind === "session" && canManageOrganization(store, actor, matter.orgId))
		) {
			sendError(res, 403, "仅所有者或组织管理员可审批并派发 AI 提请");
			return true;
		}
		if (orchestrator.isMatterRunning(matterId)) {
			sendError(res, 409, "Matter already has an active turn");
			return true;
		}
		const targetMsg = store.getMessage(messageId);
		if (!targetMsg || targetMsg.matterId !== matterId) {
			sendError(res, 404, `Message not found: ${messageId}`);
			return true;
		}
		if (!checkUserDispatchQuota(ctx, actor, res)) return true;
		const body = await readJsonBody(req);
		const requesterName =
			typeof targetMsg.metadata?.authorName === "string" && targetMsg.metadata.authorName.trim()
				? targetMsg.metadata.authorName.trim()
				: "同事";
		const hasFileRefs = Array.isArray(targetMsg.metadata?.files) && targetMsg.metadata.files.length > 0;
		const dispatchPrompt = targetMsg.content.trim()
			? `[Owner 已确认同事 ${requesterName} 的 AI 提请并安排执行]\n${targetMsg.content.trim()}`
			: hasFileRefs
				? `请处理同事 ${requesterName} 在上一条 AI 提请中附带的附件。`
				: `请处理同事 ${requesterName} 在上一条 AI 提请中附带的图片。`;
		const explicitApproveMemberId =
			typeof body.preferredMemberId === "string" && body.preferredMemberId.length > 0
				? body.preferredMemberId
				: typeof targetMsg.metadata?.preferredMemberId === "string" &&
						targetMsg.metadata.preferredMemberId.length > 0
					? targetMsg.metadata.preferredMemberId
					: null;
		const fallbackLeadMember = matter.leadMemberId ? store.getMember(matter.leadMemberId) : null;
		const preferredMemberId =
			explicitApproveMemberId ??
			(fallbackLeadMember && canActorUseMember(store, actor, fallbackLeadMember)
				? fallbackLeadMember.id
				: undefined);
		const workspaceId =
			typeof body.workspaceId === "string" && body.workspaceId.length > 0
				? body.workspaceId
				: (matter.workspaceId ?? undefined);
		const observerMemberIds = parseObserverMemberIds(body.observerMemberIds, store);
		const images = await loadStoredImagesFromRefs(targetMsg.metadata?.images, uploadsDir, memoryUploads);
		const files = await loadStoredFilesFromRefs(targetMsg.metadata?.files, uploadsDir, memoryUploads);

		const currentMatter = store.getMatter(matterId)!;
		const currentMessage = store.getMessage(messageId)!;
		const currentWorkspace = currentMatter.workspaceId ? store.getWorkspace(currentMatter.workspaceId) : null;
		const effectiveOrgId = currentWorkspace ? currentWorkspace.orgId : currentMatter.orgId;
		if (workspaceId && !store.getWorkspace(workspaceId)) {
			sendError(res, 404, `Workspace not found: ${workspaceId}`);
			return true;
		}
		if (
			(workspaceId ?? null) !== currentMatter.workspaceId ||
			!messageMatchesContext(currentMessage, {
				workspaceId: currentMatter.workspaceId,
				orgId: effectiveOrgId,
				repoPath: resolve(currentWorkspace?.repoPath ?? orchestrator.getDefaultCwd()),
			})
		) {
			sendError(res, 409, "AI request scope changed; submit a new request in the current organization/workspace");
			return true;
		}
		if (!ensureOrgEnabledAiRequest(res, ctx, actor, effectiveOrgId, preferredMemberId, observerMemberIds)) {
			return true;
		}
		if (
			preferredMemberId &&
			currentMatter.aiMemberIds !== null &&
			!currentMatter.aiMemberIds.includes(preferredMemberId)
		) {
			sendError(res, 409, "Requested AI member is no longer in this matter");
			return true;
		}
		if (
			(Array.isArray(targetMsg.metadata?.images) && images.length !== targetMsg.metadata.images.length) ||
			(Array.isArray(targetMsg.metadata?.files) && files.length !== targetMsg.metadata.files.length)
		) {
			sendError(res, 410, "Request attachments are no longer available; submit the request again");
			return true;
		}
		if (orchestrator.isMatterRunning(matterId)) {
			sendError(res, 409, "Matter already has an active turn");
			return true;
		}
		const updatedMsg = store.transitionAiRequest(messageId, "approved", {
			approvedById: actor.collaborator.id,
			approvedByName: actor.collaborator.name,
			approvedAt: new Date().toISOString(),
		});
		if (!updatedMsg) {
			sendError(res, 409, "Only a pending AI request can be approved");
			return true;
		}
		auditActorAction(ctx, req, actor, {
			action: "matter.approve_ai_request",
			targetType: "matter_message",
			targetId: messageId,
			orgId: currentMatter.orgId,
			detail: { matterId },
		});
		broadcast("matter_message", { matterId, message: updatedMsg, matter: currentMatter }, { matterId });

		runDispatchInBackground(
			{
				matterId: matter.id,
				prompt: dispatchPrompt,
				images: images.length > 0 ? images : undefined,
				files: files.length > 0 ? files : undefined,
				preferredMemberId,
				workspaceId,
				orgId: currentMatter.orgId,
				observerMemberIds,
				startedByUserId: actor.user?.id ?? null,
				author: toDispatchAuthor(actor.collaborator),
			},
			actor,
		);

		sendJson(res, 202, { accepted: true, matterId: matter.id, approvedMessageId: messageId });
		return true;
	}

	const matterDismissAiMatch = pathname.match(/^\/api\/matters\/([^/]+)\/messages\/([^/]+)\/dismiss-ai$/);
	if (method === "POST" && matterDismissAiMatch) {
		if (!requireActiveActor(res, actor)) return true;
		const matterId = decodeURIComponent(matterDismissAiMatch[1]!);
		const messageId = decodeURIComponent(matterDismissAiMatch[2]!);
		const matter = store.getMatter(matterId);
		if (!matter) {
			sendError(res, 404, `Matter not found: ${matterId}`);
			return true;
		}
		if (!canAccessMatter(store, actor, matter)) {
			sendError(res, 403, "无权访问该事项");
			return true;
		}
		if (
			!isSuperAdminActor(actor) &&
			!(actor.authKind === "session" && canManageOrganization(store, actor, matter.orgId))
		) {
			sendError(res, 403, "仅所有者或组织管理员可忽略 AI 提请");
			return true;
		}
		const targetMsg = store.getMessage(messageId);
		if (!targetMsg || targetMsg.matterId !== matterId) {
			sendError(res, 404, `Message not found: ${messageId}`);
			return true;
		}
		const updatedMsg = store.transitionAiRequest(messageId, "dismissed", {
			dismissedById: actor.collaborator.id,
			dismissedByName: actor.collaborator.name,
			dismissedAt: new Date().toISOString(),
		});
		if (!updatedMsg) {
			sendError(res, 409, "Only a pending AI request can be dismissed");
			return true;
		}
		broadcast("matter_message", { matterId, message: updatedMsg, matter }, { matterId });
		sendJson(res, 200, { ok: true, message: updatedMsg });
		return true;
	}

	const matterMsgMatch = pathname.match(/^\/api\/matters\/([^/]+)\/messages(\/conversation)?$/);
	if (method === "POST" && matterMsgMatch) {
		if (!requireActiveActor(res, actor)) return true;
		const matterId = decodeURIComponent(matterMsgMatch[1]!);
		const matter = store.getMatter(matterId);
		if (!matter) {
			sendError(res, 404, `Matter not found: ${matterId}`);
			return true;
		}
		if (!canAccessMatter(store, actor, matter)) {
			sendError(res, 403, "无权访问该事项");
			return true;
		}
		if (!canParticipateInMatter(store, actor, matter)) {
			sendError(res, 403, "只读成员（org_viewer）不能在该事项内发言或触发操作");
			return true;
		}
		if (matter.status === "archived") {
			sendError(res, 409, "该事项已归档，请先恢复为活跃事项后再继续对话");
			return true;
		}
		const body = await readJsonBody(req);
		const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
		const mode =
			matterMsgMatch[2] || body.mode === "conversation"
				? conversationModeForActor(
						ctx,
						actor,
						matter.orgId,
						prompt,
						conversationRecipients(ctx, actor, matter, prompt).humanOnly,
					)
				: body.mode === "discussion" || body.mode === "ai_request"
					? body.mode
					: "dispatch";
		if (mode === "dispatch" && !canDispatchAiInOrg(store, actor, matter.orgId)) {
			sendError(res, 403, "当前账号无权直接向 AI 派发任务，可使用「团队聊天讨论」或「提请 AI 处理」");
			return true;
		}
		const parsedImages = parseIncomingImages(body.images);
		const parsedFiles = parseIncomingFiles(body.files);
		if (!prompt && parsedImages.length === 0 && parsedFiles.length === 0) {
			sendError(res, 400, "prompt, images, or files is required");
			return true;
		}
		const explicitPreferredMemberId =
			typeof body.preferredMemberId === "string" && body.preferredMemberId.length > 0
				? body.preferredMemberId
				: null;
		const leadMember = matter.leadMemberId ? store.getMember(matter.leadMemberId) : null;
		const preferredMemberId =
			explicitPreferredMemberId ??
			(mode === "dispatch" && isExplicitRoleSetupRequest(prompt) ? ROLE_ARCHITECT_MEMBER_ID : undefined) ??
			(mode !== "discussion" && mode !== "conversation" && leadMember && canActorUseMember(store, actor, leadMember)
				? leadMember.id
				: undefined);
		const requestedWorkspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
		if (requestedWorkspaceId && requestedWorkspaceId !== matter.workspaceId) {
			sendError(res, 409, "请先通过事项设置切换工作区，再发送消息");
			return true;
		}
		const workspaceId = matter.workspaceId ?? undefined;
		const observerMemberIds = parseObserverMemberIds(body.observerMemberIds, store);
		if (!ensureOrgEnabledAiRequest(res, ctx, actor, matter.orgId, preferredMemberId, observerMemberIds)) {
			return true;
		}
		if (mode === "dispatch") {
			await settleMatterObserverPass(ctx, matterId);
			if (orchestrator.isMatterRunning(matterId) || ctx.activeRuns.has(matterId)) {
				sendError(res, 409, "Matter already has an active turn");
				return true;
			}
			if (!checkUserDispatchQuota(ctx, actor, res)) return true;
		}
		const images = await persistUploadedImages(parsedImages, uploadsDir, memoryUploads);
		const files = await persistUploadedFiles(parsedFiles, uploadsDir, memoryUploads);
		recordStoredUploadsAcl(store, {
			orgId: matter.orgId,
			matterId: matter.id,
			uploaderUserId: actor.user?.id ?? null,
			images,
			files,
		});

		if (mode !== "dispatch") {
			const { message, refreshedMatter } = appendHumanMessage(ctx, {
				matter,
				actorCollaborator: actor.collaborator,
				mode,
				prompt,
				workspaceId,
				preferredMemberId,
				images,
				files,
			});
			const discussion =
				mode === "ai_request"
					? null
					: await startAiForMessage(
							ctx,
							actor,
							refreshedMatter,
							message,
							images,
							files,
							explicitPreferredMemberId ?? undefined,
						);
			sendJson(res, 201, {
				accepted: discussion?.aiDiscussionTriggered ?? false,
				mode,
				message,
				matter: refreshedMatter,
				...discussion,
			});
			return true;
		}

		runDispatchInBackground(
			{
				matterId: matter.id,
				prompt,
				images: images.length > 0 ? images : undefined,
				files: files.length > 0 ? files : undefined,
				preferredMemberId,
				workspaceId,
				orgId: matter.orgId,
				observerMemberIds,
				startedByUserId: actor.user?.id ?? null,
				author: toDispatchAuthor(actor.collaborator),
			},
			actor,
		);

		sendJson(res, 202, { accepted: true, matterId: matter.id, mode });
		return true;
	}

	return false;
}
