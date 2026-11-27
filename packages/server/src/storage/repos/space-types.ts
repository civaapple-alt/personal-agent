import { normalizeSafeRepoFilePath } from "../space-git-store.ts";

export type SpaceKind = "org" | "workspace" | "user" | "member" | "custom";
export type SpaceVisibility = "org" | "private";
export type SpaceDocumentType = "plan" | "spec" | "decision" | "rule" | "note";
export type SpaceEntryKind = "file" | "folder";

export interface SpaceDocumentFile {
	path: string;
	sizeBytes: number;
}

export interface SpaceDocumentFeedback {
	documentId: string;
	commitHash: string;
	actorId: string;
	actorName: string;
	feedback: string;
	rating: "positive" | "negative" | "neutral" | null;
	createdAt: string;
	updatedAt: string;
}

export const SPACE_DOCUMENT_TYPES: readonly SpaceDocumentType[] = ["plan", "spec", "decision", "rule", "note"];

export const DEFAULT_FOLDER_ENTRY_GITIGNORE = `# Entry-level ignore rules
.DS_Store
node_modules/
*.log
.env
.env.*
`;

const SPACE_DOC_TYPE_DIRS: Record<SpaceDocumentType, string> = {
	plan: "plans",
	spec: "specs",
	decision: "decisions",
	rule: "rules",
	note: "notes",
};

export function normalizeSpaceEntryKind(value: unknown, fallback: SpaceEntryKind = "file"): SpaceEntryKind {
	if (value === "folder") return "folder";
	if (value === "file") return "file";
	return fallback;
}

export function detectPreviewEntryPath(files: SpaceDocumentFile[]): string | null {
	const paths = new Set(files.map((f) => f.path));
	if (paths.has("index.html")) return "index.html";
	if (paths.has("demo/index.html")) return "demo/index.html";
	const anyHtml = files.find((f) => f.path.toLowerCase().endsWith(".html"));
	return anyHtml ? anyHtml.path : null;
}

export function normalizeSpaceDocumentType(value: unknown, fallback: SpaceDocumentType = "note"): SpaceDocumentType {
	if (typeof value !== "string") return fallback;
	const trimmed = value.trim().toLowerCase();
	if (trimmed === "plan" || trimmed === "spec" || trimmed === "decision" || trimmed === "rule" || trimmed === "note") {
		return trimmed;
	}
	return fallback;
}

export interface SpaceRecord {
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
}

export interface SpaceDocument {
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
	content: string;
	headCommit: string;
	revision: number;
	createdBy: string;
	updatedBy: string;
	createdAt: string;
	updatedAt: string;
}

export interface SpaceDocumentMeta extends Omit<SpaceDocument, "content"> {
	content?: string;
}

export interface SpaceRow {
	id: string;
	kind: SpaceKind;
	org_id: string | null;
	workspace_id: string | null;
	owner_user_id: string | null;
	member_id: string | null;
	name: string;
	description: string;
	visibility: SpaceVisibility;
	created_by: string;
	created_at: string;
	updated_at: string;
	doc_count?: number;
}

export interface DocumentRow {
	id: string;
	space_id: string;
	matter_id: string | null;
	file_path: string;
	title: string;
	doc_type?: string | null;
	entry_kind?: string | null;
	linked_org_id: string | null;
	linked_workspace_id: string | null;
	linked_file_path: string | null;
	head_commit: string;
	revision: number;
	created_by: string;
	updated_by: string;
	created_at: string;
	updated_at: string;
}

export function mapSpace(row: SpaceRow): SpaceRecord {
	return {
		id: row.id,
		kind: row.kind,
		orgId: row.org_id,
		workspaceId: row.workspace_id,
		ownerUserId: row.owner_user_id,
		memberId: row.member_id,
		name: row.name,
		description: row.description,
		visibility: row.visibility,
		createdBy: row.created_by,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		documentCount: Number(row.doc_count ?? 0),
	};
}

export function mapDocumentMeta(row: DocumentRow): SpaceDocumentMeta {
	return {
		id: row.id,
		spaceId: row.space_id,
		matterId: row.matter_id,
		filePath: row.file_path,
		title: row.title,
		docType: normalizeSpaceDocumentType(row.doc_type),
		entryKind: normalizeSpaceEntryKind(row.entry_kind),
		linkedOrgId: row.linked_org_id ?? null,
		linkedWorkspaceId: row.linked_workspace_id ?? null,
		linkedFilePath: row.linked_file_path ?? null,
		headCommit: row.head_commit,
		revision: row.revision,
		createdBy: row.created_by,
		updatedBy: row.updated_by,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export function orgSpaceId(orgId: string): string {
	return `spc_org_${orgId}`;
}

export function workspaceSpaceId(workspaceId: string): string {
	return `spc_ws_${workspaceId}`;
}

export function userSpaceId(userId: string): string {
	return `spc_usr_${userId}`;
}

export function memberSpaceId(memberId: string): string {
	return `spc_mem_${memberId}`;
}

export function defaultDocFilePath(
	docId: string,
	docType: SpaceDocumentType = "note",
	entryKind: SpaceEntryKind = "file",
): string {
	return normalizeSafeRepoFilePath(
		entryKind === "folder"
			? `${SPACE_DOC_TYPE_DIRS[docType]}/${docId}`
			: `${SPACE_DOC_TYPE_DIRS[docType]}/${docId}.md`,
	);
}

export function defaultAuthorEmail(actorId: string): string {
	const cleaned = actorId.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "") || "agent";
	return `${cleaned}@personal-agent.local`;
}
