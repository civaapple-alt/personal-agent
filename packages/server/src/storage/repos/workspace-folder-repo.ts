import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { WorkspaceSourceType } from "../types.ts";
import { nowIso } from "./helpers.ts";

export type WorkspaceFolderRole = "primary" | "attached";

export interface WorkspaceFolder {
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

interface FolderRow {
	id: string;
	workspace_id: string;
	label: string;
	path: string;
	source_type: WorkspaceSourceType;
	role: WorkspaceFolderRole;
	load_rules: number;
	load_skills: number;
	sort_order: number;
	created_at: string;
	updated_at: string;
}

function mapFolder(row: FolderRow): WorkspaceFolder {
	return {
		id: row.id,
		workspaceId: row.workspace_id,
		label: row.label,
		path: row.path,
		sourceType: row.source_type === "cloned" ? "cloned" : "local",
		role: row.role === "primary" ? "primary" : "attached",
		loadRules: Boolean(row.load_rules),
		loadSkills: Boolean(row.load_skills),
		sortOrder: Number(row.sort_order ?? 0),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export class WorkspaceFolderRepo {
	private readonly db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	/** Ensure the workspace's primary repo_path exists as a primary folder row. */
	ensurePrimaryFolder(workspaceId: string): WorkspaceFolder | null {
		const ws = this.db
			.prepare("SELECT id, name, repo_path, source_type FROM workspace_links WHERE id = ?")
			.get(workspaceId) as
			| { id: string; name: string; repo_path: string; source_type: WorkspaceSourceType }
			| undefined;
		if (!ws) return null;

		const existingPrimary = this.db
			.prepare("SELECT * FROM workspace_folders WHERE workspace_id = ? AND role = 'primary' LIMIT 1")
			.get(workspaceId) as unknown as FolderRow | undefined;
		if (existingPrimary) {
			return mapFolder(existingPrimary);
		}

		const normalizedPath = resolve(ws.repo_path);
		const byPath = this.db
			.prepare("SELECT * FROM workspace_folders WHERE workspace_id = ? AND path = ? LIMIT 1")
			.get(workspaceId, normalizedPath) as unknown as FolderRow | undefined;
		const now = nowIso();
		if (byPath) {
			this.db
				.prepare("UPDATE workspace_folders SET role = 'primary', sort_order = 0, updated_at = ? WHERE id = ?")
				.run(now, byPath.id);
			return this.getFolder(byPath.id);
		}

		const id = `fld_${randomUUID()}`;
		const label = basename(normalizedPath) || ws.name || "workspace";
		this.db
			.prepare(
				`INSERT INTO workspace_folders (id, workspace_id, label, path, source_type, role, load_rules, load_skills, sort_order, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, 'primary', 1, 1, 0, ?, ?)`,
			)
			.run(id, workspaceId, label, normalizedPath, ws.source_type === "cloned" ? "cloned" : "local", now, now);
		return this.getFolder(id);
	}

	getFolder(folderId: string): WorkspaceFolder | null {
		const row = this.db.prepare("SELECT * FROM workspace_folders WHERE id = ?").get(folderId) as unknown as
			| FolderRow
			| undefined;
		return row ? mapFolder(row) : null;
	}

	listFolders(workspaceId: string): WorkspaceFolder[] {
		this.ensurePrimaryFolder(workspaceId);
		const rows = this.db
			.prepare(
				`SELECT * FROM workspace_folders
				 WHERE workspace_id = ?
				 ORDER BY CASE role WHEN 'primary' THEN 0 ELSE 1 END, sort_order ASC, created_at ASC`,
			)
			.all(workspaceId) as unknown as FolderRow[];
		return rows.map(mapFolder);
	}

	addFolder(input: {
		workspaceId: string;
		label?: string;
		path: string;
		sourceType?: WorkspaceSourceType;
		loadRules?: boolean;
		loadSkills?: boolean;
	}): WorkspaceFolder {
		const primary = this.ensurePrimaryFolder(input.workspaceId);
		if (!primary) throw new Error(`Workspace not found: ${input.workspaceId}`);
		const normalizedPath = resolve(input.path);
		const existing = this.db
			.prepare("SELECT * FROM workspace_folders WHERE workspace_id = ? AND path = ?")
			.get(input.workspaceId, normalizedPath) as unknown as FolderRow | undefined;
		if (existing) {
			throw new Error(`该目录已在当前工作区中: ${normalizedPath}`);
		}
		const maxRow = this.db
			.prepare("SELECT COALESCE(MAX(sort_order), 0) AS max_order FROM workspace_folders WHERE workspace_id = ?")
			.get(input.workspaceId) as { max_order: number } | undefined;
		const id = `fld_${randomUUID()}`;
		const label = input.label?.trim() || basename(normalizedPath) || "folder";
		const now = nowIso();
		this.db
			.prepare(
				`INSERT INTO workspace_folders (id, workspace_id, label, path, source_type, role, load_rules, load_skills, sort_order, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, 'attached', ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				input.workspaceId,
				label,
				normalizedPath,
				input.sourceType === "cloned" ? "cloned" : "local",
				input.loadRules === false ? 0 : 1,
				input.loadSkills === false ? 0 : 1,
				Number(maxRow?.max_order ?? 0) + 1,
				now,
				now,
			);
		return this.getFolder(id)!;
	}

	updateFolder(
		folderId: string,
		patch: { label?: string; loadRules?: boolean; loadSkills?: boolean },
	): WorkspaceFolder | null {
		const current = this.getFolder(folderId);
		if (!current) return null;
		const nextLabel = patch.label !== undefined ? patch.label.trim() || current.label : current.label;
		const nextRules = patch.loadRules !== undefined ? (patch.loadRules ? 1 : 0) : current.loadRules ? 1 : 0;
		const nextSkills = patch.loadSkills !== undefined ? (patch.loadSkills ? 1 : 0) : current.loadSkills ? 1 : 0;
		const now = nowIso();
		this.db
			.prepare(
				`UPDATE workspace_folders
				 SET label = ?, load_rules = ?, load_skills = ?, updated_at = ?
				 WHERE id = ?`,
			)
			.run(nextLabel, nextRules, nextSkills, now, folderId);
		return this.getFolder(folderId);
	}

	setPrimaryFolder(workspaceId: string, folderId: string): WorkspaceFolder | null {
		const target = this.getFolder(folderId);
		if (!target || target.workspaceId !== workspaceId) return null;
		const now = nowIso();
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db
				.prepare("UPDATE workspace_folders SET role = 'attached', updated_at = ? WHERE workspace_id = ?")
				.run(now, workspaceId);
			this.db
				.prepare("UPDATE workspace_folders SET role = 'primary', sort_order = 0, updated_at = ? WHERE id = ?")
				.run(now, folderId);
			this.db.prepare("UPDATE workspace_links SET repo_path = ? WHERE id = ?").run(target.path, workspaceId);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
		return this.getFolder(folderId);
	}

	removeFolder(folderId: string): boolean {
		const current = this.getFolder(folderId);
		if (!current) return false;
		if (current.role === "primary") {
			throw new Error("不能移除工作区主目录，请先将其他目录设为主目录");
		}
		const result = this.db.prepare("DELETE FROM workspace_folders WHERE id = ?").run(folderId);
		return result.changes > 0;
	}
}
