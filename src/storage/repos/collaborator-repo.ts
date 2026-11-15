import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Collaborator, CollaboratorRole } from "../types.ts";
import { DEFAULT_OWNER_COLLABORATOR_ID, mapCollaboratorRow, nowIso } from "./helpers.ts";
import type { OrganizationRepo } from "./organization-repo.ts";

/** Manages human owner and collaborator identities along with LAN invitation tokens. */
export class CollaboratorRepo {
	private readonly db: DatabaseSync;
	private readonly orgRepo: OrganizationRepo;

	constructor(db: DatabaseSync, orgRepo: OrganizationRepo) {
		this.db = db;
		this.orgRepo = orgRepo;
	}

	ensureOwnerCollaborator(defaultName?: string): Collaborator {
		const existing = this.getCollaborator(DEFAULT_OWNER_COLLABORATOR_ID);
		if (existing) {
			return existing;
		}
		const timestamp = nowIso();
		const token = `own_${randomUUID().replace(/-/g, "")}`;
		const name = defaultName?.trim() || "团队所有者";
		this.db
			.prepare(
				`INSERT INTO collaborators (id, org_id, name, role_title, permission_role, token, created_at, updated_at)
				 VALUES (?, NULL, ?, ?, 'owner', ?, ?, ?)`,
			)
			.run(DEFAULT_OWNER_COLLABORATOR_ID, name, "Owner / 宿主管理者", token, timestamp, timestamp);
		return this.getCollaborator(DEFAULT_OWNER_COLLABORATOR_ID)!;
	}

	upsertCollaborator(input: {
		id?: string;
		orgId?: string | null;
		name: string;
		roleTitle?: string;
		permissionRole?: CollaboratorRole;
	}): Collaborator {
		const name = input.name.trim();
		if (!name) throw new Error("Collaborator name is required");
		const orgId = input.orgId ?? null;
		if (orgId && !this.orgRepo.getOrganization(orgId)) {
			throw new Error(`Organization not found: ${orgId}`);
		}
		const timestamp = nowIso();
		const existing = input.id ? this.getCollaborator(input.id) : null;
		if (existing) {
			const nextRole: CollaboratorRole =
				existing.id === DEFAULT_OWNER_COLLABORATOR_ID ? "owner" : (input.permissionRole ?? existing.permissionRole);
			const nextTitle = input.roleTitle !== undefined ? input.roleTitle.trim() : existing.roleTitle;
			const nextOrgId = input.orgId !== undefined ? orgId : existing.orgId;
			this.db
				.prepare(
					`UPDATE collaborators
					 SET org_id = ?, name = ?, role_title = ?, permission_role = ?, updated_at = ?
					 WHERE id = ?`,
				)
				.run(nextOrgId, name, nextTitle, nextRole, timestamp, existing.id);
			return this.getCollaborator(existing.id)!;
		}
		const id = input.id?.trim() || `col_${randomUUID().slice(0, 12)}`;
		const permissionRole: CollaboratorRole =
			id === DEFAULT_OWNER_COLLABORATOR_ID ? "owner" : (input.permissionRole ?? "collaborator");
		const token = `${permissionRole === "owner" ? "own" : "inv"}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
		this.db
			.prepare(
				`INSERT INTO collaborators (id, org_id, name, role_title, permission_role, token, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(id, orgId, name, input.roleTitle?.trim() ?? "协作者", permissionRole, token, timestamp, timestamp);
		return this.getCollaborator(id)!;
	}

	regenerateCollaboratorToken(id: string): Collaborator {
		const existing = this.getCollaborator(id);
		if (!existing) throw new Error(`Collaborator not found: ${id}`);
		const timestamp = nowIso();
		const token = `${existing.permissionRole === "owner" ? "own" : "inv"}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
		this.db.prepare("UPDATE collaborators SET token = ?, updated_at = ? WHERE id = ?").run(token, timestamp, id);
		return this.getCollaborator(id)!;
	}

	deleteCollaborator(id: string): boolean {
		if (id === DEFAULT_OWNER_COLLABORATOR_ID) {
			throw new Error("Cannot delete default owner collaborator");
		}
		const result = this.db.prepare("DELETE FROM collaborators WHERE id = ?").run(id);
		return result.changes > 0;
	}

	getCollaborator(id: string): Collaborator | null {
		const row = this.db.prepare("SELECT * FROM collaborators WHERE id = ?").get(id) as
			| Record<string, unknown>
			| undefined;
		return row ? mapCollaboratorRow(row) : null;
	}

	getCollaboratorByToken(token: string): Collaborator | null {
		const trimmed = token.trim();
		if (!trimmed) return null;
		const row = this.db.prepare("SELECT * FROM collaborators WHERE token = ?").get(trimmed) as
			| Record<string, unknown>
			| undefined;
		return row ? mapCollaboratorRow(row) : null;
	}

	listCollaborators(orgId?: string): Collaborator[] {
		const rows = (
			orgId
				? this.db
						.prepare(
							"SELECT * FROM collaborators WHERE org_id = ? OR org_id IS NULL ORDER BY CASE permission_role WHEN 'owner' THEN 0 ELSE 1 END, created_at ASC",
						)
						.all(orgId)
				: this.db
						.prepare(
							"SELECT * FROM collaborators ORDER BY CASE permission_role WHEN 'owner' THEN 0 ELSE 1 END, created_at ASC",
						)
						.all()
		) as Record<string, unknown>[];
		return rows.map((row) => mapCollaboratorRow(row));
	}
}
