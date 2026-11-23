import { requestJson } from "./client.ts";
import type { CollaborationPresetMode, MatterDto, MatterMessageDto } from "./matters.ts";

export type RoleScope = "global" | "org" | "personal";

export type SkillStorageScope = "role_local" | "global" | "org" | "personal";

export interface NewSkillDraftDto {
	name: string;
	description: string;
	body: string;
	storageScope: SkillStorageScope;
}

export interface TeamMemberDto {
	id: string;
	templateId: string;
	displayName: string;
	roleTitle: string;
	isPrimaryContact: boolean;
	roleScope?: RoleScope;
	ownerOrgId?: string | null;
	ownerUserId?: string | null;
	keywords: string[];
	gitName: string;
	gitEmail: string;
	identitySummary: string;
}

export type RoleInteractionStyle = "lead_direct" | "consult_specialist" | "risk_observer" | "mixed";

export type RoleWorkspaceScope = "read_write_code" | "read_only_repo" | "no_repo_docs";

export interface RoleTemplateDto {
	id: string;
	name: string;
	title: string;
	roleKind?: "business" | "architect";
	roleScope?: RoleScope;
	ownerOrgId?: string | null;
	ownerUserId?: string | null;
	version: string;
	skills: string[];
	mcpDependencies?: string[];
	tools: string[];
	keywords: string[];
	shareable: boolean;
	antiJobs?: string[];
	responsibilities: string;
}

export interface RoleArchitectDraftDto {
	template: RoleTemplateDto & {
		isPrimaryContact: boolean;
		sections: Record<string, string>;
	};
	markdown: string;
	antiJobs: string[];
	toolSummary: string;
	recommendedParticipation: RoleInteractionStyle;
	designNotes: string[];
	newSkills?: NewSkillDraftDto[];
	capabilityReport?: {
		skills: Array<{ name: string; state: "file_present" | "missing" }>;
		mcpDependencies: Array<{ name: string; state: "runtime_check_required" }>;
	};
	verificationPlanState?: "specified" | "missing";
	designSource?: "rules" | "model";
}

export interface MetaArchitectMessageDto {
	role: "user" | "assistant";
	content: string;
}

export interface MetaArchitectBlueprintProposalDto {
	draft: RoleArchitectDraftDto;
	rationale: string;
}

export interface MetaArchitectFormationSuggestionDto {
	mode: CollaborationPresetMode;
	existingMemberIds: string[];
	observerMemberIds: string[];
	rationale: string;
}

export interface MetaArchitectHealthFindingDto {
	status: "ok" | "warn";
	title: string;
	detail: string;
	evidence?: Array<{
		id: string;
		kind: "role" | "message" | "feedback" | "memory";
		sourceId: string;
		matterId?: string;
		label: string;
		excerpt: string;
	}>;
}

export interface MetaArchitectRoleAdjustmentDto {
	memberId: string;
	memberName: string;
	currentTools: string[];
	suggestedTools?: string[];
	addAntiJobs?: string[];
	workflowNote?: string;
	rationale: string;
}

export interface MetaArchitectChatResultDto {
	reply: string;
	followUpQuestions: string[];
	healthFindings?: MetaArchitectHealthFindingDto[];
	roleAdjustments?: MetaArchitectRoleAdjustmentDto[];
	blueprints: MetaArchitectBlueprintProposalDto[];
	recommendedFormation?: MetaArchitectFormationSuggestionDto;
	usedHealthcheck: boolean;
}

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

export interface CreateMemberPayload {
	id?: string;
	name: string;
	title: string;
	roleScope?: RoleScope;
	ownerOrgId?: string | null;
	responsibilities?: string;
	keywords?: string[];
	skills?: string[];
	newSkills?: NewSkillDraftDto[];
	mcpDependencies?: string[];
	tools?: string[];
	antiJobs?: string[];
	sections?: Record<string, string>;
	isPrimaryContact?: boolean;
	gitName?: string;
	gitEmail?: string;
	identitySummary?: string;
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

export interface ApplyMemberAdjustmentPayload {
	memberId: string;
	tools?: string[];
	addAntiJobs?: string[];
	workflowNote?: string;
}

export function applyMemberAdjustments(
	adjustments: ApplyMemberAdjustmentPayload[],
): Promise<{ members: TeamMemberDto[] }> {
	return requestJson("/api/members/adjustments/apply", {
		method: "POST",
		body: JSON.stringify({ adjustments }),
	});
}

export interface ApplyMatterRoleProposalsPayload {
	action?: "apply" | "dismiss";
	members?: CreateMemberPayload[];
	adjustments?: ApplyMemberAdjustmentPayload[];
	matterJoinMode?: "none" | "consult" | "observer" | "lead";
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
