import type {
	MetaArchitectBlueprintProposalDto,
	MetaArchitectFormationSuggestionDto,
	MetaArchitectHealthFindingDto,
	MetaArchitectRoleAdjustmentDto,
	RoleTemplateDto,
	TeamMemberDto,
} from "./api.ts";

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
