import type {
	AccountUserDto,
	CollaboratorDto,
	MetaArchitectBlueprintProposalDto,
	MetaArchitectFormationSuggestionDto,
	MetaArchitectHealthFindingDto,
	MetaArchitectRoleAdjustmentDto,
	OrganizationDto,
	RoleScope,
	RoleTemplateDto,
	SkillStorageScope,
	TeamMemberDto,
} from "./api.ts";

export interface RoleScopeChoiceDto {
	key: string;
	roleScope: RoleScope;
	ownerOrgId: string | null;
	label: string;
}

export function canMemberManageRole(
	member: Pick<TeamMemberDto, "roleScope" | "ownerOrgId" | "ownerUserId"> | null | undefined,
	ctx: {
		isSuperAdmin?: boolean;
		accountUser?: AccountUserDto | null;
		currentUser?: CollaboratorDto | null;
		organizations?: OrganizationDto[];
	},
): boolean {
	if (!member) return false;
	const scope = member.roleScope ?? (member.ownerUserId ? "personal" : member.ownerOrgId ? "org" : "global");
	if (scope === "personal") {
		if (ctx.accountUser) return Boolean(member.ownerUserId && member.ownerUserId === ctx.accountUser.id);
		return ctx.currentUser?.permissionRole !== "collaborator";
	}
	if (scope === "org") {
		if (ctx.isSuperAdmin) return true;
		const org = member.ownerOrgId ? ctx.organizations?.find((o) => o.id === member.ownerOrgId) : undefined;
		return org?.orgRole === "org_owner" || org?.orgRole === "org_admin";
	}
	return Boolean(ctx.isSuperAdmin || (!ctx.accountUser && ctx.currentUser?.permissionRole !== "collaborator"));
}

export function buildRoleScopeChoices(ctx: {
	isSuperAdmin?: boolean;
	accountUser?: AccountUserDto | null;
	currentUser?: CollaboratorDto | null;
	organizations?: OrganizationDto[];
}): RoleScopeChoiceDto[] {
	const choices: RoleScopeChoiceDto[] = [];
	const isLegacyCollab = !ctx.accountUser && ctx.currentUser?.permissionRole === "collaborator";
	const orgs = ctx.organizations ?? [];
	const manageableOrgs = ctx.isSuperAdmin
		? orgs
		: orgs.filter((org) => org.orgRole === "org_owner" || org.orgRole === "org_admin");
	const isViewerOnly =
		Boolean(ctx.accountUser && orgs.length > 0 && orgs.every((org) => org.orgRole === "org_viewer")) &&
		!ctx.isSuperAdmin;

	if (ctx.isSuperAdmin) {
		choices.push({ key: "global", roleScope: "global", ownerOrgId: null, label: "平台通用（所有组织可用）" });
	}
	for (const org of manageableOrgs) {
		choices.push({
			key: `org:${org.id}`,
			roleScope: "org",
			ownerOrgId: org.id,
			label: `组织共享 · ${org.name}`,
		});
	}
	if (!isLegacyCollab && !isViewerOnly) {
		choices.push({ key: "personal", roleScope: "personal", ownerOrgId: null, label: "个人私有（仅我可用）" });
	}
	return choices;
}

export function allowedSkillScopesForRoleScope(
	roleScope: RoleScope,
	isSuperAdmin: boolean,
): Array<{ value: SkillStorageScope; label: string }> {
	const items: Array<{ value: SkillStorageScope; label: string }> = [
		{ value: "role_local", label: "本角色包内 skills/ 目录（随角色专属隔离）" },
	];
	if (roleScope === "personal") {
		items.push({ value: "personal", label: "我的个人私有 Skill 库（.data/skills/users/）" });
	} else if (roleScope === "org") {
		items.push({ value: "org", label: "组织共享 Skill 库（.data/skills/orgs/）" });
		if (isSuperAdmin) items.push({ value: "global", label: "平台通用 Skill 库（.data/skills/global/）" });
	} else if (isSuperAdmin) {
		items.push({ value: "global", label: "平台通用 Skill 库（.data/skills/global/）" });
	}
	return items;
}

export function resolveSkillStorageScopeForRole(
	requested: SkillStorageScope,
	roleScope: RoleScope,
	isSuperAdmin: boolean,
): SkillStorageScope {
	return allowedSkillScopesForRoleScope(roleScope, isSuperAdmin).some(({ value }) => value === requested)
		? requested
		: "role_local";
}

export function getMemberScopeBadge(
	member: Pick<TeamMemberDto, "roleScope" | "ownerOrgId">,
	organizationName?: (id: string | null) => string | null,
): { scope: RoleScope; label: string } {
	const scope = member.roleScope ?? (member.ownerOrgId ? "org" : "global");
	if (scope === "personal") return { scope, label: "仅我可用" };
	if (scope === "org") {
		const orgLabel = organizationName?.(member.ownerOrgId ?? null) ?? member.ownerOrgId ?? "组织";
		return { scope, label: `组织 · ${orgLabel}` };
	}
	return { scope, label: "平台通用" };
}

export const ROLE_ARCHITECT_MEMBER_ID = "role-architect";

export type MatterRoleJoinMode = "none" | "consult" | "observer" | "lead";

export interface RoleProposalPayloadDto {
	status: "pending" | "applied" | "dismissed";
	followUpQuestions: string[];
	healthFindings?: MetaArchitectHealthFindingDto[];
	roleAdjustments?: MetaArchitectRoleAdjustmentDto[];
	blueprints: MetaArchitectBlueprintProposalDto[];
	recommendedFormation?: MetaArchitectFormationSuggestionDto;
	isMidMatterConsult?: boolean;
	appliedMemberIds?: string[];
	appliedAdjustmentIds?: string[];
	appliedMatterJoinMode?: MatterRoleJoinMode;
}

/** True when a team member represents the built-in Role Architect meta role. */
export function isArchitectMember(
	member: Pick<TeamMemberDto, "id" | "templateId"> | null | undefined,
	templateByRoleId?: Map<string, RoleTemplateDto>,
): boolean {
	if (!member) return false;
	if (member.id === ROLE_ARCHITECT_MEMBER_ID || member.templateId === ROLE_ARCHITECT_MEMBER_ID) return true;
	const tpl = templateByRoleId?.get(member.templateId) ?? templateByRoleId?.get(member.id);
	return tpl?.roleKind === "architect";
}

/** True when a member ID belongs to the Role Architect meta role. */
export function isArchitectMemberId(
	memberId: string | null | undefined,
	members?: TeamMemberDto[],
	templateByRoleId?: Map<string, RoleTemplateDto>,
): boolean {
	if (!memberId) return false;
	if (memberId === ROLE_ARCHITECT_MEMBER_ID) return true;
	const member = members?.find((m) => m.id === memberId);
	return member ? isArchitectMember(member, templateByRoleId) : false;
}

/** Filters out Role Architect meta members when assembling ordinary business AI collaborator pools. */
export function filterBusinessMembers(
	members: TeamMemberDto[],
	templateByRoleId?: Map<string, RoleTemplateDto>,
): TeamMemberDto[] {
	return members.filter((m) => !isArchitectMember(m, templateByRoleId));
}

/** Safely parses structured inline Role Architect proposals stored on an assistant message. */
export function parseRoleProposalsFromMetadata(
	metadata: Record<string, unknown> | null | undefined,
): RoleProposalPayloadDto | null {
	const raw = metadata?.roleProposals;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const rec = raw as Record<string, unknown>;
	const status = rec.status === "applied" ? "applied" : rec.status === "dismissed" ? "dismissed" : "pending";
	const followUpQuestions = Array.isArray(rec.followUpQuestions)
		? rec.followUpQuestions.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
		: [];
	const blueprints = Array.isArray(rec.blueprints) ? (rec.blueprints as MetaArchitectBlueprintProposalDto[]) : [];
	const healthFindings = Array.isArray(rec.healthFindings)
		? (rec.healthFindings as MetaArchitectHealthFindingDto[])
		: undefined;
	const roleAdjustments = Array.isArray(rec.roleAdjustments)
		? (rec.roleAdjustments as MetaArchitectRoleAdjustmentDto[])
		: undefined;
	const recommendedFormation =
		rec.recommendedFormation && typeof rec.recommendedFormation === "object"
			? (rec.recommendedFormation as MetaArchitectFormationSuggestionDto)
			: undefined;

	return {
		status,
		followUpQuestions,
		...(healthFindings && healthFindings.length > 0 ? { healthFindings } : {}),
		...(roleAdjustments && roleAdjustments.length > 0 ? { roleAdjustments } : {}),
		blueprints,
		...(recommendedFormation ? { recommendedFormation } : {}),
		...(rec.isMidMatterConsult === true ? { isMidMatterConsult: true } : {}),
		...(Array.isArray(rec.appliedMemberIds) ? { appliedMemberIds: rec.appliedMemberIds.map(String) } : {}),
		...(Array.isArray(rec.appliedAdjustmentIds)
			? { appliedAdjustmentIds: rec.appliedAdjustmentIds.map(String) }
			: {}),
		...(typeof rec.appliedMatterJoinMode === "string"
			? { appliedMatterJoinMode: rec.appliedMatterJoinMode as MatterRoleJoinMode }
			: {}),
	};
}
