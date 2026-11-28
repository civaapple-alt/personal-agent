import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { isSkillStorageTarget, readSkillProposals, type SkillStorageTarget } from "@pa/contracts/skill-proposal";
import type { Hono } from "hono";
import { readHumanDecision } from "../../orchestrator/human-decision.ts";
import { resolveRoleSkillPath, validateSkillReference } from "../../roles/capabilities.ts";
import { ROLE_ARCHITECT_MEMBER_ID } from "../../roles/role-architect.ts";
import {
	buildScopedRoleId,
	deleteRolePackage,
	SkillNameConflictError,
	saveRolePackage,
	saveSkillProposalToDisk,
} from "../../roles/role-package-store.ts";
import { hasRoleProposalActions } from "../../roles/role-proposal-state.ts";
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
import { HttpRequestError } from "../http.ts";
import { type ApiRouteContext, type ApiRouterEnv, parseJsonBody } from "../router.ts";
import { auditActorAction, type RouteRequest } from "./context.ts";

import {
	applyRoleAdjustmentsBatch,
	broadcastTeamUpdateForMember,
	enforcePersonalQuotaForBatch,
	materializeMembersBatch,
	planMembersBatch,
	planRoleAdjustmentsBatch,
	resolveMemberTargetScope,
} from "./role-packages.ts";

function toLegacyRouteRequest(c: ApiRouteContext): RouteRequest {
	return {
		req: c.var.nodeReq!,
		res: c.var.nodeRes!,
		method: c.req.method,
		pathname: c.req.path,
		actor: c.var.actor,
	};
}

/** Register member mutation, role package import/export, and matter skill/role proposal routes. */
export function registerTeamRoutes(app: Hono<ApiRouterEnv>): void {
	app.post("/api/matters/:matterId/messages/:messageId/skill-proposals", (c) => {
		const ctx = c.var.routeCtx;
		return ctx.withRoleMutation(async () => {
			const { store, broadcast } = ctx;
			const req = c.var.nodeReq!;
			const res = c.var.nodeRes!;
			const actor = c.var.actor;
			if (!requireActiveActor(res, actor)) return c.body(null);
			const matterId = c.req.param("matterId");
			const messageId = c.req.param("messageId");
			const matter = store.getMatter(matterId);
			if (!matter) {
				throw new HttpRequestError(404, `Matter not found: ${matterId}`);
			}
			if (!canAccessMatter(store, actor, matter)) {
				throw new HttpRequestError(403, "无权访问该事项");
			}
			const targetMsg = store.getMessage(messageId);
			if (!targetMsg || targetMsg.matterId !== matterId) {
				throw new HttpRequestError(404, `Message not found: ${messageId}`);
			}
			const proposals = readSkillProposals(targetMsg.metadata);
			if (proposals.length === 0) {
				throw new HttpRequestError(409, "Message does not carry skill proposals");
			}
			const body = await parseJsonBody(c);
			const proposalId = typeof body.proposalId === "string" ? body.proposalId.trim() : "";
			const action = body.action === "dismiss" ? "dismiss" : "apply";
			const idx = proposals.findIndex((item) => item.id === proposalId);
			if (idx < 0) {
				throw new HttpRequestError(404, `Skill proposal not found: ${proposalId}`);
			}
			const targetProposal = proposals[idx]!;
			const targetScope: SkillStorageTarget = isSkillStorageTarget(body.storageScope)
				? body.storageScope
				: targetProposal.storageScope;
			const canManageOrg = isSuperAdminActor(actor) || canManageOrganization(store, actor, matter.orgId);
			const isViewer = isViewerInAllOrgsOrTarget(store, actor, matter.orgId);
			if (isViewer) {
				throw new HttpRequestError(403, "只读成员无权处理技能提案");
			}
			if (action === "dismiss") {
				if (targetProposal.status === "applied") {
					throw new HttpRequestError(409, "Applied skill proposals cannot be dismissed");
				}
				const nextProposals = proposals.map((item) =>
					item.id === proposalId
						? {
								...item,
								status: "dismissed" as const,
								actedBy: actor.user?.displayName ?? actor.authKind,
								actedAt: new Date().toISOString(),
							}
						: item,
				);
				const updatedMsg = store.updateMessageMetadata(messageId, {
					...(targetMsg.metadata ?? {}),
					skillProposals: nextProposals,
				});
				if (updatedMsg) {
					broadcast("matter_message", { matterId, message: updatedMsg, matter }, { matterId });
				}
				return c.json({ ok: true, writtenPaths: [], message: updatedMsg, matter });
			}

			if (targetProposal.status !== "pending") {
				throw new HttpRequestError(409, "Only pending skill proposals may be applied");
			}
			if (targetScope === "global" && !isSuperAdminActor(actor) && actor.authKind !== "loopback") {
				throw new HttpRequestError(403, "仅超级管理员可将技能沉淀到全局范围");
			}
			if (targetScope === "org" && !canManageOrg) {
				throw new HttpRequestError(403, "仅组织管理员或所有者可将技能沉淀到组织范围");
			}
			const workspace = matter.workspaceId ? store.getWorkspace(matter.workspaceId) : null;
			if (targetScope === "workspace" && !workspace) {
				throw new HttpRequestError(409, "当前事项未绑定工作区，无法写入工作区级 Skill");
			}
			try {
				const { writtenPaths } = await saveSkillProposalToDisk({
					proposal: targetProposal,
					storageScope: targetScope,
					skillsDir: ctx.skillsDir,
					orgId: matter.orgId,
					userId: actor.user?.id ?? null,
					workspaceId: workspace?.id ?? null,
					workspaceRepoPath: workspace?.repoPath ?? null,
				});
				const trustScopeId =
					targetScope === "global"
						? ""
						: targetScope === "org"
							? (matter.orgId ?? "")
							: targetScope === "personal"
								? (actor.user?.id ?? actor.collaborator?.id ?? "")
								: (workspace?.id ?? "");
				store.skillTrust.upsertPolicy({
					scope: targetScope,
					scopeId: trustScopeId,
					skillName: targetProposal.name,
					trustLevel: "autonomous",
					updatedByUserId: actor.user?.id ?? null,
				});
				const nextProposals = proposals.map((item) =>
					item.id === proposalId
						? {
								...item,
								storageScope: targetScope,
								status: "applied" as const,
								writtenPaths,
								actedBy: actor.user?.displayName ?? actor.authKind,
								actedAt: new Date().toISOString(),
							}
						: item,
				);
				const updatedMsg = store.updateMessageMetadata(messageId, {
					...(targetMsg.metadata ?? {}),
					skillProposals: nextProposals,
				});
				auditActorAction(ctx, req, actor, {
					action: "skill_proposal.apply",
					targetType: "skill",
					targetId: targetProposal.name,
					orgId: matter.orgId,
					detail: {
						matterId,
						storageScope: targetScope,
						writtenPaths,
					},
				});
				if (updatedMsg) {
					broadcast("matter_message", { matterId, message: updatedMsg, matter }, { matterId });
				}
				return c.json({ ok: true, writtenPaths, message: updatedMsg, matter });
			} catch (error) {
				const status = error instanceof SkillNameConflictError ? 409 : 400;
				throw new HttpRequestError(status, error instanceof Error ? error.message : String(error));
			}
		});
	});

	app.post("/api/matters/:matterId/messages/:messageId/apply-role-proposals", (c) => {
		const ctx = c.var.routeCtx;
		return ctx.withRoleMutation(async () => {
			const { store, orchestrator, broadcast } = ctx;
			const req = c.var.nodeReq!;
			const res = c.var.nodeRes!;
			const actor = c.var.actor;
			if (!requireActiveActor(res, actor)) return c.body(null);
			const r = toLegacyRouteRequest(c);
			const matterId = c.req.param("matterId");
			const messageId = c.req.param("messageId");
			let matter = store.getMatter(matterId);
			if (!matter) {
				throw new HttpRequestError(404, `Matter not found: ${matterId}`);
			}
			if (!canAccessMatter(store, actor, matter)) {
				throw new HttpRequestError(403, "无权访问该事项");
			}
			const targetMsg = store.getMessage(messageId);
			if (!targetMsg || targetMsg.matterId !== matterId) {
				throw new HttpRequestError(404, `Message not found: ${messageId}`);
			}
			const existingProposals =
				targetMsg.metadata?.roleProposals &&
				typeof targetMsg.metadata.roleProposals === "object" &&
				!Array.isArray(targetMsg.metadata.roleProposals)
					? (targetMsg.metadata.roleProposals as Record<string, unknown>)
					: null;
			if (!existingProposals) {
				throw new HttpRequestError(409, "Message does not carry role proposals");
			}

			const body = await parseJsonBody(c);
			const action = body.action === "dismiss" ? "dismiss" : "apply";
			const canManageScope = isSuperAdminActor(actor) || canManageOrganization(store, actor, matter.orgId);
			const isActiveSessionMember =
				actor.authKind === "session" && actor.user && !isViewerInAllOrgsOrTarget(store, actor, matter.orgId);
			if (action === "dismiss") {
				if (!canManageScope && !(isActiveSessionMember && matter.createdByUserId === actor.user?.id)) {
					throw new HttpRequestError(403, "仅所有者、组织管理员或私人事项发起人可处理角色提案");
				}
				if (existingProposals.status === "applied") {
					throw new HttpRequestError(409, "Applied role proposals cannot be dismissed");
				}
				const updatedMsg = store.updateMessageMetadata(messageId, {
					...(targetMsg.metadata ?? {}),
					roleProposals: { ...existingProposals, status: "dismissed" },
				});
				if (updatedMsg) {
					broadcast("matter_message", { matterId, message: updatedMsg, matter }, { matterId });
				}
				return c.json({ ok: true, createdMembers: [], updatedMembers: [], message: updatedMsg, matter });
			}

			if (existingProposals.status !== "pending") {
				throw new HttpRequestError(409, "Only pending role proposals may be applied");
			}
			const latest = store
				.listMessages(matterId, "user")
				.findLast(
					(message) =>
						message.senderType === "member" &&
						message.senderId === targetMsg.senderId &&
						(hasRoleProposalActions(message.metadata?.roleProposals) ||
							readHumanDecision(message.metadata)?.kind === "role_clarification"),
				);
			if (latest && latest.id !== messageId) {
				throw new HttpRequestError(409, "此提案已有更新，请在最新一版中确认角色");
			}
			if (readHumanDecision(targetMsg.metadata)?.kind === "role_clarification") {
				throw new HttpRequestError(409, "请先完成角色澄清，再确认架构师更新后的提案");
			}
			const matterJoinMode =
				body.matterJoinMode === "consult" || body.matterJoinMode === "observer" || body.matterJoinMode === "lead"
					? body.matterJoinMode
					: "none";
			if (matterJoinMode !== "none" && orchestrator.isMatterRunning(matterId)) {
				throw new HttpRequestError(409, "Cannot update active matter roster while a turn is running");
			}
			const rawMembers = Array.isArray(body.members) ? body.members : [];
			const rawAdjustments = Array.isArray(body.adjustments) ? body.adjustments : [];
			if (rawMembers.length + rawAdjustments.length === 0) {
				throw new HttpRequestError(400, "Select at least one role blueprint or adjustment to apply");
			}
			if (rawMembers.length > 8 || rawAdjustments.length > 8) {
				throw new HttpRequestError(400, "At most 8 members or adjustments may be applied in one batch");
			}
			if (!canManageScope) {
				if (!isActiveSessionMember) {
					throw new HttpRequestError(403, "仅所有者或组织管理员可应用角色提案");
				}
				if (
					rawAdjustments.length > 0 &&
					rawAdjustments.some((adj) => {
						const rec = adj && typeof adj === "object" ? (adj as Record<string, unknown>) : null;
						const target = typeof rec?.memberId === "string" ? store.getMember(rec.memberId) : null;
						return !target || !canActorManageMember(store, actor, target);
					})
				) {
					throw new HttpRequestError(403, "仅所有者或组织管理员可调整共享角色配置");
				}
			}

			const matterOrgId = matter.orgId;
			const memberPlans = planMembersBatch(ctx, actor, rawMembers, { fallbackOrgId: matterOrgId });
			if (
				matterJoinMode !== "none" &&
				memberPlans.some(({ template }) => template.roleScope === "org" && template.ownerOrgId !== matterOrgId)
			) {
				throw new HttpRequestError(400, "另一组织的角色可以创建到其团队库。加入本事项时请选择当前组织");
			}
			const adjustmentPlans = planRoleAdjustmentsBatch(ctx, actor, rawAdjustments);
			const createdMembers = await materializeMembersBatch(ctx, r, memberPlans);
			const updatedMembers = await applyRoleAdjustmentsBatch(ctx, r, adjustmentPlans);
			const newIds = createdMembers.map((m) => m.id);
			let matterMutated = false;
			if (matterJoinMode !== "none" && newIds.length > 0) {
				if (matter.orgId && store.hasOrgAiRolesConfigured(matter.orgId)) {
					store.enableNewGlobalRolesForOrg(
						matter.orgId,
						createdMembers.filter((member) => member.roleScope === "global").map((member) => member.id),
					);
				}
				if (matter.aiMemberIds !== null) {
					matter = store.updateMatterAiMembers(matter.id, [...matter.aiMemberIds, ...newIds]);
					matterMutated = true;
				}
				if (matterJoinMode === "consult" && matter.consultMemberIds != null) {
					matter = store.updateMatterConsultMembers(matter.id, [...matter.consultMemberIds, ...newIds]);
					matterMutated = true;
				} else if (matterJoinMode === "observer") {
					matter = store.updateMatterObservers(matter.id, [...matter.observerMemberIds, ...newIds]);
					matterMutated = true;
				} else if (matterJoinMode === "lead") {
					matter = store.updateMatterLead(matter.id, newIds[0]!);
					matterMutated = true;
				}
			}

			const confirmation = {
				userId: actor.user?.id ?? null,
				name: actor.user?.displayName ?? actor.collaborator.name,
				at: new Date().toISOString(),
				proposalMessageId: messageId,
				matterJoinMode,
				roles: createdMembers.map((member, index) => ({
					id: member.id,
					name: member.displayName,
					scope: member.roleScope,
					orgId: member.ownerOrgId ?? null,
					tools: memberPlans[index]?.template.tools ?? [],
					skills: memberPlans[index]?.newSkills.map(({ name, storageScope }) => ({ name, storageScope })) ?? [],
				})),
				adjustments: updatedMembers.map((member, index) => ({
					id: member.id,
					name: member.displayName,
					tools: adjustmentPlans[index]?.tools ?? [],
				})),
			};
			const updatedMsg = store.updateMessageMetadata(messageId, {
				...(targetMsg.metadata ?? {}),
				roleProposals: {
					...existingProposals,
					status: "applied",
					appliedMemberIds: newIds,
					appliedAdjustmentIds: updatedMembers.map((m) => m.id),
					appliedMatterJoinMode: matterJoinMode,
					confirmation,
				},
			});
			auditActorAction(ctx, req, actor, {
				action: "matter.role_proposals.confirm",
				targetType: "message",
				targetId: messageId,
				orgId: matter.orgId,
				detail: confirmation,
			});
			for (const cm of createdMembers) {
				broadcastTeamUpdateForMember(broadcast, { memberIds: [cm.id] }, cm);
			}
			for (const um of updatedMembers) {
				broadcastTeamUpdateForMember(broadcast, { memberIds: [um.id] }, um);
			}
			if (matterMutated) {
				broadcast(
					"matter_updated",
					{ matterId: matter.id, reason: "role_proposals_joined" },
					{ matterId: matter.id },
				);
			}
			if (updatedMsg) {
				broadcast("matter_message", { matterId: matter.id, message: updatedMsg, matter }, { matterId: matter.id });
			}
			return c.json({ ok: true, createdMembers, updatedMembers, message: updatedMsg, matter });
		});
	});

	app.post("/api/members/batch", (c) => {
		const ctx = c.var.routeCtx;
		return ctx.withRoleMutation(async () => {
			const { broadcast } = ctx;
			const res = c.var.nodeRes!;
			const actor = c.var.actor;
			if (!requireActiveActor(res, actor)) return c.body(null);
			const body = await parseJsonBody(c);
			const rawList = Array.isArray(body.members) ? body.members : [];
			if (rawList.length === 0 || rawList.length > 8) {
				throw new HttpRequestError(400, "members must be an array of 1 to 8 role payloads");
			}
			const created = await materializeMembersBatch(
				ctx,
				toLegacyRouteRequest(c),
				planMembersBatch(ctx, actor, rawList),
			);
			for (const member of created) {
				broadcastTeamUpdateForMember(broadcast, { memberIds: [member.id] }, member);
			}
			return c.json({ members: created }, 201);
		});
	});

	app.post("/api/members/adjustments/apply", (c) => {
		const ctx = c.var.routeCtx;
		return ctx.withRoleMutation(async () => {
			const { broadcast } = ctx;
			const res = c.var.nodeRes!;
			const actor = c.var.actor;
			if (!requireActiveActor(res, actor)) return c.body(null);
			const body = await parseJsonBody(c);
			const rawList = Array.isArray(body.adjustments) ? body.adjustments : [];
			if (rawList.length === 0 || rawList.length > 8) {
				throw new HttpRequestError(400, "adjustments must be an array of 1 to 8 role updates");
			}
			const updatedMembers = await applyRoleAdjustmentsBatch(
				ctx,
				toLegacyRouteRequest(c),
				planRoleAdjustmentsBatch(ctx, actor, rawList),
			);
			for (const member of updatedMembers) {
				broadcastTeamUpdateForMember(broadcast, { memberIds: [member.id] }, member);
			}
			return c.json({ members: updatedMembers });
		});
	});

	app.post("/api/members/import", (c) => {
		const ctx = c.var.routeCtx;
		return ctx.withRoleMutation(async () => {
			const { store, orchestrator, rolesDir, broadcast } = ctx;
			const req = c.var.nodeReq!;
			const res = c.var.nodeRes!;
			const actor = c.var.actor;
			if (!requireActiveActor(res, actor)) return c.body(null);
			const body = await parseJsonBody(c);
			const markdown = typeof body.markdown === "string" ? body.markdown : "";
			if (!markdown.trim()) {
				throw new HttpRequestError(400, "markdown is required");
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
			return c.json({ member }, 201);
		});
	});

	app.post("/api/members", (c) => {
		const ctx = c.var.routeCtx;
		return ctx.withRoleMutation(async () => {
			const { broadcast } = ctx;
			const res = c.var.nodeRes!;
			const actor = c.var.actor;
			if (!requireActiveActor(res, actor)) return c.body(null);
			const body = await parseJsonBody(c);
			const [member] = await materializeMembersBatch(
				ctx,
				toLegacyRouteRequest(c),
				planMembersBatch(ctx, actor, [body]),
			);
			if (!member) throw new Error("Member creation returned no result");
			broadcastTeamUpdateForMember(broadcast, { memberId: member.id }, member);
			return c.json({ member }, 201);
		});
	});

	app.patch("/api/members/:memberId", (c) => {
		const ctx = c.var.routeCtx;
		return ctx.withRoleMutation(async () => {
			const { store, broadcast } = ctx;
			const res = c.var.nodeRes!;
			const actor = c.var.actor;
			if (!requireActiveActor(res, actor)) return c.body(null);
			const memberId = c.req.param("memberId");
			const existing = store.getMember(memberId);
			if (!existing) {
				throw new HttpRequestError(404, `Member not found: ${memberId}`);
			}
			if (!canActorManageMember(store, actor, existing)) {
				throw new HttpRequestError(403, "无权编辑该 AI 角色的署名与资料");
			}
			const body = await parseJsonBody(c);
			const member = store.updateMemberIdentity(memberId, {
				displayName: typeof body.displayName === "string" ? body.displayName : undefined,
				roleTitle: typeof body.roleTitle === "string" ? body.roleTitle : undefined,
				gitName: typeof body.gitName === "string" ? body.gitName : undefined,
				gitEmail: typeof body.gitEmail === "string" ? body.gitEmail : undefined,
				identitySummary: typeof body.identitySummary === "string" ? body.identitySummary : undefined,
			});
			broadcastTeamUpdateForMember(broadcast, { memberId: member.id }, member);
			return c.json({ member });
		});
	});

	app.delete("/api/members/:memberId", (c) => {
		const ctx = c.var.routeCtx;
		return ctx.withRoleMutation(async () => {
			const { store, orchestrator, rolesDir, broadcast } = ctx;
			const req = c.var.nodeReq!;
			const res = c.var.nodeRes!;
			const actor = c.var.actor;
			if (!requireActiveActor(res, actor)) return c.body(null);
			const memberId = c.req.param("memberId");
			const existing = store.getMember(memberId);
			if (!existing) {
				throw new HttpRequestError(404, `Member not found: ${memberId}`);
			}
			if (!canActorManageMember(store, actor, existing)) {
				throw new HttpRequestError(403, "无权删除该 AI 角色");
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
				return c.json({ ok: true, deletedMemberId: deleted.id });
			} catch (error) {
				throw new HttpRequestError(409, error instanceof Error ? error.message : String(error));
			}
		});
	});

	app.post("/api/members/:memberId/primary", (c) => {
		const ctx = c.var.routeCtx;
		return ctx.withRoleMutation(async () => {
			const { store, broadcast } = ctx;
			const res = c.var.nodeRes!;
			const actor = c.var.actor;
			if (!requireOwner(res, actor)) return c.body(null);
			const memberId = c.req.param("memberId");
			const existing = store.getMember(memberId);
			if (!existing) {
				throw new HttpRequestError(404, `Member not found: ${memberId}`);
			}
			if (existing.roleScope !== "global") {
				throw new HttpRequestError(400, "仅平台通用（global）AI 角色可设为全局默认主联系人");
			}
			const member = store.setPrimaryContact(memberId);
			broadcast("team_updated", { memberId: member.id });
			return c.json({ member });
		});
	});

	app.get("/api/members/:memberId/skills/detail", (c) => {
		const ctx = c.var.routeCtx;
		const { store, orchestrator } = ctx;
		const res = c.var.nodeRes!;
		const actor = c.var.actor;
		if (!requireActiveActor(res, actor)) return c.body(null);
		const memberId = c.req.param("memberId");
		const member = store.getMember(memberId);
		if (!member) {
			throw new HttpRequestError(404, `Member not found: ${memberId}`);
		}
		if (!canActorUseMember(store, actor, member)) {
			throw new HttpRequestError(403, "无权查看其他组织或他人的私有角色技能");
		}
		const template = orchestrator.getTemplateForMember(member);
		if (!template) {
			throw new HttpRequestError(404, `Role template not found for member: ${memberId}`);
		}
		const skillRef = (c.req.query("skill") ?? "").trim();
		if (!skillRef || !template.skills.includes(skillRef)) {
			throw new HttpRequestError(404, "该角色未声明此技能");
		}
		const resolvedPath = resolveRoleSkillPath(skillRef, template, { skillsDir: ctx.skillsDir });
		if (!resolvedPath || !existsSync(resolvedPath)) {
			throw new HttpRequestError(404, `未在磁盘找到技能文件：${skillRef}`);
		}
		const MAX_CHARS = 64 * 1024;
		const readBounded = (target: string) => {
			const raw = readFileSync(target, "utf8");
			return raw.length <= MAX_CHARS ? raw : `${raw.slice(0, MAX_CHARS)}\n\n…（内容超过 64KB，已截断预览）`;
		};
		const skillDir = dirname(resolvedPath);
		const scriptsDir = resolve(skillDir, "scripts");
		const scripts: Array<{ path: string; content: string }> = [];
		if (existsSync(scriptsDir)) {
			try {
				for (const entry of readdirSync(scriptsDir, { withFileTypes: true })) {
					if (!entry.isFile() || entry.name.startsWith(".")) continue;
					scripts.push({
						path: `scripts/${entry.name}`,
						content: readBounded(resolve(scriptsDir, entry.name)),
					});
				}
				scripts.sort((a, b) => a.path.localeCompare(b.path));
			} catch {
				// Ignore unreadable scripts directory
			}
		}
		const isOwner = isSuperAdminActor(actor) || actor.authKind === "loopback";
		const nameMatch = skillRef.match(/^skills\/([^/]+)\/SKILL\.md$/);
		return c.json({
			detail: {
				name: nameMatch?.[1] ?? skillRef,
				skillRef,
				filePath: isOwner ? resolvedPath : basename(resolvedPath),
				content: readBounded(resolvedPath),
				scripts,
			},
		});
	});

	app.get("/api/members/:memberId/export", (c) => {
		const { store, orchestrator } = c.var.routeCtx;
		const res = c.var.nodeRes!;
		const actor = c.var.actor;
		if (!requireActiveActor(res, actor)) return c.body(null);
		const memberId = c.req.param("memberId");
		const member = store.getMember(memberId);
		if (!member) {
			throw new HttpRequestError(404, `Member not found: ${memberId}`);
		}
		if (!canActorUseMember(store, actor, member)) {
			throw new HttpRequestError(403, "无权导出其他组织或他人的私有角色");
		}
		const template = orchestrator.getTemplateForMember(member);
		if (!template) {
			throw new HttpRequestError(404, `Role template not found for member: ${memberId}`);
		}
		const markdown = serializeRoleTemplateMarkdown(template);
		return c.json({ id: template.id, filename: `${template.id}.md`, markdown });
	});
}
