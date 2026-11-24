import { isSkillStorageTarget, readSkillProposals, type SkillStorageTarget } from "@pa/contracts/skill-proposal";
import { readHumanDecision } from "../../orchestrator/human-decision.ts";
import { validateSkillReference } from "../../roles/capabilities.ts";
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
		(r.method === "POST" &&
			(r.pathname.endsWith("/apply-role-proposals") || r.pathname.endsWith("/skill-proposals")));
	return mutation ? ctx.withRoleMutation(() => handleTeamRoutesUnlocked(ctx, r)) : handleTeamRoutesUnlocked(ctx, r);
}

async function handleTeamRoutesUnlocked(ctx: ServerRouteContext, r: RouteRequest): Promise<boolean> {
	const { store, orchestrator, rolesDir, broadcast } = ctx;
	const { req, res, method, pathname, actor } = r;

	const skillProposalMatch = pathname.match(/^\/api\/matters\/([^/]+)\/messages\/([^/]+)\/skill-proposals$/);
	if (method === "POST" && skillProposalMatch) {
		if (!requireActiveActor(res, actor)) return true;
		const matterId = decodeURIComponent(skillProposalMatch[1]!);
		const messageId = decodeURIComponent(skillProposalMatch[2]!);
		const matter = store.getMatter(matterId);
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
		const proposals = readSkillProposals(targetMsg.metadata);
		if (proposals.length === 0) {
			sendError(res, 409, "Message does not carry skill proposals");
			return true;
		}
		const body = await readJsonBody(req);
		const proposalId = typeof body.proposalId === "string" ? body.proposalId.trim() : "";
		const action = body.action === "dismiss" ? "dismiss" : "apply";
		const idx = proposals.findIndex((item) => item.id === proposalId);
		if (idx < 0) {
			sendError(res, 404, `Skill proposal not found: ${proposalId}`);
			return true;
		}
		const targetProposal = proposals[idx]!;
		const targetScope: SkillStorageTarget = isSkillStorageTarget(body.storageScope)
			? body.storageScope
			: targetProposal.storageScope;
		const canManageOrg = isSuperAdminActor(actor) || canManageOrganization(store, actor, matter.orgId);
		const isViewer = isViewerInAllOrgsOrTarget(store, actor, matter.orgId);
		if (isViewer) {
			sendError(res, 403, "只读成员无权处理技能提案");
			return true;
		}
		if (action === "dismiss") {
			if (targetProposal.status === "applied") {
				sendError(res, 409, "Applied skill proposals cannot be dismissed");
				return true;
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
			sendJson(res, 200, { ok: true, writtenPaths: [], message: updatedMsg, matter });
			return true;
		}

		if (targetProposal.status !== "pending") {
			sendError(res, 409, "Only pending skill proposals may be applied");
			return true;
		}
		if (targetScope === "global" && !isSuperAdminActor(actor) && actor.authKind !== "loopback") {
			sendError(res, 403, "仅超级管理员可将技能沉淀到全局范围");
			return true;
		}
		if (targetScope === "org" && !canManageOrg) {
			sendError(res, 403, "仅组织管理员或所有者可将技能沉淀到组织范围");
			return true;
		}
		const workspace = matter.workspaceId ? store.getWorkspace(matter.workspaceId) : null;
		if (targetScope === "workspace" && !workspace) {
			sendError(res, 409, "当前事项未绑定工作区，无法写入工作区 .agents/skills/");
			return true;
		}
		try {
			const { writtenPaths } = await saveSkillProposalToDisk({
				proposal: targetProposal,
				storageScope: targetScope,
				skillsDir: ctx.skillsDir,
				orgId: matter.orgId,
				userId: actor.user?.id ?? null,
				workspaceRepoPath: workspace?.repoPath ?? null,
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
			sendJson(res, 200, { ok: true, writtenPaths, message: updatedMsg, matter });
		} catch (error) {
			const status = error instanceof SkillNameConflictError ? 409 : 400;
			sendError(res, status, error instanceof Error ? error.message : String(error));
		}
		return true;
	}

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
			sendError(res, 409, "此提案已有更新，请在最新一版中确认角色");
			return true;
		}
		if (readHumanDecision(targetMsg.metadata)?.kind === "role_clarification") {
			sendError(res, 409, "请先完成角色澄清，再确认架构师更新后的提案");
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

		const matterOrgId = matter.orgId;
		const memberPlans = planMembersBatch(ctx, actor, rawMembers, { fallbackOrgId: matterOrgId });
		if (
			matterJoinMode !== "none" &&
			memberPlans.some(({ template }) => template.roleScope === "org" && template.ownerOrgId !== matterOrgId)
		) {
			sendError(res, 400, "另一组织的角色可以创建到其团队库。加入本事项时请选择当前组织");
			return true;
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
