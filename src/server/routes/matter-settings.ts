import type { MatterVisibility } from "../../storage/types.ts";
import {
	canAccessMatter,
	canAccessOrganization,
	canAccessWorkspace,
	canDispatchAiInOrg,
	canManageOrganization,
	isGlobalUnscopedActor,
} from "../acl.ts";
import { isSuperAdminActor, requireActiveActor } from "../auth.ts";
import { readJsonBody, sendError, sendJson } from "../http.ts";
import { parseCollaboratorIds, parseObserverMemberIds, type RouteRequest, type ServerRouteContext } from "./context.ts";
import { ensureOrgEnabledAiRequest } from "./matter-roster.ts";
import { validateModelSelection } from "./model-settings.ts";

/** Update a matter’s workspace, visibility, and roster. */
export async function handleMatterSettingsRoutes(ctx: ServerRouteContext, r: RouteRequest): Promise<boolean> {
	const { store, orchestrator, broadcast } = ctx;
	const { req, res, method, pathname, actor } = r;

	const matterDetailMatch = pathname.match(/^\/api\/matters\/([^/]+)$/);
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
		const hasModelSelectionUpdate = Object.hasOwn(body, "modelSelection");
		const hasWorkspaceUpdate = Object.hasOwn(body, "workspaceId");
		const hasOrgUpdate = Object.hasOwn(body, "orgId");
		const hasLeadUpdate = Object.hasOwn(body, "leadMemberId");
		const hasAiMembersUpdate = Object.hasOwn(body, "aiMemberIds");
		const hasConsultMembersUpdate = Object.hasOwn(body, "consultMemberIds");
		const hasObserversEnabledUpdate = Object.hasOwn(body, "observersEnabled");
		const hasObserverUpdate = Object.hasOwn(body, "observerMemberIds");
		const hasDiscussionAiUpdate = Object.hasOwn(body, "discussionAiEnabled");
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
		const parsedConsultMemberIds =
			hasConsultMembersUpdate && body.consultMemberIds === null
				? null
				: hasConsultMembersUpdate
					? parseObserverMemberIds(body.consultMemberIds, store)
					: undefined;
		if (hasConsultMembersUpdate && parsedConsultMemberIds === undefined) {
			sendError(res, 400, "consultMemberIds must be null or an array of member IDs");
			return true;
		}
		if (hasObserversEnabledUpdate && typeof body.observersEnabled !== "boolean") {
			sendError(res, 400, "observersEnabled must be a boolean");
			return true;
		}
		if (hasDiscussionAiUpdate && typeof body.discussionAiEnabled !== "boolean") {
			sendError(res, 400, "discussionAiEnabled must be a boolean");
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
		const modelSelection = hasModelSelectionUpdate
			? await validateModelSelection(ctx, body.modelSelection)
			: undefined;
		if (hasModelSelectionUpdate) {
			const current = store.getMatter(matterId);
			if (current?.orgId !== existing.orgId || current?.createdByUserId !== existing.createdByUserId) {
				sendError(res, 409, "事项归属已变化，请刷新后再配置模型");
				return true;
			}
			if (!canDispatchAiInOrg(store, actor, existing.orgId) || !current || !canAccessMatter(store, actor, current)) {
				sendError(res, 403, "无权为此事项配置模型");
				return true;
			}
		}
		if (
			(hasModelSelectionUpdate || hasWorkspaceUpdate || hasOrgUpdate || hasLeadUpdate) &&
			orchestrator.isMatterRunning(matterId)
		) {
			sendError(res, 409, "Stop the active turn before switching workspaces, organizations, lead member, or model");
			return true;
		}
		const rosterOrgId = targetWorkspace ? targetWorkspace.orgId : hasOrgUpdate ? nextOrgId : existing.orgId;
		if (
			!ensureOrgEnabledAiRequest(res, ctx, actor, rosterOrgId, nextLeadId, [
				...(parsedAiMemberIds ?? []),
				...(parsedConsultMemberIds ?? []),
				...(observerMemberIds ?? []),
			])
		) {
			return true;
		}
		let updated = existing;
		if (modelSelection !== undefined) {
			updated = store.updateMatterModelSelection(matterId, modelSelection);
			broadcast("matter_updated", { matterId, modelSelection }, { matterId });
		}
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
					consultMemberIds: updated.consultMemberIds,
					observerMemberIds: updated.observerMemberIds,
				},
				{ matterId },
			);
		}
		if (hasConsultMembersUpdate && parsedConsultMemberIds !== undefined) {
			updated = store.updateMatterConsultMembers(matterId, parsedConsultMemberIds);
			broadcast(
				"matter_updated",
				{
					matterId,
					aiMemberIds: updated.aiMemberIds,
					consultMemberIds: updated.consultMemberIds,
					observerMemberIds: updated.observerMemberIds,
				},
				{ matterId },
			);
		}
		if (hasDiscussionAiUpdate) {
			updated = store.updateMatterDiscussionAiEnabled(matterId, Boolean(body.discussionAiEnabled));
			broadcast(
				"matter_updated",
				{
					matterId,
					discussionAiEnabled: updated.discussionAiEnabled,
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

	return false;
}
