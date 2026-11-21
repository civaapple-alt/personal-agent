import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, resolve } from "node:path";
import { type PstackRuntime, preparePstackRuntime } from "../../../pi-extensions/pstack-methods/methods.js";
import { buildRuntimeOverview } from "../../orchestrator/runtime-info.ts";
import { toPublicCollaborator, toPublicUser } from "../../storage/repositories.ts";
import type { PlatformRole, RegistrationMode, UserStatus } from "../../storage/types.ts";
import {
	extractClientIp,
	extractHeaderToken,
	isLoopbackRemote,
	parseCookies,
	type RequestActor,
	requireActiveActor,
	requireSuperAdmin,
	SESSION_COOKIE_NAME,
	SlidingWindowRateLimiter,
} from "../auth.ts";
import { readJsonBody, sendError, sendJson } from "../http.ts";
import { auditActorAction, type RouteRequest, type ServerRouteContext } from "./context.ts";
import { validateModelSelection } from "./model-settings.ts";

const authRateLimiter = new SlidingWindowRateLimiter(20, 5 * 60 * 1000);
const SESSION_MAX_AGE_SEC = 2_592_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function setSessionCookie(req: IncomingMessage, res: ServerResponse, rawToken: string): void {
	const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "").toLowerCase();
	const isHttps = forwardedProto === "https";
	const secureAttr = isHttps ? "; Secure" : "";
	res.setHeader(
		"Set-Cookie",
		`${SESSION_COOKIE_NAME}=${encodeURIComponent(rawToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SEC}${secureAttr}`,
	);
}

function clearSessionCookie(res: ServerResponse): void {
	res.setHeader("Set-Cookie", `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function ensureUserBelongsToDefaultOrgIfBootstrapped(ctx: ServerRouteContext, userId: string): void {
	const defaultOrg = ctx.store.getDefaultOrganization();
	if (!defaultOrg) return;
	if (ctx.store.listOrgMembers(defaultOrg.id).length === 0) {
		ctx.store.upsertOrgMember({
			orgId: defaultOrg.id,
			userId,
			orgRole: "org_owner",
			roleTitle: "超级管理员",
		});
	}
}

/** Handle authentication, registration, admin setup, and super-admin platform routes. */
export async function handleAdminAndAuthRoutes(
	ctx: ServerRouteContext,
	req: IncomingMessage,
	res: ServerResponse,
	method: string,
	pathname: string,
	actor: RequestActor | null,
	requireAuth: boolean,
): Promise<boolean> {
	const { store } = ctx;
	const ip = extractClientIp(req);

	if (method === "GET" && pathname === "/api/auth/session") {
		const presentedToken = Boolean(extractHeaderToken(req) || parseCookies(req)[SESSION_COOKIE_NAME]?.trim());
		const settings = store.getPlatformSettings(ctx.defaultWorkspacesRoot);
		const needsAdminSetup = requireAuth && !store.hasPasswordedAdmin();
		const pendingApproval = actor?.user?.status === "pending_review";
		sendJson(res, 200, {
			authenticated: Boolean(actor),
			requireAuth,
			permissionRequired: requireAuth || !isLoopbackRemote(req),
			revokedSession: Boolean(!actor && presentedToken),
			pendingApproval: Boolean(pendingApproval),
			needsAdminSetup,
			registrationMode: settings.registrationMode,
			authKind: actor?.authKind ?? null,
			currentUser: actor ? toPublicCollaborator(actor.collaborator) : null,
			accountUser: actor?.user ? toPublicUser(actor.user) : null,
		});
		return true;
	}

	if (method === "GET" && pathname === "/api/auth/invite-preview") {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const token = url.searchParams.get("token")?.trim() ?? "";
		if (!token) {
			sendJson(res, 200, { valid: false, reason: "缺少邀请码" });
			return true;
		}
		const invite = store.peekOrgInviteByToken(token);
		if (!invite) {
			sendJson(res, 200, { valid: false, reason: "组织邀请链接无效、已过期或已达使用上限" });
			return true;
		}
		const org = store.getOrganization(invite.orgId);
		if (!org) {
			sendJson(res, 200, { valid: false, reason: "邀请对应的组织已不存在" });
			return true;
		}
		const existingMembership = actor?.user ? store.getOrgMembership(org.id, actor.user.id) : null;
		sendJson(res, 200, {
			valid: true,
			orgId: org.id,
			orgName: org.name,
			orgRole: invite.orgRole,
			alreadyMember: Boolean(existingMembership),
			existingRole: existingMembership?.orgRole ?? null,
		});
		return true;
	}

	if (method === "POST" && pathname === "/api/auth/setup-admin") {
		const rateKey = `setup:${ip}`;
		if (!authRateLimiter.check(rateKey)) {
			sendError(res, 429, "操作过于频繁，请稍后再试");
			return true;
		}
		if (store.hasPasswordedAdmin()) {
			sendError(res, 409, "超级管理员已初始化，不能重复设置");
			return true;
		}
		const body = await readJsonBody(req);
		const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
		const password = typeof body.password === "string" ? body.password : "";
		const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
		if (!EMAIL_RE.test(email)) {
			sendError(res, 400, "请输入有效的管理员邮箱");
			return true;
		}
		if (password.length < 8) {
			sendError(res, 400, "管理员密码长度至少为 8 位");
			return true;
		}
		const adminUser = store.setupInitialAdmin({
			email,
			password,
			displayName: displayName || "系统超级管理员",
		});
		ensureUserBelongsToDefaultOrgIfBootstrapped(ctx, adminUser.id);
		const { rawToken } = store.createSession(adminUser.id, {
			ip,
			userAgent: String(req.headers["user-agent"] ?? ""),
		});
		authRateLimiter.reset(rateKey);
		setSessionCookie(req, res, rawToken);
		store.recordAuditLog({
			actorUserId: adminUser.id,
			actorEmail: adminUser.email,
			actorName: adminUser.displayName,
			action: "admin.setup",
			targetType: "user",
			targetId: adminUser.id,
			ip,
		});
		sendJson(res, 201, {
			ok: true,
			accountUser: toPublicUser(adminUser),
		});
		return true;
	}

	if (method === "POST" && pathname === "/api/auth/register") {
		const body = await readJsonBody(req);
		const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
		const password = typeof body.password === "string" ? body.password : "";
		const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
		const inviteToken = typeof body.inviteToken === "string" ? body.inviteToken.trim() : "";
		const rateKey = `register:${ip}`;
		if (!authRateLimiter.check(rateKey)) {
			sendError(res, 429, "注册请求过于频繁，请稍后再试");
			return true;
		}
		if (!EMAIL_RE.test(email)) {
			authRateLimiter.recordFailure(rateKey);
			sendError(res, 400, "请输入有效的邮箱地址");
			return true;
		}
		if (password.length < 8) {
			sendError(res, 400, "密码长度至少需要 8 位");
			return true;
		}
		if (!displayName) {
			sendError(res, 400, "请输入显示姓名");
			return true;
		}
		const settings = store.getPlatformSettings(ctx.defaultWorkspacesRoot);
		const validInvite = inviteToken ? store.peekOrgInviteByToken(inviteToken) : null;
		if (inviteToken && !validInvite) {
			authRateLimiter.recordFailure(rateKey);
			sendError(res, 400, "组织邀请码无效、已过期或已达上限");
			return true;
		}
		if (settings.registrationMode === "invite_only" && !validInvite) {
			sendError(res, 403, "当前站点仅开放受邀注册，请联系管理员或组织管理员获取邀请链接");
			return true;
		}
		if (store.getUserByEmail(email)) {
			authRateLimiter.recordFailure(rateKey);
			sendError(res, 409, "该邮箱已注册，请直接登录");
			return true;
		}
		const initialStatus: UserStatus = settings.registrationMode === "open_review" ? "pending_review" : "active";
		const user = store.createUser({
			email,
			displayName,
			password,
			platformRole: "user",
			status: initialStatus,
		});
		if (validInvite) {
			store.consumeOrgInviteByToken(inviteToken, user.id);
		}
		const { rawToken } = store.createSession(user.id, {
			ip,
			userAgent: String(req.headers["user-agent"] ?? ""),
		});
		setSessionCookie(req, res, rawToken);
		store.recordAuditLog({
			actorUserId: user.id,
			actorEmail: user.email,
			actorName: user.displayName,
			action: "auth.register",
			targetType: "user",
			targetId: user.id,
			orgId: validInvite?.orgId ?? null,
			detail: { status: initialStatus, viaInvite: Boolean(validInvite) },
			ip,
		});
		sendJson(res, 201, {
			ok: true,
			pendingApproval: initialStatus === "pending_review",
			accountUser: toPublicUser(user),
		});
		return true;
	}

	if (method === "POST" && pathname === "/api/auth/login") {
		const body = await readJsonBody(req);
		const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
		const password = typeof body.password === "string" ? body.password : "";
		const token = typeof body.token === "string" ? body.token.trim() : "";
		const inviteToken = typeof body.inviteToken === "string" ? body.inviteToken.trim() : "";
		const rateKey = `login:${ip}:${email || "token"}`;
		if (!authRateLimiter.check(rateKey)) {
			sendError(res, 429, "登录尝试过于频繁，请 5 分钟后再试");
			return true;
		}
		if (email) {
			if (!password) {
				authRateLimiter.recordFailure(rateKey);
				sendError(res, 400, "请输入登录密码");
				return true;
			}
			const user = store.authenticateUser(email, password);
			if (!user) {
				authRateLimiter.recordFailure(rateKey);
				sendError(res, 401, "邮箱或密码错误");
				return true;
			}
			if (user.status === "disabled") {
				authRateLimiter.recordFailure(rateKey);
				sendError(res, 403, "当前账号已被管理员停用");
				return true;
			}
			authRateLimiter.reset(rateKey);
			let joinedOrgId: string | null = null;
			if (inviteToken && user.status === "active") {
				const consumed = store.consumeOrgInviteByToken(inviteToken, user.id);
				joinedOrgId = consumed.invite.orgId;
			}
			const { rawToken } = store.createSession(user.id, {
				ip,
				userAgent: String(req.headers["user-agent"] ?? ""),
			});
			setSessionCookie(req, res, rawToken);
			store.recordAuditLog({
				actorUserId: user.id,
				actorEmail: user.email,
				actorName: user.displayName,
				action: "auth.login",
				targetType: "user",
				targetId: user.id,
				orgId: joinedOrgId,
				ip,
			});
			sendJson(res, 200, {
				ok: true,
				pendingApproval: user.status === "pending_review",
				joinedOrgId,
				accountUser: toPublicUser(user),
			});
			return true;
		}
		if (!token) {
			sendError(res, 400, "请填写邮箱与密码，或提供有效的邀请口令");
			return true;
		}
		const matched = store.getCollaboratorByToken(token);
		if (!matched) {
			authRateLimiter.recordFailure(rateKey);
			sendError(res, 401, "无效或已失效的邀请口令");
			return true;
		}
		authRateLimiter.reset(rateKey);
		setSessionCookie(req, res, matched.token);
		sendJson(res, 200, {
			ok: true,
			currentUser: toPublicCollaborator(matched),
		});
		return true;
	}

	if (method === "POST" && pathname === "/api/auth/logout") {
		const rawToken = extractHeaderToken(req) || parseCookies(req)[SESSION_COOKIE_NAME]?.trim() || "";
		if (rawToken) {
			store.revokeSessionByToken(rawToken);
		}
		if (actor?.sessionTokenHash) ctx.closeAccountSession(actor.sessionTokenHash);
		clearSessionCookie(res);
		sendJson(res, 200, { ok: true });
		return true;
	}

	if (method === "POST" && pathname === "/api/auth/change-password") {
		if (!requireActiveActor(res, actor)) return true;
		if (!actor.user) {
			sendError(res, 400, "当前访客口令不支持修改账号密码");
			return true;
		}
		const body = await readJsonBody(req);
		const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
		const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
		if (newPassword.length < 8) {
			sendError(res, 400, "新密码长度至少需要 8 位");
			return true;
		}
		if (actor.user.passwordHash && !store.authenticateUser(actor.user.email, currentPassword)) {
			sendError(res, 401, "当前密码不正确");
			return true;
		}
		store.updateUser(actor.user.id, { password: newPassword });
		store.revokeAllUserSessions(actor.user.id);
		const { rawToken } = store.createSession(actor.user.id, {
			ip,
			userAgent: String(req.headers["user-agent"] ?? ""),
		});
		setSessionCookie(req, res, rawToken);
		auditActorAction(ctx, req, actor, {
			action: "auth.change_password",
			targetType: "user",
			targetId: actor.user.id,
		});
		sendJson(res, 200, { ok: true });
		return true;
	}

	return false;
}

/** Handle `/api/admin/*` platform super-admin endpoints. */
export async function handleAdminRoutes(ctx: ServerRouteContext, r: RouteRequest): Promise<boolean> {
	const { store, orchestrator, dialogBroker, activeRuns, broadcast, revokeTokenSessions } = ctx;
	const { req, res, method, pathname, actor } = r;
	if (!pathname.startsWith("/api/admin")) return false;
	if (!requireSuperAdmin(res, actor)) return true;

	if (method === "GET" && pathname === "/api/admin/overview") {
		const settings = store.getPlatformSettings(ctx.defaultWorkspacesRoot);
		const users = store.listUsers().map((u) => ({
			...toPublicUser(u),
			ownedOrgCount: store.countOwnedOrganizations(u.id),
			orgMemberships: store.listUserOrganizations(u.id).map((o) => ({
				orgId: o.id,
				orgName: o.name,
				orgRole: o.orgRole,
			})),
		}));
		const allWorkspaces = store.listWorkspaces();
		const allMatters = store.listMatters();
		const organizations = store.listOrganizations().map((org) => ({
			...org,
			memberCount: store.listOrgMembers(org.id).length,
			workspaceCount: allWorkspaces.filter((w) => w.orgId === org.id).length,
			matterCount: allMatters.filter((m) => m.orgId === org.id).length,
		}));
		const runs = [...activeRuns.entries()].map(([matterId, run]) => {
			const matter = store.getMatter(matterId);
			return {
				matterId,
				matterTitle: matter?.title ?? matterId,
				orgId: matter?.orgId ?? run.orgId ?? null,
				startedByUserId: run.startedByUserId ?? null,
				stage: run.progress.stage,
				label: run.progress.label,
				startedAt: run.startedAt,
			};
		});
		const auditLogs = store.listAuditLogs({ limit: 80 });
		sendJson(res, 200, {
			settings,
			users,
			organizations,
			activeRuns: runs,
			auditLogs,
		});
		return true;
	}

	if (method === "PATCH" && pathname === "/api/admin/settings") {
		const body = await readJsonBody(req);
		let registrationMode: RegistrationMode | undefined;
		if (body.registrationMode !== undefined) {
			if (
				body.registrationMode !== "open_auto" &&
				body.registrationMode !== "open_review" &&
				body.registrationMode !== "invite_only"
			) {
				sendError(res, 400, "registrationMode 必须是 open_auto、open_review 或 invite_only");
				return true;
			}
			registrationMode = body.registrationMode;
		}
		let workspacesRoot: string | undefined;
		if (body.workspacesRoot !== undefined) {
			if (typeof body.workspacesRoot !== "string" || !body.workspacesRoot.trim()) {
				sendError(res, 400, "workspacesRoot 不能为空");
				return true;
			}
			workspacesRoot = resolve(body.workspacesRoot.trim());
		}
		let localWorkspaceAllowlist: string[] | undefined;
		if (body.localWorkspaceAllowlist !== undefined) {
			if (!Array.isArray(body.localWorkspaceAllowlist)) {
				sendError(res, 400, "localWorkspaceAllowlist 必须是字符串数组");
				return true;
			}
			localWorkspaceAllowlist = body.localWorkspaceAllowlist
				.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
				.map((item) => item.trim());
		}
		const defaultModelSelection = Object.hasOwn(body, "defaultModelSelection")
			? await validateModelSelection(ctx, body.defaultModelSelection)
			: undefined;
		const updated = store.updatePlatformSettings(
			{
				defaultModelSelection,
				...(registrationMode ? { registrationMode } : {}),
				...(workspacesRoot ? { workspacesRoot } : {}),
				...(typeof body.allowLocalWorkspacePath === "boolean"
					? { allowLocalWorkspacePath: body.allowLocalWorkspacePath }
					: {}),
				...(localWorkspaceAllowlist !== undefined ? { localWorkspaceAllowlist } : {}),
				...(typeof body.allowCommandPreviews === "boolean"
					? { allowCommandPreviews: body.allowCommandPreviews }
					: {}),
				...(typeof body.defaultMaxOrgs === "number" ? { defaultMaxOrgs: body.defaultMaxOrgs } : {}),
				...(typeof body.defaultMaxActiveDispatches === "number"
					? { defaultMaxActiveDispatches: body.defaultMaxActiveDispatches }
					: {}),
				...(typeof body.defaultMaxPersonalRoles === "number"
					? { defaultMaxPersonalRoles: body.defaultMaxPersonalRoles }
					: {}),
			},
			ctx.defaultWorkspacesRoot,
		);
		auditActorAction(ctx, req, actor, {
			action: "admin.update_settings",
			targetType: "platform_settings",
			targetId: "platform",
			detail: { ...updated },
		});
		sendJson(res, 200, { settings: updated });
		return true;
	}

	const adminUserMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
	if (method === "PATCH" && adminUserMatch) {
		const userId = decodeURIComponent(adminUserMatch[1]!);
		const existing = store.getUserById(userId);
		if (!existing) {
			sendError(res, 404, `User not found: ${userId}`);
			return true;
		}
		const body = await readJsonBody(req);
		let platformRole: PlatformRole | undefined;
		if (body.platformRole !== undefined) {
			if (body.platformRole !== "super_admin" && body.platformRole !== "user") {
				sendError(res, 400, "platformRole 必须是 super_admin 或 user");
				return true;
			}
			platformRole = body.platformRole;
		}
		let status: UserStatus | undefined;
		if (body.status !== undefined) {
			if (body.status !== "active" && body.status !== "pending_review" && body.status !== "disabled") {
				sendError(res, 400, "status 必须是 active、pending_review 或 disabled");
				return true;
			}
			status = body.status;
		}
		let updated: ReturnType<typeof store.updateUser>;
		try {
			updated = store.updateUser(userId, {
				...(typeof body.displayName === "string" ? { displayName: body.displayName } : {}),
				...(platformRole ? { platformRole } : {}),
				...(status ? { status } : {}),
				...(typeof body.maxOrgs === "number" ? { maxOrgs: body.maxOrgs } : {}),
				...(typeof body.maxActiveDispatches === "number" ? { maxActiveDispatches: body.maxActiveDispatches } : {}),
				...(typeof body.maxPersonalRoles === "number" ? { maxPersonalRoles: body.maxPersonalRoles } : {}),
				...(typeof body.canDispatchAi === "boolean" ? { canDispatchAi: body.canDispatchAi } : {}),
			});
		} catch (err) {
			sendError(res, 400, err instanceof Error ? err.message : String(err));
			return true;
		}
		if (updated.status === "disabled") {
			store.revokeAllUserSessions(updated.id);
			revokeTokenSessions(updated.id, "user_disabled");
		}
		auditActorAction(ctx, req, actor, {
			action: "admin.update_user",
			targetType: "user",
			targetId: updated.id,
			detail: {
				status: updated.status,
				platformRole: updated.platformRole,
				maxOrgs: updated.maxOrgs,
				maxActiveDispatches: updated.maxActiveDispatches,
				maxPersonalRoles: updated.maxPersonalRoles,
				canDispatchAi: updated.canDispatchAi,
			},
		});
		sendJson(res, 200, { user: toPublicUser(updated) });
		return true;
	}

	if (method === "GET" && pathname === "/api/admin/audit") {
		sendJson(res, 200, { auditLogs: store.listAuditLogs({ limit: 200 }) });
		return true;
	}

	const adminAbortMatch = pathname.match(/^\/api\/admin\/matters\/([^/]+)\/abort$/);
	if (method === "POST" && adminAbortMatch) {
		const matterId = decodeURIComponent(adminAbortMatch[1]!);
		if (!store.getMatter(matterId)) {
			sendError(res, 404, `Matter not found: ${matterId}`);
			return true;
		}
		dialogBroker.cancelForMatter(matterId);
		const aborted = await orchestrator.abortMatter(matterId);
		broadcast("matter_aborted", { matterId, aborted }, { matterId });
		auditActorAction(ctx, req, actor, {
			action: "admin.abort_matter",
			targetType: "matter",
			targetId: matterId,
			detail: { aborted },
		});
		sendJson(res, 200, { ok: true, aborted });
		return true;
	}

	if (method === "POST" && pathname === "/api/admin/runtime/pstack/enable") {
		if (process.env.PA_PSTACK_DIR?.trim()) {
			sendError(res, 409, "当前由启动环境变量 PA_PSTACK_DIR 接管，请从启动参数移除后重启服务");
			return true;
		}
		const body = await readJsonBody(req);
		const path = typeof body.path === "string" ? body.path.trim() : "";
		if (!isAbsolute(path)) {
			sendError(res, 400, "请填写服务主机上已有的 pstack 方法包绝对路径，可用 pi list 查看");
			return true;
		}
		let runtime: PstackRuntime;
		try {
			runtime = await preparePstackRuntime(path);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			sendError(res, 400, `无法启用 pstack 方法包：${msg}`);
			return true;
		}
		const updatedSettings = store.updatePlatformSettings({ pstackDir: runtime.root }, ctx.defaultWorkspacesRoot);
		orchestrator.setPstackDir(runtime.root);
		auditActorAction(ctx, req, actor, {
			action: "admin.pstack_enable",
			targetType: "runtime_extension",
			targetId: "pstack",
			detail: {
				path: runtime.root,
				version: runtime.version,
				skillCount: runtime.skills.length,
			},
		});
		const overview = await buildRuntimeOverview({
			config: orchestrator.getRuntimeConfig(),
			serverConfig: ctx.getServerRuntimeConfig?.(),
			activeMembers: store.listMembers(),
			isOwner: true,
			probePiCli: ctx.probePiCli,
		});
		sendJson(res, 200, {
			settings: updatedSettings,
			overview,
		});
		return true;
	}

	if (method === "POST" && pathname === "/api/admin/runtime/pstack/disable") {
		if (process.env.PA_PSTACK_DIR?.trim()) {
			sendError(res, 409, "当前由启动环境变量 PA_PSTACK_DIR 接管，请从启动参数移除后重启服务以停用");
			return true;
		}
		const updatedSettings = store.updatePlatformSettings({ pstackDir: null }, ctx.defaultWorkspacesRoot);
		orchestrator.setPstackDir(undefined);
		auditActorAction(ctx, req, actor, {
			action: "admin.pstack_disable",
			targetType: "runtime_extension",
			targetId: "pstack",
		});
		const overview = await buildRuntimeOverview({
			config: orchestrator.getRuntimeConfig(),
			serverConfig: ctx.getServerRuntimeConfig?.(),
			activeMembers: store.listMembers(),
			isOwner: true,
			probePiCli: ctx.probePiCli,
		});
		sendJson(res, 200, { settings: updatedSettings, overview });
		return true;
	}

	return false;
}
