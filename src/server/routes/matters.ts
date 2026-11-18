import type { ServerResponse } from "node:http";
import { resolve } from "node:path";
import { messageMatchesContext } from "../../orchestrator/matter-context.ts";
import { PiDecisionError } from "../../orchestrator/pi-decision.ts";
import type { PromptFileAttachment, PromptImageAttachment } from "../../orchestrator/team-orchestrator.ts";
import { ROLE_ARCHITECT_MEMBER_ID } from "../../roles/role-architect.ts";
import type { RpcExtensionUIResponsePayload } from "../../rpc/types.ts";
import type { Collaborator, DeliverableType, Matter, MatterVisibility } from "../../storage/types.ts";
import {
	canAccessMatter,
	canAccessOrganization,
	canAccessWorkspace,
	canActorUseMember,
	canDispatchAiInOrg,
	canManageOrganization,
	canParticipateInMatter,
	isGlobalUnscopedActor,
	requireMatterReadAccess,
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

function countActiveDispatchesForUser(ctx: ServerRouteContext, userId: string): number {
	let count = 0;
	for (const run of ctx.activeRuns.values()) {
		if (run.startedByUserId === userId) count += 1;
	}
	return count;
}

function ensureActorAllowedMembers(
	res: ServerResponse,
	ctx: ServerRouteContext,
	actor: RequestActor,
	memberIds: Array<string | null | undefined>,
): boolean {
	for (const memberId of memberIds) {
		if (!memberId) continue;
		const member = ctx.store.getMember(memberId);
		if (!member) {
			sendError(res, 404, `Member not found: ${memberId}`);
			return false;
		}
		if (!canActorUseMember(ctx.store, actor, member)) {
			sendError(res, 403, `无权使用或指定该 AI 角色: ${memberId}`);
			return false;
		}
	}
	return true;
}

function ensureOrgEnabledAiRequest(
	res: ServerResponse,
	ctx: ServerRouteContext,
	actor: RequestActor,
	orgId: string | null,
	preferredMemberId: string | null | undefined,
	aiMemberIds: string[] | null | undefined,
): boolean {
	if (
		!ensureActorAllowedMembers(res, ctx, actor, [
			preferredMemberId,
			...(Array.isArray(aiMemberIds) ? aiMemberIds : []),
		])
	) {
		return false;
	}
	if (!orgId) return true;
	const allowed = new Set(ctx.store.resolveEffectiveOrgMembersForUser(orgId, actor.user?.id).map((m) => m.id));
	if (preferredMemberId && preferredMemberId !== ROLE_ARCHITECT_MEMBER_ID && !allowed.has(preferredMemberId)) {
		sendError(res, 403, `角色 ${preferredMemberId} 未在该组织中启用`);
		return false;
	}
	if (Array.isArray(aiMemberIds) && aiMemberIds.some((id) => id !== ROLE_ARCHITECT_MEMBER_ID && !allowed.has(id))) {
		sendError(res, 403, "包含未在该组织中启用的 AI 角色");
		return false;
	}
	return true;
}

function checkUserDispatchQuota(ctx: ServerRouteContext, actor: RequestActor, res: { end: unknown }): boolean {
	if (!actor.user || isSuperAdminActor(actor)) return true;
	const activeCount = countActiveDispatchesForUser(ctx, actor.user.id);
	if (activeCount >= actor.user.maxActiveDispatches) {
		sendError(
			res as Parameters<typeof sendError>[0],
			429,
			`当前并发执行中的 AI 任务已达上限（${actor.user.maxActiveDispatches} 个），请等待完成或中止后再试`,
		);
		return false;
	}
	return true;
}

function resolveActorDefaultOrgId(ctx: ServerRouteContext, actor: RequestActor): string | null {
	if (actor.authKind === "session" && actor.user) {
		const orgs = ctx.store.listUserOrganizations(actor.user.id);
		return orgs.find((o) => o.isDefault)?.id ?? orgs[0]?.id ?? null;
	}
	return ctx.store.getDefaultOrganization()?.id ?? null;
}

function appendDiscussionOrAiRequestMessage(
	ctx: ServerRouteContext,
	input: {
		matter: Matter;
		actorCollaborator: Collaborator;
		mode: "discussion" | "ai_request";
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

/** Handle `/api/matters*` and `/api/dialogs/:id/respond` endpoints. */
export async function handleMatterRoutes(ctx: ServerRouteContext, r: RouteRequest): Promise<boolean> {
	const {
		store,
		orchestrator,
		dialogBroker,
		uploadsDir,
		memoryUploads,
		activeRuns,
		broadcast,
		runDispatchInBackground,
	} = ctx;
	const { req, res, method, pathname, actor } = r;

	const matterDetailMatch = pathname.match(/^\/api\/matters\/([^/]+)$/);
	if (method === "GET" && matterDetailMatch) {
		const matterId = decodeURIComponent(matterDetailMatch[1]!);
		const matter = store.getMatter(matterId);
		if (!matter) {
			sendError(res, 404, `Matter not found: ${matterId}`);
			return true;
		}
		if (!requireMatterReadAccess(res, store, actor, matter)) return true;
		const active = activeRuns.get(matterId);
		sendJson(res, 200, {
			matter,
			demoGuide: ctx.innerMatterDemo?.guideFor(matter),
			userMessages: store.listMessages(matterId, "user"),
			internalCollabMessages: store.listMessages(matterId, "internal_collab"),
			noticeMessages: store.listMessages(matterId, "notice"),
			deliverables: store.listDeliverables(matterId),
			pendingDialogs: dialogBroker.listPending(matterId),
			activeRun: active
				? {
						...active.progress,
						matterId,
						startedAt: active.startedAt,
						streamingDelta: active.accumulatedDelta,
					}
				: null,
		});
		return true;
	}

	const matterAbortMatch = pathname.match(/^\/api\/matters\/([^/]+)\/abort$/);
	if (method === "POST" && matterAbortMatch) {
		if (!requireActiveActor(res, actor)) return true;
		const matterId = decodeURIComponent(matterAbortMatch[1]!);
		const existing = store.getMatter(matterId);
		if (!existing) {
			sendError(res, 404, `Matter not found: ${matterId}`);
			return true;
		}
		const canAbort =
			isSuperAdminActor(actor) ||
			canManageOrganization(store, actor, existing.orgId) ||
			(actor.authKind === "session" && actor.user && existing.createdByUserId === actor.user.id);
		if (!canAbort) {
			sendError(res, 403, "仅所有者、组织管理员或事项发起人可中止执行");
			return true;
		}
		dialogBroker.cancelForMatter(matterId);
		const aborted = await orchestrator.abortMatter(matterId);
		auditActorAction(ctx, req, actor, {
			action: "matter.abort",
			targetType: "matter",
			targetId: matterId,
			orgId: existing.orgId,
			detail: { aborted },
		});
		broadcast("matter_aborted", { matterId, aborted }, { matterId });
		sendJson(res, 200, { ok: true, aborted });
		return true;
	}

	if (method === "PATCH" && matterDetailMatch) {
		if (!requireActiveActor(res, actor)) return true;
		const matterId = decodeURIComponent(matterDetailMatch[1]!);
		const existing = store.getMatter(matterId);
		if (!existing) {
			sendError(res, 404, `Matter not found: ${matterId}`);
			return true;
		}
		if (!canAccessMatter(store, actor, existing)) {
			sendError(res, 403, "无权访问该事项");
			return true;
		}
		const canModifyMatter =
			isGlobalUnscopedActor(actor) ||
			isSuperAdminActor(actor) ||
			canManageOrganization(store, actor, existing.orgId) ||
			(actor.authKind === "session" && actor.user && existing.createdByUserId === actor.user.id);
		if (!canModifyMatter) {
			sendError(res, 403, "仅所有者、组织管理员或事项发起人可修改事项配置");
			return true;
		}
		const body = await readJsonBody(req);
		const hasWorkspaceUpdate = Object.hasOwn(body, "workspaceId");
		const hasOrgUpdate = Object.hasOwn(body, "orgId");
		const hasLeadUpdate = Object.hasOwn(body, "leadMemberId");
		const hasAiMembersUpdate = Object.hasOwn(body, "aiMemberIds");
		const hasObserversEnabledUpdate = Object.hasOwn(body, "observersEnabled");
		const hasObserverUpdate = Object.hasOwn(body, "observerMemberIds");
		const hasCollaboratorUpdate = Object.hasOwn(body, "collaboratorIds");
		const hasVisibilityUpdate = Object.hasOwn(body, "visibility");
		const workspaceId =
			typeof body.workspaceId === "string" && body.workspaceId.trim().length > 0 ? body.workspaceId.trim() : null;
		const targetWorkspace = hasWorkspaceUpdate && workspaceId ? store.getWorkspace(workspaceId) : null;
		if (hasWorkspaceUpdate && workspaceId) {
			if (!targetWorkspace) {
				sendError(res, 404, `Workspace not found: ${workspaceId}`);
				return true;
			}
			if (!canAccessWorkspace(store, actor, targetWorkspace)) {
				sendError(res, 403, "无权将事项切换到未授权的项目仓库");
				return true;
			}
		}
		const nextOrgId =
			body.orgId === null
				? null
				: typeof body.orgId === "string" && body.orgId.trim().length > 0
					? body.orgId.trim()
					: null;
		if (hasOrgUpdate && body.orgId !== null && typeof body.orgId !== "string") {
			sendError(res, 400, "orgId must be a string or null");
			return true;
		}
		if (hasOrgUpdate && nextOrgId && !store.getOrganization(nextOrgId)) {
			sendError(res, 404, `Organization not found: ${nextOrgId}`);
			return true;
		}
		if (hasOrgUpdate && nextOrgId && !canAccessOrganization(store, actor, nextOrgId)) {
			sendError(res, 403, "无权将事项转移到未加入的组织");
			return true;
		}
		const nextLeadId =
			typeof body.leadMemberId === "string" && body.leadMemberId.trim().length > 0 ? body.leadMemberId.trim() : null;
		if (hasLeadUpdate && (!nextLeadId || !store.getMember(nextLeadId))) {
			sendError(
				res,
				nextLeadId ? 404 : 400,
				nextLeadId ? `Member not found: ${nextLeadId}` : "leadMemberId is invalid",
			);
			return true;
		}
		const parsedAiMemberIds =
			hasAiMembersUpdate && body.aiMemberIds === null
				? null
				: hasAiMembersUpdate
					? parseObserverMemberIds(body.aiMemberIds, store)
					: undefined;
		if (hasAiMembersUpdate && parsedAiMemberIds === undefined) {
			sendError(res, 400, "aiMemberIds must be null or an array of member IDs");
			return true;
		}
		if (hasAiMembersUpdate && Array.isArray(parsedAiMemberIds) && parsedAiMemberIds.length === 0) {
			sendError(res, 400, "At least one AI member must remain in the matter");
			return true;
		}
		if (hasObserversEnabledUpdate && typeof body.observersEnabled !== "boolean") {
			sendError(res, 400, "observersEnabled must be a boolean");
			return true;
		}
		const observerMemberIds = hasObserverUpdate ? parseObserverMemberIds(body.observerMemberIds, store) : undefined;
		if (hasObserverUpdate && !observerMemberIds) {
			sendError(res, 400, "observerMemberIds must be an array of member IDs");
			return true;
		}
		const collaboratorIds = hasCollaboratorUpdate ? parseCollaboratorIds(body.collaboratorIds, store) : undefined;
		if (hasCollaboratorUpdate && !collaboratorIds) {
			sendError(res, 400, "collaboratorIds must be an array of collaborator IDs");
			return true;
		}
		if ((hasWorkspaceUpdate || hasOrgUpdate || hasLeadUpdate) && orchestrator.isMatterRunning(matterId)) {
			sendError(res, 409, "Stop the active turn before switching workspaces, organizations, or lead member");
			return true;
		}
		const rosterOrgId = targetWorkspace ? targetWorkspace.orgId : hasOrgUpdate ? nextOrgId : existing.orgId;
		if (
			!ensureOrgEnabledAiRequest(res, ctx, actor, rosterOrgId, nextLeadId, [
				...(parsedAiMemberIds ?? []),
				...(observerMemberIds ?? []),
			])
		) {
			return true;
		}
		let updated = existing;
		if (hasOrgUpdate) {
			updated = store.updateMatterOrganization(matterId, nextOrgId);
			broadcast(
				"matter_updated",
				{ matterId, orgId: updated.orgId, workspaceId: updated.workspaceId },
				{ matterId },
			);
		}
		if (hasWorkspaceUpdate) {
			updated = store.updateMatterWorkspace(matterId, workspaceId);
			broadcast("workspace_updated", { matterId, workspaceId, orgId: updated.orgId }, { matterId });
		}
		if (hasAiMembersUpdate && parsedAiMemberIds !== undefined) {
			updated = store.updateMatterAiMembers(matterId, parsedAiMemberIds);
			broadcast(
				"matter_updated",
				{
					matterId,
					aiMemberIds: updated.aiMemberIds,
					observerMemberIds: updated.observerMemberIds,
				},
				{ matterId },
			);
		}
		if (hasLeadUpdate && nextLeadId) {
			updated = store.updateMatterLead(matterId, nextLeadId);
			broadcast(
				"matter_updated",
				{
					matterId,
					leadMemberId: updated.leadMemberId,
					aiMemberIds: updated.aiMemberIds,
					observerMemberIds: updated.observerMemberIds,
				},
				{ matterId },
			);
		}
		if (hasObserversEnabledUpdate) {
			updated = store.updateMatterObserversEnabled(matterId, Boolean(body.observersEnabled));
			broadcast(
				"matter_updated",
				{
					matterId,
					observersEnabled: updated.observersEnabled,
					observerMemberIds: updated.observerMemberIds,
				},
				{ matterId },
			);
		}
		if (observerMemberIds !== undefined) {
			updated = store.updateMatterObservers(matterId, observerMemberIds);
			broadcast(
				"matter_updated",
				{
					matterId,
					observersEnabled: updated.observersEnabled,
					observerMemberIds: updated.observerMemberIds,
				},
				{ matterId },
			);
		}
		if (collaboratorIds !== undefined) {
			updated = store.updateMatterCollaborators(matterId, collaboratorIds);
			broadcast("matter_updated", { matterId, collaboratorIds: updated.collaboratorIds }, { matterId });
		}
		if (hasVisibilityUpdate) {
			const visibility: MatterVisibility = body.visibility === "private" ? "private" : "org";
			updated = store.updateMatterVisibility(matterId, visibility);
			broadcast("matter_updated", { matterId, visibility }, { matterId });
		}
		sendJson(res, 200, { matter: updated });
		return true;
	}

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

	if (method === "POST" && pathname === "/api/matters") {
		if (!requireActiveActor(res, actor)) return true;
		const body = await readJsonBody(req);
		const mode = body.mode === "discussion" ? "discussion" : body.mode === "ai_request" ? "ai_request" : "dispatch";
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
		const deliverableTitle =
			typeof body.deliverableTitle === "string" && body.deliverableTitle.trim().length > 0
				? body.deliverableTitle.trim()
				: undefined;
		const deliverableType =
			typeof body.deliverableType === "string" ? (body.deliverableType as DeliverableType) : undefined;
		const aiMemberIds = Object.hasOwn(body, "aiMemberIds")
			? body.aiMemberIds === null
				? null
				: parseObserverMemberIds(body.aiMemberIds, store)
			: undefined;
		const observersEnabled = typeof body.observersEnabled === "boolean" ? body.observersEnabled : undefined;
		const observerMemberIds = parseObserverMemberIds(body.observerMemberIds, store);
		const requestedCollaboratorIds = parseCollaboratorIds(body.collaboratorIds, store) ?? [];
		const initialCollaboratorIds = [...requestedCollaboratorIds];
		if (actor.authKind === "legacy_token" && actor.collaborator.permissionRole !== "owner") {
			if (!initialCollaboratorIds.includes(actor.collaborator.id)) {
				initialCollaboratorIds.push(actor.collaborator.id);
			}
		}
		const visibility: MatterVisibility = body.visibility === "private" ? "private" : "org";
		if (
			!ensureOrgEnabledAiRequest(res, ctx, actor, orgId, preferredMemberId, [
				...(aiMemberIds ?? []),
				...(observerMemberIds ?? []),
			])
		) {
			return true;
		}
		const images = await persistUploadedImages(parsedImages, uploadsDir, memoryUploads);
		const files = await persistUploadedFiles(parsedFiles, uploadsDir, memoryUploads);

		const leadMember = orchestrator.routeMemberForRequest(prompt, preferredMemberId, aiMemberIds, orgId, {
			actorUserId: actor.user?.id ?? null,
		});
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
			leadMemberId: leadMember.id,
			workspaceId: workspaceId ?? null,
			orgId,
			createdByUserId: actor.user?.id ?? null,
			visibility,
			aiMemberIds,
			observersEnabled,
			observerMemberIds,
			collaboratorIds: initialCollaboratorIds,
		});
		recordStoredUploadsAcl(store, {
			orgId: matter.orgId,
			matterId: matter.id,
			uploaderUserId: actor.user?.id ?? null,
			images,
			files,
		});

		if (mode === "discussion" || mode === "ai_request") {
			const { message, refreshedMatter } = appendDiscussionOrAiRequestMessage(ctx, {
				matter,
				actorCollaborator: actor.collaborator,
				mode,
				prompt,
				workspaceId,
				preferredMemberId,
				images,
				files,
			});
			sendJson(res, 201, { matter: refreshedMatter, message, assignedMember: leadMember });
			return true;
		}

		runDispatchInBackground({
			matterId: matter.id,
			title,
			prompt,
			images: images.length > 0 ? images : undefined,
			files: files.length > 0 ? files : undefined,
			preferredMemberId: leadMember.id,
			workspaceId,
			orgId: matter.orgId,
			observerMemberIds: matter.observerMemberIds,
			deliverableTitle,
			deliverableType,
			startedByUserId: actor.user?.id ?? null,
			author: toDispatchAuthor(actor.collaborator),
		});

		sendJson(res, 202, { matter, assignedMember: leadMember });
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

		runDispatchInBackground({
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
		});

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

	const matterMsgMatch = pathname.match(/^\/api\/matters\/([^/]+)\/messages$/);
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
		const body = await readJsonBody(req);
		const mode = body.mode === "discussion" ? "discussion" : body.mode === "ai_request" ? "ai_request" : "dispatch";
		if (mode === "dispatch") {
			if (!canDispatchAiInOrg(store, actor, matter.orgId)) {
				sendError(res, 403, "当前账号无权直接向 AI 派发任务，可使用「团队聊天讨论」或「提请 AI 处理」");
				return true;
			}
			if (orchestrator.isMatterRunning(matterId)) {
				sendError(res, 409, "Matter already has an active turn");
				return true;
			}
			if (!checkUserDispatchQuota(ctx, actor, res)) return true;
		}
		const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
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
			(leadMember && canActorUseMember(store, actor, leadMember) ? leadMember.id : undefined);
		const requestedWorkspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
		if (requestedWorkspaceId && requestedWorkspaceId !== matter.workspaceId) {
			sendError(res, 409, "请先通过事项设置切换工作区，再发送消息");
			return true;
		}
		const workspaceId = matter.workspaceId ?? undefined;
		const deliverableTitle =
			typeof body.deliverableTitle === "string" && body.deliverableTitle.trim().length > 0
				? body.deliverableTitle.trim()
				: undefined;
		const observerMemberIds = parseObserverMemberIds(body.observerMemberIds, store);
		if (!ensureOrgEnabledAiRequest(res, ctx, actor, matter.orgId, preferredMemberId, observerMemberIds)) {
			return true;
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

		if (mode === "discussion" || mode === "ai_request") {
			// Legacy LAN guest discussion may record guest collaborator ID on non-private shared matters,
			// but never auto-grants access to private matters.
			if (
				actor.authKind === "legacy_token" &&
				actor.collaborator.permissionRole !== "owner" &&
				matter.visibility !== "private"
			) {
				store.addMatterCollaborator(matterId, actor.collaborator.id);
			}
			const { message, refreshedMatter } = appendDiscussionOrAiRequestMessage(ctx, {
				matter,
				actorCollaborator: actor.collaborator,
				mode,
				prompt,
				workspaceId,
				preferredMemberId,
				images,
				files,
			});
			sendJson(res, 201, { accepted: false, mode, message, matter: refreshedMatter });
			return true;
		}

		runDispatchInBackground({
			matterId: matter.id,
			prompt,
			images: images.length > 0 ? images : undefined,
			files: files.length > 0 ? files : undefined,
			preferredMemberId,
			workspaceId,
			orgId: matter.orgId,
			observerMemberIds,
			deliverableTitle,
			startedByUserId: actor.user?.id ?? null,
			author: toDispatchAuthor(actor.collaborator),
		});

		sendJson(res, 202, { accepted: true, matterId: matter.id });
		return true;
	}

	const dialogMatch = pathname.match(/^\/api\/dialogs\/([^/]+)\/respond$/);
	if (method === "POST" && dialogMatch) {
		if (!requireActiveActor(res, actor)) return true;
		const dialogId = decodeURIComponent(dialogMatch[1]!);
		const pending = dialogBroker.listPending().find((d) => d.id === dialogId);
		const matter = pending ? store.getMatter(pending.matterId) : null;
		const canRespond =
			isSuperAdminActor(actor) ||
			(matter &&
				canAccessMatter(store, actor, matter) &&
				(canManageOrganization(store, actor, matter.orgId) ||
					(actor.authKind === "session" && actor.user && matter.createdByUserId === actor.user.id)));
		if (!canRespond) {
			sendError(res, 403, "无权确认该交互弹窗");
			return true;
		}
		const body = await readJsonBody(req);
		let payload: RpcExtensionUIResponsePayload;
		if (body.cancelled === true) {
			payload = { cancelled: true };
		} else if (typeof body.confirmed === "boolean") {
			payload = { confirmed: body.confirmed };
		} else if (typeof body.value === "string") {
			payload = { value: body.value };
		} else {
			sendError(res, 400, "Expected confirmed, value, or cancelled");
			return true;
		}

		const matched = dialogBroker.respond(dialogId, payload);
		if (!matched) {
			sendError(res, 404, `Pending dialog not found: ${dialogId}`);
			return true;
		}
		sendJson(res, 200, { ok: true, dialogId });
		return true;
	}

	return false;
}
