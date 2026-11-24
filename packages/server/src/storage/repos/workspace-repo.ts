import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { MESSAGE_WORKSPACE_ID_SQL } from "../schema.ts";
import type { WorkspaceLink, WorkspaceSourceType, WorkspaceVisibility } from "../types.ts";
import { mapWorkspaceRow, normalizeUniqueIds, nowIso } from "./helpers.ts";
import type { OrganizationRepo } from "./organization-repo.ts";

const WORKSPACE_HAS_HISTORY_OR_GRANTS = `
	EXISTS (SELECT 1 FROM matters WHERE workspace_id = w.id)
	OR EXISTS (SELECT 1 FROM member_memories WHERE workspace_id = w.id)
	OR EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = w.id)
	OR EXISTS (SELECT 1 FROM worker_sessions WHERE workspace_id = w.id)
	OR EXISTS (SELECT 1 FROM matter_messages WHERE ${MESSAGE_WORKSPACE_ID_SQL} = w.id)
`;

export class WorkspaceMutationError extends Error {
	readonly statusCode: 400 | 409;

	constructor(statusCode: 400 | 409, message: string) {
		super(message);
		this.statusCode = statusCode;
	}
}

export class WorkspaceRepo {
	private readonly db: DatabaseSync;
	private readonly orgs: OrganizationRepo;

	constructor(db: DatabaseSync, orgs: OrganizationRepo) {
		this.db = db;
		this.orgs = orgs;
	}

	upsertWorkspace(input: {
		id?: string;
		orgId?: string | null;
		name: string;
		repoPath: string;
		defaultBranch?: string;
		description?: string;
		sourceType?: WorkspaceSourceType;
		cloneUrl?: string | null;
		visibility?: WorkspaceVisibility;
		allowedUserIds?: string[];
	}): WorkspaceLink {
		return this.write(() => this.upsertWorkspaceInTransaction(input));
	}

	private upsertWorkspaceInTransaction(input: Parameters<WorkspaceRepo["upsertWorkspace"]>[0]): WorkspaceLink {
		const existing = this.db.prepare("SELECT * FROM workspace_links WHERE repo_path = ?").get(input.repoPath) as
			| Record<string, unknown>
			| undefined;
		if (existing) {
			const nextOrgId = input.orgId !== undefined ? input.orgId : existing.org_id ? String(existing.org_id) : null;
			const workspaceId = String(existing.id);
			this.validateOrganizationChange(workspaceId, existing.org_id ? String(existing.org_id) : null, nextOrgId);
			const nextSourceType = input.sourceType ?? (existing.source_type === "cloned" ? "cloned" : "local");
			const nextCloneUrl =
				input.cloneUrl !== undefined ? input.cloneUrl : existing.clone_url ? String(existing.clone_url) : null;
			const nextVisibility = input.visibility ?? (existing.visibility === "restricted" ? "restricted" : "org");
			this.db
				.prepare(
					`UPDATE workspace_links
					 SET org_id = ?, name = ?, default_branch = ?, description = ?, source_type = ?, clone_url = ?, visibility = ?
					 WHERE id = ?`,
				)
				.run(
					nextOrgId,
					input.name,
					input.defaultBranch ?? String(existing.default_branch),
					input.description ?? String(existing.description),
					nextSourceType,
					nextCloneUrl,
					nextVisibility,
					String(existing.id),
				);
			this.updateWorkspaceMembers(workspaceId, input.visibility, input.allowedUserIds);
			return this.getWorkspace(workspaceId)!;
		}

		const id = input.id ?? `ws_${randomUUID()}`;
		const timestamp = nowIso();
		this.db
			.prepare(
				`INSERT INTO workspace_links (id, org_id, name, repo_path, default_branch, description, source_type, clone_url, visibility, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				input.orgId ?? null,
				input.name,
				input.repoPath,
				input.defaultBranch ?? "main",
				input.description ?? "",
				input.sourceType ?? "local",
				input.cloneUrl ?? null,
				input.visibility ?? "org",
				timestamp,
			);
		this.updateWorkspaceMembers(id, input.visibility, input.allowedUserIds);
		return this.getWorkspace(id)!;
	}

	updateWorkspace(
		id: string,
		patch: {
			orgId?: string | null;
			name?: string;
			defaultBranch?: string;
			description?: string;
			visibility?: WorkspaceVisibility;
			allowedUserIds?: string[];
		},
	): WorkspaceLink {
		return this.write(() => this.updateWorkspaceInTransaction(id, patch));
	}

	private updateWorkspaceInTransaction(
		id: string,
		patch: Parameters<WorkspaceRepo["updateWorkspace"]>[1],
	): WorkspaceLink {
		const existing = this.getWorkspace(id);
		if (!existing) throw new Error(`Workspace not found: ${id}`);
		const nextOrgId = patch.orgId !== undefined ? patch.orgId : existing.orgId;
		this.validateOrganizationChange(id, existing.orgId, nextOrgId);
		const nextName = patch.name !== undefined ? patch.name.trim() || existing.name : existing.name;
		const nextBranch =
			patch.defaultBranch !== undefined
				? patch.defaultBranch.trim() || existing.defaultBranch
				: existing.defaultBranch;
		const nextDesc = patch.description !== undefined ? patch.description.trim() : existing.description;
		const nextVisibility = patch.visibility ?? existing.visibility ?? "org";
		this.db
			.prepare(
				`UPDATE workspace_links
				 SET org_id = ?, name = ?, default_branch = ?, description = ?, visibility = ?
				 WHERE id = ?`,
			)
			.run(nextOrgId, nextName, nextBranch, nextDesc, nextVisibility, id);
		this.updateWorkspaceMembers(id, patch.visibility, patch.allowedUserIds);
		return this.getWorkspace(id)!;
	}

	getWorkspace(id: string): WorkspaceLink | null {
		const row = this.db.prepare("SELECT * FROM workspace_links WHERE id = ?").get(id) as
			| Record<string, unknown>
			| undefined;
		return row ? mapWorkspaceRow(row) : null;
	}

	listWorkspaces(): WorkspaceLink[] {
		const rows = this.db.prepare("SELECT * FROM workspace_links ORDER BY created_at ASC").all() as Record<
			string,
			unknown
		>[];
		return rows.map((row) => mapWorkspaceRow(row));
	}

	setWorkspaceAccess(workspaceId: string, visibility: WorkspaceVisibility, allowedUserIds: string[]): void {
		this.updateWorkspace(workspaceId, { visibility, allowedUserIds });
	}

	listWorkspaceMemberIds(workspaceId: string): string[] {
		const rows = this.db
			.prepare("SELECT user_id FROM workspace_members WHERE workspace_id = ? ORDER BY created_at ASC")
			.all(workspaceId);
		return rows.map((row) => String(row.user_id));
	}

	isWorkspaceMember(workspaceId: string, userId: string): boolean {
		return Boolean(
			this.db
				.prepare("SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?")
				.get(workspaceId, userId),
		);
	}

	assignOrphanWorkspacesToDefaultOrganization(): number {
		const defaultOrg = this.orgs.ensureDefaultOrganization();
		return this.write(() => {
			const rows = this.db
				.prepare(`SELECT w.id FROM workspace_links w
				WHERE w.org_id IS NULL AND NOT (${WORKSPACE_HAS_HISTORY_OR_GRANTS})`)
				.all();
			const setOrganization = this.db.prepare("UPDATE workspace_links SET org_id = ? WHERE id = ?");
			for (const row of rows) setOrganization.run(defaultOrg.id, String(row.id));
			return rows.length;
		});
	}

	/** Older databases may already contain an out-of-scope workspace reassignment. */
	hasWorkspaceScopeConflict(workspaceId: string): boolean {
		return Boolean(
			this.db
				.prepare(`SELECT 1 FROM workspace_links w
			WHERE w.id = ? AND (
				EXISTS (SELECT 1 FROM matters m WHERE m.workspace_id = w.id AND m.org_id IS NOT w.org_id)
				OR EXISTS (
					SELECT 1 FROM matter_messages WHERE ${MESSAGE_WORKSPACE_ID_SQL} = w.id
					AND CASE WHEN json_valid(metadata_json) THEN json_type(metadata_json, '$.orgId') IS NOT NULL
						AND json_extract(metadata_json, '$.orgId') IS NOT w.org_id ELSE 0 END
				)
			)`)
				.get(workspaceId),
		);
	}

	private validateOrganizationChange(
		workspaceId: string,
		currentOrgId: string | null,
		nextOrgId: string | null,
	): void {
		if (currentOrgId === nextOrgId) return;
		if (nextOrgId && !this.orgs.getOrganization(nextOrgId)) {
			throw new WorkspaceMutationError(400, `Organization not found: ${nextOrgId}`);
		}
		const referenced = this.db
			.prepare(`SELECT 1 FROM workspace_links w
			WHERE w.id = ? AND (${WORKSPACE_HAS_HISTORY_OR_GRANTS})`)
			.get(workspaceId);
		if (referenced) {
			throw new WorkspaceMutationError(409, "工作区已有事项、经验、执行历史或授权名单，无法更改所属组织");
		}
	}

	private updateWorkspaceMembers(
		workspaceId: string,
		visibility: WorkspaceVisibility | undefined,
		allowedUserIds: string[] | undefined,
	): void {
		if (visibility !== "org" && allowedUserIds === undefined) return;
		const effectiveVisibility = visibility ?? this.getWorkspace(workspaceId)?.visibility ?? "org";
		const ids = effectiveVisibility === "restricted" ? normalizeUniqueIds(allowedUserIds) : [];
		const getUser = this.db.prepare("SELECT 1 FROM users WHERE id = ?");
		for (const userId of ids) {
			if (!getUser.get(userId)) throw new WorkspaceMutationError(400, `Workspace member not found: ${userId}`);
		}
		this.db.prepare("DELETE FROM workspace_members WHERE workspace_id = ?").run(workspaceId);
		const insert = this.db.prepare(
			"INSERT INTO workspace_members (workspace_id, user_id, created_at) VALUES (?, ?, ?)",
		);
		const timestamp = nowIso();
		for (const userId of ids) insert.run(workspaceId, userId, timestamp);
	}

	private write<T>(operation: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = operation();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
}
