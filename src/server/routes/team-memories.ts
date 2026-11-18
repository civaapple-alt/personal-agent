import { DistillationMemberAccessError } from "../../orchestrator/distiller.ts";
import type { MetaArchitectMessage } from "../../orchestrator/meta-architect.ts";
import { PiDecisionError } from "../../orchestrator/pi-decision.ts";
import { assessRoleCapabilities, validateSkillReference } from "../../roles/capabilities.ts";
import {
	applyRoleTemplatePatch,
	buildRoleDesignDraft,
	normalizeRoleTools,
	normalizeRoleVerificationPlan,
	ROLE_ARCHITECT_MEMBER_ID,
	type RoleInteractionStyle,
	type RoleTemplatePatch,
	type RoleWorkspaceScope,
} from "../../roles/role-architect.ts";
import {
	allowedSkillScopesForRole,
	assertNewSkillNamesAvailable,
	buildScopedRoleId,
	deleteRolePackage,
	SkillNameConflictError,
	saveRolePackage,
	validateNewSkillDrafts,
} from "../../roles/role-package-store.ts";
import {
	formatRoleTemplateBody,
	parseRoleScope,
	parseRoleTemplateMarkdown,
	parseRoleThinkingLevel,
	serializeRoleTemplateMarkdown,
	validateRoleTemplateId,
} from "../../roles/template-loader.ts";
import type { NewSkillDraft, RoleScope, RoleTemplate } from "../../roles/types.ts";
import type { ThinkingLevel } from "../../rpc/types.ts";
import type { PersonalAgentStore } from "../../storage/repositories.ts";
import { normalizeMemoryCategory } from "../../storage/repositories.ts";
import type { FeedbackRating, MemoryCategory, MemoryScope, MemoryStatus, TeamMember } from "../../storage/types.ts";
import {
	canAccessMatter,
	canAccessOrganization,
	canAccessWorkspace,
	canActorAccessMemory,
	canActorCreateRoleInScope,
	canActorManageMember,
	canActorUseMember,
	canDistillMatter,
	canManageOrganization,
	isGlobalUnscopedActor,
	isViewerInAllOrgsOrTarget,
	resolveActorAccessibleOrgIds,
} from "../acl.ts";
import { isSuperAdminActor, type RequestActor, requireActiveActor, requireOwner } from "../auth.ts";
import { HttpRequestError, readJsonBody, responseCancellation, sendError, sendJson } from "../http.ts";
import {
	auditActorAction,
	broadcastMemoryUpdates,
	MEMORY_CATEGORIES,
	type RouteRequest,
	type ServerRouteContext,
} from "./context.ts";

interface PlannedMember {
	template: RoleTemplate;
	identity: Parameters<ServerRouteContext["store"]["updateMemberIdentity"]>[1];
	newSkills: NewSkillDraft[];
}

function canActorManageMemoryEntry(
	store: PersonalAgentStore,
	actor: RequestActor,
	input: {
		member: Pick<TeamMember, "roleScope" | "ownerOrgId" | "ownerUserId"> | null | undefined;
		scope: MemoryScope;
		orgId?: string | null;
		workspaceId?: string | null;
	},
): boolean {
	if (isGlobalUnscopedActor(actor) || isSuperAdminActor(actor)) return true;
	if (!input.member) return false;
	if (input.member.roleScope === "personal") {
		return canActorManageMember(store, actor, input.member);
	}
	if (input.scope === "role_general") {
		return (
			input.member.roleScope === "org" &&
			Boolean(input.member.ownerOrgId && canManageOrganization(store, actor, input.member.ownerOrgId))
		);
	}
	if (input.scope === "company_private") {
		return Boolean(input.orgId && canManageOrganization(store, actor, input.orgId));
	}
	const ws = input.workspaceId ? store.getWorkspace(input.workspaceId) : null;
	return Boolean(ws?.orgId && canManageOrganization(store, actor, ws.orgId));
}

interface ResolvedRoleScopeTarget {
	roleScope: RoleScope;
	ownerOrgId: string | null;
	ownerUserId: string | null;
}

function broadcastTeamUpdateForMember(
	broadcast: ServerRouteContext["broadcast"],
	payload: unknown,
	member: Pick<TeamMember, "roleScope" | "ownerOrgId" | "ownerUserId">,
): void {
	if (member.roleScope === "personal") {
		broadcast("team_updated", payload, { userId: member.ownerUserId ?? null });
		return;
	}
	if (member.roleScope === "org") {
		broadcast("team_updated", payload, { orgId: member.ownerOrgId ?? null });
		return;
	}
	broadcast("team_updated", payload);
}

function resolveMemberTargetScope(
	ctx: ServerRouteContext,
	actor: RequestActor,
	rec: Record<string, unknown>,
	fallbackOrgId?: string | null,
): ResolvedRoleScopeTarget {
	const { store } = ctx;
	const hasExplicitScope = Object.hasOwn(rec, "roleScope") && rec.roleScope !== undefined && rec.roleScope !== null;
	const parsedExplicitScope = hasExplicitScope ? parseRoleScope(rec.roleScope) : undefined;
	if (hasExplicitScope && !parsedExplicitScope) {
		throw new HttpRequestError(400, "roleScope 必须是 global、org 或 personal");
	}
	const explicitOrgId = typeof rec.ownerOrgId === "string" && rec.ownerOrgId.trim() ? rec.ownerOrgId.trim() : null;

	let roleScope: RoleScope;
	if (parsedExplicitScope) {
		roleScope = parsedExplicitScope;
	} else if (explicitOrgId) {
		roleScope = "org";
	} else if (isSuperAdminActor(actor)) {
		roleScope = "global";
	} else if (fallbackOrgId && canManageOrganization(store, actor, fallbackOrgId)) {
		roleScope = "org";
	} else if (actor.authKind === "session" && actor.user) {
		const manageableOrg = store
			.listUserOrganizations(actor.user.id)
			.find((org) => org.orgRole === "org_owner" || org.orgRole === "org_admin");
		roleScope = manageableOrg ? "org" : "personal";
	} else {
		roleScope = "personal";
	}

	let ownerOrgId: string | null = null;
	if (roleScope === "org") {
		ownerOrgId = explicitOrgId ?? fallbackOrgId ?? null;
		if (!ownerOrgId && actor.user) {
			const manageableOrg = store
				.listUserOrganizations(actor.user.id)
				.find((org) => org.orgRole === "org_owner" || org.orgRole === "org_admin");
			ownerOrgId = manageableOrg?.id ?? null;
		}
		if (ownerOrgId && !store.getOrganization(ownerOrgId)) {
			throw new HttpRequestError(404, `Organization not found: ${ownerOrgId}`);
		}
	}

	const check = canActorCreateRoleInScope(store, actor, roleScope, ownerOrgId);
	if (!check.allowed) {
		throw new HttpRequestError(403, check.reason ?? "无权在此范围创建 AI 角色");
	}
	return {
		roleScope,
		ownerOrgId: roleScope === "org" ? ownerOrgId : null,
		ownerUserId: roleScope === "personal" ? (actor.user?.id ?? null) : null,
	};
}

function enforcePersonalQuotaForBatch(
	ctx: ServerRouteContext,
	actor: RequestActor,
	plannedList: Array<Pick<RoleTemplate, "roleScope">>,
): void {
	if (isSuperAdminActor(actor) || !actor.user) return;
	const newPersonalCount = plannedList.filter((item) => item.roleScope === "personal").length;
	if (newPersonalCount === 0) return;
	const current = ctx.store.countPersonalRoles(actor.user.id);
	if (current + newPersonalCount > actor.user.maxPersonalRoles) {
		throw new HttpRequestError(
			403,
			`个人私有 AI 角色已达配额上限（${current}/${actor.user.maxPersonalRoles}），如需扩容请联系超级管理员`,
		);
	}
}

function planMemberFromBody(
	ctx: ServerRouteContext,
	actor: RequestActor,
	body: Record<string, unknown>,
	existingIds: Set<string>,
	options?: { fallbackOrgId?: string | null },
): PlannedMember {
	const name = typeof body.name === "string" ? body.name.trim() : "";
	const title = typeof body.title === "string" ? body.title.trim() : "";
	if (!name || !title) {
		throw new HttpRequestError(400, "name and title are required");
	}
	const scopeTarget = resolveMemberTargetScope(ctx, actor, body, options?.fallbackOrgId);
	const responsibilities =
		typeof body.responsibilities === "string" && body.responsibilities.trim().length > 0
			? body.responsibilities.trim()
			: `- 承担 ${name} 的核心岗位职责与交付产出。`;
	const hasExplicitId = typeof body.id === "string" && body.id.trim().length > 0;
	const rawBaseId = hasExplicitId
		? String(body.id).trim()
		: title
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/^-|-$/g, "") || `role-${Date.now()}`;
	let rawId: string;
	if (scopeTarget.roleScope === "global") {
		rawId = rawBaseId;
		if (!hasExplicitId && existingIds.has(rawId)) {
			let idx = 2;
			while (existingIds.has(`${rawId}-${idx}`)) idx += 1;
			rawId = `${rawId}-${idx}`;
		}
		try {
			validateRoleTemplateId(rawId);
		} catch (error) {
			throw new HttpRequestError(400, error instanceof Error ? error.message : String(error));
		}
		if (rawId === ROLE_ARCHITECT_MEMBER_ID || existingIds.has(rawId)) {
			throw new HttpRequestError(409, `Role id already exists or is reserved: ${rawId}`);
		}
	} else {
		if (rawBaseId === ROLE_ARCHITECT_MEMBER_ID) {
			throw new HttpRequestError(409, `Role id already exists or is reserved: ${rawBaseId}`);
		}
		try {
			validateRoleTemplateId(rawBaseId);
		} catch (error) {
			throw new HttpRequestError(400, error instanceof Error ? error.message : String(error));
		}
		rawId = buildScopedRoleId({
			baseId: rawBaseId,
			roleScope: scopeTarget.roleScope,
			ownerOrgId: scopeTarget.ownerOrgId,
			ownerUserId: scopeTarget.ownerUserId,
			existingIds,
			allowCollisionSuffix: !hasExplicitId,
		});
		if (existingIds.has(rawId)) {
			throw new HttpRequestError(409, `Role id already exists: ${rawId}`);
		}
	}
	existingIds.add(rawId);
	const keywords = Array.isArray(body.keywords)
		? body.keywords.map(String).filter(Boolean)
		: typeof body.keywords === "string"
			? body.keywords
					.split(/[,，\s]+/)
					.map((s) => s.trim())
					.filter(Boolean)
			: [];
	const skills = Array.isArray(body.skills) ? body.skills.map(String).filter(Boolean) : [];
	for (const skillName of skills) {
		try {
			validateSkillReference(skillName);
		} catch (error) {
			throw new HttpRequestError(400, error instanceof Error ? error.message : String(error));
		}
	}
	const mcpDependencies = Array.isArray(body.mcpDependencies) ? body.mcpDependencies.map(String).filter(Boolean) : [];
	if (mcpDependencies.some((dep) => !/^[a-zA-Z0-9_-]+$/.test(dep)))
		throw new HttpRequestError(400, "Invalid MCP dependency name");
	const tools = normalizeRoleTools(Array.isArray(body.tools) ? body.tools.map(String) : undefined);
	const antiJobs = Array.isArray(body.antiJobs) ? body.antiJobs.map(String).filter(Boolean) : [];
	const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : "kimi-for-coding";
	const provider = typeof body.provider === "string" && body.provider.trim() ? body.provider.trim() : "kimi-coding";
	let thinkingLevel: ThinkingLevel;
	try {
		thinkingLevel = parseRoleThinkingLevel(body.thinkingLevel ?? "high");
	} catch (error) {
		throw new HttpRequestError(400, error instanceof Error ? error.message : String(error));
	}
	if ([name, title, model, provider, ...keywords, ...skills, ...antiJobs].some((value) => /[\r\n]/.test(value))) {
		throw new HttpRequestError(400, "Role metadata fields and array entries must each fit on one line");
	}
	let newSkills: NewSkillDraft[] = [];
	if (body.newSkills !== undefined) {
		try {
			newSkills = validateNewSkillDrafts(body.newSkills, {
				roleScope: scopeTarget.roleScope,
				allowedScopes: allowedSkillScopesForRole(scopeTarget.roleScope, isSuperAdminActor(actor)),
			});
		} catch (error) {
			throw new HttpRequestError(400, error instanceof Error ? error.message : String(error));
		}
	}
	if (body.isPrimaryContact === true && scopeTarget.roleScope !== "global") {
		throw new HttpRequestError(400, "仅平台通用（global）AI 角色可设为全局默认主联系人");
	}
	const isPrimaryContact = scopeTarget.roleScope === "global" && body.isPrimaryContact === true;
	const customSections =
		body.sections && typeof body.sections === "object" ? (body.sections as Record<string, unknown>) : {};
	const skillsAndMethods =
		typeof customSections.skillsAndMethods === "string" && customSections.skillsAndMethods.trim()
			? customSections.skillsAndMethods.trim()
			: "- 围绕明确问题开展调研或核查，交付可验证的结果。";
	const toolsAndEnvironment =
		typeof customSections.toolsAndEnvironment === "string" && customSections.toolsAndEnvironment.trim()
			? customSections.toolsAndEnvironment.trim()
			: tools.length === 0
				? "- 纯分析与文稿协同，不挂载文件编辑与终端工具。"
				: `- 使用已声明的最小必要工具（${tools.join(", ")}）。`;
	const collaborationConventions =
		typeof customSections.collaborationConventions === "string" && customSections.collaborationConventions.trim()
			? customSections.collaborationConventions.trim()
			: "- 平时静默推进，关键节点请用户确认，内部协作留痕。";
	const deliveryAndVerification =
		typeof customSections.deliveryAndVerification === "string" && customSections.deliveryAndVerification.trim()
			? customSections.deliveryAndVerification.trim()
			: "- 产出结构化说明或可执行验证结果。";

	const sections = {
		responsibilitiesAndBoundaries: responsibilities,
		skillsAndMethods,
		toolsAndEnvironment,
		collaborationConventions,
		deliveryAndVerification,
	};

	const template: RoleTemplate = {
		id: rawId,
		name,
		title,
		roleScope: scopeTarget.roleScope,
		...(scopeTarget.ownerOrgId ? { ownerOrgId: scopeTarget.ownerOrgId } : {}),
		...(scopeTarget.ownerUserId ? { ownerUserId: scopeTarget.ownerUserId } : {}),
		version: "1.0.0",
		shareable: scopeTarget.roleScope === "global",
		defaultProvider: provider,
		defaultModel: model,
		thinkingLevel,
		isPrimaryContact,
		keywords,
		tools,
		skills,
		mcpDependencies,
		...(antiJobs.length > 0 ? { antiJobs } : {}),
		sections,
		rawBody: formatRoleTemplateBody(sections),
	};

	return {
		template,
		newSkills,
		identity: {
			gitName: typeof body.gitName === "string" ? body.gitName : undefined,
			gitEmail: typeof body.gitEmail === "string" ? body.gitEmail : undefined,
			identitySummary: typeof body.identitySummary === "string" ? body.identitySummary : undefined,
		},
	};
}

function planMembersBatch(
	ctx: ServerRouteContext,
	actor: RequestActor,
	rawList: unknown[],
	options?: { fallbackOrgId?: string | null },
): PlannedMember[] {
	const existingIds = new Set(ctx.store.listMembers().map((member) => member.id));
	const planned: PlannedMember[] = [];
	for (const item of rawList) {
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			throw new HttpRequestError(400, "Each item in members must be an object");
		}
		const rec = item as Record<string, unknown>;
		planned.push(planMemberFromBody(ctx, actor, rec, existingIds, options));
	}
	enforcePersonalQuotaForBatch(
		ctx,
		actor,
		planned.map((p) => p.template),
	);
	return planned;
}

async function materializeMembersBatch(
	ctx: ServerRouteContext,
	r: RouteRequest,
	planned: PlannedMember[],
): Promise<TeamMember[]> {
	const packages = planned.map(({ template, newSkills }) => ({
		rolesDir: ctx.rolesDir,
		skillsDir: ctx.skillsDir,
		template,
		newSkills,
	}));
	try {
		assertNewSkillNamesAvailable(packages);
	} catch (error) {
		if (error instanceof SkillNameConflictError) throw new HttpRequestError(409, error.message);
		throw error;
	}
	const created: TeamMember[] = [];
	for (const { template, identity, newSkills } of planned) {
		const saved = await saveRolePackage({
			rolesDir: ctx.rolesDir,
			skillsDir: ctx.skillsDir,
			template,
			newSkills,
		}).catch((error: unknown) => {
			if (error instanceof SkillNameConflictError) throw new HttpRequestError(409, error.message);
			throw error;
		});
		const member = ctx.orchestrator.registerRoleTemplate(saved.template);
		const updated = ctx.store.updateMemberIdentity(member.id, identity);
		created.push(updated);
		auditActorAction(ctx, r.req, r.actor, {
			action: "role.create",
			targetType: "role",
			targetId: updated.id,
			orgId: updated.ownerOrgId ?? null,
			detail: {
				roleScope: updated.roleScope,
				createdSkills: newSkills.map((s) => ({ name: s.name, storageScope: s.storageScope })),
			},
		});
	}
	return created;
}

function planRoleAdjustmentsBatch(ctx: ServerRouteContext, actor: RequestActor, rawList: unknown[]): RoleTemplate[] {
	const { store, orchestrator } = ctx;
	const planned: RoleTemplate[] = [];
	const seen = new Set<string>();
	for (const item of rawList) {
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			throw new HttpRequestError(400, "Each item in adjustments must be an object");
		}
		const rec = item as Record<string, unknown>;
		const memberId = typeof rec.memberId === "string" ? rec.memberId.trim() : "";
		const member = memberId ? store.getMember(memberId) : null;
		if (!member) {
			throw new HttpRequestError(
				memberId ? 404 : 400,
				memberId ? `Member not found: ${memberId}` : "memberId is required",
			);
		}
		if (!canActorManageMember(store, actor, member)) {
			throw new HttpRequestError(403, `无权调整角色 ${member.displayName} 的配置`);
		}
		const prev = orchestrator.getTemplateForMember(member);
		if (!prev) {
			throw new HttpRequestError(404, `Role template not found for member: ${memberId}`);
		}
		if (memberId === ROLE_ARCHITECT_MEMBER_ID || seen.has(memberId)) {
			throw new HttpRequestError(409, `Reserved or repeated role adjustment: ${memberId}`);
		}
		seen.add(memberId);
		const patch: RoleTemplatePatch = {
			...(Array.isArray(rec.tools) ? { tools: rec.tools.map(String) } : {}),
			...(Array.isArray(rec.addAntiJobs) ? { addAntiJobs: rec.addAntiJobs.map(String).filter(Boolean) } : {}),
			...(typeof rec.workflowNote === "string" && rec.workflowNote.trim()
				? { workflowNote: rec.workflowNote.trim() }
				: {}),
		};
		if (patch.tools === undefined && (!patch.addAntiJobs || patch.addAntiJobs.length === 0) && !patch.workflowNote) {
			throw new HttpRequestError(400, `Adjustment for ${memberId} has no changes to apply`);
		}
		const patched = applyRoleTemplatePatch(prev, patch);
		patched.roleScope = member.roleScope;
		patched.ownerOrgId = member.ownerOrgId ?? null;
		patched.ownerUserId = member.ownerUserId ?? null;
		planned.push(patched);
	}
	return planned;
}

async function applyRoleAdjustmentsBatch(
	ctx: ServerRouteContext,
	r: RouteRequest,
	planned: RoleTemplate[],
): Promise<TeamMember[]> {
	const { orchestrator, rolesDir, skillsDir } = ctx;
	const updatedMembers: TeamMember[] = [];
	for (const next of planned) {
		const saved = await saveRolePackage({ rolesDir, skillsDir, template: next });
		const member = orchestrator.registerRoleTemplate(saved.template);
		updatedMembers.push(member);
		auditActorAction(ctx, r.req, r.actor, {
			action: "role.adjust",
			targetType: "role",
			targetId: member.id,
			orgId: member.ownerOrgId ?? null,
			detail: { roleScope: member.roleScope },
		});
	}
	return updatedMembers;
}

/** Handle AI team members, role architect Meta-Bot, role template import/export, memories, and RSI distillation. */
export async function handleTeamMemoryRoutes(ctx: ServerRouteContext, r: RouteRequest): Promise<boolean> {
	const mutation =
		(r.method !== "GET" &&
			/^\/api\/members(?:\/|$)/.test(r.pathname) &&
			r.pathname !== "/api/members/architect/chat" &&
			r.pathname !== "/api/members/design") ||
		(r.method === "POST" && r.pathname.endsWith("/apply-role-proposals"));
	return mutation
		? ctx.withRoleMutation(() => handleTeamMemoryRoutesUnlocked(ctx, r))
		: handleTeamMemoryRoutesUnlocked(ctx, r);
}

async function handleTeamMemoryRoutesUnlocked(ctx: ServerRouteContext, r: RouteRequest): Promise<boolean> {
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

	if (method === "POST" && pathname === "/api/members/architect/chat") {
		if (!requireActiveActor(res, actor)) return true;
		const body = await readJsonBody(req);
		const rawMessages = Array.isArray(body.messages) ? body.messages : [];
		const messages: MetaArchitectMessage[] = rawMessages
			.map((item) => {
				if (!item || typeof item !== "object") return null;
				const rec = item as Record<string, unknown>;
				const role = rec.role === "assistant" ? "assistant" : rec.role === "user" ? "user" : null;
				const content = typeof rec.content === "string" ? rec.content.trim() : "";
				return role && content ? { role, content } : null;
			})
			.filter((m): m is MetaArchitectMessage => m !== null);
		if (messages.length === 0) {
			sendError(res, 400, "messages array with at least one message is required");
			return true;
		}
		const workspaceId =
			typeof body.workspaceId === "string" && body.workspaceId.trim().length > 0 ? body.workspaceId.trim() : null;
		const workspace = workspaceId ? store.getWorkspace(workspaceId) : null;
		if (workspaceId && !workspace) {
			sendError(res, 404, `Workspace not found: ${workspaceId}`);
			return true;
		}
		if (workspace && !canAccessWorkspace(store, actor, workspace)) {
			sendError(res, 403, "无权访问所选项目仓库");
			return true;
		}
		const explicitOrgId = typeof body.orgId === "string" && body.orgId.trim().length > 0 ? body.orgId.trim() : null;
		if (explicitOrgId && !store.getOrganization(explicitOrgId)) {
			sendError(res, 404, `Organization not found: ${explicitOrgId}`);
			return true;
		}
		const effectiveOrgId = explicitOrgId ?? workspace?.orgId ?? null;
		if (effectiveOrgId && !canAccessOrganization(store, actor, effectiveOrgId)) {
			sendError(res, 403, "无权访问所选组织");
			return true;
		}
		if (
			(actor.authKind === "legacy_token" && actor.collaborator.permissionRole !== "owner") ||
			isViewerInAllOrgsOrTarget(store, actor, effectiveOrgId)
		) {
			sendError(res, 403, "只读成员或访客口令不支持调用角色架构师");
			return true;
		}
		const targetScope = resolveMemberTargetScope(ctx, actor, body, effectiveOrgId);
		const canRunOrgHealthcheck =
			isSuperAdminActor(actor) ||
			(effectiveOrgId
				? canManageOrganization(store, actor, effectiveOrgId)
				: Boolean(
						actor.user &&
							store
								.listUserOrganizations(actor.user.id)
								.some((org) => org.orgRole === "org_owner" || org.orgRole === "org_admin"),
					));
		const cancellation = responseCancellation(res);
		try {
			const result = await orchestrator.chatWithRoleArchitect({
				messages,
				matterPrompt: typeof body.matterPrompt === "string" ? body.matterPrompt.trim() || undefined : undefined,
				workspaceId,
				orgId: targetScope.ownerOrgId ?? effectiveOrgId,
				targetRoleScope: targetScope.roleScope,
				actorUserId: actor.user?.id ?? null,
				allowedOrgIds: resolveActorAccessibleOrgIds(store, actor),
				isSuperAdmin: isSuperAdminActor(actor),
				includeHealthcheck: body.includeHealthcheck === true && canRunOrgHealthcheck,
				signal: cancellation.signal,
			});
			if (res.destroyed || cancellation.signal.aborted) return true;
			sendJson(res, 200, result);
		} finally {
			cancellation.dispose();
		}
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

	if (method === "POST" && pathname === "/api/members/design") {
		if (!requireActiveActor(res, actor)) return true;
		const body = await readJsonBody(req);
		const targetScope = resolveMemberTargetScope(ctx, actor, body);
		const oneJob = typeof body.oneJob === "string" ? body.oneJob.trim() : "";
		if (!oneJob) {
			sendError(res, 400, "oneJob is required");
			return true;
		}
		const antiJobs = Array.isArray(body.antiJobs)
			? body.antiJobs.map(String).filter(Boolean)
			: typeof body.antiJobs === "string"
				? body.antiJobs
						.split(/[\n;；]+/)
						.map((s) => s.trim())
						.filter(Boolean)
				: undefined;
		const keywords = Array.isArray(body.keywords) ? body.keywords.map(String).filter(Boolean) : undefined;
		const interactionStyle =
			body.interactionStyle === "lead_direct" ||
			body.interactionStyle === "consult_specialist" ||
			body.interactionStyle === "risk_observer" ||
			body.interactionStyle === "mixed"
				? (body.interactionStyle as RoleInteractionStyle)
				: undefined;
		const workspaceScope =
			body.workspaceScope === "read_write_code" ||
			body.workspaceScope === "read_only_repo" ||
			body.workspaceScope === "no_repo_docs"
				? (body.workspaceScope as RoleWorkspaceScope)
				: undefined;
		const skills = Array.isArray(body.skills)
			? body.skills.filter((value): value is string => typeof value === "string")
			: [];
		for (const s of skills) {
			try {
				validateSkillReference(s);
			} catch (error) {
				throw new HttpRequestError(400, error instanceof Error ? error.message : String(error));
			}
		}
		const visibleExistingIds = store
			.listMembers()
			.filter((m) => canActorUseMember(store, actor, m))
			.map((m) => m.id);
		const mode = body.mode === "model" || body.useModel === true ? "model" : "rules";
		const designInput = {
			oneJob,
			roleId: typeof body.roleId === "string" ? body.roleId : undefined,
			roleScope: targetScope.roleScope,
			ownerOrgId: targetScope.ownerOrgId,
			ownerUserId: targetScope.ownerUserId,
			antiJobs,
			quietWhen: typeof body.quietWhen === "string" ? body.quietWhen : undefined,
			interactionStyle,
			workspaceScope,
			roleName: typeof body.roleName === "string" ? body.roleName : undefined,
			roleTitle: typeof body.roleTitle === "string" ? body.roleTitle : undefined,
			keywords,
			workflowRules: typeof body.workflowRules === "string" ? body.workflowRules : undefined,
			constraints: typeof body.constraints === "string" ? body.constraints : undefined,
			skills,
			mcpDependencies: Array.isArray(body.mcpDependencies)
				? body.mcpDependencies.filter((value): value is string => typeof value === "string")
				: [],
			communicationStyle: typeof body.communicationStyle === "string" ? body.communicationStyle : undefined,
			verificationPlan: normalizeRoleVerificationPlan(body.verificationPlan),
			isPrimaryContact: targetScope.roleScope === "global" && body.isPrimaryContact === true,
			existingMemberIds: visibleExistingIds,
		};
		if (mode === "model") {
			const cancellation = responseCancellation(res);
			try {
				const draft = await orchestrator.designRoleWithModel({
					...designInput,
					allowedOrgIds: resolveActorAccessibleOrgIds(store, actor),
					signal: cancellation.signal,
				});
				if (res.destroyed || cancellation.signal.aborted) return true;
				sendJson(res, 200, draft);
			} catch (err) {
				if (res.destroyed || cancellation.signal.aborted) return true;
				if (err instanceof PiDecisionError) {
					sendError(res, err.kind === "aborted" ? 499 : 502, err.message);
					return true;
				}
				sendError(res, 502, err instanceof Error ? err.message : String(err));
			} finally {
				cancellation.dispose();
			}
			return true;
		}
		const draft = buildRoleDesignDraft(designInput);
		sendJson(res, 200, {
			...draft,
			designSource: "rules",
			capabilityReport: await assessRoleCapabilities(draft.template, { skillsDir: ctx.skillsDir }),
		});
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

	if (method === "POST" && pathname === "/api/memories") {
		if (!requireActiveActor(res, actor)) return true;
		const body = await readJsonBody(req);
		const memberId = typeof body.memberId === "string" ? body.memberId.trim() : "";
		const content = typeof body.content === "string" ? body.content.trim() : "";
		const scope = (typeof body.scope === "string" ? body.scope : "role_general") as MemoryScope;
		if (!memberId || !content) {
			sendError(res, 400, "memberId and content are required");
			return true;
		}
		const targetMember = store.getMember(memberId);
		if (!targetMember) {
			sendError(res, 404, `Member not found: ${memberId}`);
			return true;
		}
		if (scope !== "role_general" && scope !== "company_private" && scope !== "project_private") {
			sendError(res, 400, `Unsupported memory scope: ${scope}`);
			return true;
		}
		const category =
			body.category === undefined
				? "general"
				: typeof body.category === "string" && MEMORY_CATEGORIES.has(body.category as MemoryCategory)
					? normalizeMemoryCategory(body.category)
					: null;
		if (!category) {
			sendError(res, 400, `Unsupported memory category: ${String(body.category)}`);
			return true;
		}
		const orgId =
			scope === "company_private" && typeof body.orgId === "string" && body.orgId.trim() ? body.orgId.trim() : null;
		if (orgId && !store.getOrganization(orgId)) {
			sendError(res, 404, `Organization not found: ${orgId}`);
			return true;
		}
		const workspaceId =
			scope === "role_general" || orgId
				? null
				: typeof body.workspaceId === "string" && body.workspaceId
					? body.workspaceId
					: null;
		if (workspaceId && !store.getWorkspace(workspaceId)) {
			sendError(res, 404, `Workspace not found: ${workspaceId}`);
			return true;
		}
		if (
			(orgId && !canAccessOrganization(store, actor, orgId)) ||
			(workspaceId && !canAccessWorkspace(store, actor, store.getWorkspace(workspaceId))) ||
			!canActorManageMemoryEntry(store, actor, { member: targetMember, scope, orgId, workspaceId })
		) {
			sendError(res, 403, "仅所有者或对应组织管理员可为该范围沉淀经验");
			return true;
		}
		const rawStatus = body.status;
		const status: MemoryStatus =
			rawStatus === "candidate" || rawStatus === "verified" || rawStatus === "rejected" || rawStatus === "superseded"
				? rawStatus
				: body.verified === false
					? "candidate"
					: "verified";
		const memory = store.addMemory({
			memberId,
			scope,
			category,
			orgId,
			workspaceId,
			content,
			rationale: typeof body.rationale === "string" ? body.rationale.trim() : "",
			sourceMatterId: typeof body.sourceMatterId === "string" && body.sourceMatterId ? body.sourceMatterId : null,
			sourceDeliverableId:
				typeof body.sourceDeliverableId === "string" && body.sourceDeliverableId ? body.sourceDeliverableId : null,
			status,
			verified: status === "verified",
			supersedesMemoryId:
				typeof body.supersedesMemoryId === "string" && body.supersedesMemoryId ? body.supersedesMemoryId : null,
		});
		broadcastMemoryUpdates(broadcast, [memory]);
		sendJson(res, 201, { memory });
		return true;
	}

	const memoryAppsMatch = pathname.match(/^\/api\/memories\/([^/]+)\/applications$/);
	if (method === "GET" && memoryAppsMatch) {
		if (!requireActiveActor(res, actor)) return true;
		const memoryId = decodeURIComponent(memoryAppsMatch[1]!);
		const memory = store.getMemory(memoryId);
		if (!memory) {
			sendError(res, 404, `Memory not found: ${memoryId}`);
			return true;
		}
		if (!canActorAccessMemory(store, actor, memory)) {
			sendError(res, 403, "无权查看该经验的使用溯源");
			return true;
		}
		const apps = store.listMemoryApplications(memoryId).filter((app) => {
			const matter = store.getMatter(app.matterId);
			return Boolean(matter && canAccessMatter(store, actor, matter));
		});
		sendJson(res, 200, { memory, applications: apps });
		return true;
	}

	const memoryEvalMatch = pathname.match(/^\/api\/memories\/([^/]+)\/evaluate$/);
	if (method === "POST" && memoryEvalMatch) {
		if (!requireActiveActor(res, actor)) return true;
		const memoryId = decodeURIComponent(memoryEvalMatch[1]!);
		const existing = store.getMemory(memoryId);
		if (!existing) {
			sendError(res, 404, `Memory not found: ${memoryId}`);
			return true;
		}
		const existingMember = store.getMember(existing.memberId);
		if (
			!canActorAccessMemory(store, actor, existing) ||
			!canActorManageMemoryEntry(store, actor, {
				member: existingMember,
				scope: existing.scope,
				orgId: existing.orgId,
				workspaceId: existing.workspaceId,
			})
		) {
			sendError(res, 403, "无权评价该经验");
			return true;
		}
		const body = await readJsonBody(req);
		if (body.outcome !== "positive" && body.outcome !== "negative") {
			sendError(res, 400, "outcome must be positive or negative");
			return true;
		}
		const memory = store.evaluateMemory({
			memoryId,
			outcome: body.outcome === "positive" ? "feedback_positive" : "feedback_negative",
			matterId: typeof body.matterId === "string" && body.matterId ? body.matterId : existing.sourceMatterId,
			memberId: existing.memberId,
			note: typeof body.note === "string" ? body.note.trim() : "",
		});
		broadcastMemoryUpdates(broadcast, [memory]);
		sendJson(res, 200, { memory });
		return true;
	}

	const memoryPatchMatch = pathname.match(/^\/api\/memories\/([^/]+)$/);
	if (method === "PATCH" && memoryPatchMatch) {
		if (!requireActiveActor(res, actor)) return true;
		const memoryId = decodeURIComponent(memoryPatchMatch[1]!);
		const existing = store.getMemory(memoryId);
		if (!existing) {
			sendError(res, 404, `Memory not found: ${memoryId}`);
			return true;
		}
		const existingMember = store.getMember(existing.memberId);
		if (
			!canActorAccessMemory(store, actor, existing) ||
			!canActorManageMemoryEntry(store, actor, {
				member: existingMember,
				scope: existing.scope,
				orgId: existing.orgId,
				workspaceId: existing.workspaceId,
			})
		) {
			sendError(res, 403, "无权修改该经验");
			return true;
		}
		const body = await readJsonBody(req);
		const memberId = typeof body.memberId === "string" && body.memberId.trim() ? body.memberId.trim() : undefined;
		if (memberId && !store.getMember(memberId)) {
			sendError(res, 404, `Member not found: ${memberId}`);
			return true;
		}
		const scope = typeof body.scope === "string" ? (body.scope as MemoryScope) : undefined;
		if (scope && scope !== "role_general" && scope !== "company_private" && scope !== "project_private") {
			sendError(res, 400, `Unsupported memory scope: ${scope}`);
			return true;
		}
		const category =
			body.category === undefined
				? undefined
				: typeof body.category === "string" && MEMORY_CATEGORIES.has(body.category as MemoryCategory)
					? (body.category as MemoryCategory)
					: null;
		if (category === null) {
			sendError(res, 400, `Unsupported memory category: ${String(body.category)}`);
			return true;
		}
		const orgId =
			body.orgId === null
				? null
				: typeof body.orgId === "string" && body.orgId.trim()
					? body.orgId.trim()
					: undefined;
		if (orgId && !store.getOrganization(orgId)) {
			sendError(res, 404, `Organization not found: ${orgId}`);
			return true;
		}
		const workspaceId =
			body.workspaceId === null
				? null
				: typeof body.workspaceId === "string" && body.workspaceId
					? body.workspaceId
					: undefined;
		if (workspaceId && !store.getWorkspace(workspaceId)) {
			sendError(res, 404, `Workspace not found: ${workspaceId}`);
			return true;
		}
		const nextMemberId = memberId ?? existing.memberId;
		const nextScope = scope ?? existing.scope;
		const nextOrgId = orgId === undefined ? existing.orgId : orgId;
		const nextWorkspaceId = workspaceId === undefined ? existing.workspaceId : workspaceId;
		const nextMember = store.getMember(nextMemberId);
		if (
			!canActorAccessMemory(store, actor, {
				memberId: nextMemberId,
				scope: nextScope,
				orgId: nextOrgId,
				workspaceId: nextWorkspaceId,
			}) ||
			!canActorManageMemoryEntry(store, actor, {
				member: nextMember,
				scope: nextScope,
				orgId: nextOrgId,
				workspaceId: nextWorkspaceId,
			})
		) {
			sendError(res, 403, "无权将经验移至该角色或作用域");
			return true;
		}
		const status = typeof body.status === "string" ? (body.status as MemoryStatus) : undefined;
		if (
			status &&
			status !== "candidate" &&
			status !== "verified" &&
			status !== "rejected" &&
			status !== "superseded"
		) {
			sendError(res, 400, `Unsupported memory status: ${status}`);
			return true;
		}
		const memory = store.updateMemory(memoryId, {
			memberId,
			content: typeof body.content === "string" ? body.content : undefined,
			scope,
			category,
			orgId,
			workspaceId,
			status,
			rationale: typeof body.rationale === "string" ? body.rationale : undefined,
			supersedesMemoryId:
				body.supersedesMemoryId === null
					? null
					: typeof body.supersedesMemoryId === "string"
						? body.supersedesMemoryId
						: undefined,
		});
		if (
			existing.memberId !== memory.memberId ||
			existing.scope !== memory.scope ||
			existing.orgId !== memory.orgId ||
			existing.workspaceId !== memory.workspaceId
		) {
			broadcast("memory_updated", {}, { memory: existing });
		}
		broadcastMemoryUpdates(broadcast, [memory]);
		sendJson(res, 200, { memory });
		return true;
	}

	if (method === "POST" && pathname === "/api/rsi/distill/abort") {
		if (!requireActiveActor(res, actor)) return true;
		const body = await readJsonBody(req);
		const matterId = typeof body.matterId === "string" ? body.matterId.trim() : "";
		if (!matterId) {
			sendError(res, 400, "matterId is required");
			return true;
		}
		const matter = store.getMatter(matterId);
		if (!matter) {
			sendError(res, 404, `Matter not found: ${matterId}`);
			return true;
		}
		if (!canDistillMatter(store, actor, matter)) {
			sendError(res, 403, "仅所有者或对应组织管理员可中止该事项经验复盘");
			return true;
		}
		const aborted = orchestrator.abortDistillation(matterId);
		sendJson(res, 200, { ok: true, aborted });
		return true;
	}

	if (method === "POST" && pathname === "/api/rsi/distill") {
		if (!requireActiveActor(res, actor)) return true;
		const body = await readJsonBody(req);
		const matterId = typeof body.matterId === "string" ? body.matterId.trim() : "";
		if (!matterId) {
			sendError(res, 400, "matterId is required");
			return true;
		}
		const matter = store.getMatter(matterId);
		if (!matter) {
			sendError(res, 404, `Matter not found: ${matterId}`);
			return true;
		}
		if (!canDistillMatter(store, actor, matter)) {
			sendError(res, 403, "仅所有者或对应组织管理员可在该事项触发团队经验复盘");
			return true;
		}
		const deliverableId =
			typeof body.deliverableId === "string" && body.deliverableId.trim() ? body.deliverableId.trim() : undefined;
		if (deliverableId) {
			const targetDeliverable = store.getDeliverable(deliverableId);
			if (!targetDeliverable) {
				sendError(res, 404, `Deliverable not found: ${deliverableId}`);
				return true;
			}
			if (targetDeliverable.matterId !== matterId) {
				sendError(res, 400, "deliverableId does not belong to the specified matterId");
				return true;
			}
		}
		const memberId = typeof body.memberId === "string" && body.memberId.trim() ? body.memberId.trim() : undefined;
		const feedback = typeof body.feedback === "string" && body.feedback.trim() ? body.feedback.trim() : undefined;
		const rating: FeedbackRating | undefined =
			body.rating === "positive" || body.rating === "negative" || body.rating === "neutral"
				? body.rating
				: undefined;
		const scopeMode = body.scopeMode === "single" || body.scopeMode === "team" ? body.scopeMode : undefined;
		const cancellation = responseCancellation(res);
		try {
			const result = await orchestrator.distillExperiences({
				matterId,
				deliverableId,
				memberId,
				feedback,
				rating,
				scopeMode,
				signal: cancellation.signal,
				canReviewMember: (member) => canActorUseMember(store, actor, member),
			});
			broadcastMemoryUpdates(broadcast, result.createdMemories);
			sendJson(res, 200, {
				ok: true,
				...result,
				createdMemories: result.createdMemories.filter((memory) => canActorAccessMemory(store, actor, memory)),
			});
		} catch (err) {
			if (err instanceof DistillationMemberAccessError) throw new HttpRequestError(403, err.message);
			if (
				cancellation.signal.aborted ||
				(err instanceof Error && err.message === "Experience distillation was aborted")
			) {
				if (!res.writableEnded && !res.destroyed) {
					sendJson(res, 200, {
						ok: false,
						aborted: true,
						createdMemories: [],
						skippedDuplicates: 0,
						summary: "已取消 AI 经验复盘",
					});
				}
				return true;
			}
			throw err;
		} finally {
			cancellation.dispose();
		}
		return true;
	}

	return false;
}
