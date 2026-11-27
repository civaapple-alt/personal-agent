export type SpaceKind = "org" | "workspace" | "user" | "member" | "custom";
export type SpaceVisibility = "org" | "private";
export type SpaceDocumentType = "plan" | "spec" | "decision" | "rule" | "note";
export type SpaceEntryKind = "file" | "folder";
export type FeedbackRating = "positive" | "negative" | "neutral";

export const SPACE_DOCUMENT_TYPES: readonly SpaceDocumentType[] = ["plan", "spec", "decision", "rule", "note"];

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

export function normalizeSpaceDocumentType(value: unknown, fallback: SpaceDocumentType = "note"): SpaceDocumentType {
	if (typeof value !== "string") return fallback;
	const trimmed = value.trim().toLowerCase();
	if (trimmed === "plan" || trimmed === "spec" || trimmed === "decision" || trimmed === "rule" || trimmed === "note") {
		return trimmed;
	}
	return fallback;
}

export function normalizeSpaceEntryKind(value: unknown, fallback: SpaceEntryKind = "file"): SpaceEntryKind {
	if (value === "folder") return "folder";
	if (value === "file") return "file";
	return fallback;
}

export interface SpaceDocumentFileDto {
	path: string;
	sizeBytes: number;
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

export interface SpaceDocumentFeedbackDto {
	documentId: string;
	commitHash: string;
	actorId: string;
	actorName: string;
	feedback: string;
	rating: FeedbackRating | null;
	createdAt: string;
	updatedAt: string;
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
