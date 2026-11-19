import { validateSkillReference } from "../../roles/capabilities.ts";
import { ROLE_ARCHITECT_MEMBER_ID } from "../../roles/role-architect.ts";
import { buildScopedRoleId, deleteRolePackage, saveRolePackage } from "../../roles/role-package-store.ts";
import { parseRoleTemplateMarkdown, serializeRoleTemplateMarkdown } from "../../roles/template-loader.ts";
import type { RoleTemplate } from "../../roles/types.ts";
import {
	canAccessMatter,
	canActorManageMember,
	canActorUseMember,
	canManageOrganization,
	isViewerInAllOrgsOrTarget,
} from "../acl.ts";
import { isSuperAdminActor, requireActiveActor, requireOwner } from "../auth.ts";
import { HttpRequestError, readJsonBody, sendError, sendJson } from "../http.ts";
import { auditActorAction, type RouteRequest, type ServerRouteContext } from "./context.ts";

import {
	applyRoleAdjustmentsBatch,
	broadcastTeamUpdateForMember,
	enforcePersonalQuotaForBatch,
	materializeMembersBatch,
	planMembersBatch,
	planRoleAdjustmentsBatch,
	resolveMemberTargetScope,
} from "./role-packages.ts";

/** Handle member changes, role package import/export, and matter role proposals. */
export async function handleTeamRoutes(ctx: ServerRouteContext, r: RouteRequest): Promise<boolean> {
	const mutation =
		(r.method !== "GET" &&
			/^\/api\/members(?:\/|$)/.test(r.pathname) &&
			r.pathname !== "/api/members/architect/chat" &&
			r.pathname !== "/api/members/design") ||
		(r.method === "POST" && r.pathname.endsWith("/apply-role-proposals"));
	return mutation ? ctx.withRoleMutation(() => handleTeamRoutesUnlocked(ctx, r)) : handleTeamRoutesUnlocked(ctx, r);
}

async function handleTeamRoutesUnlocked(ctx: ServerRouteContext, r: RouteRequest): Promise<boolean> {
	const { store, orchestrator, rolesDir, broadcast } = ctx;
	const { req, res, method, pathname, actor } = r;

	const proposalApplyMatch = pathname.match(/^\/api\/matters\/([^/]+)\/messages\/([^/]+)\/apply-role-proposals$/);
	if (method === "POST" && proposalApplyMatch) {
		if (!requireActiveActor(res, actor)) return true;
		const matterId = decodeURIComponent(proposalApplyMatch[1]!);
		const messageId = decodeURIComponent(proposalApplyMatch[2]!);
		let matter = store.getMatter(matterId);
		if (!matter) {
			sendError(res, 404, `Matter not found: ${matterId}`);
			return true;
		}
		if (!canAccessMatter(store, actor, matter)) {
			sendError(res, 403, "无权访问该事项");
			return true;
		}
		const targetMsg = store.getMessage(messageId);
		if (!targetMsg || targetMsg.matterId !== matterId) {
			sendError(res, 404, `Message not found: ${messageId}`);
			return true;
		}
		const existingProposals =
			targetMsg.metadata?.roleProposals &&
			typeof targetMsg.metadata.roleProposals === "object" &&
			!Array.isArray(targetMsg.metadata.roleProposals)
				? (targetMsg.metadata.roleProposals as Record<string, unknown>)
				: null;
		if (!existingProposals) {
			sendError(res, 409, "Message does not carry role proposals");
			return true;
		}

		const body = await readJsonBody(req);
		const action = body.action === "dismiss" ? "dismiss" : "apply";
		const canManageScope = isSuperAdminActor(actor) || canManageOrganization(store, actor, matter.orgId);
		const isActiveSessionMember =
			actor.authKind === "session" && actor.user && !isViewerInAllOrgsOrTarget(store, actor, matter.orgId);
		if (action === "dismiss") {
			if (!canManageScope && !(isActiveSessionMember && matter.createdByUserId === actor.user?.id)) {
				sendError(res, 403, "仅所有者、组织管理员或私人事项发起人可处理角色提案");
				return true;
			}
			if (existingProposals.status === "applied") {
				sendError(res, 409, "Applied role proposals cannot be dismissed");
				return true;
			}
			const updatedMsg = store.updateMessageMetadata(messageId, {
				...(targetMsg.metadata ?? {}),
				roleProposals: { ...existingProposals, status: "dismissed" },
			});
			if (updatedMsg) {
				broadcast("matter_message", { matterId, message: updatedMsg, matter }, { matterId });
			}
			sendJson(res, 200, { ok: true, createdMembers: [], updatedMembers: [], message: updatedMsg, matter });
			return true;
		}

		if (existingProposals.status !== "pending") {
			sendError(res, 409, "Only pending role proposals may be applied");
			return true;
		}
		const matterJoinMode =
			body.matterJoinMode === "consult" || body.matterJoinMode === "observer" || body.matterJoinMode === "lead"
				? body.matterJoinMode
				: "none";
		if (matterJoinMode !== "none" && orchestrator.isMatterRunning(matterId)) {
			sendError(res, 409, "Cannot update active matter roster while a turn is running");
			return true;
		}
		const rawMembers = Array.isArray(body.members) ? body.members : [];
		const rawAdjustments = Array.isArray(body.adjustments) ? body.adjustments : [];
		if (rawMembers.length + rawAdjustments.length === 0) {
			sendError(res, 400, "Select at least one role blueprint or adjustment to apply");
			return true;
		}
		if (rawMembers.length > 8 || rawAdjustments.length > 8) {
			sendError(res, 400, "At most 8 members or adjustments may be applied in one batch");
			return true;
		}
		if (!canManageScope) {
			if (!isActiveSessionMember) {
				sendError(res, 403, "仅所有者或组织管理员可应用角色提案");
				return true;
			}
			if (
				rawAdjustments.length > 0 &&
				rawAdjustments.some((adj) => {
					const rec = adj && typeof adj === "object" ? (adj as Record<string, unknown>) : null;
					const target = typeof rec?.memberId === "string" ? store.getMember(rec.memberId) : null;
					return !target || !canActorManageMember(store, actor, target);
				})
			) {
				sendError(res, 403, "仅所有者或组织管理员可调整共享角色配置");
				return true;
			}
		}

		const memberPlans = planMembersBatch(ctx, actor, rawMembers, { fallbackOrgId: matter.orgId });
		const adjustmentPlans = planRoleAdjustmentsBatch(ctx, actor, rawAdjustments);
		const createdMembers = await materializeMembersBatch(ctx, r, memberPlans);
		const updatedMembers = await applyRoleAdjustmentsBatch(ctx, r, adjustmentPlans);
		const newIds = createdMembers.map((m) => m.id);
		let matterMutated = false;
		if (matterJoinMode !== "none" && newIds.length > 0) {
			if (matter.aiMemberIds !== null) {
				matter = store.updateMatterAiMembers(matter.id, [...matter.aiMemberIds, ...newIds]);
				matterMutated = true;
			}
			if (matterJoinMode === "observer") {
				matter = store.updateMatterObservers(matter.id, [...matter.observerMemberIds, ...newIds]);
				matterMutated = true;
			} else if (matterJoinMode === "lead") {
				matter = store.updateMatterLead(matter.id, newIds[0]!);
				matterMutated = true;
			}
		}

		const updatedMsg = store.updateMessageMetadata(messageId, {
			...(targetMsg.metadata ?? {}),
			roleProposals: {
				...existingProposals,
				status: "applied",
				appliedMemberIds: newIds,
				appliedAdjustmentIds: updatedMembers.map((m) => m.id),
				appliedMatterJoinMode: matterJoinMode,
			},
		});
		for (const cm of createdMembers) {
			broadcastTeamUpdateForMember(broadcast, { memberIds: [cm.id] }, cm);
		}
		for (const um of updatedMembers) {
			broadcastTeamUpdateForMember(broadcast, { memberIds: [um.id] }, um);
		}
		if (matterMutated) {
			broadcast("matter_updated", { matterId: matter.id, reason: "role_proposals_joined" }, { matterId: matter.id });
		}
		if (updatedMsg) {
			broadcast("matter_message", { matterId: matter.id, message: updatedMsg, matter }, { matterId: matter.id });
		}
		sendJson(res, 200, { ok: true, createdMembers, updatedMembers, message: updatedMsg, matter });
		return true;
	}

	if (method === "POST" && pathname === "/api/members/batch") {
		if (!requireActiveActor(res, actor)) return true;
		const body = await readJsonBody(req);
		const rawList = Array.isArray(body.members) ? body.members : [];
		if (rawList.length === 0 || rawList.length > 8) {
			sendError(res, 400, "members must be an array of 1 to 8 role payloads");
			return true;
		}
		const created = await materializeMembersBatch(ctx, r, planMembersBatch(ctx, actor, rawList));
		for (const member of created) {
			broadcastTeamUpdateForMember(broadcast, { memberIds: [member.id] }, member);
		}
		sendJson(res, 201, { members: created });
		return true;
	}

	if (method === "POST" && pathname === "/api/members/adjustments/apply") {
		if (!requireActiveActor(res, actor)) return true;
		const body = await readJsonBody(req);
		const rawList = Array.isArray(body.adjustments) ? body.adjustments : [];
		if (rawList.length === 0 || rawList.length > 8) {
			sendError(res, 400, "adjustments must be an array of 1 to 8 role updates");
			return true;
		}
		const updatedMembers = await applyRoleAdjustmentsBatch(ctx, r, planRoleAdjustmentsBatch(ctx, actor, rawList));
		for (const member of updatedMembers) {
			broadcastTeamUpdateForMember(broadcast, { memberIds: [member.id] }, member);
		}
		sendJson(res, 200, { members: updatedMembers });
		return true;
	}

	if (method === "POST" && pathname === "/api/members") {
		if (!requireActiveActor(res, actor)) return true;
		const body = await readJsonBody(req);
		const [member] = await materializeMembersBatch(ctx, r, planMembersBatch(ctx, actor, [body]));
		if (!member) throw new Error("Member creation returned no result");
		broadcastTeamUpdateForMember(broadcast, { memberId: member.id }, member);
		sendJson(res, 201, { member });
		return true;
	}

	const memberPatchMatch = pathname.match(/^\/api\/members\/([^/]+)$/);
	if (method === "PATCH" && memberPatchMatch) {
		if (!requireActiveActor(res, actor)) return true;
		const memberId = decodeURIComponent(memberPatchMatch[1]!);
		const existing = store.getMember(memberId);
		if (!existing) {
			sendError(res, 404, `Member not found: ${memberId}`);
			return true;
		}
		if (!canActorManageMember(store, actor, existing)) {
			sendError(res, 403, "无权编辑该 AI 角色的署名与资料");
			return true;
		}
		const body = await readJsonBody(req);
		const member = store.updateMemberIdentity(memberId, {
			displayName: typeof body.displayName === "string" ? body.displayName : undefined,
			roleTitle: typeof body.roleTitle === "string" ? body.roleTitle : undefined,
			gitName: typeof body.gitName === "string" ? body.gitName : undefined,
			gitEmail: typeof body.gitEmail === "string" ? body.gitEmail : undefined,
			identitySummary: typeof body.identitySummary === "string" ? body.identitySummary : undefined,
		});
		broadcastTeamUpdateForMember(broadcast, { memberId: member.id }, member);
		sendJson(res, 200, { member });
		return true;
	}

	if (method === "DELETE" && memberPatchMatch) {
		if (!requireActiveActor(res, actor)) return true;
		const memberId = decodeURIComponent(memberPatchMatch[1]!);
		const existing = store.getMember(memberId);
		if (!existing) {
			sendError(res, 404, `Member not found: ${memberId}`);
			return true;
		}
		if (!canActorManageMember(store, actor, existing)) {
			sendError(res, 403, "无权删除该 AI 角色");
			return true;
		}
		try {
			const deleted = orchestrator.unregisterRoleTemplate(memberId);
			await deleteRolePackage({ rolesDir, member: deleted }).catch(() => {});
			auditActorAction(ctx, req, actor, {
				action: "role.delete",
				targetType: "role",
				targetId: deleted.id,
				orgId: deleted.ownerOrgId ?? null,
				detail: { roleScope: deleted.roleScope },
			});
			broadcastTeamUpdateForMember(broadcast, { removedMemberId: deleted.id }, deleted);
			sendJson(res, 200, { ok: true, deletedMemberId: deleted.id });
		} catch (error) {
			sendError(res, 409, error instanceof Error ? error.message : String(error));
		}
		return true;
	}

	const memberPrimaryMatch = pathname.match(/^\/api\/members\/([^/]+)\/primary$/);
	if (method === "POST" && memberPrimaryMatch) {
		if (!requireOwner(res, actor)) return true;
		const memberId = decodeURIComponent(memberPrimaryMatch[1]!);
		const existing = store.getMember(memberId);
		if (!existing) {
			sendError(res, 404, `Member not found: ${memberId}`);
			return true;
		}
		if (existing.roleScope !== "global") {
			sendError(res, 400, "仅平台通用（global）AI 角色可设为全局默认主联系人");
			return true;
		}
		const member = store.setPrimaryContact(memberId);
		broadcast("team_updated", { memberId: member.id });
		sendJson(res, 200, { member });
		return true;
	}

	const memberExportMatch = pathname.match(/^\/api\/members\/([^/]+)\/export$/);
	if (method === "GET" && memberExportMatch) {
		if (!requireActiveActor(res, actor)) return true;
		const memberId = decodeURIComponent(memberExportMatch[1]!);
		const member = store.getMember(memberId);
		if (!member) {
			sendError(res, 404, `Member not found: ${memberId}`);
			return true;
		}
		if (!canActorUseMember(store, actor, member)) {
			sendError(res, 403, "无权导出其他组织或他人的私有角色");
			return true;
		}
		const template = orchestrator.getTemplateForMember(member);
		if (!template) {
			sendError(res, 404, `Role template not found for member: ${memberId}`);
			return true;
		}
		const markdown = serializeRoleTemplateMarkdown(template);
		sendJson(res, 200, { id: template.id, filename: `${template.id}.md`, markdown });
		return true;
	}

	if (method === "POST" && pathname === "/api/members/import") {
		if (!requireActiveActor(res, actor)) return true;
		const body = await readJsonBody(req);
		const markdown = typeof body.markdown === "string" ? body.markdown : "";
		if (!markdown.trim()) {
			sendError(res, 400, "markdown is required");
			return true;
		}
		const targetScope = resolveMemberTargetScope(ctx, actor, body);
		let parsed: RoleTemplate;
		try {
			parsed = parseRoleTemplateMarkdown(markdown);
			for (const skillName of parsed.skills) {
				validateSkillReference(skillName);
			}
		} catch (error) {
			throw new HttpRequestError(400, error instanceof Error ? error.message : String(error));
		}
		if (parsed.id === ROLE_ARCHITECT_MEMBER_ID) {
			throw new HttpRequestError(409, "Built-in role architect cannot be replaced by an imported role");
		}
		const existingIds = new Set(store.listMembers().map((m) => m.id));
		const targetId =
			targetScope.roleScope === "global"
				? parsed.id
				: buildScopedRoleId({
						baseId: parsed.id,
						roleScope: targetScope.roleScope,
						ownerOrgId: targetScope.ownerOrgId,
						ownerUserId: targetScope.ownerUserId,
						existingIds,
						allowCollisionSuffix: false,
					});
		const existingMember = store.getMember(targetId);
		if (existingMember) {
			const sameScope =
				existingMember.roleScope === targetScope.roleScope &&
				(existingMember.ownerOrgId ?? null) === targetScope.ownerOrgId &&
				(existingMember.ownerUserId ?? null) === targetScope.ownerUserId;
			if (!sameScope || !canActorManageMember(store, actor, existingMember)) {
				throw new HttpRequestError(409, `Role id "${targetId}" conflicts with an existing role`);
			}
		} else {
			enforcePersonalQuotaForBatch(ctx, actor, [{ roleScope: targetScope.roleScope }]);
		}
		const scopedTemplate: RoleTemplate = {
			...parsed,
			id: targetId,
			roleScope: targetScope.roleScope,
			ownerOrgId: targetScope.ownerOrgId,
			ownerUserId: targetScope.ownerUserId,
			shareable: targetScope.roleScope === "global" ? parsed.shareable : false,
			isPrimaryContact:
				targetScope.roleScope === "global" && isSuperAdminActor(actor) ? parsed.isPrimaryContact : false,
		};
		const saved = await saveRolePackage({
			rolesDir,
			skillsDir: ctx.skillsDir,
			template: scopedTemplate,
		});
		const member = orchestrator.registerRoleTemplate(saved.template);
		auditActorAction(ctx, req, actor, {
			action: "role.import",
			targetType: "role",
			targetId: member.id,
			orgId: member.ownerOrgId ?? null,
			detail: { roleScope: member.roleScope },
		});
		broadcastTeamUpdateForMember(broadcast, { memberId: member.id }, member);
		sendJson(res, 201, { member });
		return true;
	}

	return false;
}
