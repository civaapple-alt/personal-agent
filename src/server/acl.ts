import { existsSync, realpathSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { isAbsolute, relative, resolve } from "node:path";
import type { PersonalAgentStore } from "../storage/repositories.ts";
import type { Matter, OrgMemberRole, PlatformSettings, WorkspaceLink } from "../storage/types.ts";
import { isSuperAdminActor, type RequestActor, requireActiveActor } from "./auth.ts";
import { sendError } from "./http.ts";

export function isGlobalUnscopedActor(actor: RequestActor): boolean {
	if (actor.authKind === "loopback") return true;
	if (actor.authKind === "legacy_token" && actor.collaborator.permissionRole === "owner") return true;
	return false;
}

function isLegacyCollaboratorActor(actor: RequestActor): boolean {
	return actor.authKind === "legacy_token" && actor.collaborator.permissionRole !== "owner";
}

export function getActorOrgRole(
	store: PersonalAgentStore,
	actor: RequestActor,
	orgId: string | null | undefined,
): OrgMemberRole | null {
	if (!orgId) {
		return isGlobalUnscopedActor(actor) || isLegacyCollaboratorActor(actor) ? "org_owner" : null;
	}
	if (isGlobalUnscopedActor(actor)) return "org_owner";
	if (actor.user) {
		const membership = store.getOrgMembership(orgId, actor.user.id);
		if (membership) return membership.orgRole;
		return null;
	}
	if (isLegacyCollaboratorActor(actor)) {
		if (!actor.collaborator.orgId || actor.collaborator.orgId === orgId) {
			return "org_member";
		}
		return null;
	}
	return null;
}

export function canAccessOrganization(
	store: PersonalAgentStore,
	actor: RequestActor | null,
	orgId: string | null | undefined,
): boolean {
	if (!actor) return false;
	if (actor.user && actor.user.status !== "active") return false;
	if (isGlobalUnscopedActor(actor)) return true;
	if (!orgId) return isLegacyCollaboratorActor(actor) && !actor.collaborator.orgId;
	return getActorOrgRole(store, actor, orgId) !== null;
}

export function canManageOrganization(
	store: PersonalAgentStore,
	actor: RequestActor | null,
	orgId: string | null | undefined,
): boolean {
	if (!actor) return false;
	if (actor.user && actor.user.status !== "active") return false;
	if (isGlobalUnscopedActor(actor)) return true;
	if (!orgId) return false;
	const role = getActorOrgRole(store, actor, orgId);
	return role === "org_owner" || role === "org_admin";
}

export function canAccessWorkspace(
	store: PersonalAgentStore,
	actor: RequestActor | null,
	ws: WorkspaceLink | null | undefined,
): boolean {
	if (!actor || !ws) return false;
	if (actor.user && actor.user.status !== "active") return false;
	if (isGlobalUnscopedActor(actor)) return true;
	if (!canAccessOrganization(store, actor, ws.orgId)) return false;
	if (ws.visibility !== "restricted") return true;
	if (canManageOrganization(store, actor, ws.orgId)) return true;
	if (actor.user) {
		return store.isWorkspaceMember(ws.id, actor.user.id);
	}
	return false;
}

export function canAccessMatter(
	store: PersonalAgentStore,
	actor: RequestActor | null,
	matter: Matter | null | undefined,
): boolean {
	if (!actor || !matter) return false;
	if (actor.user && actor.user.status !== "active") return false;
	if (isGlobalUnscopedActor(actor)) return true;
	if (matter.orgId && !canAccessOrganization(store, actor, matter.orgId)) return false;
	if (!matter.orgId && actor.authKind === "session") {
		if (matter.createdByUserId !== actor.user?.id && !matter.collaboratorIds.includes(actor.user?.id ?? "")) {
			return false;
		}
	}
	if (matter.workspaceId) {
		const ws = store.getWorkspace(matter.workspaceId);
		if (ws && !canAccessWorkspace(store, actor, ws)) return false;
	}
	if (matter.visibility === "private" && actor.authKind === "session") {
		const uid = actor.user?.id ?? "";
		if (
			matter.createdByUserId !== uid &&
			!matter.collaboratorIds.includes(uid) &&
			!canManageOrganization(store, actor, matter.orgId)
		) {
			return false;
		}
	}
	return true;
}

export function canParticipateInMatter(store: PersonalAgentStore, actor: RequestActor | null, matter: Matter): boolean {
	if (!canAccessMatter(store, actor, matter)) return false;
	if (!actor) return false;
	if (isGlobalUnscopedActor(actor)) return true;
	if (isLegacyCollaboratorActor(actor)) return true;
	const orgRole = matter.orgId ? getActorOrgRole(store, actor, matter.orgId) : "org_member";
	return orgRole !== "org_viewer" && orgRole !== null;
}

export function canDispatchAiInOrg(
	store: PersonalAgentStore,
	actor: RequestActor | null,
	orgId: string | null | undefined,
): boolean {
	if (!actor) return false;
	if (actor.user && actor.user.status !== "active") return false;
	// Legacy LAN guests remain strictly blocked from direct AI dispatch.
	if (isLegacyCollaboratorActor(actor)) return false;
	if (isGlobalUnscopedActor(actor)) return true;
	if (actor.user && !actor.user.canDispatchAi) return false;
	if (!orgId) return false;
	const orgRole = getActorOrgRole(store, actor, orgId);
	return orgRole === "org_owner" || orgRole === "org_admin" || orgRole === "org_member";
}

export function requireOrgAccess(
	res: ServerResponse,
	store: PersonalAgentStore,
	actor: RequestActor | null,
	orgId: string | null | undefined,
): actor is RequestActor {
	if (!requireActiveActor(res, actor)) return false;
	if (!canAccessOrganization(store, actor, orgId)) {
		sendError(res, 403, "无权访问该组织");
		return false;
	}
	return true;
}

export function requireOrgAdmin(
	res: ServerResponse,
	store: PersonalAgentStore,
	actor: RequestActor | null,
	orgId: string | null | undefined,
): actor is RequestActor {
	if (!requireActiveActor(res, actor)) return false;
	if (!canManageOrganization(store, actor, orgId)) {
		sendError(res, 403, "仅该组织所有者或管理员可执行此操作");
		return false;
	}
	return true;
}

export function requireMatterReadAccess(
	res: ServerResponse,
	store: PersonalAgentStore,
	actor: RequestActor | null,
	matter: Matter,
): actor is RequestActor {
	if (!requireActiveActor(res, actor)) return false;
	if (!canAccessMatter(store, actor, matter)) {
		sendError(res, 403, "无权访问该事项");
		return false;
	}
	return true;
}

export function requireWorkspaceReadAccess(
	res: ServerResponse,
	store: PersonalAgentStore,
	actor: RequestActor | null,
	ws: WorkspaceLink,
): actor is RequestActor {
	if (!requireActiveActor(res, actor)) return false;
	if (!canAccessWorkspace(store, actor, ws)) {
		sendError(res, 403, "无权访问该项目仓库");
		return false;
	}
	return true;
}

export function canActorAccessUpload(store: PersonalAgentStore, actor: RequestActor | null, filename: string): boolean {
	if (!actor) return false;
	if (actor.user && actor.user.status !== "active") return false;
	if (isGlobalUnscopedActor(actor)) return true;
	const record = store.getUploadRecord(filename);
	if (!record) {
		return true;
	}
	if (record.matterId) {
		const matter = store.getMatter(record.matterId);
		if (matter) return canAccessMatter(store, actor, matter);
	}
	if (record.orgId) {
		return canAccessOrganization(store, actor, record.orgId);
	}
	if (actor.user && record.uploaderUserId === actor.user.id) return true;
	return false;
}

function isInsideDir(parentDir: string, childPath: string): boolean {
	const rel = relative(parentDir, childPath);
	return rel === "" || (!rel.startsWith("..") && rel !== ".." && !isAbsolute(rel));
}

export function validateLocalWorkspaceBindingPath(input: {
	rawPath: string;
	settings: PlatformSettings;
	actor: RequestActor;
	dataDir?: string;
}): string {
	const trimmed = input.rawPath.trim();
	if (!trimmed) {
		throw new Error("repoPath is required");
	}
	const isAdmin = isSuperAdminActor(input.actor);
	if (!isAdmin && !input.settings.allowLocalWorkspacePath) {
		throw new Error("当前管理员已关闭直接绑定服务器本地目录，请填写 Git Clone 地址");
	}
	const resolved = resolve(trimmed);
	if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
		throw new Error(`本地目录不存在或不是目录: ${trimmed}`);
	}
	const realTarget = realpathSync(resolved);
	const dataRoot = resolve(input.dataDir ?? resolve(process.cwd(), ".data"));
	if (existsSync(dataRoot)) {
		const realData = realpathSync(dataRoot);
		const workspacesRoot = resolve(input.settings.workspacesRoot);
		const insideWorkspacesRoot = existsSync(workspacesRoot) && isInsideDir(realpathSync(workspacesRoot), realTarget);
		if (isInsideDir(realData, realTarget) && !insideWorkspacesRoot) {
			throw new Error("出于安全限制，不允许将系统 .data 运行目录直接绑定为项目仓库");
		}
	}
	if (!isAdmin && input.settings.localWorkspaceAllowlist.length > 0) {
		const allowed = input.settings.localWorkspaceAllowlist.some((prefix) => {
			if (!existsSync(prefix)) return false;
			return isInsideDir(realpathSync(resolve(prefix)), realTarget);
		});
		if (!allowed) {
			throw new Error("所选本地目录不在管理员允许的服务器目录白名单内");
		}
	}
	return realTarget;
}
