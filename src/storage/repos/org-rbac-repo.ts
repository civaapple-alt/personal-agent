import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ThinkingLevel } from "../../rpc/types.ts";
import type {
	Organization,
	OrganizationAiRoleConfig,
	OrganizationInvite,
	OrganizationMember,
	OrgMemberRole,
	TeamMember,
	UploadRecord,
	WorkspaceVisibility,
} from "../types.ts";
import { mapMemberRow, mapOrganizationRow, nowIso } from "./helpers.ts";
import type { MemberRepo } from "./member-repo.ts";
import { generateOpaqueToken, hashOpaqueToken } from "./user-auth-repo.ts";

function normalizeOrgRole(raw: unknown): OrgMemberRole {
	if (raw === "org_owner" || raw === "org_admin" || raw === "org_member" || raw === "org_viewer") {
		return raw;
	}
	return "org_member";
}

function mapOrgAiRoleRow(row: Record<string, unknown>): OrganizationAiRoleConfig {
	return {
		orgId: String(row.org_id),
		memberId: String(row.member_id),
		enabled: Boolean(row.enabled),
		isPrimaryContact: Boolean(row.is_primary_contact),
		displayNameOverride: row.display_name_override ? String(row.display_name_override) : null,
		providerOverride: row.provider_override ? String(row.provider_override) : null,
		modelOverride: row.model_override ? String(row.model_override) : null,
		thinkingLevelOverride: row.thinking_level_override
			? (String(row.thinking_level_override) as ThinkingLevel)
			: null,
		gitNameOverride:
			typeof row.git_name_override === "string" && row.git_name_override.trim()
				? row.git_name_override.trim()
				: null,
		gitEmailOverride:
			typeof row.git_email_override === "string" && row.git_email_override.trim()
				? row.git_email_override.trim()
				: null,
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}

function mapOrgInviteRow(row: Record<string, unknown>): OrganizationInvite {
	return {
		id: String(row.id),
		orgId: String(row.org_id),
		orgRole: normalizeOrgRole(row.org_role),
		createdByUserId: String(row.created_by_user_id),
		maxUses: Number(row.max_uses ?? 1),
		usedCount: Number(row.used_count ?? 0),
		expiresAt: row.expires_at ? String(row.expires_at) : null,
		revokedAt: row.revoked_at ? String(row.revoked_at) : null,
		createdAt: String(row.created_at),
	};
}

/** Manages organization memberships, invites, per-org AI role enablement/overrides, project ACL, and upload ACLs. */
export class OrgRbacRepo {
	private readonly db: DatabaseSync;
	private readonly memberRepo: MemberRepo;

	constructor(db: DatabaseSync, memberRepo: MemberRepo) {
		this.db = db;
		this.memberRepo = memberRepo;
	}

	// ---- Organization Memberships ----
	upsertOrgMember(input: {
		orgId: string;
		userId: string;
		orgRole: OrgMemberRole;
		roleTitle?: string;
	}): OrganizationMember {
		const timestamp = nowIso();
		const existing = this.getOrgMembership(input.orgId, input.userId);
		if (existing && existing.orgRole === "org_owner" && input.orgRole !== "org_owner") {
			const otherOwners = this.listOrgMembers(input.orgId).filter(
				(m) => m.userId !== input.userId && m.orgRole === "org_owner",
			);
			if (otherOwners.length === 0) {
				throw new Error("组织至少需保留一位所有者（org_owner）");
			}
		}
		this.db
			.prepare(
				`INSERT INTO organization_members (org_id, user_id, org_role, role_title, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(org_id, user_id) DO UPDATE SET
				   org_role = excluded.org_role,
				   role_title = CASE WHEN trim(excluded.role_title) != '' THEN excluded.role_title ELSE organization_members.role_title END,
				   updated_at = excluded.updated_at`,
			)
			.run(
				input.orgId,
				input.userId,
				normalizeOrgRole(input.orgRole),
				input.roleTitle?.trim() ?? "",
				timestamp,
				timestamp,
			);
		return this.getOrgMembership(input.orgId, input.userId)!;
	}

	removeOrgMember(orgId: string, userId: string): boolean {
		const existing = this.getOrgMembership(orgId, userId);
		if (!existing) return false;
		if (existing.orgRole === "org_owner") {
			const otherOwners = this.listOrgMembers(orgId).filter((m) => m.userId !== userId && m.orgRole === "org_owner");
			if (otherOwners.length === 0) {
				throw new Error("组织至少需保留一位所有者，无法移出最后一位所有者");
			}
		}
		const res = this.db
			.prepare("DELETE FROM organization_members WHERE org_id = ? AND user_id = ?")
			.run(orgId, userId);
		return Number(res.changes ?? 0) > 0;
	}

	getOrgMembership(orgId: string, userId: string): OrganizationMember | null {
		const row = this.db
			.prepare(
				`SELECT om.org_id, om.user_id, om.org_role, om.role_title, om.created_at, om.updated_at,
				        u.email, u.display_name, u.status AS user_status
				 FROM organization_members om
				 JOIN users u ON u.id = om.user_id
				 WHERE om.org_id = ? AND om.user_id = ?`,
			)
			.get(orgId, userId) as Record<string, unknown> | undefined;
		if (!row) return null;
		return {
			orgId: String(row.org_id),
			userId: String(row.user_id),
			email: String(row.email),
			displayName: String(row.display_name),
			userStatus: (row.user_status as OrganizationMember["userStatus"]) ?? "active",
			orgRole: normalizeOrgRole(row.org_role),
			roleTitle: typeof row.role_title === "string" ? row.role_title : "",
			createdAt: String(row.created_at),
			updatedAt: String(row.updated_at),
		};
	}

	listOrgMembers(orgId: string): OrganizationMember[] {
		const rows = this.db
			.prepare(
				`SELECT om.org_id, om.user_id, om.org_role, om.role_title, om.created_at, om.updated_at,
				        u.email, u.display_name, u.status AS user_status
				 FROM organization_members om
				 JOIN users u ON u.id = om.user_id
				 WHERE om.org_id = ?
				 ORDER BY CASE om.org_role
				   WHEN 'org_owner' THEN 0
				   WHEN 'org_admin' THEN 1
				   WHEN 'org_member' THEN 2
				   ELSE 3
				 END, om.created_at ASC`,
			)
			.all(orgId) as Record<string, unknown>[];
		return rows.map((row) => ({
			orgId: String(row.org_id),
			userId: String(row.user_id),
			email: String(row.email),
			displayName: String(row.display_name),
			userStatus: (row.user_status as OrganizationMember["userStatus"]) ?? "active",
			orgRole: normalizeOrgRole(row.org_role),
			roleTitle: typeof row.role_title === "string" ? row.role_title : "",
			createdAt: String(row.created_at),
			updatedAt: String(row.updated_at),
		}));
	}

	listUserOrganizations(userId: string): Array<Organization & { orgRole: OrgMemberRole }> {
		const rows = this.db
			.prepare(
				`SELECT o.*, om.org_role
				 FROM organizations o
				 JOIN organization_members om ON om.org_id = o.id
				 WHERE om.user_id = ?
				 ORDER BY o.is_default DESC, o.created_at ASC`,
			)
			.all(userId) as Record<string, unknown>[];
		return rows.map((row) => ({
			...mapOrganizationRow(row),
			orgRole: normalizeOrgRole(row.org_role),
		}));
	}

	countOwnedOrganizations(userId: string): number {
		const row = this.db
			.prepare("SELECT COUNT(*) AS cnt FROM organization_members WHERE user_id = ? AND org_role = 'org_owner'")
			.get(userId) as Record<string, unknown>;
		return Number(row?.cnt ?? 0);
	}

	// ---- Organization Invites ----
	createOrgInvite(input: {
		orgId: string;
		orgRole?: OrgMemberRole;
		createdByUserId: string;
		maxUses?: number;
		expiresInHours?: number | null;
	}): { rawToken: string; invite: OrganizationInvite } {
		const id = `oinv_${randomUUID().slice(0, 12)}`;
		const rawToken = generateOpaqueToken("orginv", 24);
		const tokenHash = hashOpaqueToken(rawToken);
		const timestamp = nowIso();
		const maxUses = Math.max(1, Math.min(500, Math.floor(input.maxUses ?? 20)));
		const expiresAt =
			input.expiresInHours && input.expiresInHours > 0
				? new Date(Date.now() + input.expiresInHours * 3600 * 1000).toISOString()
				: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
		this.db
			.prepare(
				`INSERT INTO organization_invites (
					id, org_id, token_hash, org_role, created_by_user_id,
					max_uses, used_count, expires_at, revoked_at, created_at
				) VALUES (?, ?, ?, ?, ?, ?, 0, ?, NULL, ?)`,
			)
			.run(
				id,
				input.orgId,
				tokenHash,
				normalizeOrgRole(input.orgRole ?? "org_member"),
				input.createdByUserId,
				maxUses,
				expiresAt,
				timestamp,
			);
		const row = this.db.prepare("SELECT * FROM organization_invites WHERE id = ?").get(id) as Record<string, unknown>;
		return { rawToken, invite: mapOrgInviteRow(row) };
	}

	listOrgInvites(orgId: string): OrganizationInvite[] {
		const rows = this.db
			.prepare("SELECT * FROM organization_invites WHERE org_id = ? ORDER BY created_at DESC")
			.all(orgId) as Record<string, unknown>[];
		return rows.map(mapOrgInviteRow);
	}

	revokeOrgInvite(orgId: string, inviteId: string): boolean {
		const res = this.db
			.prepare("UPDATE organization_invites SET revoked_at = ? WHERE id = ? AND org_id = ? AND revoked_at IS NULL")
			.run(nowIso(), inviteId, orgId);
		return Number(res.changes ?? 0) > 0;
	}

	peekOrgInviteByToken(rawToken: string): OrganizationInvite | null {
		const trimmed = rawToken.trim();
		if (!trimmed) return null;
		const tokenHash = hashOpaqueToken(trimmed);
		const row = this.db.prepare("SELECT * FROM organization_invites WHERE token_hash = ?").get(tokenHash) as
			| Record<string, unknown>
			| undefined;
		if (!row) return null;
		const invite = mapOrgInviteRow(row);
		if (invite.revokedAt) return null;
		if (invite.expiresAt && Date.parse(invite.expiresAt) <= Date.now()) return null;
		if (invite.usedCount >= invite.maxUses) return null;
		return invite;
	}

	consumeOrgInviteByToken(
		rawToken: string,
		userId: string,
	): { invite: OrganizationInvite; membership: OrganizationMember } {
		const tokenHash = hashOpaqueToken(rawToken.trim());
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const row = this.db.prepare("SELECT * FROM organization_invites WHERE token_hash = ?").get(tokenHash) as
				| Record<string, unknown>
				| undefined;
			if (!row) throw new Error("组织邀请码无效或已过期");
			const invite = mapOrgInviteRow(row);
			if (invite.revokedAt) throw new Error("组织邀请码已被撤销");
			if (invite.expiresAt && Date.parse(invite.expiresAt) <= Date.now()) throw new Error("组织邀请码已过期");
			if (invite.usedCount >= invite.maxUses) throw new Error("组织邀请码已达到最大使用次数");
			const existingMember = this.getOrgMembership(invite.orgId, userId);
			if (existingMember) {
				this.db.exec("COMMIT");
				return { invite, membership: existingMember };
			}
			this.db.prepare("UPDATE organization_invites SET used_count = used_count + 1 WHERE id = ?").run(invite.id);
			const membership = this.upsertOrgMember({ orgId: invite.orgId, userId, orgRole: invite.orgRole });
			this.db.exec("COMMIT");
			return { invite: { ...invite, usedCount: invite.usedCount + 1 }, membership };
		} catch (err) {
			this.db.exec("ROLLBACK");
			throw err;
		}
	}

	// ---- Organization AI Roles ----
	hasOrgAiRolesConfigured(orgId: string): boolean {
		const row = this.db.prepare("SELECT 1 FROM organization_ai_roles WHERE org_id = ? LIMIT 1").get(orgId);
		return Boolean(row);
	}

	listOrgAiRoleConfigs(orgId: string): OrganizationAiRoleConfig[] {
		const rows = this.db
			.prepare("SELECT * FROM organization_ai_roles WHERE org_id = ? ORDER BY created_at ASC")
			.all(orgId) as Record<string, unknown>[];
		return rows.map(mapOrgAiRoleRow);
	}

	setOrgAiRolesBatch(
		orgId: string,
		roles: Array<{
			memberId: string;
			enabled: boolean;
			isPrimaryContact?: boolean;
			displayNameOverride?: string | null;
			providerOverride?: string | null;
			modelOverride?: string | null;
			thinkingLevelOverride?: ThinkingLevel | null;
			gitNameOverride?: string | null;
			gitEmailOverride?: string | null;
		}>,
	): OrganizationAiRoleConfig[] {
		const timestamp = nowIso();
		const primaryId =
			roles.find((r) => r.enabled && r.isPrimaryContact)?.memberId ?? roles.find((r) => r.enabled)?.memberId ?? null;
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db.prepare("DELETE FROM organization_ai_roles WHERE org_id = ?").run(orgId);
			const stmt = this.db.prepare(
				`INSERT INTO organization_ai_roles (
					org_id, member_id, enabled, is_primary_contact,
					display_name_override, provider_override, model_override, thinking_level_override,
					git_name_override, git_email_override, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			for (const role of roles) {
				const member = this.memberRepo.getMember(role.memberId);
				if (!member) continue;
				if (member.roleScope === "personal") continue;
				if (member.roleScope === "org" && member.ownerOrgId !== orgId) continue;
				stmt.run(
					orgId,
					role.memberId,
					role.enabled ? 1 : 0,
					primaryId === role.memberId ? 1 : 0,
					role.displayNameOverride?.trim() || null,
					role.providerOverride?.trim() || null,
					role.modelOverride?.trim() || null,
					role.thinkingLevelOverride ?? null,
					role.gitNameOverride?.trim() || null,
					role.gitEmailOverride?.trim() || null,
					timestamp,
					timestamp,
				);
			}
			this.db.exec("COMMIT");
		} catch (err) {
			this.db.exec("ROLLBACK");
			throw err;
		}
		return this.listOrgAiRoleConfigs(orgId);
	}

	resolveEffectiveOrgMembers(orgId: string): TeamMember[] {
		const allRows = this.db
			.prepare(
				`SELECT * FROM team_members
				 WHERE role_scope = 'global' OR (role_scope = 'org' AND owner_org_id = ?)
				 ORDER BY created_at ASC`,
			)
			.all(orgId) as Record<string, unknown>[];
		const baseMembers = allRows.map(mapMemberRow);
		const configs = this.listOrgAiRoleConfigs(orgId);
		if (configs.length === 0) {
			return baseMembers;
		}
		const configMap = new Map(configs.map((c) => [c.memberId, c]));
		const hasPrimaryOverride = configs.some((c) => c.enabled && c.isPrimaryContact);
		return baseMembers
			.filter((member) => {
				const cfg = configMap.get(member.id);
				return cfg ? cfg.enabled : member.roleScope === "org" && member.ownerOrgId === orgId;
			})
			.map((member) => {
				const cfg = configMap.get(member.id);
				if (!cfg) return hasPrimaryOverride ? { ...member, isPrimaryContact: false } : member;
				return {
					...member,
					displayName: cfg.displayNameOverride ?? member.displayName,
					provider: cfg.providerOverride ?? member.provider,
					model: cfg.modelOverride ?? member.model,
					thinkingLevel: cfg.thinkingLevelOverride ?? member.thinkingLevel,
					gitName: cfg.gitNameOverride?.trim() || member.gitName,
					gitEmail: cfg.gitEmailOverride?.trim() || member.gitEmail,
					isPrimaryContact: hasPrimaryOverride ? cfg.isPrimaryContact : member.isPrimaryContact,
				};
			});
	}

	resolveMemberForOrg(orgId: string | null | undefined, member: TeamMember): TeamMember {
		if (!orgId || member.roleScope === "personal") return member;
		const resolved = this.resolveEffectiveOrgMembers(orgId).find((m) => m.id === member.id);
		return resolved ?? member;
	}

	resolveEffectiveOrgMembersForUser(orgId: string, userId?: string | null): TeamMember[] {
		const shared = this.resolveEffectiveOrgMembers(orgId);
		if (!userId) return shared;
		const personalRows = this.db
			.prepare(
				`SELECT * FROM team_members
				 WHERE role_scope = 'personal' AND owner_user_id = ?
				 ORDER BY created_at ASC`,
			)
			.all(userId) as Record<string, unknown>[];
		if (personalRows.length === 0) return shared;
		const seen = new Set(shared.map((m) => m.id));
		return [...shared, ...personalRows.map(mapMemberRow).filter((m) => !seen.has(m.id))];
	}

	// ---- Project / Workspace Access Members ----
	setWorkspaceAccess(workspaceId: string, visibility: WorkspaceVisibility, allowedUserIds: string[]): void {
		const timestamp = nowIso();
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db.prepare("UPDATE workspace_links SET visibility = ? WHERE id = ?").run(visibility, workspaceId);
			this.db.prepare("DELETE FROM workspace_members WHERE workspace_id = ?").run(workspaceId);
			if (visibility === "restricted") {
				const stmt = this.db.prepare(
					"INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, created_at) VALUES (?, ?, ?)",
				);
				for (const userId of allowedUserIds) {
					const trimmed = userId.trim();
					if (trimmed) stmt.run(workspaceId, trimmed, timestamp);
				}
			}
			this.db.exec("COMMIT");
		} catch (err) {
			this.db.exec("ROLLBACK");
			throw err;
		}
	}

	listWorkspaceMemberIds(workspaceId: string): string[] {
		const rows = this.db
			.prepare("SELECT user_id FROM workspace_members WHERE workspace_id = ? ORDER BY created_at ASC")
			.all(workspaceId) as Record<string, unknown>[];
		return rows.map((r) => String(r.user_id));
	}

	isWorkspaceMember(workspaceId: string, userId: string): boolean {
		const row = this.db
			.prepare("SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?")
			.get(workspaceId, userId);
		return Boolean(row);
	}

	// ---- Upload ACL Index ----
	recordUpload(input: {
		filename: string;
		orgId: string | null;
		matterId: string | null;
		uploaderUserId: string | null;
		kind: string;
		mimeType: string;
	}): void {
		this.db
			.prepare(
				`INSERT OR REPLACE INTO uploads_index (filename, org_id, matter_id, uploader_user_id, kind, mime_type, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(input.filename, input.orgId, input.matterId, input.uploaderUserId, input.kind, input.mimeType, nowIso());
	}

	getUploadRecord(filename: string): UploadRecord | null {
		const row = this.db.prepare("SELECT * FROM uploads_index WHERE filename = ?").get(filename) as
			| Record<string, unknown>
			| undefined;
		if (!row) return null;
		return {
			filename: String(row.filename),
			orgId: row.org_id ? String(row.org_id) : null,
			matterId: row.matter_id ? String(row.matter_id) : null,
			uploaderUserId: row.uploader_user_id ? String(row.uploader_user_id) : null,
			kind: String(row.kind),
			mimeType: String(row.mime_type),
			createdAt: String(row.created_at),
		};
	}

	findLegacyUploadMatterId(filename: string): string | null {
		const matches = this.db
			.prepare(
				`SELECT DISTINCT m.matter_id
				 FROM matter_messages AS m
				 JOIN json_each(CASE WHEN json_valid(m.metadata_json) THEN m.metadata_json END) AS field
				   ON field.key IN ('images', 'files') AND field.type = 'array'
				 JOIN json_each(CASE WHEN field.type = 'array' THEN field.value END) AS attachment
				 WHERE CASE WHEN attachment.type = 'object' THEN json_extract(attachment.value, '$.url') END = ?
				 LIMIT 2`,
			)
			.all(`/api/uploads/${filename}`);
		return matches.length === 1 && typeof matches[0]?.matter_id === "string" ? matches[0].matter_id : null;
	}
}
