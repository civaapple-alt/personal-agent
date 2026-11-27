export type WorkspaceSourceType = "local" | "cloned";
export type WorkspaceVisibility = "org" | "restricted";
export type WorkspaceFolderRole = "primary" | "attached";
export type DiscoveredRuleMode = "full" | "pointer" | "disabled";

/** Shared wire contract for a linked or cloned project workspace. */
export interface WorkspaceDto {
	id: string;
	orgId: string | null;
	name: string;
	repoPath: string;
	defaultBranch: string;
	description: string;
	sourceType?: "local" | "clone" | WorkspaceSourceType;
	cloneUrl?: string | null;
	visibility?: WorkspaceVisibility;
	allowedUserIds?: string[];
	repoGitUser?: { name: string; email: string } | null;
	createdAt?: string;
}

export interface WorkspaceFolderDto {
	id: string;
	workspaceId: string;
	label: string;
	path: string;
	sourceType: WorkspaceSourceType;
	role: WorkspaceFolderRole;
	loadRules: boolean;
	loadSkills: boolean;
	sortOrder: number;
	createdAt: string;
	updatedAt: string;
}

export interface DiscoveredRuleDto {
	id: string;
	folderId: string;
	folderLabel: string;
	folderRole: WorkspaceFolderRole;
	fileName: string;
	filePath: string;
	tokens: number;
	preview: string;
	mode: DiscoveredRuleMode;
}

export interface DiscoveredSkillDto {
	id: string;
	name: string;
	description: string;
	folderId: string;
	folderLabel: string;
	folderRole: WorkspaceFolderRole;
	skillDir: string;
	filePath: string;
	tokens: number;
	excluded: boolean;
}

export interface WorkspaceCustomizationsReportDto {
	rulesBudgetTokens: number;
	skillsBudgetTokens: number;
	rulesTokensUsed: number;
	rulesTotalTokens: number;
	skillsTokensUsed: number;
	skillsTotalTokens: number;
	rules: DiscoveredRuleDto[];
	skills: DiscoveredSkillDto[];
}

export interface WorkspacePiTrustDto {
	eligible: boolean;
	decision: boolean | null;
	matchedPath: string | null;
	effectiveTrusted: boolean;
	canEdit: boolean;
}
