import { resolve } from "node:path";
import { messageMatchesContext } from "../../orchestrator/matter-context.ts";
import type { PromptImageAttachment } from "../../orchestrator/team-orchestrator.ts";
import type { RpcExtensionUIResponsePayload } from "../../rpc/types.ts";
import type { Collaborator, DeliverableType, Matter } from "../../storage/types.ts";
import { requireOwner, toDispatchAuthor } from "../auth.ts";
import { readJsonBody, sendError, sendJson } from "../http.ts";
import { loadStoredImagesFromRefs, parseIncomingImages, persistUploadedImages } from "../uploads.ts";
import { parseCollaboratorIds, parseObserverMemberIds, type RouteRequest, type ServerRouteContext } from "./context.ts";

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
	},
) {
	const { store, orchestrator, broadcast } = ctx;
	const boundWorkspace = input.workspaceId ? store.getWorkspace(input.workspaceId) : null;
	const imageMetadataRefs = input.images.map((item, idx) => ({
		...(item.url ? { url: item.url } : {}),
		mimeType: item.mimeType,
		name: item.name || `image-${idx + 1}`,
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
		},
	});
	const refreshedMatter = store.getMatter(input.matter.id) ?? input.matter;
	broadcast("matter_message", { matterId: refreshedMatter.id, message, matter: refreshedMatter });
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
		if (!requireOwner(res, actor)) return true;
		const matterId = decodeURIComponent(matterAbortMatch[1]!);
		if (!store.getMatter(matterId)) {
			sendError(res, 404, `Matter not found: ${matterId}`);
			return true;
		}
		dialogBroker.cancelForMatter(matterId);
		const aborted = await orchestrator.abortMatter(matterId);
		broadcast("matter_aborted", { matterId, aborted });
		sendJson(res, 200, { ok: true, aborted });
		return true;
	}

	if (method === "PATCH" && matterDetailMatch) {
		if (!requireOwner(res, actor)) return true;
		const matterId = decodeURIComponent(matterDetailMatch[1]!);
		const existing = store.getMatter(matterId);
		if (!existing) {
			sendError(res, 404, `Matter not found: ${matterId}`);
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
		const workspaceId =
			typeof body.workspaceId === "string" && body.workspaceId.trim().length > 0 ? body.workspaceId.trim() : null;
		if (hasWorkspaceUpdate && workspaceId && !store.getWorkspace(workspaceId)) {
			sendError(res, 404, `Workspace not found: ${workspaceId}`);
			return true;
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
		let updated = existing;
		if (hasOrgUpdate) {
			updated = store.updateMatterOrganization(matterId, nextOrgId);
			broadcast("matter_updated", { matterId, orgId: updated.orgId, workspaceId: updated.workspaceId });
		}
		if (hasWorkspaceUpdate) {
			updated = store.updateMatterWorkspace(matterId, workspaceId);
			broadcast("workspace_updated", { matterId, workspaceId, orgId: updated.orgId });
		}
		if (hasAiMembersUpdate && parsedAiMemberIds !== undefined) {
			updated = store.updateMatterAiMembers(matterId, parsedAiMemberIds);
			broadcast("matter_updated", {
				matterId,
				aiMemberIds: updated.aiMemberIds,
				observerMemberIds: updated.observerMemberIds,
			});
		}
		if (hasLeadUpdate && nextLeadId) {
			updated = store.updateMatterLead(matterId, nextLeadId);
			broadcast("matter_updated", {
				matterId,
				leadMemberId: updated.leadMemberId,
				aiMemberIds: updated.aiMemberIds,
				observerMemberIds: updated.observerMemberIds,
			});
		}
		if (hasObserversEnabledUpdate) {
			updated = store.updateMatterObserversEnabled(matterId, Boolean(body.observersEnabled));
			broadcast("matter_updated", {
				matterId,
				observersEnabled: updated.observersEnabled,
				observerMemberIds: updated.observerMemberIds,
			});
		}
		if (observerMemberIds !== undefined) {
			updated = store.updateMatterObservers(matterId, observerMemberIds);
			broadcast("matter_updated", {
				matterId,
				observersEnabled: updated.observersEnabled,
				observerMemberIds: updated.observerMemberIds,
			});
		}
		if (collaboratorIds !== undefined) {
			updated = store.updateMatterCollaborators(matterId, collaboratorIds);
			broadcast("matter_updated", { matterId, collaboratorIds: updated.collaboratorIds });
		}
		sendJson(res, 200, { matter: updated });
		return true;
	}

	if (method === "POST" && pathname === "/api/matters/assess") {
		const body = await readJsonBody(req);
		const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
		const workspaceId =
			typeof body.workspaceId === "string" && body.workspaceId.trim().length > 0 ? body.workspaceId.trim() : null;
		const preferredMemberId =
			typeof body.preferredMemberId === "string" && body.preferredMemberId.trim().length > 0
				? body.preferredMemberId.trim()
				: undefined;
		if (workspaceId && !store.getWorkspace(workspaceId)) {
			sendError(res, 404, `Workspace not found: ${workspaceId}`);
			return true;
		}
		if (preferredMemberId && !store.getMember(preferredMemberId)) {
			sendError(res, 404, `Member not found: ${preferredMemberId}`);
			return true;
		}
		const assessment = orchestrator.assessInitiation({
			prompt,
			hasImages: body.hasImages === true,
			hasWorkspace: Boolean(workspaceId),
			preferredMemberId,
		});
		sendJson(res, 200, assessment);
		return true;
	}

	if (method === "POST" && pathname === "/api/matters") {
		const body = await readJsonBody(req);
		const mode = body.mode === "discussion" ? "discussion" : body.mode === "ai_request" ? "ai_request" : "dispatch";
		if (mode === "dispatch" && !requireOwner(res, actor)) return true;
		const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
		const parsedImages = parseIncomingImages(body.images);
		if (!prompt && parsedImages.length === 0) {
			sendError(res, 400, "prompt or images is required");
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
			: hasExplicitOrg
				? requestedOrgId
				: (store.getDefaultOrganization()?.id ?? null);
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
		const initialCollaboratorIds =
			actor!.collaborator.permissionRole !== "owner" && !requestedCollaboratorIds.includes(actor!.collaborator.id)
				? [...requestedCollaboratorIds, actor!.collaborator.id]
				: requestedCollaboratorIds;
		const images = await persistUploadedImages(parsedImages, uploadsDir, memoryUploads);

		const leadMember = orchestrator.routeMemberForRequest(prompt, preferredMemberId, aiMemberIds);
		const fallbackTitle = prompt
			? prompt.slice(0, 60)
			: images.length === 1
				? `图片：${images[0]?.name ?? "上传图片"}`.slice(0, 60)
				: `上传了 ${images.length} 张图片`;
		const matter = store.createMatter({
			title: title ?? fallbackTitle,
			leadMemberId: leadMember.id,
			workspaceId: workspaceId ?? null,
			orgId,
			aiMemberIds,
			observersEnabled,
			observerMemberIds,
			collaboratorIds: initialCollaboratorIds,
		});

		if (mode === "discussion" || mode === "ai_request") {
			const { message, refreshedMatter } = appendDiscussionOrAiRequestMessage(ctx, {
				matter,
				actorCollaborator: actor!.collaborator,
				mode,
				prompt,
				workspaceId,
				preferredMemberId,
				images,
			});
			sendJson(res, 201, { matter: refreshedMatter, message, assignedMember: leadMember });
			return true;
		}

		runDispatchInBackground({
			matterId: matter.id,
			title,
			prompt,
			images: images.length > 0 ? images : undefined,
			preferredMemberId: leadMember.id,
			workspaceId,
			observerMemberIds: matter.observerMemberIds,
			deliverableTitle,
			deliverableType,
			author: toDispatchAuthor(actor!.collaborator),
		});

		sendJson(res, 202, { matter, assignedMember: leadMember });
		return true;
	}

	const matterApproveAiMatch = pathname.match(/^\/api\/matters\/([^/]+)\/messages\/([^/]+)\/approve-ai$/);
	if (method === "POST" && matterApproveAiMatch) {
		if (!requireOwner(res, actor)) return true;
		const matterId = decodeURIComponent(matterApproveAiMatch[1]!);
		const messageId = decodeURIComponent(matterApproveAiMatch[2]!);
		const matter = store.getMatter(matterId);
		if (!matter) {
			sendError(res, 404, `Matter not found: ${matterId}`);
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
		const body = await readJsonBody(req);
		const requesterName =
			typeof targetMsg.metadata?.authorName === "string" && targetMsg.metadata.authorName.trim()
				? targetMsg.metadata.authorName.trim()
				: "同事";
		const dispatchPrompt = targetMsg.content.trim()
			? `[Owner 已确认同事 ${requesterName} 的 AI 提请并安排执行]\n${targetMsg.content.trim()}`
			: `请处理同事 ${requesterName} 在上一条 AI 提请中附带的图片。`;
		const preferredMemberId =
			typeof body.preferredMemberId === "string" && body.preferredMemberId.length > 0
				? body.preferredMemberId
				: typeof targetMsg.metadata?.preferredMemberId === "string" &&
						targetMsg.metadata.preferredMemberId.length > 0
					? targetMsg.metadata.preferredMemberId
					: (matter.leadMemberId ?? undefined);
		const workspaceId =
			typeof body.workspaceId === "string" && body.workspaceId.length > 0
				? body.workspaceId
				: (matter.workspaceId ?? undefined);
		const observerMemberIds = parseObserverMemberIds(body.observerMemberIds, store);
		const images = await loadStoredImagesFromRefs(targetMsg.metadata?.images, uploadsDir, memoryUploads);

		// Validate all asynchronous inputs before claiming the request. No awaits between claim and dispatch.
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
		if (preferredMemberId && !store.getMember(preferredMemberId)) {
			sendError(res, 404, `Member not found: ${preferredMemberId}`);
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
		if (Array.isArray(targetMsg.metadata?.images) && images.length !== targetMsg.metadata.images.length) {
			sendError(res, 410, "Request attachments are no longer available; submit the request again");
			return true;
		}
		if (orchestrator.isMatterRunning(matterId)) {
			sendError(res, 409, "Matter already has an active turn");
			return true;
		}
		const updatedMsg = store.transitionAiRequest(messageId, "approved", {
			approvedById: actor!.collaborator.id,
			approvedByName: actor!.collaborator.name,
			approvedAt: new Date().toISOString(),
		});
		if (!updatedMsg) {
			sendError(res, 409, "Only a pending AI request can be approved");
			return true;
		}
		broadcast("matter_message", { matterId, message: updatedMsg, matter: currentMatter });

		runDispatchInBackground({
			matterId: matter.id,
			prompt: dispatchPrompt,
			images: images.length > 0 ? images : undefined,
			preferredMemberId,
			workspaceId,
			observerMemberIds,
			author: toDispatchAuthor(actor!.collaborator),
		});

		sendJson(res, 202, { accepted: true, matterId: matter.id, approvedMessageId: messageId });
		return true;
	}

	const matterDismissAiMatch = pathname.match(/^\/api\/matters\/([^/]+)\/messages\/([^/]+)\/dismiss-ai$/);
	if (method === "POST" && matterDismissAiMatch) {
		if (!requireOwner(res, actor)) return true;
		const matterId = decodeURIComponent(matterDismissAiMatch[1]!);
		const messageId = decodeURIComponent(matterDismissAiMatch[2]!);
		const matter = store.getMatter(matterId);
		if (!matter) {
			sendError(res, 404, `Matter not found: ${matterId}`);
			return true;
		}
		const targetMsg = store.getMessage(messageId);
		if (!targetMsg || targetMsg.matterId !== matterId) {
			sendError(res, 404, `Message not found: ${messageId}`);
			return true;
		}
		const updatedMsg = store.transitionAiRequest(messageId, "dismissed", {
			dismissedById: actor!.collaborator.id,
			dismissedByName: actor!.collaborator.name,
			dismissedAt: new Date().toISOString(),
		});
		if (!updatedMsg) {
			sendError(res, 409, "Only a pending AI request can be dismissed");
			return true;
		}
		broadcast("matter_message", { matterId, message: updatedMsg, matter });
		sendJson(res, 200, { ok: true, message: updatedMsg });
		return true;
	}

	const matterMsgMatch = pathname.match(/^\/api\/matters\/([^/]+)\/messages$/);
	if (method === "POST" && matterMsgMatch) {
		const matterId = decodeURIComponent(matterMsgMatch[1]!);
		const matter = store.getMatter(matterId);
		if (!matter) {
			sendError(res, 404, `Matter not found: ${matterId}`);
			return true;
		}
		const body = await readJsonBody(req);
		const mode = body.mode === "discussion" ? "discussion" : body.mode === "ai_request" ? "ai_request" : "dispatch";
		if (mode === "dispatch" && !requireOwner(res, actor)) return true;
		if (mode === "dispatch" && orchestrator.isMatterRunning(matterId)) {
			sendError(res, 409, "Matter already has an active turn");
			return true;
		}
		const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
		const parsedImages = parseIncomingImages(body.images);
		if (!prompt && parsedImages.length === 0) {
			sendError(res, 400, "prompt or images is required");
			return true;
		}
		const preferredMemberId =
			typeof body.preferredMemberId === "string" && body.preferredMemberId.length > 0
				? body.preferredMemberId
				: (matter.leadMemberId ?? undefined);
		const workspaceId =
			typeof body.workspaceId === "string" && body.workspaceId.length > 0
				? body.workspaceId
				: (matter.workspaceId ?? undefined);
		const deliverableTitle =
			typeof body.deliverableTitle === "string" && body.deliverableTitle.trim().length > 0
				? body.deliverableTitle.trim()
				: undefined;
		const observerMemberIds = parseObserverMemberIds(body.observerMemberIds, store);
		const images = await persistUploadedImages(parsedImages, uploadsDir, memoryUploads);

		if (mode === "discussion" || mode === "ai_request") {
			if (actor!.collaborator.permissionRole !== "owner") {
				store.addMatterCollaborator(matterId, actor!.collaborator.id);
			}
			const { message, refreshedMatter } = appendDiscussionOrAiRequestMessage(ctx, {
				matter,
				actorCollaborator: actor!.collaborator,
				mode,
				prompt,
				workspaceId,
				preferredMemberId,
				images,
			});
			sendJson(res, 201, { accepted: false, mode, message, matter: refreshedMatter });
			return true;
		}

		runDispatchInBackground({
			matterId: matter.id,
			prompt,
			images: images.length > 0 ? images : undefined,
			preferredMemberId,
			workspaceId,
			observerMemberIds,
			deliverableTitle,
			author: toDispatchAuthor(actor!.collaborator),
		});

		sendJson(res, 202, { accepted: true, matterId: matter.id });
		return true;
	}

	const dialogMatch = pathname.match(/^\/api\/dialogs\/([^/]+)\/respond$/);
	if (method === "POST" && dialogMatch) {
		if (!requireOwner(res, actor)) return true;
		const dialogId = decodeURIComponent(dialogMatch[1]!);
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
