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

export type SpaceKind = "org" | "workspace" | "user" | "member" | "custom";
export type SpaceVisibility = "org" | "private";

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

function defaultDocFilePath(docId: string): string {
	return normalizeSafeRepoFilePath(`pages/${docId}.md`);
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

	listDocuments(filter?: { spaceId?: string; matterId?: string }): SpaceDocumentMeta[] {
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
		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const rows = this.db
			.prepare(`SELECT * FROM space_documents ${where} ORDER BY updated_at DESC, id ASC`)
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
		const content = (await this.git.readDocument(meta.spaceId, meta.filePath)) ?? "";
		return { ...meta, content };
	}

	async createDocument(input: {
		spaceId: string;
		matterId?: string | null;
		title: string;
		content: string;
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
		const filePath = input.filePath ? normalizeSafeRepoFilePath(input.filePath) : defaultDocFilePath(id);
		const title = input.title.trim();
		const linkedOrgId = input.linkedOrgId?.trim() || null;
		const linkedWorkspaceId = input.linkedWorkspaceId?.trim() || null;
		const linkedFilePath = input.linkedFilePath?.trim() || null;
		const now = nowIso();
		const { commitHash } = await this.git.writeDocument({
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
				`INSERT INTO space_documents (id, space_id, matter_id, file_path, title, linked_org_id, linked_workspace_id, linked_file_path, head_commit, revision, created_by, updated_by, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
			)
			.run(
				id,
				space.id,
				input.matterId ?? null,
				filePath,
				title,
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
		const linkedOrgId = input.linkedOrgId !== undefined ? input.linkedOrgId?.trim() || null : current.linkedOrgId;
		const linkedWorkspaceId =
			input.linkedWorkspaceId !== undefined ? input.linkedWorkspaceId?.trim() || null : current.linkedWorkspaceId;
		const linkedFilePath =
			input.linkedFilePath !== undefined ? input.linkedFilePath?.trim() || null : current.linkedFilePath;
		const now = nowIso();
		let commitHash: string;
		try {
			const committed = await this.git.writeDocument({
				spaceId: current.spaceId,
				filePath: current.filePath,
				content: input.content,
				authorName: input.actorName || input.actorId,
				authorEmail: input.actorEmail || defaultAuthorEmail(input.actorId),
				commitMessage: input.commitMessage || `Update ${title}`,
				expectedCommit: current.headCommit || null,
				allowEmpty:
					title !== current.title ||
					linkedOrgId !== current.linkedOrgId ||
					linkedWorkspaceId !== current.linkedWorkspaceId ||
					linkedFilePath !== current.linkedFilePath,
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
				 SET title = ?, linked_org_id = ?, linked_workspace_id = ?, linked_file_path = ?, head_commit = ?, revision = ?, updated_by = ?, updated_at = ?
				 WHERE id = ? AND revision = ?`,
			)
			.run(
				title,
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

	async listDocumentCommits(docId: string, limit = 50): Promise<SpaceGitCommit[]> {
		const meta = this.getDocumentMeta(docId);
		if (!meta) return [];
		return this.git.listCommits(meta.spaceId, meta.filePath, limit);
	}

	async getDocumentCommitDetail(docId: string, commitHash: string): Promise<SpaceGitCommitDetail | null> {
		const meta = this.getDocumentMeta(docId);
		if (!meta) return null;
		return this.git.getCommitDetail(meta.spaceId, commitHash, meta.filePath);
	}

	/** Import legacy DB-stored space_pages into the new Git-backed spaces once, without duplicating. */
	async migrateLegacySpacePages(): Promise<number> {
		const tableExists = this.db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'space_pages'")
			.get();
		if (!tableExists) return 0;
		const legacyPages = this.db
			.prepare(
				"SELECT id, matter_id, title, content, revision, created_by, updated_by, created_at, updated_at FROM space_pages ORDER BY created_at ASC",
			)
			.all() as Array<{
			id: string;
			matter_id: string;
			title: string;
			content: string;
			revision: number;
			created_by: string;
			updated_by: string;
			created_at: string;
			updated_at: string;
		}>;
		if (legacyPages.length === 0) return 0;

		let migrated = 0;
		for (const page of legacyPages) {
			if (this.getDocumentMeta(page.id)) continue;
			const matter = this.db
				.prepare("SELECT id, org_id, workspace_id, visibility, created_by_user_id FROM matters WHERE id = ?")
				.get(page.matter_id) as
				| {
						id: string;
						org_id: string | null;
						workspace_id: string | null;
						visibility: "org" | "private";
						created_by_user_id: string | null;
				  }
				| undefined;
			if (!matter) continue;
			const space = this.resolveMatterDefaultSpace({
				id: matter.id,
				orgId: matter.org_id,
				workspaceId: matter.workspace_id,
				visibility: matter.visibility === "private" ? "private" : "org",
				createdByUserId: matter.created_by_user_id,
			});
			const filePath = defaultDocFilePath(page.id);
			const { commitHash } = await this.git.writeDocument({
				spaceId: space.id,
				filePath,
				content: page.content,
				authorName: page.updated_by,
				authorEmail: defaultAuthorEmail(page.updated_by),
				commitMessage: `Migrate ${page.title}`,
				allowEmpty: true,
			});
			this.db
				.prepare(
					`INSERT OR IGNORE INTO space_documents (id, space_id, matter_id, file_path, title, head_commit, revision, created_by, updated_by, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					page.id,
					space.id,
					page.matter_id,
					filePath,
					page.title,
					commitHash,
					page.revision,
					page.created_by,
					page.updated_by,
					page.created_at,
					page.updated_at,
				);
			migrated += 1;
		}
		return migrated;
	}
}
