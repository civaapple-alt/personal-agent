import type { IncomingMessage, ServerResponse } from "node:http";
import type { PersonalAgentStore } from "../storage/repositories.ts";
import type { Collaborator, CollaboratorRole, PlatformUser } from "../storage/types.ts";
import { sendError } from "./http.ts";

export const SESSION_COOKIE_NAME = "pa_session";

export type ActorAuthKind = "session" | "loopback";

export interface RequestActor {
	collaborator: Collaborator;
	user: PlatformUser | null;
	viaToken: boolean;
	authKind: ActorAuthKind;
	sessionTokenHash?: string;
}

export class SlidingWindowRateLimiter {
	private readonly maxAttempts: number;
	private readonly windowMs: number;
	private readonly buckets = new Map<string, number[]>();

	constructor(maxAttempts = 20, windowMs = 5 * 60 * 1000) {
		this.maxAttempts = maxAttempts;
		this.windowMs = windowMs;
	}

	check(key: string): boolean {
		const now = Date.now();
		const cutoff = now - this.windowMs;
		const existing = (this.buckets.get(key) ?? []).filter((ts) => ts > cutoff);
		if (existing.length >= this.maxAttempts) {
			this.buckets.set(key, existing);
			return false;
		}
		return true;
	}

	recordFailure(key: string): void {
		const now = Date.now();
		const cutoff = now - this.windowMs;
		const existing = (this.buckets.get(key) ?? []).filter((ts) => ts > cutoff);
		existing.push(now);
		this.buckets.set(key, existing);
		if (this.buckets.size > 4096) {
			const firstKey = this.buckets.keys().next().value;
			if (firstKey) this.buckets.delete(firstKey);
		}
	}

	reset(key: string): void {
		this.buckets.delete(key);
	}
}

export function extractClientIp(req: IncomingMessage): string {
	return req.socket?.remoteAddress ?? "";
}

export function isLoopbackAddress(address: string): boolean {
	return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export function isLoopbackRemote(req: IncomingMessage): boolean {
	return isLoopbackAddress(extractClientIp(req));
}

export function parseCookies(req: IncomingMessage): Record<string, string> {
	const raw = req.headers.cookie;
	if (!raw || typeof raw !== "string") return {};
	const result: Record<string, string> = {};
	for (const part of raw.split(";")) {
		const idx = part.indexOf("=");
		if (idx <= 0) continue;
		const key = part.slice(0, idx).trim();
		const value = part.slice(idx + 1).trim();
		if (!key) continue;
		try {
			result[key] = decodeURIComponent(value);
		} catch {
			result[key] = value;
		}
	}
	return result;
}

export function extractHeaderToken(req: IncomingMessage): string | null {
	const direct = req.headers["x-pa-token"];
	if (typeof direct === "string" && direct.trim()) {
		return direct.trim();
	}
	const auth = req.headers.authorization;
	if (typeof auth === "string" && /^Bearer\s+/i.test(auth)) {
		const token = auth.replace(/^Bearer\s+/i, "").trim();
		return token || null;
	}
	return null;
}

export function userToCollaboratorView(store: PersonalAgentStore, user: PlatformUser): Collaborator {
	const memberships = store.listUserOrganizations(user.id);
	const primaryMembership = memberships.find((m) => m.isDefault) ?? memberships[0] ?? null;
	const orgMembership = primaryMembership ? store.getOrgMembership(primaryMembership.id, user.id) : null;
	const permissionRole: CollaboratorRole = user.platformRole === "super_admin" ? "owner" : "collaborator";
	return {
		id: user.id,
		orgId: primaryMembership?.id ?? null,
		name: user.displayName,
		roleTitle: orgMembership?.roleTitle || (user.platformRole === "super_admin" ? "超级管理员" : "团队成员"),
		permissionRole,
		createdAt: user.createdAt,
		updatedAt: user.updatedAt,
	};
}

export function resolveRequestActor(
	req: IncomingMessage,
	store: PersonalAgentStore,
	requireAuth: boolean,
): RequestActor | null {
	const headerToken = extractHeaderToken(req);
	const cookieToken = parseCookies(req)[SESSION_COOKIE_NAME]?.trim() || null;
	const rawToken = headerToken || cookieToken;
	if (rawToken) {
		const sessionHit = store.getSessionAndUserByToken(rawToken);
		if (sessionHit) {
			return {
				collaborator: userToCollaboratorView(store, sessionHit.user),
				user: sessionHit.user,
				viaToken: true,
				authKind: "session",
				sessionTokenHash: sessionHit.session.id,
			};
		}
		// Never silently elevate an invalidated/unknown session token to loopback owner.
		return null;
	}
	if (!requireAuth && isLoopbackRemote(req)) {
		const adminUser = store.ensureLocalBootstrapAdmin();
		return {
			collaborator: userToCollaboratorView(store, adminUser),
			user: adminUser,
			viaToken: false,
			authKind: "loopback",
		};
	}
	return null;
}

export function requireActiveActor(res: ServerResponse, actor: RequestActor | null): actor is RequestActor {
	if (!actor) {
		sendError(res, 401, "未认证，请登录或通过有效邀请进入工作台");
		return false;
	}
	if (actor.user?.status === "pending_review") {
		sendError(res, 403, "账号已注册，正等待超级管理员审核开通后方可使用");
		return false;
	}
	if (actor.user?.status === "disabled") {
		sendError(res, 403, "当前账号已被管理员停用");
		return false;
	}
	return true;
}

export function isSuperAdminActor(actor: RequestActor | null): boolean {
	if (!actor) return false;
	if (actor.authKind === "loopback") return true;
	if (actor.user && actor.user.platformRole === "super_admin" && actor.user.status === "active") {
		return true;
	}
	return false;
}

export function requireSuperAdmin(res: ServerResponse, actor: RequestActor | null): actor is RequestActor {
	if (!requireActiveActor(res, actor)) return false;
	if (!isSuperAdminActor(actor)) {
		sendError(res, 403, "仅系统超级管理员（Admin）可执行此操作");
		return false;
	}
	return true;
}

export function requireOwner(res: ServerResponse, actor: RequestActor | null): actor is RequestActor {
	if (!requireActiveActor(res, actor)) return false;
	if (!isSuperAdminActor(actor)) {
		sendError(res, 403, "仅所有者（Owner）可执行此操作；协同成员可参与讨论、提交 AI 提请或评价成果");
		return false;
	}
	return true;
}

export function toDispatchAuthor(collaborator: Collaborator): {
	collaboratorId: string;
	name: string;
	roleTitle: string;
	permissionRole: CollaboratorRole;
} {
	return {
		collaboratorId: collaborator.id,
		name: collaborator.name,
		roleTitle: collaborator.roleTitle,
		permissionRole: collaborator.permissionRole,
	};
}
