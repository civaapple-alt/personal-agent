import { requestJson } from "./client.ts";

export interface WorkspaceFolderDto {
	id: string;
	workspaceId: string;
	label: string;
	path: string;
	sourceType: "local" | "cloned";
	role: "primary" | "attached";
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
	folderRole: "primary" | "attached";
	fileName: string;
	filePath: string;
	tokens: number;
	preview: string;
	mode: "full" | "pointer" | "disabled";
}

export interface DiscoveredSkillDto {
	id: string;
	name: string;
	description: string;
	folderId: string;
	folderLabel: string;
	folderRole: "primary" | "attached";
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

export function fetchWorkspaceCustomizations(workspaceId: string, folderId?: string) {
	const query = folderId ? `?folderId=${encodeURIComponent(folderId)}` : "";
	return requestJson<{
		workspaceId: string;
		folders: WorkspaceFolderDto[];
		piTrust?: WorkspacePiTrustDto;
		report: WorkspaceCustomizationsReportDto;
	}>(`/api/workspaces/${encodeURIComponent(workspaceId)}/customizations${query}`);
}

export function updateWorkspacePiTrust(workspaceId: string, trusted: boolean | null) {
	return requestJson<{ workspaceId: string; piTrust: WorkspacePiTrustDto }>(
		`/api/workspaces/${encodeURIComponent(workspaceId)}/pi-trust`,
		{ method: "PATCH", body: JSON.stringify({ trusted }) },
	);
}

export function addWorkspaceFolder(
	workspaceId: string,
	input: { path: string; label?: string; loadRules?: boolean; loadSkills?: boolean },
) {
	return requestJson<{ folder: WorkspaceFolderDto; folders: WorkspaceFolderDto[] }>(
		`/api/workspaces/${encodeURIComponent(workspaceId)}/folders`,
		{ method: "POST", body: JSON.stringify(input) },
	);
}

export function updateWorkspaceFolder(
	workspaceId: string,
	folderId: string,
	patch: { label?: string; loadRules?: boolean; loadSkills?: boolean; setPrimary?: boolean },
) {
	return requestJson<{ folder: WorkspaceFolderDto; folders: WorkspaceFolderDto[] }>(
		`/api/workspaces/${encodeURIComponent(workspaceId)}/folders/${encodeURIComponent(folderId)}`,
		{ method: "PATCH", body: JSON.stringify(patch) },
	);
}

export function removeWorkspaceFolder(workspaceId: string, folderId: string) {
	return requestJson<{ folders: WorkspaceFolderDto[] }>(
		`/api/workspaces/${encodeURIComponent(workspaceId)}/folders/${encodeURIComponent(folderId)}`,
		{ method: "DELETE" },
	);
}
