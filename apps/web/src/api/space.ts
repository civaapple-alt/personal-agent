import {
	SPACE_DOC_TYPE_OPTIONS,
	type SpaceDocumentDto,
	type SpaceDocumentFeedbackDto,
	type SpaceDocumentFileDto,
	type SpaceDocumentMetaDto,
	type SpaceDocumentType,
	type SpaceDto,
	type SpaceEntryKind,
	type SpaceGitCommitDetailDto,
	type SpaceGitCommitDto,
	type SpaceKind,
	type SpaceVisibility,
	spaceDocTypeLabel,
} from "@pa/contracts/space";
import { requestJson } from "./client.ts";

export {
	SPACE_DOC_TYPE_OPTIONS,
	type SpaceDocumentDto,
	type SpaceDocumentFeedbackDto,
	type SpaceDocumentFileDto,
	type SpaceDocumentMetaDto,
	type SpaceDocumentType,
	type SpaceDto,
	type SpaceEntryKind,
	type SpaceGitCommitDetailDto,
	type SpaceGitCommitDto,
	type SpaceKind,
	type SpaceVisibility,
	spaceDocTypeLabel,
};

export function listSpaceDocumentFeedback(docId: string) {
	return requestJson<{ feedback: SpaceDocumentFeedbackDto[] }>(
		`/api/spaces/documents/${encodeURIComponent(docId)}/feedback`,
	);
}

export function saveSpaceDocumentFeedback(
	docId: string,
	input: { commitHash: string; feedback: string; rating: SpaceDocumentFeedbackDto["rating"] },
) {
	return requestJson<{ feedback: SpaceDocumentFeedbackDto }>(
		`/api/spaces/documents/${encodeURIComponent(docId)}/feedback`,
		{ method: "POST", body: JSON.stringify(input) },
	);
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
		extraFiles?: Array<{ path: string; content: string }>;
		matterId?: string | null;
		sourceMessageId?: string | null;
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

export function writeSpaceDocumentFiles(
	docId: string,
	input: { files: Array<{ path: string; content: string }>; commitMessage?: string },
) {
	return requestJson<{
		document: SpaceDocumentDto;
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
