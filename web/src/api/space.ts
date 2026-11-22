import { requestJson } from "./client.ts";

export type SpaceKind = "org" | "workspace" | "user" | "member" | "custom";
export type SpaceVisibility = "org" | "private";
export type SpaceDocumentType = "plan" | "spec" | "decision" | "rule" | "note";
export type SpaceEntryKind = "file" | "folder";

export interface SpaceDocumentFileDto {
	path: string;
	sizeBytes: number;
}

export const SPACE_DOC_TYPE_OPTIONS: Array<{ value: SpaceDocumentType; label: string; hint: string }> = [
	{ value: "plan", label: "方案", hint: "实现计划、架构方案、落地路线图" },
	{ value: "spec", label: "规格", hint: "PRD、需求规格、接口契约、验收标准" },
	{ value: "decision", label: "决策", hint: "ADR、方案取舍结论、评审纪要与复盘" },
	{ value: "rule", label: "规范", hint: "团队约定、SOP 手册、检查清单" },
	{ value: "note", label: "资料", hint: "调研分析、参考资料、README 镜像与草稿" },
];

export function spaceDocTypeLabel(docType?: SpaceDocumentType | string | null): string {
	const found = SPACE_DOC_TYPE_OPTIONS.find((item) => item.value === docType);
	return found ? found.label : "资料";
}

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
	docType: SpaceDocumentType;
	entryKind: SpaceEntryKind;
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

export function listSpaceDocuments(spaceId: string, options?: { docType?: SpaceDocumentType }) {
	const query = options?.docType ? `?docType=${encodeURIComponent(options.docType)}` : "";
	return requestJson<{
		space: SpaceDto;
		documents: SpaceDocumentMetaDto[];
	}>(`/api/spaces/${encodeURIComponent(spaceId)}/documents${query}`);
}

export function listRecentSpaceDocuments(options?: { docType?: SpaceDocumentType; q?: string; limit?: number }) {
	const params = new URLSearchParams();
	if (options?.docType) params.set("docType", options.docType);
	if (options?.q) params.set("q", options.q);
	if (options?.limit) params.set("limit", String(options.limit));
	const qs = params.toString();
	return requestJson<{ documents: SpaceDocumentMetaDto[] }>(`/api/spaces/recent${qs ? `?${qs}` : ""}`);
}

export function createSpaceDocument(
	spaceId: string,
	input: {
		title: string;
		docType?: SpaceDocumentType;
		entryKind?: SpaceEntryKind;
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
	return requestJson<{
		document: SpaceDocumentDto;
		canWrite: boolean;
		files?: SpaceDocumentFileDto[];
		previewEntryPath?: string | null;
	}>(`/api/spaces/documents/${encodeURIComponent(docId)}`);
}

export function promoteSpaceDocumentToFolder(docId: string) {
	return requestJson<{
		document: SpaceDocumentDto;
		files: SpaceDocumentFileDto[];
		previewEntryPath: string | null;
	}>(`/api/spaces/documents/${encodeURIComponent(docId)}/promote`, {
		method: "POST",
	});
}

export function readSpaceDocumentFile(docId: string, subPath: string) {
	return requestJson<{ path: string; content: string }>(
		`/api/spaces/documents/${encodeURIComponent(docId)}/files?path=${encodeURIComponent(subPath)}`,
	);
}

export function writeSpaceDocumentFile(
	docId: string,
	input: { path: string; content: string; commitMessage?: string },
) {
	return requestJson<{
		document: SpaceDocumentDto;
		subPath: string;
		files: SpaceDocumentFileDto[];
		previewEntryPath: string | null;
	}>(`/api/spaces/documents/${encodeURIComponent(docId)}/files`, {
		method: "PUT",
		body: JSON.stringify(input),
	});
}

export function deleteSpaceDocumentFile(docId: string, subPath: string) {
	return requestJson<{
		document: SpaceDocumentDto;
		files: SpaceDocumentFileDto[];
		previewEntryPath: string | null;
	}>(`/api/spaces/documents/${encodeURIComponent(docId)}/files?path=${encodeURIComponent(subPath)}`, {
		method: "DELETE",
	});
}

export function spaceDocumentPreviewUrl(docId: string, entryPath: string): string {
	const encodedSegments = entryPath
		.split("/")
		.filter(Boolean)
		.map((seg) => encodeURIComponent(seg))
		.join("/");
	return `/api/spaces/documents/${encodeURIComponent(docId)}/preview/${encodedSegments}`;
}

export function updateSpaceDocument(
	docId: string,
	input: {
		revision: number;
		title: string;
		docType?: SpaceDocumentType;
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
