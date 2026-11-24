import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
	normalizeSafeRepoFilePath,
	SpaceConflictError,
	type SpaceGitCommit,
	type SpaceGitCommitDetail,
	SpaceGitStore,
} from "../space-git-store.ts";
import { DEFAULT_LOCAL_ADMIN_USER_ID, DEFAULT_ORGANIZATION_ID, nowIso } from "./helpers.ts";
import { syncSpaceFeedbackVotes } from "./space-feedback-votes.ts";

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

interface SpaceRow {
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

interface DocumentRow {
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

function mapSpace(row: SpaceRow): SpaceRecord {
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

function mapDocumentMeta(row: DocumentRow): SpaceDocumentMeta {
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

function defaultDocFilePath(
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

function defaultAuthorEmail(actorId: string): string {
	const cleaned = actorId.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "") || "agent";
	return `${cleaned}@personal-agent.local`;
}

export class SpaceRepo {
	private readonly db: DatabaseSync;
	readonly git: SpaceGitStore;

	constructor(db: DatabaseSync, gitStore?: SpaceGitStore) {
		this.db = db;
		this.git = gitStore ?? new SpaceGitStore();
	}

	private selectSpaceWithCounts(whereSql: string, params: Array<string | number>): SpaceRow[] {
		return this.db
			.prepare(
				`SELECT s.*,
				 (SELECT COUNT(*) FROM space_documents d WHERE d.space_id = s.id) AS doc_count
				 FROM spaces s ${whereSql}`,
			)
			.all(...params) as unknown as SpaceRow[];
	}

	getSpace(id: string): SpaceRecord | null {
		const row = this.selectSpaceWithCounts("WHERE s.id = ?", [id])[0];
		return row ? mapSpace(row) : null;
	}

	listSpaces(kind?: SpaceKind): SpaceRecord[] {
		const rows = kind
			? this.selectSpaceWithCounts("WHERE s.kind = ? ORDER BY s.updated_at DESC, s.name ASC", [kind])
			: this.selectSpaceWithCounts(
					`ORDER BY CASE s.kind
						WHEN 'org' THEN 1
						WHEN 'workspace' THEN 2
						WHEN 'user' THEN 3
						WHEN 'member' THEN 4
						ELSE 5
					END, s.updated_at DESC, s.name ASC`,
					[],
				);
		return rows.map(mapSpace);
	}

	ensureOrgSpace(org: { id: string; name: string }): SpaceRecord {
		const id = orgSpaceId(org.id);
		const now = nowIso();
		const name = `${org.name} · 组织空间`;
		const existing = this.getSpace(id);
		if (existing) {
			if (existing.name !== name) {
				this.db.prepare("UPDATE spaces SET name = ?, updated_at = ? WHERE id = ?").run(name, now, id);
				return this.getSpace(id)!;
			}
			return existing;
		}
		this.db
			.prepare(
				`INSERT INTO spaces (id, kind, org_id, workspace_id, owner_user_id, member_id, name, description, visibility, created_by, created_at, updated_at)
				 VALUES (?, 'org', ?, NULL, NULL, NULL, ?, '', 'org', 'system', ?, ?)`,
			)
			.run(id, org.id, name, now, now);
		return this.getSpace(id)!;
	}

	ensureWorkspaceSpace(ws: {
		id: string;
		orgId: string | null;
		name: string;
		visibility: "org" | "restricted";
	}): SpaceRecord {
		const id = workspaceSpaceId(ws.id);
		const now = nowIso();
		const name = `${ws.name} · 仓库空间`;
		const visibility: SpaceVisibility = ws.visibility === "restricted" ? "private" : "org";
		const existing = this.getSpace(id);
		if (existing) {
			if (existing.name !== name || existing.orgId !== ws.orgId || existing.visibility !== visibility) {
				this.db
					.prepare("UPDATE spaces SET name = ?, org_id = ?, visibility = ?, updated_at = ? WHERE id = ?")
					.run(name, ws.orgId, visibility, now, id);
				return this.getSpace(id)!;
			}
			return existing;
		}
		this.db
			.prepare(
				`INSERT INTO spaces (id, kind, org_id, workspace_id, owner_user_id, member_id, name, description, visibility, created_by, created_at, updated_at)
				 VALUES (?, 'workspace', ?, ?, NULL, NULL, ?, '', ?, 'system', ?, ?)`,
			)
			.run(id, ws.orgId, ws.id, name, visibility, now, now);
		return this.getSpace(id)!;
	}

	ensureUserSpace(user: { id: string; displayName: string }): SpaceRecord {
		const id = userSpaceId(user.id);
		const now = nowIso();
		const name = `${user.displayName} · 个人空间`;
		const existing = this.getSpace(id);
		if (existing) {
			if (existing.name !== name) {
				this.db.prepare("UPDATE spaces SET name = ?, updated_at = ? WHERE id = ?").run(name, now, id);
				return this.getSpace(id)!;
			}
			return existing;
		}
		this.db
			.prepare(
				`INSERT INTO spaces (id, kind, org_id, workspace_id, owner_user_id, member_id, name, description, visibility, created_by, created_at, updated_at)
				 VALUES (?, 'user', NULL, NULL, ?, NULL, ?, '个人资料与私密事项空间', 'private', ?, ?, ?)`,
			)
			.run(id, user.id, name, user.id, now, now);
		return this.getSpace(id)!;
	}

	ensureMemberSpace(member: {
		id: string;
		name: string;
		roleScope?: string;
		ownerOrgId?: string | null;
		ownerUserId?: string | null;
	}): SpaceRecord {
		const id = memberSpaceId(member.id);
		const now = nowIso();
		const name = `${member.name} · 角色空间`;
		const visibility: SpaceVisibility = member.roleScope === "personal" ? "private" : "org";
		const existing = this.getSpace(id);
		if (existing) {
			if (
				existing.name !== name ||
				existing.orgId !== (member.ownerOrgId ?? null) ||
				existing.ownerUserId !== (member.ownerUserId ?? null) ||
				existing.visibility !== visibility
			) {
				this.db
					.prepare(
						"UPDATE spaces SET name = ?, org_id = ?, owner_user_id = ?, visibility = ?, updated_at = ? WHERE id = ?",
					)
					.run(name, member.ownerOrgId ?? null, member.ownerUserId ?? null, visibility, now, id);
				return this.getSpace(id)!;
			}
			return existing;
		}
		this.db
			.prepare(
				`INSERT INTO spaces (id, kind, org_id, workspace_id, owner_user_id, member_id, name, description, visibility, created_by, created_at, updated_at)
				 VALUES (?, 'member', ?, NULL, ?, ?, ?, 'AI 角色沉淀与过程资料空间', ?, 'system', ?, ?)`,
			)
			.run(id, member.ownerOrgId ?? null, member.ownerUserId ?? null, member.id, name, visibility, now, now);
		return this.getSpace(id)!;
	}

	ensureAllDefaultSpaces(): void {
		const orgs = this.db.prepare("SELECT id, name FROM organizations").all() as Array<{ id: string; name: string }>;
		for (const org of orgs) this.ensureOrgSpace(org);

		const workspaces = this.db.prepare("SELECT id, org_id, name, visibility FROM workspace_links").all() as Array<{
			id: string;
			org_id: string | null;
			name: string;
			visibility: "org" | "restricted";
		}>;
		for (const ws of workspaces) {
			this.ensureWorkspaceSpace({
				id: ws.id,
				orgId: ws.org_id,
				name: ws.name,
				visibility: ws.visibility === "restricted" ? "restricted" : "org",
			});
		}

		const users = this.db.prepare("SELECT id, display_name FROM users").all() as Array<{
			id: string;
			display_name: string;
		}>;
		for (const user of users) {
			this.ensureUserSpace({ id: user.id, displayName: user.display_name });
		}

		const members = this.db
			.prepare("SELECT id, display_name, role_scope, owner_org_id, owner_user_id FROM team_members")
			.all() as Array<{
			id: string;
			display_name: string;
			role_scope: string;
			owner_org_id: string | null;
			owner_user_id: string | null;
		}>;
		for (const member of members) {
			this.ensureMemberSpace({
				id: member.id,
				name: member.display_name,
				roleScope: member.role_scope,
				ownerOrgId: member.owner_org_id,
				ownerUserId: member.owner_user_id,
			});
		}
	}

	createCustomSpace(input: {
		name: string;
		description?: string;
		orgId?: string | null;
		ownerUserId?: string | null;
		visibility: SpaceVisibility;
		createdBy: string;
	}): SpaceRecord {
		const id = `spc_${randomUUID()}`;
		const now = nowIso();
		const name = input.name.trim();
		if (!name || name.length > 100) {
			throw new Error("请提供空间名称（最多 100 字）");
		}
		this.db
			.prepare(
				`INSERT INTO spaces (id, kind, org_id, workspace_id, owner_user_id, member_id, name, description, visibility, created_by, created_at, updated_at)
				 VALUES (?, 'custom', ?, NULL, ?, NULL, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				input.orgId ?? null,
				input.ownerUserId ?? null,
				name,
				(input.description ?? "").trim(),
				input.visibility,
				input.createdBy,
				now,
				now,
			);
		return this.getSpace(id)!;
	}

	resolveMatterDefaultSpace(matter: {
		id: string;
		orgId?: string | null;
		workspaceId?: string | null;
		visibility?: "org" | "private";
		createdByUserId?: string | null;
	}): SpaceRecord {
		this.ensureAllDefaultSpaces();
		if (matter.visibility === "private") {
			const ownerId = matter.createdByUserId || DEFAULT_LOCAL_ADMIN_USER_ID;
			const userSpace = this.getSpace(userSpaceId(ownerId));
			if (userSpace) return userSpace;
			const userRow = this.db.prepare("SELECT id, display_name FROM users WHERE id = ?").get(ownerId) as
				| { id: string; display_name: string }
				| undefined;
			if (userRow) return this.ensureUserSpace({ id: userRow.id, displayName: userRow.display_name });
		}
		if (matter.workspaceId) {
			const wsSpace = this.getSpace(workspaceSpaceId(matter.workspaceId));
			if (wsSpace) return wsSpace;
		}
		const targetOrgId = matter.orgId ?? DEFAULT_ORGANIZATION_ID;
		const orgSpace = this.getSpace(orgSpaceId(targetOrgId));
		if (orgSpace) return orgSpace;
		const orgRow = this.db.prepare("SELECT id, name FROM organizations WHERE id = ?").get(targetOrgId) as
			| { id: string; name: string }
			| undefined;
		if (orgRow) return this.ensureOrgSpace(orgRow);
		const firstOrg = this.db.prepare("SELECT id, name FROM organizations LIMIT 1").get() as
			| { id: string; name: string }
			| undefined;
		if (firstOrg) return this.ensureOrgSpace(firstOrg);
		const fallbackId = `spc_default`;
		const existingFallback = this.getSpace(fallbackId);
		if (existingFallback) return existingFallback;
		const now = nowIso();
		this.db
			.prepare(
				`INSERT INTO spaces (id, kind, org_id, workspace_id, owner_user_id, member_id, name, description, visibility, created_by, created_at, updated_at)
				 VALUES (?, 'custom', NULL, NULL, NULL, NULL, '默认空间', '默认资料空间', 'org', 'system', ?, ?)`,
			)
			.run(fallbackId, now, now);
		return this.getSpace(fallbackId)!;
	}

	listDocuments(filter?: { spaceId?: string; matterId?: string; docType?: SpaceDocumentType }): SpaceDocumentMeta[] {
		const conditions: string[] = [];
		const params: Array<string | number> = [];
		if (filter?.spaceId) {
			conditions.push("space_id = ?");
			params.push(filter.spaceId);
		}
		if (filter?.matterId) {
			conditions.push("matter_id = ?");
			params.push(filter.matterId);
		}
		if (filter?.docType) {
			conditions.push("doc_type = ?");
			params.push(filter.docType);
		}
		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const rows = this.db
			.prepare(`SELECT * FROM space_documents ${where} ORDER BY updated_at DESC, id ASC`)
			.all(...params) as unknown as DocumentRow[];
		return rows.map(mapDocumentMeta);
	}

	listRecentDocumentsForSpaces(
		spaceIds: string[],
		filter?: { docType?: SpaceDocumentType; query?: string; limit?: number },
	): SpaceDocumentMeta[] {
		if (spaceIds.length === 0) return [];
		const placeholders = spaceIds.map(() => "?").join(", ");
		const conditions: string[] = [`space_id IN (${placeholders})`];
		const params: Array<string | number> = [...spaceIds];
		if (filter?.docType) {
			conditions.push("doc_type = ?");
			params.push(filter.docType);
		}
		const trimmedQuery = filter?.query?.trim();
		if (trimmedQuery) {
			const like = `%${trimmedQuery}%`;
			conditions.push("(title LIKE ? OR file_path LIKE ? OR COALESCE(linked_file_path, '') LIKE ?)");
			params.push(like, like, like);
		}
		const limit = Math.max(1, Math.min(200, filter?.limit ?? 60));
		params.push(limit);
		const rows = this.db
			.prepare(
				`SELECT * FROM space_documents WHERE ${conditions.join(" AND ")} ORDER BY updated_at DESC, id ASC LIMIT ?`,
			)
			.all(...params) as unknown as DocumentRow[];
		return rows.map(mapDocumentMeta);
	}

	getDocumentMeta(docId: string): SpaceDocumentMeta | null {
		const row = this.db.prepare("SELECT * FROM space_documents WHERE id = ?").get(docId) as unknown as
			| DocumentRow
			| undefined;
		return row ? mapDocumentMeta(row) : null;
	}

	async getDocument(docId: string): Promise<SpaceDocument | null> {
		const meta = this.getDocumentMeta(docId);
		if (!meta) return null;
		const entryFile = meta.entryKind === "folder" ? `${meta.filePath}/README.md` : meta.filePath;
		const content = (await this.git.readDocument(meta.spaceId, entryFile)) ?? "";
		return { ...meta, content };
	}

	async listDocumentFiles(
		docId: string,
	): Promise<{ files: SpaceDocumentFile[]; previewEntryPath: string | null } | null> {
		const meta = this.getDocumentMeta(docId);
		if (!meta) return null;
		if (meta.entryKind !== "folder") {
			return { files: [], previewEntryPath: null };
		}
		const files = await this.git.listDirectoryFiles(meta.spaceId, meta.filePath);
		return { files, previewEntryPath: detectPreviewEntryPath(files) };
	}

	async readDocumentFile(docId: string, subPath: string): Promise<string | null> {
		const meta = this.getDocumentMeta(docId);
		if (!meta || meta.entryKind !== "folder") return null;
		const safeSub = normalizeSafeRepoFilePath(subPath);
		return this.git.readDocument(meta.spaceId, `${meta.filePath}/${safeSub}`);
	}

	async readDocumentFileRaw(docId: string, subPath: string): Promise<Buffer | null> {
		const meta = this.getDocumentMeta(docId);
		if (!meta || meta.entryKind !== "folder") return null;
		const safeSub = normalizeSafeRepoFilePath(subPath);
		return this.git.readRawFile(meta.spaceId, `${meta.filePath}/${safeSub}`);
	}

	async createDocument(input: {
		spaceId: string;
		matterId?: string | null;
		title: string;
		docType?: SpaceDocumentType;
		entryKind?: SpaceEntryKind;
		content: string;
		extraFiles?: Array<{ subPath: string; content: string }>;
		linkedOrgId?: string | null;
		linkedWorkspaceId?: string | null;
		linkedFilePath?: string | null;
		actorId: string;
		actorName?: string;
		actorEmail?: string;
		filePath?: string;
		commitMessage?: string;
	}): Promise<SpaceDocument> {
		const space = this.getSpace(input.spaceId);
		if (!space) throw new Error(`Space not found: ${input.spaceId}`);
		const id = `doc_${randomUUID()}`;
		const docType = normalizeSpaceDocumentType(input.docType);
		const entryKind = normalizeSpaceEntryKind(input.entryKind);
		const filePath = input.filePath
			? normalizeSafeRepoFilePath(input.filePath)
			: defaultDocFilePath(id, docType, entryKind);
		const title = input.title.trim();
		const linkedOrgId = input.linkedOrgId?.trim() || null;
		const linkedWorkspaceId = input.linkedWorkspaceId?.trim() || null;
		const linkedFilePath = input.linkedFilePath?.trim() || null;
		const now = nowIso();
		const folderFilesMap = new Map<string, string>();
		if (entryKind === "folder") {
			folderFilesMap.set("README.md", input.content);
			folderFilesMap.set(".gitignore", DEFAULT_FOLDER_ENTRY_GITIGNORE);
			for (const extra of input.extraFiles ?? []) {
				const safeSub = normalizeSafeRepoFilePath(extra.subPath);
				folderFilesMap.set(safeSub, extra.content);
			}
		}
		const { commitHash } =
			entryKind === "folder"
				? await this.git.writeFolderFiles({
						spaceId: space.id,
						dirPath: filePath,
						files: Array.from(folderFilesMap.entries()).map(([subPath, content]) => ({ subPath, content })),
						authorName: input.actorName || input.actorId,
						authorEmail: input.actorEmail || defaultAuthorEmail(input.actorId),
						commitMessage: input.commitMessage || `Create ${title}`,
						allowEmpty: true,
					})
				: await this.git.writeDocument({
						spaceId: space.id,
						filePath,
						content: input.content,
						authorName: input.actorName || input.actorId,
						authorEmail: input.actorEmail || defaultAuthorEmail(input.actorId),
						commitMessage: input.commitMessage || `Create ${title}`,
						allowEmpty: true,
					});
		this.db
			.prepare(
				`INSERT INTO space_documents (id, space_id, matter_id, file_path, title, doc_type, entry_kind, linked_org_id, linked_workspace_id, linked_file_path, head_commit, revision, created_by, updated_by, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
			)
			.run(
				id,
				space.id,
				input.matterId ?? null,
				filePath,
				title,
				docType,
				entryKind,
				linkedOrgId,
				linkedWorkspaceId,
				linkedFilePath,
				commitHash,
				input.actorId,
				input.actorId,
				now,
				now,
			);
		this.db.prepare("UPDATE spaces SET updated_at = ? WHERE id = ?").run(now, space.id);
		return {
			id,
			spaceId: space.id,
			matterId: input.matterId ?? null,
			filePath,
			title,
			docType,
			entryKind,
			linkedOrgId,
			linkedWorkspaceId,
			linkedFilePath,
			content: input.content,
			headCommit: commitHash,
			revision: 1,
			createdBy: input.actorId,
			updatedBy: input.actorId,
			createdAt: now,
			updatedAt: now,
		};
	}

	async updateDocument(
		docId: string,
		input: {
			revision?: number;
			expectedCommit?: string;
			title: string;
			docType?: SpaceDocumentType;
			content: string;
			linkedOrgId?: string | null;
			linkedWorkspaceId?: string | null;
			linkedFilePath?: string | null;
			actorId: string;
			actorName?: string;
			actorEmail?: string;
			commitMessage?: string;
		},
	): Promise<SpaceDocument | null> {
		const current = this.getDocumentMeta(docId);
		if (!current) return null;
		if (input.revision !== undefined && input.revision !== current.revision) {
			return null;
		}
		if (input.expectedCommit !== undefined && input.expectedCommit !== current.headCommit) {
			return null;
		}
		const title = input.title.trim();
		const docType = input.docType !== undefined ? normalizeSpaceDocumentType(input.docType) : current.docType;
		const linkedOrgId = input.linkedOrgId !== undefined ? input.linkedOrgId?.trim() || null : current.linkedOrgId;
		const linkedWorkspaceId =
			input.linkedWorkspaceId !== undefined ? input.linkedWorkspaceId?.trim() || null : current.linkedWorkspaceId;
		const linkedFilePath =
			input.linkedFilePath !== undefined ? input.linkedFilePath?.trim() || null : current.linkedFilePath;
		const now = nowIso();
		const metaChanged =
			title !== current.title ||
			docType !== current.docType ||
			linkedOrgId !== current.linkedOrgId ||
			linkedWorkspaceId !== current.linkedWorkspaceId ||
			linkedFilePath !== current.linkedFilePath;
		let commitHash: string;
		try {
			const committed =
				current.entryKind === "folder"
					? await this.git.writeFolderFiles({
							spaceId: current.spaceId,
							dirPath: current.filePath,
							files: [{ subPath: "README.md", content: input.content }],
							authorName: input.actorName || input.actorId,
							authorEmail: input.actorEmail || defaultAuthorEmail(input.actorId),
							commitMessage: input.commitMessage || `Update ${title}`,
							expectedCommit: current.headCommit || null,
							allowEmpty: metaChanged,
						})
					: await this.git.writeDocument({
							spaceId: current.spaceId,
							filePath: current.filePath,
							content: input.content,
							authorName: input.actorName || input.actorId,
							authorEmail: input.actorEmail || defaultAuthorEmail(input.actorId),
							commitMessage: input.commitMessage || `Update ${title}`,
							expectedCommit: current.headCommit || null,
							allowEmpty: metaChanged,
						});
			commitHash = committed.commitHash;
		} catch (error) {
			if (error instanceof SpaceConflictError) return null;
			throw error;
		}
		const nextRevision = current.revision + 1;
		const changed = this.db
			.prepare(
				`UPDATE space_documents
				 SET title = ?, doc_type = ?, linked_org_id = ?, linked_workspace_id = ?, linked_file_path = ?, head_commit = ?, revision = ?, updated_by = ?, updated_at = ?
				 WHERE id = ? AND revision = ?`,
			)
			.run(
				title,
				docType,
				linkedOrgId,
				linkedWorkspaceId,
				linkedFilePath,
				commitHash,
				nextRevision,
				input.actorId,
				now,
				docId,
				current.revision,
			);
		if (changed.changes !== 1) return null;
		this.db.prepare("UPDATE spaces SET updated_at = ? WHERE id = ?").run(now, current.spaceId);
		return {
			...current,
			title,
			docType,
			linkedOrgId,
			linkedWorkspaceId,
			linkedFilePath,
			content: input.content,
			headCommit: commitHash,
			revision: nextRevision,
			updatedBy: input.actorId,
			updatedAt: now,
		};
	}

	async promoteDocumentToFolder(
		docId: string,
		input: { actorId: string; actorName?: string; actorEmail?: string; commitMessage?: string },
	): Promise<SpaceDocument | null> {
		const current = this.getDocumentMeta(docId);
		if (!current) return null;
		if (current.entryKind === "folder") {
			return this.getDocument(docId);
		}
		const targetDir = defaultDocFilePath(current.id, current.docType, "folder");
		const now = nowIso();
		const { commitHash } = await this.git.promoteFileToFolder({
			spaceId: current.spaceId,
			oldFilePath: current.filePath,
			dirPath: targetDir,
			defaultGitignore: DEFAULT_FOLDER_ENTRY_GITIGNORE,
			authorName: input.actorName || input.actorId,
			authorEmail: input.actorEmail || defaultAuthorEmail(input.actorId),
			commitMessage: input.commitMessage || `Convert ${current.title} to folder entry`,
		});
		const nextRevision = current.revision + 1;
		this.db
			.prepare(
				`UPDATE space_documents
				 SET file_path = ?, entry_kind = 'folder', head_commit = ?, revision = ?, updated_by = ?, updated_at = ?
				 WHERE id = ?`,
			)
			.run(targetDir, commitHash, nextRevision, input.actorId, now, docId);
		this.db.prepare("UPDATE spaces SET updated_at = ? WHERE id = ?").run(now, current.spaceId);
		return this.getDocument(docId);
	}

	async writeDocumentFiles(
		docId: string,
		input: {
			files: Array<{ subPath: string; content: string }>;
			actorId: string;
			actorName?: string;
			actorEmail?: string;
			commitMessage?: string;
		},
	): Promise<{
		document: SpaceDocument;
		files: SpaceDocumentFile[];
		previewEntryPath: string | null;
	} | null> {
		if (input.files.length === 0) return null;
		const normalized = input.files.map((item) => ({
			subPath: normalizeSafeRepoFilePath(item.subPath),
			content: item.content,
		}));
		let current = this.getDocumentMeta(docId);
		if (!current) return null;
		if (current.entryKind !== "folder") {
			await this.promoteDocumentToFolder(docId, {
				actorId: input.actorId,
				actorName: input.actorName,
				actorEmail: input.actorEmail,
			});
			current = this.getDocumentMeta(docId);
			if (!current || current.entryKind !== "folder") return null;
		}
		const now = nowIso();
		const defaultMsg =
			normalized.length === 1
				? `Update ${normalized[0]!.subPath} in ${current.title}`
				: `Add/update ${normalized.length} files in ${current.title}`;
		const { commitHash } = await this.git.writeFolderFiles({
			spaceId: current.spaceId,
			dirPath: current.filePath,
			files: normalized,
			authorName: input.actorName || input.actorId,
			authorEmail: input.actorEmail || defaultAuthorEmail(input.actorId),
			commitMessage: input.commitMessage || defaultMsg,
			allowEmpty: true,
		});
		const nextRevision = current.revision + 1;
		this.db
			.prepare(
				`UPDATE space_documents
				 SET head_commit = ?, revision = ?, updated_by = ?, updated_at = ?
				 WHERE id = ?`,
			)
			.run(commitHash, nextRevision, input.actorId, now, docId);
		this.db.prepare("UPDATE spaces SET updated_at = ? WHERE id = ?").run(now, current.spaceId);
		const doc = await this.getDocument(docId);
		if (!doc) return null;
		const listed = await this.listDocumentFiles(docId);
		return {
			document: doc,
			files: listed?.files ?? [],
			previewEntryPath: listed?.previewEntryPath ?? null,
		};
	}

	async writeDocumentFile(
		docId: string,
		input: {
			subPath: string;
			content: string;
			actorId: string;
			actorName?: string;
			actorEmail?: string;
			commitMessage?: string;
		},
	): Promise<{
		document: SpaceDocument;
		subPath: string;
		files: SpaceDocumentFile[];
		previewEntryPath: string | null;
	} | null> {
		const safeSub = normalizeSafeRepoFilePath(input.subPath);
		const res = await this.writeDocumentFiles(docId, {
			files: [{ subPath: safeSub, content: input.content }],
			actorId: input.actorId,
			actorName: input.actorName,
			actorEmail: input.actorEmail,
			commitMessage: input.commitMessage,
		});
		return res ? { ...res, subPath: safeSub } : null;
	}

	async deleteDocumentFile(
		docId: string,
		input: {
			subPath: string;
			actorId: string;
			actorName?: string;
			actorEmail?: string;
			commitMessage?: string;
		},
	): Promise<{
		document: SpaceDocument;
		files: SpaceDocumentFile[];
		previewEntryPath: string | null;
	} | null> {
		const current = this.getDocumentMeta(docId);
		if (!current || current.entryKind !== "folder") return null;
		const safeSub = normalizeSafeRepoFilePath(input.subPath);
		if (safeSub === "README.md") {
			throw new Error("不能删除目录条目的主入口文件 README.md");
		}
		const now = nowIso();
		const { commitHash } = await this.git.deleteFolderFile({
			spaceId: current.spaceId,
			dirPath: current.filePath,
			subPath: safeSub,
			authorName: input.actorName || input.actorId,
			authorEmail: input.actorEmail || defaultAuthorEmail(input.actorId),
			commitMessage: input.commitMessage || `Delete ${safeSub} from ${current.title}`,
		});
		const nextRevision = current.revision + 1;
		this.db
			.prepare(
				`UPDATE space_documents
				 SET head_commit = ?, revision = ?, updated_by = ?, updated_at = ?
				 WHERE id = ?`,
			)
			.run(commitHash, nextRevision, input.actorId, now, docId);
		this.db.prepare("UPDATE spaces SET updated_at = ? WHERE id = ?").run(now, current.spaceId);
		const doc = await this.getDocument(docId);
		if (!doc) return null;
		const listed = await this.listDocumentFiles(docId);
		return {
			document: doc,
			files: listed?.files ?? [],
			previewEntryPath: listed?.previewEntryPath ?? null,
		};
	}

	async listDocumentCommits(docId: string, limit = 50): Promise<SpaceGitCommit[]> {
		const meta = this.getDocumentMeta(docId);
		if (!meta) return [];
		return this.git.listCommits(meta.spaceId, meta.filePath, limit);
	}

	listDocumentFeedback(docId: string): SpaceDocumentFeedback[] {
		const rows = this.db
			.prepare("SELECT * FROM space_document_feedback WHERE document_id = ? ORDER BY updated_at DESC, actor_id")
			.all(docId) as unknown as Array<{
			document_id: string;
			commit_hash: string;
			actor_id: string;
			actor_name: string;
			feedback: string;
			rating: SpaceDocumentFeedback["rating"];
			created_at: string;
			updated_at: string;
		}>;
		return rows.map((row) => ({
			documentId: row.document_id,
			commitHash: row.commit_hash,
			actorId: row.actor_id,
			actorName: row.actor_name,
			feedback: row.feedback,
			rating: row.rating,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		}));
	}

	async saveDocumentFeedback(input: {
		documentId: string;
		commitHash: string;
		actorId: string;
		actorName: string;
		feedback: string;
		rating: SpaceDocumentFeedback["rating"];
	}): Promise<SpaceDocumentFeedback | null> {
		const document = this.getDocumentMeta(input.documentId);
		if (!document) return null;
		const hash = input.commitHash.toLowerCase();
		if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(hash)) throw new Error("Invalid document commit hash");
		if (
			hash !== document.headCommit &&
			!(await this.git.isDocumentCommit(document.spaceId, document.filePath, hash))
		) {
			throw new Error("Commit does not belong to this document");
		}
		const now = nowIso();
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db
				.prepare(`INSERT INTO space_document_feedback
				(document_id, commit_hash, actor_id, actor_name, feedback, rating, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(document_id, commit_hash, actor_id) DO UPDATE SET
				actor_name = excluded.actor_name, feedback = excluded.feedback,
				rating = excluded.rating, updated_at = excluded.updated_at`)
				.run(input.documentId, hash, input.actorId, input.actorName, input.feedback, input.rating, now, now);
			syncSpaceFeedbackVotes(this.db, { ...input, commitHash: hash });
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
		return (
			this.listDocumentFeedback(input.documentId).find(
				(entry) => entry.commitHash === hash && entry.actorId === input.actorId,
			) ?? null
		);
	}

	async getDocumentCommitDetail(docId: string, commitHash: string): Promise<SpaceGitCommitDetail | null> {
		const meta = this.getDocumentMeta(docId);
		if (!meta) return null;
		return this.git.getCommitDetail(meta.spaceId, commitHash, meta.filePath);
	}
}
