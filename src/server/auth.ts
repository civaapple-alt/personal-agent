import type { IncomingMessage, ServerResponse } from "node:http";
import type { PersonalAgentStore } from "../storage/repositories.ts";
import type { Collaborator, CollaboratorRole } from "../storage/types.ts";
import { sendError } from "./http.ts";

export const SESSION_COOKIE_NAME = "pa_session";

export interface RequestActor {
	collaborator: Collaborator;
	viaToken: boolean;
}

export function isLoopbackRemote(req: IncomingMessage): boolean {
	const remote = req.socket?.remoteAddress ?? "";
	return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
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

export function resolveRequestActor(
	req: IncomingMessage,
	store: PersonalAgentStore,
	requireAuth: boolean,
): RequestActor | null {
	const headerToken = extractHeaderToken(req);
	if (headerToken) {
		const matched = store.getCollaboratorByToken(headerToken);
		return matched ? { collaborator: matched, viaToken: true } : null;
	}
	const cookieToken = parseCookies(req)[SESSION_COOKIE_NAME]?.trim();
	if (cookieToken) {
		const matched = store.getCollaboratorByToken(cookieToken);
		// Explicit session cookie must remain valid; never silently elevate an invalidated session to loopback Owner.
		return matched ? { collaborator: matched, viaToken: true } : null;
	}
	if (!requireAuth && isLoopbackRemote(req)) {
		const owner = store.ensureOwnerCollaborator();
		return { collaborator: owner, viaToken: false };
	}
	return null;
}

export function requireOwner(res: ServerResponse, actor: RequestActor | null): actor is RequestActor {
	if (!actor) {
		sendError(res, 401, "未认证，请通过有效邀请链接或口令登录");
		return false;
	}
	if (actor.collaborator.permissionRole !== "owner") {
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
