import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { readStoredModelSelection } from "../../rpc/model-selection.ts";
import type {
	AuditLogEntry,
	PlatformRole,
	PlatformSettings,
	PlatformUser,
	RegistrationMode,
	UserSessionRecord,
	UserStatus,
} from "../types.ts";
import { DEFAULT_LOCAL_ADMIN_USER_ID, nowIso } from "./helpers.ts";

const SETTINGS_KEY = "platform_settings_v1";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function hashOpaqueToken(raw: string): string {
	return createHash("sha256").update(raw, "utf8").digest("hex");
}

export function generateOpaqueToken(prefix: string, bytes = 24): string {
	return `${prefix}_${randomBytes(bytes).toString("base64url")}`;
}

export function hashPassword(password: string): string {
	const salt = randomBytes(16).toString("hex");
	const derived = scryptSync(password, salt, 64).toString("hex");
	return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
	if (!storedHash.startsWith("scrypt$")) return false;
	const parts = storedHash.split("$");
	if (parts.length !== 3) return false;
	const salt = parts[1] ?? "";
	const expectedHex = parts[2] ?? "";
	if (!salt || !expectedHex) return false;
	try {
		const expectedBuf = Buffer.from(expectedHex, "hex");
		const actualBuf = scryptSync(password, salt, expectedBuf.length);
		return actualBuf.length === expectedBuf.length && timingSafeEqual(actualBuf, expectedBuf);
	} catch {
		return false;
	}
}

function mapUserRow(row: Record<string, unknown>): PlatformUser {
	const platformRole: PlatformRole = row.platform_role === "super_admin" ? "super_admin" : "user";
	const rawStatus = row.status;
	const status: UserStatus =
		rawStatus === "disabled" ? "disabled" : rawStatus === "pending_review" ? "pending_review" : "active";
	return {
		id: String(row.id),
		email: String(row.email),
		displayName: String(row.display_name),
		passwordHash: typeof row.password_hash === "string" ? row.password_hash : "",
		platformRole,
		status,
		maxOrgs: Math.max(0, Number(row.max_orgs ?? 5)),
		maxActiveDispatches: Math.max(0, Number(row.max_active_dispatches ?? 3)),
		maxPersonalRoles: Math.max(0, Number(row.max_personal_roles ?? 5)),
		canDispatchAi: row.can_dispatch_ai === undefined ? true : Boolean(row.can_dispatch_ai),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}

function mapSessionRow(row: Record<string, unknown>): UserSessionRecord {
	return {
		id: String(row.id),
		userId: String(row.user_id),
		expiresAt: String(row.expires_at),
		revokedAt: row.revoked_at ? String(row.revoked_at) : null,
		ip: typeof row.ip === "string" ? row.ip : "",
		userAgent: typeof row.user_agent === "string" ? row.user_agent : "",
		createdAt: String(row.created_at),
	};
}

function mapAuditRow(row: Record<string, unknown>): AuditLogEntry {
	let detail: Record<string, unknown> | null = null;
	if (typeof row.detail_json === "string" && row.detail_json.trim()) {
		try {
			detail = JSON.parse(row.detail_json) as Record<string, unknown>;
		} catch {
			detail = null;
		}
	}
	return {
		id: String(row.id),
		actorUserId: row.actor_user_id ? String(row.actor_user_id) : null,
		actorEmail: typeof row.actor_email === "string" ? row.actor_email : "",
		actorName: typeof row.actor_name === "string" ? row.actor_name : "",
		action: String(row.action),
		targetType: typeof row.target_type === "string" ? row.target_type : "",
		targetId: typeof row.target_id === "string" ? row.target_id : "",
		orgId: row.org_id ? String(row.org_id) : null,
		detail,
		ip: typeof row.ip === "string" ? row.ip : "",
		createdAt: String(row.created_at),
	};
}

/** Manages platform user accounts, hashed sessions, admin setup, global security settings, and audit logs. */
export class UserAuthRepo {
	private readonly db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	ensureLocalBootstrapAdmin(defaultName?: string): PlatformUser {
		const existing = this.getUserById(DEFAULT_LOCAL_ADMIN_USER_ID);
		if (existing) return existing;
		const timestamp = nowIso();
		const displayName = defaultName?.trim() || "团队所有者";
		this.db
			.prepare(
				`INSERT INTO users (
					id, email, display_name, password_hash, platform_role, status,
					max_orgs, max_active_dispatches, max_personal_roles, can_dispatch_ai, created_at, updated_at
				) VALUES (?, ?, ?, '', 'super_admin', 'active', 100, 20, 100, 1, ?, ?)`,
			)
			.run(DEFAULT_LOCAL_ADMIN_USER_ID, "owner@localhost", displayName, timestamp, timestamp);
		return this.getUserById(DEFAULT_LOCAL_ADMIN_USER_ID)!;
	}

	hasPasswordedAdmin(): boolean {
		const row = this.db
			.prepare(
				`SELECT 1 FROM users
				 WHERE platform_role = 'super_admin' AND status = 'active' AND TRIM(password_hash) != ''
				 LIMIT 1`,
			)
			.get();
		return Boolean(row);
	}

	setupInitialAdmin(input: { email: string; password: string; displayName: string }): PlatformUser {
		if (this.hasPasswordedAdmin()) {
			throw new Error("Super admin is already initialized");
		}
		const email = input.email.trim().toLowerCase();
		const displayName = input.displayName.trim() || "系统超级管理员";
		const passwordHash = hashPassword(input.password);
		const timestamp = nowIso();
		const existingEmail = this.getUserByEmail(email);
		if (existingEmail) {
			this.db
				.prepare(
					`UPDATE users
					 SET display_name = ?, password_hash = ?, platform_role = 'super_admin', status = 'active',
					     max_orgs = 100, max_active_dispatches = 20, max_personal_roles = 100, can_dispatch_ai = 1, updated_at = ?
					 WHERE id = ?`,
				)
				.run(displayName, passwordHash, timestamp, existingEmail.id);
			return this.getUserById(existingEmail.id)!;
		}
		const localPlaceholder = this.getUserById(DEFAULT_LOCAL_ADMIN_USER_ID);
		if (localPlaceholder && !localPlaceholder.passwordHash) {
			this.db
				.prepare(
					`UPDATE users
					 SET email = ?, display_name = ?, password_hash = ?, platform_role = 'super_admin', status = 'active',
					     max_orgs = 100, max_active_dispatches = 20, max_personal_roles = 100, can_dispatch_ai = 1, updated_at = ?
					 WHERE id = ?`,
				)
				.run(email, displayName, passwordHash, timestamp, DEFAULT_LOCAL_ADMIN_USER_ID);
			return this.getUserById(DEFAULT_LOCAL_ADMIN_USER_ID)!;
		}
		return this.createUser({
			email,
			displayName,
			password: input.password,
			platformRole: "super_admin",
			status: "active",
			maxOrgs: 100,
			maxActiveDispatches: 20,
			maxPersonalRoles: 100,
			canDispatchAi: true,
		});
	}

	createUser(input: {
		id?: string;
		email: string;
		displayName: string;
		password: string;
		platformRole?: PlatformRole;
		status?: UserStatus;
		maxOrgs?: number;
		maxActiveDispatches?: number;
		maxPersonalRoles?: number;
		canDispatchAi?: boolean;
	}): PlatformUser {
		const email = input.email.trim().toLowerCase();
		if (!email) throw new Error("Email is required");
		if (this.getUserByEmail(email)) {
			throw new Error("该邮箱已注册");
		}
		const displayName = input.displayName.trim();
		if (!displayName) throw new Error("Display name is required");
		const settings = this.getPlatformSettings();
		const id = input.id?.trim() || `usr_${randomUUID().slice(0, 12)}`;
		const timestamp = nowIso();
		const passwordHash = hashPassword(input.password);
		this.db
			.prepare(
				`INSERT INTO users (
					id, email, display_name, password_hash, platform_role, status,
					max_orgs, max_active_dispatches, max_personal_roles, can_dispatch_ai, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				email,
				displayName,
				passwordHash,
				input.platformRole ?? "user",
				input.status ?? "active",
				input.maxOrgs ?? settings.defaultMaxOrgs,
				input.maxActiveDispatches ?? settings.defaultMaxActiveDispatches,
				input.maxPersonalRoles ?? settings.defaultMaxPersonalRoles,
				input.canDispatchAi === false ? 0 : 1,
				timestamp,
				timestamp,
			);
		return this.getUserById(id)!;
	}

	authenticateUser(email: string, password: string): PlatformUser | null {
		const user = this.getUserByEmail(email);
		if (!user || !user.passwordHash) return null;
		if (!verifyPassword(password, user.passwordHash)) return null;
		return user;
	}

	getUserById(id: string): PlatformUser | null {
		const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Record<string, unknown> | undefined;
		return row ? mapUserRow(row) : null;
	}

	getUserByEmail(email: string): PlatformUser | null {
		const normalized = email.trim().toLowerCase();
		if (!normalized) return null;
		const row = this.db.prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE").get(normalized) as
			| Record<string, unknown>
			| undefined;
		return row ? mapUserRow(row) : null;
	}

	listUsers(): PlatformUser[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM users
				 ORDER BY CASE platform_role WHEN 'super_admin' THEN 0 ELSE 1 END, created_at ASC`,
			)
			.all() as Record<string, unknown>[];
		return rows.map(mapUserRow);
	}

	updateUser(
		userId: string,
		patch: {
			displayName?: string;
			platformRole?: PlatformRole;
			status?: UserStatus;
			maxOrgs?: number;
			maxActiveDispatches?: number;
			maxPersonalRoles?: number;
			canDispatchAi?: boolean;
			password?: string;
		},
	): PlatformUser {
		const existing = this.getUserById(userId);
		if (!existing) throw new Error(`User not found: ${userId}`);
		const nextRole = patch.platformRole ?? existing.platformRole;
		const nextStatus = patch.status ?? existing.status;
		if (
			existing.platformRole === "super_admin" &&
			existing.status === "active" &&
			(nextRole !== "super_admin" || nextStatus !== "active")
		) {
			const otherAdmins = this.listUsers().filter(
				(u) => u.id !== userId && u.platformRole === "super_admin" && u.status === "active",
			);
			if (otherAdmins.length === 0) {
				throw new Error("系统至少需保留一位启用状态的超级管理员");
			}
		}
		const timestamp = nowIso();
		const displayName =
			patch.displayName !== undefined ? patch.displayName.trim() || existing.displayName : existing.displayName;
		const maxOrgs = patch.maxOrgs !== undefined ? Math.max(0, Math.floor(patch.maxOrgs)) : existing.maxOrgs;
		const maxActiveDispatches =
			patch.maxActiveDispatches !== undefined
				? Math.max(0, Math.floor(patch.maxActiveDispatches))
				: existing.maxActiveDispatches;
		const maxPersonalRoles =
			patch.maxPersonalRoles !== undefined
				? Math.max(0, Math.floor(patch.maxPersonalRoles))
				: existing.maxPersonalRoles;
		const canDispatchAi = patch.canDispatchAi !== undefined ? patch.canDispatchAi : existing.canDispatchAi;
		const passwordHash = patch.password ? hashPassword(patch.password) : existing.passwordHash;
		this.db
			.prepare(
				`UPDATE users
				 SET display_name = ?, password_hash = ?, platform_role = ?, status = ?,
				     max_orgs = ?, max_active_dispatches = ?, max_personal_roles = ?, can_dispatch_ai = ?, updated_at = ?
				 WHERE id = ?`,
			)
			.run(
				displayName,
				passwordHash,
				nextRole,
				nextStatus,
				maxOrgs,
				maxActiveDispatches,
				maxPersonalRoles,
				canDispatchAi ? 1 : 0,
				timestamp,
				userId,
			);
		return this.getUserById(userId)!;
	}

	createSession(
		userId: string,
		meta?: { ip?: string; userAgent?: string },
	): { rawToken: string; session: UserSessionRecord } {
		const rawToken = generateOpaqueToken("pas", 32);
		const hashedId = hashOpaqueToken(rawToken);
		const timestamp = nowIso();
		const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
		this.db
			.prepare(
				`INSERT INTO user_sessions (id, user_id, expires_at, revoked_at, ip, user_agent, created_at)
				 VALUES (?, ?, ?, NULL, ?, ?, ?)`,
			)
			.run(hashedId, userId, expiresAt, meta?.ip ?? "", (meta?.userAgent ?? "").slice(0, 240), timestamp);
		const row = this.db.prepare("SELECT * FROM user_sessions WHERE id = ?").get(hashedId) as Record<string, unknown>;
		return { rawToken, session: mapSessionRow(row) };
	}

	getSessionAndUserByToken(rawToken: string): { session: UserSessionRecord; user: PlatformUser } | null {
		const trimmed = rawToken.trim();
		if (!trimmed) return null;
		return this.getSessionAndUserByHash(hashOpaqueToken(trimmed));
	}

	getSessionAndUserByHash(sessionHash: string): { session: UserSessionRecord; user: PlatformUser } | null {
		const row = this.db.prepare("SELECT * FROM user_sessions WHERE id = ?").get(sessionHash) as
			| Record<string, unknown>
			| undefined;
		if (!row) return null;
		const session = mapSessionRow(row);
		if (session.revokedAt) return null;
		if (Date.parse(session.expiresAt) <= Date.now()) return null;
		const user = this.getUserById(session.userId);
		if (!user || user.status === "disabled") return null;
		return { session, user };
	}

	revokeSessionByToken(rawToken: string): boolean {
		const trimmed = rawToken.trim();
		if (!trimmed) return false;
		const hashedId = hashOpaqueToken(trimmed);
		const res = this.db
			.prepare("UPDATE user_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
			.run(nowIso(), hashedId);
		return Number(res.changes ?? 0) > 0;
	}

	revokeAllUserSessions(userId: string): number {
		const res = this.db
			.prepare("UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
			.run(nowIso(), userId);
		return Number(res.changes ?? 0);
	}

	getPlatformSettings(defaultWorkspacesRoot?: string): PlatformSettings {
		const fallbackRoot = defaultWorkspacesRoot?.trim() || resolve(process.cwd(), ".data/team-workspaces");
		const row = this.db
			.prepare("SELECT value_json, updated_at FROM platform_settings WHERE key = ?")
			.get(SETTINGS_KEY) as Record<string, unknown> | undefined;
		const defaults: PlatformSettings = {
			registrationMode: "open_review",
			workspacesRoot: fallbackRoot,
			allowLocalWorkspacePath: true,
			localWorkspaceAllowlist: [],
			allowCommandPreviews: true,
			defaultMaxOrgs: 5,
			defaultMaxActiveDispatches: 3,
			defaultMaxPersonalRoles: 5,
			pstackDir: null,
			webAccessRoleGrants: {},
			defaultModelSelection: null,
			updatedAt: row?.updated_at ? String(row.updated_at) : nowIso(),
		};
		if (!row || typeof row.value_json !== "string") return defaults;
		try {
			const parsed = JSON.parse(row.value_json) as Partial<PlatformSettings>;
			const registrationMode: RegistrationMode =
				parsed.registrationMode === "open_auto" ||
				parsed.registrationMode === "open_review" ||
				parsed.registrationMode === "invite_only"
					? parsed.registrationMode
					: "open_review";
			return {
				registrationMode,
				workspacesRoot:
					typeof parsed.workspacesRoot === "string" && parsed.workspacesRoot.trim()
						? parsed.workspacesRoot.trim()
						: defaults.workspacesRoot,
				allowLocalWorkspacePath:
					typeof parsed.allowLocalWorkspacePath === "boolean"
						? parsed.allowLocalWorkspacePath
						: defaults.allowLocalWorkspacePath,
				localWorkspaceAllowlist: Array.isArray(parsed.localWorkspaceAllowlist)
					? parsed.localWorkspaceAllowlist
							.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
							.map((x) => x.trim())
					: [],
				allowCommandPreviews:
					typeof parsed.allowCommandPreviews === "boolean"
						? parsed.allowCommandPreviews
						: defaults.allowCommandPreviews,
				defaultMaxOrgs:
					typeof parsed.defaultMaxOrgs === "number" && Number.isFinite(parsed.defaultMaxOrgs)
						? Math.max(0, Math.floor(parsed.defaultMaxOrgs))
						: defaults.defaultMaxOrgs,
				defaultMaxActiveDispatches:
					typeof parsed.defaultMaxActiveDispatches === "number" &&
					Number.isFinite(parsed.defaultMaxActiveDispatches)
						? Math.max(0, Math.floor(parsed.defaultMaxActiveDispatches))
						: defaults.defaultMaxActiveDispatches,
				defaultMaxPersonalRoles:
					typeof parsed.defaultMaxPersonalRoles === "number" && Number.isFinite(parsed.defaultMaxPersonalRoles)
						? Math.max(0, Math.floor(parsed.defaultMaxPersonalRoles))
						: defaults.defaultMaxPersonalRoles,
				pstackDir:
					typeof parsed.pstackDir === "string" && parsed.pstackDir.trim()
						? parsed.pstackDir.trim()
						: defaults.pstackDir,
				webAccessRoleGrants: Object.fromEntries(
					Object.entries(parsed.webAccessRoleGrants ?? {}).filter(
						([id, createdAt]) => id.length > 0 && typeof createdAt === "string" && createdAt.length > 0,
					),
				),
				defaultModelSelection: readStoredModelSelection(parsed.defaultModelSelection),
				updatedAt: String(row.updated_at ?? defaults.updatedAt),
			};
		} catch {
			return defaults;
		}
	}

	updatePlatformSettings(
		patch: Partial<Omit<PlatformSettings, "updatedAt">>,
		defaultWorkspacesRoot?: string,
	): PlatformSettings {
		const current = this.getPlatformSettings(defaultWorkspacesRoot);
		const timestamp = nowIso();
		const next: Omit<PlatformSettings, "updatedAt"> = {
			registrationMode: patch.registrationMode ?? current.registrationMode,
			workspacesRoot: patch.workspacesRoot?.trim() ? resolve(patch.workspacesRoot.trim()) : current.workspacesRoot,
			allowLocalWorkspacePath:
				patch.allowLocalWorkspacePath !== undefined
					? patch.allowLocalWorkspacePath
					: current.allowLocalWorkspacePath,
			localWorkspaceAllowlist:
				patch.localWorkspaceAllowlist !== undefined
					? patch.localWorkspaceAllowlist.map((p) => resolve(p.trim())).filter(Boolean)
					: current.localWorkspaceAllowlist,
			allowCommandPreviews:
				patch.allowCommandPreviews !== undefined ? patch.allowCommandPreviews : current.allowCommandPreviews,
			defaultMaxOrgs:
				patch.defaultMaxOrgs !== undefined ? Math.max(0, Math.floor(patch.defaultMaxOrgs)) : current.defaultMaxOrgs,
			defaultMaxActiveDispatches:
				patch.defaultMaxActiveDispatches !== undefined
					? Math.max(0, Math.floor(patch.defaultMaxActiveDispatches))
					: current.defaultMaxActiveDispatches,
			defaultMaxPersonalRoles:
				patch.defaultMaxPersonalRoles !== undefined
					? Math.max(0, Math.floor(patch.defaultMaxPersonalRoles))
					: current.defaultMaxPersonalRoles,
			defaultModelSelection:
				patch.defaultModelSelection === undefined ? current.defaultModelSelection : patch.defaultModelSelection,
			pstackDir:
				patch.pstackDir === null || patch.pstackDir === ""
					? null
					: typeof patch.pstackDir === "string" && patch.pstackDir.trim()
						? resolve(patch.pstackDir.trim())
						: current.pstackDir,
			webAccessRoleGrants: patch.webAccessRoleGrants ?? current.webAccessRoleGrants,
		};
		this.db
			.prepare(
				`INSERT INTO platform_settings (key, value_json, updated_at)
				 VALUES (?, ?, ?)
				 ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
			)
			.run(SETTINGS_KEY, JSON.stringify(next), timestamp);
		return this.getPlatformSettings(defaultWorkspacesRoot);
	}

	recordAuditLog(input: {
		actorUserId?: string | null;
		actorEmail?: string;
		actorName?: string;
		action: string;
		targetType?: string;
		targetId?: string;
		orgId?: string | null;
		detail?: Record<string, unknown> | null;
		ip?: string;
	}): AuditLogEntry {
		const id = `aud_${randomUUID().slice(0, 12)}`;
		const timestamp = nowIso();
		this.db
			.prepare(
				`INSERT INTO audit_logs (
					id, actor_user_id, actor_email, actor_name, action,
					target_type, target_id, org_id, detail_json, ip, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				input.actorUserId ?? null,
				input.actorEmail ?? "",
				input.actorName ?? "",
				input.action,
				input.targetType ?? "",
				input.targetId ?? "",
				input.orgId ?? null,
				input.detail ? JSON.stringify(input.detail) : null,
				input.ip ?? "",
				timestamp,
			);
		const row = this.db.prepare("SELECT * FROM audit_logs WHERE id = ?").get(id) as Record<string, unknown>;
		return mapAuditRow(row);
	}

	listAuditLogs(options?: { limit?: number; orgId?: string | null }): AuditLogEntry[] {
		const limit = Math.max(1, Math.min(200, Math.floor(options?.limit ?? 80)));
		const rows = (
			options?.orgId
				? this.db
						.prepare("SELECT * FROM audit_logs WHERE org_id = ? ORDER BY created_at DESC LIMIT ?")
						.all(options.orgId, limit)
				: this.db.prepare("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?").all(limit)
		) as Record<string, unknown>[];
		return rows.map(mapAuditRow);
	}
}
