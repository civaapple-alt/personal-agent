import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Organization, WorkspaceLink, WorkspaceSourceType, WorkspaceVisibility } from "../types.ts";
import {
	DEFAULT_ORGANIZATION_ID,
	DEFAULT_ORGANIZATION_NAME,
	mapOrganizationRow,
	mapWorkspaceRow,
	nowIso,
	slugifyOrganizationName,
} from "./helpers.ts";

/** Manages organizations, default org seeding, and linked Git project workspaces. */
export class OrganizationRepo {
	private readonly db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	upsertOrganization(input: {
		id?: string;
		name: string;
		slug?: string;
		gitEmailDomain?: string;
		useRoleGitIdentity?: boolean;
		description?: string;
		isDefault?: boolean;
		workspacesDir?: string | null;
		createdByUserId?: string | null;
	}): Organization {
		const name = input.name.trim();
		if (!name) throw new Error("Organization name is required");
		const timestamp = nowIso();
		const gitEmailDomain = (input.gitEmailDomain ?? "").trim().replace(/^@+/, "");
		const description = (input.description ?? "").trim();
		if (input.id) {
			const existing = this.getOrganization(input.id);
			if (existing) {
				this.db.exec("BEGIN IMMEDIATE");
				try {
					if (input.isDefault === true) {
						this.db.prepare("UPDATE organizations SET is_default = 0").run();
					}
					const nextDefault =
						input.isDefault !== undefined ? (input.isDefault ? 1 : 0) : existing.isDefault ? 1 : 0;
					const nextUseRoleGitIdentity =
						input.useRoleGitIdentity !== undefined
							? input.useRoleGitIdentity
								? 1
								: 0
							: existing.useRoleGitIdentity
								? 1
								: 0;
					const nextSlug = input.slug?.trim() || existing.slug || slugifyOrganizationName(name, existing.id);
					const nextWorkspacesDir =
						input.workspacesDir !== undefined ? input.workspacesDir : (existing.workspacesDir ?? null);
					this.db
						.prepare(
							`UPDATE organizations
							 SET name = ?, slug = ?, git_email_domain = ?, use_role_git_identity = ?, description = ?, is_default = ?, workspaces_dir = ?, updated_at = ?
							 WHERE id = ?`,
						)
						.run(
							name,
							nextSlug,
							gitEmailDomain,
							nextUseRoleGitIdentity,
							description,
							nextDefault,
							nextWorkspacesDir,
							timestamp,
							existing.id,
						);
					this.db.exec("COMMIT");
				} catch (err) {
					this.db.exec("ROLLBACK");
					throw err;
				}
				return this.getOrganization(existing.id)!;
			}
		}
		const id = input.id?.trim() || `org_${randomUUID()}`;
		const slug = input.slug?.trim() || slugifyOrganizationName(name, id);
		const hasDefault = Boolean(this.db.prepare("SELECT 1 FROM organizations WHERE is_default = 1 LIMIT 1").get());
		const shouldBeDefault = input.isDefault !== undefined ? input.isDefault : !hasDefault;
		const useRoleGitIdentity = input.useRoleGitIdentity === true ? 1 : 0;
		this.db.exec("BEGIN IMMEDIATE");
		try {
			if (shouldBeDefault) {
				this.db.prepare("UPDATE organizations SET is_default = 0").run();
			}
			this.db
				.prepare(
					`INSERT INTO organizations (id, name, slug, git_email_domain, use_role_git_identity, description, is_default, workspaces_dir, created_by_user_id, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					id,
					name,
					slug,
					gitEmailDomain,
					useRoleGitIdentity,
					description,
					shouldBeDefault ? 1 : 0,
					input.workspacesDir ?? null,
					input.createdByUserId ?? null,
					timestamp,
					timestamp,
				);
			this.db.exec("COMMIT");
		} catch (err) {
			this.db.exec("ROLLBACK");
			throw err;
		}
		return this.getOrganization(id)!;
	}

	updateOrganization(
		id: string,
		patch: {
			name?: string;
			gitEmailDomain?: string;
			useRoleGitIdentity?: boolean;
			description?: string;
			isDefault?: boolean;
		},
	): Organization {
		const existing = this.getOrganization(id);
		if (!existing) throw new Error(`Organization not found: ${id}`);
		const timestamp = nowIso();
		const name = patch.name !== undefined ? patch.name.trim() || existing.name : existing.name;
		const gitEmailDomain =
			patch.gitEmailDomain !== undefined ? patch.gitEmailDomain.trim().replace(/^@+/, "") : existing.gitEmailDomain;
		const useRoleGitIdentity =
			patch.useRoleGitIdentity !== undefined ? patch.useRoleGitIdentity : Boolean(existing.useRoleGitIdentity);
		const description = patch.description !== undefined ? patch.description.trim() : existing.description;
		const nextDefault = patch.isDefault !== undefined ? patch.isDefault : existing.isDefault;
		this.db.exec("BEGIN IMMEDIATE");
		try {
			if (patch.isDefault === true) {
				this.db.prepare("UPDATE organizations SET is_default = 0").run();
			}
			this.db
				.prepare(
					`UPDATE organizations
					 SET name = ?, git_email_domain = ?, use_role_git_identity = ?, description = ?, is_default = ?, updated_at = ?
					 WHERE id = ?`,
				)
				.run(name, gitEmailDomain, useRoleGitIdentity ? 1 : 0, description, nextDefault ? 1 : 0, timestamp, id);
			this.db.exec("COMMIT");
		} catch (err) {
			this.db.exec("ROLLBACK");
			throw err;
		}
		return this.getOrganization(id)!;
	}

	setDefaultOrganization(id: string): Organization {
		return this.updateOrganization(id, { isDefault: true });
	}

	getDefaultOrganization(): Organization | null {
		const defaultRow = this.db
			.prepare("SELECT * FROM organizations WHERE is_default = 1 ORDER BY created_at ASC LIMIT 1")
			.get() as Record<string, unknown> | undefined;
		if (defaultRow) return mapOrganizationRow(defaultRow);
		const firstRow = this.db.prepare("SELECT * FROM organizations ORDER BY created_at ASC LIMIT 1").get() as
			| Record<string, unknown>
			| undefined;
		return firstRow ? mapOrganizationRow(firstRow) : null;
	}

	ensureDefaultOrganization(): Organization {
		const existing = this.getDefaultOrganization();
		if (existing) {
			if (!existing.isDefault) {
				return this.setDefaultOrganization(existing.id);
			}
			return existing;
		}
		return this.upsertOrganization({
			id: DEFAULT_ORGANIZATION_ID,
			name: DEFAULT_ORGANIZATION_NAME,
			gitEmailDomain: "",
			description: "未单独指定组织时自动归入的默认组织",
			isDefault: true,
		});
	}

	assignOrphanWorkspacesToDefaultOrganization(): number {
		const defaultOrg = this.ensureDefaultOrganization();
		const res = this.db.prepare("UPDATE workspace_links SET org_id = ? WHERE org_id IS NULL").run(defaultOrg.id);
		return Number(res.changes ?? 0);
	}

	getOrganization(id: string): Organization | null {
		const row = this.db.prepare("SELECT * FROM organizations WHERE id = ?").get(id) as
			| Record<string, unknown>
			| undefined;
		return row ? mapOrganizationRow(row) : null;
	}

	listOrganizations(): Organization[] {
		const rows = this.db.prepare("SELECT * FROM organizations ORDER BY created_at ASC").all() as Record<
			string,
			unknown
		>[];
		return rows.map((row) => mapOrganizationRow(row));
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
	}): WorkspaceLink {
		const existing = this.db.prepare("SELECT * FROM workspace_links WHERE repo_path = ?").get(input.repoPath) as
			| Record<string, unknown>
			| undefined;
		if (existing) {
			const nextOrgId = input.orgId !== undefined ? input.orgId : existing.org_id ? String(existing.org_id) : null;
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
			return this.getWorkspace(String(existing.id))!;
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
		},
	): WorkspaceLink {
		const existing = this.getWorkspace(id);
		if (!existing) throw new Error(`Workspace not found: ${id}`);
		const nextOrgId = patch.orgId !== undefined ? patch.orgId : existing.orgId;
		if (nextOrgId && !this.getOrganization(nextOrgId)) {
			throw new Error(`Organization not found: ${nextOrgId}`);
		}
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
}
