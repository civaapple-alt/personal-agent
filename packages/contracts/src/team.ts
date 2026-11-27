export type RoleScope = "global" | "org" | "personal";
export type SkillStorageScope = "role_local" | "global" | "org" | "personal";
export type RoleKind = "business" | "architect" | "solo";
export type RoleInteractionStyle = "lead_direct" | "consult_specialist" | "risk_observer" | "mixed";
export type RoleWorkspaceScope = "read_write_code" | "read_only_repo" | "no_repo_docs";
export type CollaborationPresetMode = "solo" | "lead_consult" | "lead_review" | "human_first";

export interface NewSkillDraftDto {
	name: string;
	description: string;
	body: string;
	storageScope: SkillStorageScope;
}

export interface RoleCapabilityReportDto {
	skills: Array<{ name: string; state: "file_present" | "missing" }>;
	mcpDependencies: Array<{ name: string; state: "runtime_check_required" }>;
}

/** Shared wire contract for a persisted AI team member. */
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
	createdAt?: string;
	updatedAt?: string;
}

export interface RoleTemplateDto {
	id: string;
	name: string;
	title: string;
	roleKind?: RoleKind;
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
	capabilityReport?: RoleCapabilityReportDto;
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

export interface MetaArchitectHealthEvidenceDto {
	id: string;
	kind: "role" | "message" | "feedback" | "memory" | "insight" | "skill_trust";
	sourceId: string;
	matterId?: string;
	label: string;
	excerpt: string;
}

export interface MetaArchitectHealthFindingDto {
	status: "ok" | "warn";
	title: string;
	detail: string;
	evidence?: MetaArchitectHealthEvidenceDto[];
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

export interface ApplyMemberAdjustmentPayload {
	memberId: string;
	tools?: string[];
	addAntiJobs?: string[];
	workflowNote?: string;
}

export interface ApplyMatterRoleProposalsPayload {
	action?: "apply" | "dismiss";
	members?: CreateMemberPayload[];
	adjustments?: ApplyMemberAdjustmentPayload[];
	matterJoinMode?: "none" | "consult" | "observer" | "lead";
}

export interface MemberSkillDetailDto {
	name: string;
	skillRef: string;
	filePath: string;
	content: string;
	scripts: Array<{ path: string; content: string }>;
}
