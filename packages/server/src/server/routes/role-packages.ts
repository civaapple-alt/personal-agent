import type { SseEventPayloadMap } from "@pa/contracts/sse-events";
import { validateSkillReference } from "../../roles/capabilities.ts";
import {
	applyRoleTemplatePatch,
	normalizeRoleTools,
	ROLE_ARCHITECT_MEMBER_ID,
	type RoleTemplatePatch,
} from "../../roles/role-architect.ts";
import {
	allowedSkillScopesForRole,
	assertNewSkillNamesAvailable,
	buildScopedRoleId,
	SkillNameConflictError,
	saveRolePackage,
	validateNewSkillDrafts,
} from "../../roles/role-package-store.ts";
import { formatRoleTemplateBody, parseRoleScope, validateRoleTemplateId } from "../../roles/template-loader.ts";
import type { NewSkillDraft, RoleScope, RoleTemplate } from "../../roles/types.ts";
import type { TeamMember } from "../../storage/types.ts";
import { canActorCreateRoleInScope, canActorManageMember, canManageOrganization } from "../acl.ts";
import { isSuperAdminActor, type RequestActor } from "../auth.ts";
import { HttpRequestError } from "../http.ts";
import { auditActorAction, type RouteRequest, type ServerRouteContext } from "./context.ts";

interface PlannedMember {
	template: RoleTemplate;
	identity: Parameters<ServerRouteContext["store"]["updateMemberIdentity"]>[1];
	newSkills: NewSkillDraft[];
}

interface ResolvedRoleScopeTarget {
	roleScope: RoleScope;
	ownerOrgId: string | null;
	ownerUserId: string | null;
}

export function broadcastTeamUpdateForMember(
	broadcast: ServerRouteContext["broadcast"],
	payload: SseEventPayloadMap["team_updated"],
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

export function resolveMemberTargetScope(
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

export function enforcePersonalQuotaForBatch(
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
	if ([name, title, ...keywords, ...skills, ...antiJobs].some((value) => /[\r\n]/.test(value))) {
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

export function planMembersBatch(
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

export async function materializeMembersBatch(
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

export function planRoleAdjustmentsBatch(
	ctx: ServerRouteContext,
	actor: RequestActor,
	rawList: unknown[],
): RoleTemplate[] {
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

export async function applyRoleAdjustmentsBatch(
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
