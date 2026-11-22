import { existsSync, realpathSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { isAbsolute, relative, resolve } from "node:path";
import { ROLE_ARCHITECT_MEMBER_ID } from "../roles/role-architect.ts";
import type { RoleScope } from "../roles/types.ts";
import type { SpaceRecord } from "../storage/repos/space-repo.ts";
import type { PersonalAgentStore } from "../storage/repositories.ts";
import type {
	Deliverable,
	Matter,
	MemberMemory,
	OrgMemberRole,
	PlatformSettings,
	TeamMember,
	WorkspaceLink,
} from "../storage/types.ts";
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

export function resolveActorAccessibleOrgIds(store: PersonalAgentStore, actor: RequestActor | null): Set<string> {
	const ids = new Set<string>();
	if (!actor) return ids;
	for (const org of store.listOrganizations()) {
		if (canAccessOrganization(store, actor, org.id)) ids.add(org.id);
	}
	return ids;
}

export function isViewerInAllOrgsOrTarget(
	store: PersonalAgentStore,
	actor: RequestActor,
	orgId?: string | null,
): boolean {
	if (actor.authKind === "loopback" || isSuperAdminActor(actor)) return false;
	if (!actor.user) return isLegacyCollaboratorActor(actor);
	if (orgId) {
		return getActorOrgRole(store, actor, orgId) === "org_viewer";
	}
	const orgs = store.listUserOrganizations(actor.user.id);
	if (orgs.length === 0) return false;
	return orgs.every((org) => org.orgRole === "org_viewer");
}

export function canActorCreateRoleInScope(
	store: PersonalAgentStore,
	actor: RequestActor | null,
	roleScope: RoleScope,
	ownerOrgId?: string | null,
): { allowed: boolean; reason?: string } {
	if (!actor) return { allowed: false, reason: "未认证" };
	if (actor.user && actor.user.status !== "active") return { allowed: false, reason: "账号未激活" };
	if (roleScope === "global") {
		if (isSuperAdminActor(actor)) return { allowed: true };
		return { allowed: false, reason: "仅超级管理员可创建或修改平台通用（global）AI 角色与 Skill" };
	}
	if (roleScope === "org") {
		if (!ownerOrgId) return { allowed: false, reason: "创建组织共享 AI 角色必须指定所属组织" };
		if (!store.getOrganization(ownerOrgId))
			return { allowed: false, reason: `Organization not found: ${ownerOrgId}` };
		if (isSuperAdminActor(actor) || canManageOrganization(store, actor, ownerOrgId)) {
			return { allowed: true };
		}
		return { allowed: false, reason: "仅组织所有者或管理员可创建该组织的共享 AI 角色与 Skill" };
	}
	if (isLegacyCollaboratorActor(actor)) {
		return { allowed: false, reason: "访客邀请口令不支持创建个人私有角色，请登录个人账号后操作" };
	}
	if (!actor.user) {
		return { allowed: false, reason: "当前会话未绑定个人账号，无法创建个人私有角色" };
	}
	if (isViewerInAllOrgsOrTarget(store, actor, ownerOrgId)) {
		return { allowed: false, reason: "只读成员（org_viewer）无权创建个人私有 AI 角色与 Skill" };
	}
	return { allowed: true };
}

export function canActorUseMember(
	store: PersonalAgentStore,
	actor: RequestActor | null,
	member: Pick<TeamMember, "roleScope" | "ownerOrgId" | "ownerUserId"> | null | undefined,
): boolean {
	if (!actor || !member) return false;
	if (actor.user && actor.user.status !== "active") return false;
	if (member.roleScope === "personal") {
		return Boolean(actor.user && member.ownerUserId && member.ownerUserId === actor.user.id);
	}
	if (member.roleScope === "org") {
		return (
			isSuperAdminActor(actor) ||
			Boolean(member.ownerOrgId && canAccessOrganization(store, actor, member.ownerOrgId))
		);
	}
	return true;
}

export function canTargetMatterAi(
	store: PersonalAgentStore,
	actor: RequestActor,
	orgId: string | null,
	memberId: string,
): boolean {
	const member = store.getMember(memberId);
	return Boolean(
		member &&
			canActorUseMember(store, actor, member) &&
			(!orgId ||
				memberId === ROLE_ARCHITECT_MEMBER_ID ||
				store.resolveEffectiveOrgMembersForUser(orgId, actor.user?.id).some(({ id }) => id === memberId)),
	);
}

export function canActorManageMember(
	store: PersonalAgentStore,
	actor: RequestActor | null,
	member: Pick<TeamMember, "roleScope" | "ownerOrgId" | "ownerUserId"> | null | undefined,
): boolean {
	if (!actor || !member) return false;
	if (actor.user && actor.user.status !== "active") return false;
	if (member.roleScope === "personal") {
		return Boolean(actor.user && member.ownerUserId && member.ownerUserId === actor.user.id);
	}
	if (member.roleScope === "org") {
		return Boolean(
			member.ownerOrgId && (isSuperAdminActor(actor) || canManageOrganization(store, actor, member.ownerOrgId)),
		);
	}
	return isSuperAdminActor(actor);
}

export function canActorAccessMemory(
	store: PersonalAgentStore,
	actor: RequestActor | null,
	memory: Pick<MemberMemory, "memberId" | "scope" | "orgId" | "workspaceId">,
	member = store.getMember(memory.memberId),
): boolean {
	if (!canActorUseMember(store, actor, member)) return false;
	if (memory.scope === "role_general") return true;
	if (memory.scope === "company_private" && memory.orgId) {
		return canAccessOrganization(store, actor, memory.orgId);
	}
	return Boolean(
		memory.workspaceId &&
			canAccessWorkspace(store, actor, store.getWorkspace(memory.workspaceId)) &&
			!store.hasWorkspaceScopeConflict(memory.workspaceId),
	);
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
	if (!matter.orgId && actor.authKind === "legacy_token" && !isGlobalUnscopedActor(actor)) {
		if (actor.collaborator.orgId && !matter.collaboratorIds.includes(actor.collaborator.id)) {
			return false;
		}
	}
	if (matter.workspaceId) {
		const ws = store.getWorkspace(matter.workspaceId);
		if (ws && !canAccessWorkspace(store, actor, ws)) return false;
	}
	if (matter.visibility === "private" && actor.authKind === "legacy_token" && !isGlobalUnscopedActor(actor)) {
		if (!matter.collaboratorIds.includes(actor.collaborator.id)) {
			return false;
		}
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

export function canAccessDeliverable(
	store: PersonalAgentStore,
	actor: RequestActor | null,
	deliverable: Deliverable | null | undefined,
): boolean {
	if (!actor || !deliverable) return false;
	if (actor.user && actor.user.status !== "active") return false;
	if (isGlobalUnscopedActor(actor)) return true;
	const matter = store.getMatter(deliverable.matterId);
	if (!matter) return isSuperAdminActor(actor);
	return canAccessMatter(store, actor, matter);
}

export function canDistillMatter(
	store: PersonalAgentStore,
	actor: RequestActor | null,
	matter: Matter | null | undefined,
): boolean {
	if (!actor || !matter) return false;
	if (!canAccessMatter(store, actor, matter)) return false;
	return isGlobalUnscopedActor(actor) || isSuperAdminActor(actor) || canManageOrganization(store, actor, matter.orgId);
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
		const matterId = store.findLegacyUploadMatterId(filename);
		return Boolean(matterId && canAccessMatter(store, actor, store.getMatter(matterId)));
	}
	if (record.matterId) {
		return canAccessMatter(store, actor, store.getMatter(record.matterId));
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

export function canAccessSpace(
	store: PersonalAgentStore,
	actor: RequestActor | null,
	space: SpaceRecord | null | undefined,
): boolean {
	if (!actor || !space) return false;
	if (actor.user && actor.user.status !== "active") return false;

	// User personal spaces and private custom spaces are strictly scoped to their owner (even for super_admin).
	if (space.kind === "user") {
		if (actor.user) return space.ownerUserId === actor.user.id;
		if (actor.authKind === "loopback") return space.ownerUserId === "usr_local_owner";
		return false;
	}
	if (space.kind === "custom" && space.visibility === "private") {
		if (actor.user) return space.ownerUserId === actor.user.id || space.createdBy === actor.user.id;
		if (actor.authKind === "loopback") {
			return space.ownerUserId === "usr_local_owner" || space.createdBy === "usr_local_owner";
		}
		return false;
	}

	if (isGlobalUnscopedActor(actor) || isSuperAdminActor(actor)) return true;

	if (space.kind === "org") {
		return canAccessOrganization(store, actor, space.orgId);
	}
	if (space.kind === "workspace") {
		const workspace = space.workspaceId ? store.getWorkspace(space.workspaceId) : null;
		return canAccessWorkspace(store, actor, workspace);
	}
	if (space.kind === "member") {
		const member = space.memberId ? store.getMember(space.memberId) : null;
		if (!member) return false;
		return canActorUseMember(store, actor, member);
	}
	return space.orgId ? canAccessOrganization(store, actor, space.orgId) : true;
}

export function canWriteSpace(
	store: PersonalAgentStore,
	actor: RequestActor | null,
	space: SpaceRecord | null | undefined,
): boolean {
	if (!actor || !space) return false;
	if (!canAccessSpace(store, actor, space)) return false;

	if (space.kind === "user") {
		if (actor.user) return space.ownerUserId === actor.user.id;
		if (actor.authKind === "loopback") return space.ownerUserId === "usr_local_owner";
		return false;
	}
	if (space.kind === "custom" && space.visibility === "private") {
		if (actor.user) return space.ownerUserId === actor.user.id || space.createdBy === actor.user.id;
		if (actor.authKind === "loopback") {
			return space.ownerUserId === "usr_local_owner" || space.createdBy === "usr_local_owner";
		}
		return false;
	}

	if (isGlobalUnscopedActor(actor) || isSuperAdminActor(actor)) return true;

	if (space.kind === "org") {
		return getActorOrgRole(store, actor, space.orgId) !== "org_viewer";
	}
	if (space.kind === "workspace") {
		const workspace = space.workspaceId ? store.getWorkspace(space.workspaceId) : null;
		return getActorOrgRole(store, actor, workspace?.orgId ?? space.orgId) !== "org_viewer";
	}
	if (space.kind === "member") {
		const member = space.memberId ? store.getMember(space.memberId) : null;
		if (!member) return false;
		if (member.roleScope === "personal") {
			return Boolean(actor.user && member.ownerUserId === actor.user.id);
		}
		if (member.roleScope === "org") {
			return getActorOrgRole(store, actor, member.ownerOrgId) !== "org_viewer";
		}
		return !isViewerInAllOrgsOrTarget(store, actor);
	}
	return space.orgId
		? getActorOrgRole(store, actor, space.orgId) !== "org_viewer"
		: !isViewerInAllOrgsOrTarget(store, actor);
}
