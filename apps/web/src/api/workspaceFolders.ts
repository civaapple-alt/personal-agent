import type {
	DiscoveredRuleDto,
	DiscoveredSkillDto,
	WorkspaceCustomizationsReportDto,
	WorkspaceFolderDto,
	WorkspacePiTrustDto,
} from "@pa/contracts/workspace";
import { requestJson } from "./client.ts";

export type {
	DiscoveredRuleDto,
	DiscoveredSkillDto,
	WorkspaceCustomizationsReportDto,
	WorkspaceFolderDto,
	WorkspacePiTrustDto,
};

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
