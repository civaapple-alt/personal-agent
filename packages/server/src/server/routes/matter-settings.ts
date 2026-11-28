import type { Hono } from "hono";
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
import { HttpRequestError } from "../http.ts";
import { type ApiRouterEnv, parseJsonBody } from "../router.ts";
import { parseCollaboratorIds, parseObserverMemberIds } from "./context.ts";
import { ensureOrgEnabledAiRequest } from "./matter-roster.ts";
import { validateModelSelection } from "./model-settings.ts";

/** Register route to update a matter’s workspace, visibility, and roster. */
export function registerMatterSettingsRoutes(app: Hono<ApiRouterEnv>): void {
	app.patch("/api/matters/:matterId", async (c) => {
		const ctx = c.var.routeCtx;
		const { store, orchestrator, broadcast } = ctx;
		const actor = c.var.actor;
		const res = c.var.nodeRes!;
		if (!requireActiveActor(res, actor)) return c.body(null);
		const matterId = c.req.param("matterId");
		const existing = store.getMatter(matterId);
		if (!existing) {
			throw new HttpRequestError(404, `Matter not found: ${matterId}`);
		}
		if (!canAccessMatter(store, actor, existing)) {
			throw new HttpRequestError(403, "无权访问该事项");
		}
		const canModifyMatter =
			isGlobalUnscopedActor(actor) ||
			isSuperAdminActor(actor) ||
			canManageOrganization(store, actor, existing.orgId) ||
			(actor.authKind === "session" && actor.user && existing.createdByUserId === actor.user.id);
		if (!canModifyMatter) {
			throw new HttpRequestError(403, "仅所有者、组织管理员或事项发起人可修改事项配置");
		}
		const body = await parseJsonBody(c);
		const hasModelSelectionUpdate = Object.hasOwn(body, "modelSelection");
		const hasWorkspaceUpdate = Object.hasOwn(body, "workspaceId");
		const hasOrgUpdate = Object.hasOwn(body, "orgId");
		const hasLeadUpdate = Object.hasOwn(body, "leadMemberId");
		const hasCollaborationModeUpdate = Object.hasOwn(body, "collaborationMode");
		const hasCoordinatorUpdate = Object.hasOwn(body, "coordinatorMemberId");
		const hasAiMembersUpdate = Object.hasOwn(body, "aiMemberIds");
		const hasConsultMembersUpdate = Object.hasOwn(body, "consultMemberIds");
		const hasObserversEnabledUpdate = Object.hasOwn(body, "observersEnabled");
		const hasObserverUpdate = Object.hasOwn(body, "observerMemberIds");
		const hasDiscussionAiUpdate = Object.hasOwn(body, "discussionAiEnabled");
		const hasCollaboratorUpdate = Object.hasOwn(body, "collaboratorIds");
		const hasVisibilityUpdate = Object.hasOwn(body, "visibility");
		const hasStatusUpdate = Object.hasOwn(body, "status");
		const nextStatus =
			body.status === "archived" || body.status === "open" ? (body.status as "archived" | "open") : undefined;
		if (hasStatusUpdate && !nextStatus) {
			throw new HttpRequestError(400, 'status must be "archived" or "open"');
		}
		const workspaceId =
			typeof body.workspaceId === "string" && body.workspaceId.trim().length > 0 ? body.workspaceId.trim() : null;
		const targetWorkspace = hasWorkspaceUpdate && workspaceId ? store.getWorkspace(workspaceId) : null;
		if (hasWorkspaceUpdate && workspaceId) {
			if (!targetWorkspace) {
				throw new HttpRequestError(404, `Workspace not found: ${workspaceId}`);
			}
			if (!canAccessWorkspace(store, actor, targetWorkspace)) {
				throw new HttpRequestError(403, "无权将事项切换到未授权的项目仓库");
			}
		}
		const nextOrgId =
			body.orgId === null
				? null
				: typeof body.orgId === "string" && body.orgId.trim().length > 0
					? body.orgId.trim()
					: null;
		if (hasOrgUpdate && body.orgId !== null && typeof body.orgId !== "string") {
			throw new HttpRequestError(400, "orgId must be a string or null");
		}
		if (hasOrgUpdate && nextOrgId && !store.getOrganization(nextOrgId)) {
			throw new HttpRequestError(404, `Organization not found: ${nextOrgId}`);
		}
		if (hasOrgUpdate && nextOrgId && !canAccessOrganization(store, actor, nextOrgId)) {
			throw new HttpRequestError(403, "无权将事项转移到未加入的组织");
		}
		const nextLeadId =
			typeof body.leadMemberId === "string" && body.leadMemberId.trim().length > 0 ? body.leadMemberId.trim() : null;
		if (hasLeadUpdate && (!nextLeadId || !store.getMember(nextLeadId))) {
			throw new HttpRequestError(
				nextLeadId ? 404 : 400,
				nextLeadId ? `Member not found: ${nextLeadId}` : "leadMemberId is invalid",
			);
		}
		const nextCollaborationMode =
			body.collaborationMode === "lead" || body.collaborationMode === "board"
				? (body.collaborationMode as "lead" | "board")
				: undefined;
		if (hasCollaborationModeUpdate && !nextCollaborationMode) {
			throw new HttpRequestError(400, 'collaborationMode must be "lead" or "board"');
		}
		const nextCoordinatorMemberId =
			body.coordinatorMemberId === null
				? null
				: typeof body.coordinatorMemberId === "string" && body.coordinatorMemberId.trim().length > 0
					? body.coordinatorMemberId.trim()
					: undefined;
		if (
			hasCoordinatorUpdate &&
			body.coordinatorMemberId !== null &&
			(!nextCoordinatorMemberId || !store.getMember(nextCoordinatorMemberId))
		) {
			throw new HttpRequestError(
				nextCoordinatorMemberId ? 404 : 400,
				nextCoordinatorMemberId ? `Member not found: ${nextCoordinatorMemberId}` : "coordinatorMemberId is invalid",
			);
		}
		const parsedAiMemberIds =
			hasAiMembersUpdate && body.aiMemberIds === null
				? null
				: hasAiMembersUpdate
					? parseObserverMemberIds(body.aiMemberIds, store)
					: undefined;
		if (hasAiMembersUpdate && parsedAiMemberIds === undefined) {
			throw new HttpRequestError(400, "aiMemberIds must be null or an array of member IDs");
		}
		if (hasAiMembersUpdate && Array.isArray(parsedAiMemberIds) && parsedAiMemberIds.length === 0) {
			throw new HttpRequestError(400, "At least one AI member must remain in the matter");
		}
		const parsedConsultMemberIds =
			hasConsultMembersUpdate && body.consultMemberIds === null
				? null
				: hasConsultMembersUpdate
					? parseObserverMemberIds(body.consultMemberIds, store)
					: undefined;
		if (hasConsultMembersUpdate && parsedConsultMemberIds === undefined) {
			throw new HttpRequestError(400, "consultMemberIds must be null or an array of member IDs");
		}
		if (hasObserversEnabledUpdate && typeof body.observersEnabled !== "boolean") {
			throw new HttpRequestError(400, "observersEnabled must be a boolean");
		}
		if (hasDiscussionAiUpdate && typeof body.discussionAiEnabled !== "boolean") {
			throw new HttpRequestError(400, "discussionAiEnabled must be a boolean");
		}
		const observerMemberIds = hasObserverUpdate ? parseObserverMemberIds(body.observerMemberIds, store) : undefined;
		if (hasObserverUpdate && !observerMemberIds) {
			throw new HttpRequestError(400, "observerMemberIds must be an array of member IDs");
		}
		const collaboratorIds = hasCollaboratorUpdate ? parseCollaboratorIds(body.collaboratorIds, store) : undefined;
		if (hasCollaboratorUpdate && !collaboratorIds) {
			throw new HttpRequestError(400, "collaboratorIds must be an array of collaborator IDs");
		}
		const modelSelection = hasModelSelectionUpdate
			? await validateModelSelection(ctx, body.modelSelection)
			: undefined;
		if (hasModelSelectionUpdate) {
			const current = store.getMatter(matterId);
			if (current?.orgId !== existing.orgId || current?.createdByUserId !== existing.createdByUserId) {
				throw new HttpRequestError(409, "事项归属已变化，请刷新后再配置模型");
			}
			if (!canDispatchAiInOrg(store, actor, existing.orgId) || !current || !canAccessMatter(store, actor, current)) {
				throw new HttpRequestError(403, "无权为此事项配置模型");
			}
		}
		if (
			(hasModelSelectionUpdate ||
				hasWorkspaceUpdate ||
				hasOrgUpdate ||
				hasLeadUpdate ||
				hasCollaborationModeUpdate ||
				hasCoordinatorUpdate) &&
			orchestrator.isMatterRunning(matterId)
		) {
			throw new HttpRequestError(
				409,
				"Stop the active turn before switching workspaces, organizations, lead member, collaboration mode, or model",
			);
		}
		if (nextStatus === "archived" && orchestrator.isMatterRunning(matterId)) {
			throw new HttpRequestError(409, "请先停止当前正在运行的事项再归档");
		}
		const rosterOrgId = targetWorkspace ? targetWorkspace.orgId : hasOrgUpdate ? nextOrgId : existing.orgId;
		if (
			!ensureOrgEnabledAiRequest(res, ctx, actor, rosterOrgId, nextLeadId ?? nextCoordinatorMemberId ?? null, [
				...(parsedAiMemberIds ?? []),
				...(parsedConsultMemberIds ?? []),
				...(observerMemberIds ?? []),
			])
		) {
			return c.body(null);
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
		if (hasCollaborationModeUpdate || hasCoordinatorUpdate) {
			updated = store.updateMatterBoardMeta(matterId, {
				...(nextCollaborationMode ? { collaborationMode: nextCollaborationMode } : {}),
				...(nextCoordinatorMemberId !== undefined ? { coordinatorMemberId: nextCoordinatorMemberId } : {}),
			});
			broadcast(
				"matter_updated",
				{
					matterId,
					collaborationMode: updated.collaborationMode,
					coordinatorMemberId: updated.coordinatorMemberId,
				},
				{ matterId },
			);
		}
		if (hasObserversEnabledUpdate || observerMemberIds !== undefined) {
			if (observerMemberIds !== undefined) updated = store.updateMatterObservers(matterId, observerMemberIds);
			if (hasObserversEnabledUpdate) {
				updated = store.updateMatterObserversEnabled(matterId, Boolean(body.observersEnabled));
			}
			if (!updated.observersEnabled) void orchestrator.stopObserverPass(matterId);
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
		if (nextStatus) {
			updated = store.updateMatterStatus(matterId, nextStatus);
			broadcast("matter_updated", { matterId, status: updated.status }, { matterId });
		}
		return c.json({ matter: updated });
	});
}
