import { requestJson } from "./client.ts";

export type SpaceKind = "org" | "workspace" | "user" | "member" | "custom";
export type SpaceVisibility = "org" | "private";

export interface SpaceDto {
	id: string;
	kind: SpaceKind;
	orgId: string | null;
	workspaceId: string | null;
	ownerUserId: string | null;
	memberId: string | null;
	name: string;
	description: string;
	visibility: SpaceVisibility;
	createdBy: string;
	createdAt: string;
	updatedAt: string;
	documentCount: number;
	canWrite?: boolean;
}

export interface SpaceDocumentMetaDto {
	id: string;
	spaceId: string;
	matterId: string | null;
	filePath: string;
	title: string;
	linkedOrgId: string | null;
	linkedWorkspaceId: string | null;
	linkedFilePath: string | null;
	headCommit: string;
	revision: number;
	createdBy: string;
	updatedBy: string;
	createdAt: string;
	updatedAt: string;
}

export interface SpaceDocumentDto extends SpaceDocumentMetaDto {
	content: string;
}

export interface SpaceGitCommitDto {
	hash: string;
	shortHash: string;
	authorName: string;
	authorEmail: string;
	committedAt: string;
	subject: string;
}

export interface SpaceGitCommitDetailDto {
	commit: SpaceGitCommitDto;
	diff: string;
	content: string | null;
}

export function listSpaces() {
	return requestJson<{ spaces: SpaceDto[] }>("/api/spaces");
}

export function createCustomSpace(input: {
	name: string;
	description?: string;
	orgId?: string | null;
	visibility: SpaceVisibility;
}) {
	return requestJson<{ space: SpaceDto }>("/api/spaces", {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export function listSpaceDocuments(spaceId: string) {
	return requestJson<{
		space: SpaceDto;
		documents: SpaceDocumentMetaDto[];
	}>(`/api/spaces/${encodeURIComponent(spaceId)}/documents`);
}

export function createSpaceDocument(
	spaceId: string,
	input: {
		title: string;
		content: string;
		matterId?: string | null;
		linkedOrgId?: string | null;
		linkedWorkspaceId?: string | null;
		linkedFilePath?: string | null;
		commitMessage?: string;
	},
) {
	return requestJson<{ document: SpaceDocumentDto }>(`/api/spaces/${encodeURIComponent(spaceId)}/documents`, {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export function getSpaceDocument(docId: string) {
	return requestJson<{ document: SpaceDocumentDto; canWrite: boolean }>(
		`/api/spaces/documents/${encodeURIComponent(docId)}`,
	);
}

export function updateSpaceDocument(
	docId: string,
	input: {
		revision: number;
		title: string;
		content: string;
		linkedOrgId?: string | null;
		linkedWorkspaceId?: string | null;
		linkedFilePath?: string | null;
		commitMessage?: string;
	},
) {
	return requestJson<{ document: SpaceDocumentDto }>(`/api/spaces/documents/${encodeURIComponent(docId)}`, {
		method: "PATCH",
		body: JSON.stringify(input),
	});
}

export function listSpaceDocumentCommits(docId: string) {
	return requestJson<{ commits: SpaceGitCommitDto[] }>(`/api/spaces/documents/${encodeURIComponent(docId)}/commits`);
}

export function getSpaceDocumentCommitDetail(docId: string, hash: string) {
	return requestJson<{ detail: SpaceGitCommitDetailDto }>(
		`/api/spaces/documents/${encodeURIComponent(docId)}/commits/${encodeURIComponent(hash)}`,
	);
}
