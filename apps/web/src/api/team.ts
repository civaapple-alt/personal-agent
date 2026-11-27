import type { MatterDto, MatterMessageDto } from "@pa/contracts/matter";
import type {
	ApplyMatterRoleProposalsPayload,
	ApplyMemberAdjustmentPayload,
	CreateMemberPayload,
	MemberSkillDetailDto,
	MetaArchitectBlueprintProposalDto,
	MetaArchitectChatResultDto,
	MetaArchitectFormationSuggestionDto,
	MetaArchitectHealthFindingDto,
	MetaArchitectMessageDto,
	MetaArchitectRoleAdjustmentDto,
	NewSkillDraftDto,
	RoleArchitectDraftDto,
	RoleInteractionStyle,
	RoleScope,
	RoleTemplateDto,
	RoleWorkspaceScope,
	SkillStorageScope,
	TeamMemberDto,
} from "@pa/contracts/team";
import { requestJson } from "./client.ts";

export type {
	ApplyMatterRoleProposalsPayload,
	ApplyMemberAdjustmentPayload,
	CreateMemberPayload,
	MemberSkillDetailDto,
	MetaArchitectBlueprintProposalDto,
	MetaArchitectChatResultDto,
	MetaArchitectFormationSuggestionDto,
	MetaArchitectHealthFindingDto,
	MetaArchitectMessageDto,
	MetaArchitectRoleAdjustmentDto,
	NewSkillDraftDto,
	RoleArchitectDraftDto,
	RoleInteractionStyle,
	RoleScope,
	RoleTemplateDto,
	RoleWorkspaceScope,
	SkillStorageScope,
	TeamMemberDto,
};

export function designRoleDraft(
	input: {
		oneJob: string;
		roleScope?: RoleScope;
		ownerOrgId?: string | null;
		antiJobs?: string[];
		quietWhen?: string;
		interactionStyle?: RoleInteractionStyle;
		workspaceScope?: RoleWorkspaceScope;
		roleName?: string;
		roleTitle?: string;
		keywords?: string[];
		workflowRules?: string;
		constraints?: string;
		skills?: string[];
		mcpDependencies?: string[];
		communicationStyle?: string;
		verificationPlan?: string | { task: string; successCriteria: string; boundaryCheck: string };
		isPrimaryContact?: boolean;
		mode?: "rules" | "model";
	},
	signal?: AbortSignal,
): Promise<RoleArchitectDraftDto> {
	return requestJson("/api/members/design", {
		method: "POST",
		body: JSON.stringify(input),
		signal,
	});
}

export function chatWithRoleArchitect(
	input: {
		messages: MetaArchitectMessageDto[];
		matterPrompt?: string;
		workspaceId?: string | null;
		orgId?: string | null;
		roleScope?: RoleScope;
		includeHealthcheck?: boolean;
	},
	signal?: AbortSignal,
): Promise<MetaArchitectChatResultDto> {
	return requestJson("/api/members/architect/chat", {
		method: "POST",
		body: JSON.stringify(input),
		signal,
	});
}

export function createMember(input: CreateMemberPayload): Promise<{ member: TeamMemberDto }> {
	return requestJson("/api/members", {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export function createMembersBatch(members: CreateMemberPayload[]): Promise<{ members: TeamMemberDto[] }> {
	return requestJson("/api/members/batch", {
		method: "POST",
		body: JSON.stringify({ members }),
	});
}

export function applyMemberAdjustments(
	adjustments: ApplyMemberAdjustmentPayload[],
): Promise<{ members: TeamMemberDto[] }> {
	return requestJson("/api/members/adjustments/apply", {
		method: "POST",
		body: JSON.stringify({ adjustments }),
	});
}

export function applyMatterRoleProposals(
	matterId: string,
	messageId: string,
	input: ApplyMatterRoleProposalsPayload,
): Promise<{
	ok: boolean;
	createdMembers: TeamMemberDto[];
	updatedMembers: TeamMemberDto[];
	message: MatterMessageDto | null;
	matter: MatterDto;
}> {
	return requestJson(
		`/api/matters/${encodeURIComponent(matterId)}/messages/${encodeURIComponent(messageId)}/apply-role-proposals`,
		{
			method: "POST",
			body: JSON.stringify(input),
		},
	);
}

export function updateMemberIdentity(
	memberId: string,
	input: {
		displayName?: string;
		roleTitle?: string;
		gitName?: string;
		gitEmail?: string;
		identitySummary?: string;
	},
): Promise<{ member: TeamMemberDto }> {
	return requestJson(`/api/members/${encodeURIComponent(memberId)}`, {
		method: "PATCH",
		body: JSON.stringify(input),
	});
}

export function setPrimaryMember(memberId: string): Promise<{ member: TeamMemberDto }> {
	return requestJson(`/api/members/${encodeURIComponent(memberId)}/primary`, {
		method: "POST",
		body: "{}",
	});
}

export function deleteMember(memberId: string): Promise<{ ok: boolean; deletedMemberId: string }> {
	return requestJson(`/api/members/${encodeURIComponent(memberId)}`, {
		method: "DELETE",
	});
}

export function exportMemberPackage(memberId: string): Promise<{
	id: string;
	filename: string;
	markdown: string;
}> {
	return requestJson(`/api/members/${encodeURIComponent(memberId)}/export`);
}

export function fetchMemberSkillDetail(memberId: string, skillRef: string): Promise<{ detail: MemberSkillDetailDto }> {
	const query = new URLSearchParams({ skill: skillRef });
	return requestJson<{ detail: MemberSkillDetailDto }>(
		`/api/members/${encodeURIComponent(memberId)}/skills/detail?${query.toString()}`,
	);
}

export function importMemberPackage(
	markdown: string,
	options?: { roleScope?: RoleScope; ownerOrgId?: string | null },
): Promise<{ member: TeamMemberDto }> {
	return requestJson("/api/members/import", {
		method: "POST",
		body: JSON.stringify({
			markdown,
			...(options?.roleScope ? { roleScope: options.roleScope } : {}),
			...(options?.ownerOrgId ? { ownerOrgId: options.ownerOrgId } : {}),
		}),
	});
}

export async function actOnSkillProposal(
	matterId: string,
	messageId: string,
	payload: {
		proposalId: string;
		action: "apply" | "dismiss";
		storageScope?: "global" | "org" | "personal" | "workspace";
	},
): Promise<{ ok: true; writtenPaths: string[] }> {
	return requestJson(
		`/api/matters/${encodeURIComponent(matterId)}/messages/${encodeURIComponent(messageId)}/skill-proposals`,
		{
			method: "POST",
			body: JSON.stringify(payload),
		},
	);
}
