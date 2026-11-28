import type { IncomingMessage } from "node:http";
import { resolve } from "node:path";
import type { Hono } from "hono";
import { readDotEnvMap, resolveEnvFilePath } from "../../extensions/env-credentials.ts";
import { createSystemOneClassifier } from "../../orchestrator/architect/system-one.ts";
import { toPublicUser } from "../../storage/repositories.ts";
import type { PlatformRole, RegistrationMode, UserStatus } from "../../storage/types.ts";
import { canAccessOrganization, canAccessWorkspace } from "../acl.ts";
import {
	extractClientIp,
	extractHeaderToken,
	isLoopbackRemote,
	parseCookies,
	requireActiveActor,
	SESSION_COOKIE_NAME,
	SlidingWindowRateLimiter,
} from "../auth.ts";
import { HttpRequestError } from "../http.ts";
import { type ApiRouteContext, type ApiRouterEnv, parseJsonBody, requireSuperAdminMiddleware } from "../router.ts";
import { auditActorAction, type ServerRouteContext } from "./context.ts";
import { validateModelSelection } from "./model-settings.ts";

const authRateLimiter = new SlidingWindowRateLimiter(20, 5 * 60 * 1000);
const SESSION_MAX_AGE_SEC = 2_592_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function setSessionCookie(c: ApiRouteContext, req: IncomingMessage, rawToken: string): void {
	const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "").toLowerCase();
	const isHttps = forwardedProto === "https";
	const secureAttr = isHttps ? "; Secure" : "";
	c.header(
		"Set-Cookie",
		`${SESSION_COOKIE_NAME}=${encodeURIComponent(rawToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SEC}${secureAttr}`,
	);
}

function clearSessionCookie(c: ApiRouteContext): void {
	c.header("Set-Cookie", `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
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

/** Register authentication, registration, initial admin setup, and personal token routes. */
export function registerPublicAuthRoutes(app: Hono<ApiRouterEnv>): void {
	app.get("/api/auth/session", (c) => {
		const ctx = c.var.routeCtx;
		const req = c.var.nodeReq!;
		const actor = c.var.actor;
		const requireAuth = c.var.requireAuth;
		const presentedToken = Boolean(extractHeaderToken(req) || parseCookies(req)[SESSION_COOKIE_NAME]?.trim());
		const settings = ctx.store.getPlatformSettings(ctx.defaultWorkspacesRoot);
		const needsAdminSetup = requireAuth && !ctx.store.hasPasswordedAdmin();
		const pendingApproval = actor?.user?.status === "pending_review";
		return c.json({
			authenticated: Boolean(actor),
			requireAuth,
			permissionRequired: requireAuth || !isLoopbackRemote(req),
			revokedSession: Boolean(!actor && presentedToken),
			pendingApproval: Boolean(pendingApproval),
			needsAdminSetup,
			registrationMode: settings.registrationMode,
			authKind: actor?.authKind ?? null,
			currentUser: actor ? actor.collaborator : null,
			accountUser: actor?.user ? toPublicUser(actor.user) : null,
		});
	});

	app.get("/api/auth/invite-preview", (c) => {
		const { store } = c.var.routeCtx;
		const actor = c.var.actor;
		const token = c.req.query("token")?.trim() ?? "";
		if (!token) {
			return c.json({ valid: false, reason: "缺少邀请码" });
		}
		const invite = store.peekOrgInviteByToken(token);
		if (!invite) {
			return c.json({ valid: false, reason: "组织邀请链接无效、已过期或已达使用上限" });
		}
		const org = store.getOrganization(invite.orgId);
		if (!org) {
			return c.json({ valid: false, reason: "邀请对应的组织已不存在" });
		}
		const existingMembership = actor?.user ? store.getOrgMembership(org.id, actor.user.id) : null;
		return c.json({
			valid: true,
			orgId: org.id,
			orgName: org.name,
			orgRole: invite.orgRole,
			alreadyMember: Boolean(existingMembership),
			existingRole: existingMembership?.orgRole ?? null,
		});
	});

	app.post("/api/auth/setup-admin", async (c) => {
		const ctx = c.var.routeCtx;
		const { store } = ctx;
		const req = c.var.nodeReq!;
		const ip = extractClientIp(req);
		const rateKey = `setup:${ip}`;
		if (!authRateLimiter.check(rateKey)) {
			throw new HttpRequestError(429, "操作过于频繁，请稍后再试");
		}
		if (store.hasPasswordedAdmin()) {
			throw new HttpRequestError(409, "超级管理员已初始化，不能重复设置");
		}
		const body = await parseJsonBody(c);
		const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
		const password = typeof body.password === "string" ? body.password : "";
		const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
		if (!EMAIL_RE.test(email)) {
			throw new HttpRequestError(400, "请输入有效的管理员邮箱");
		}
		if (password.length < 8) {
			throw new HttpRequestError(400, "管理员密码长度至少为 8 位");
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
		setSessionCookie(c, req, rawToken);
		store.recordAuditLog({
			actorUserId: adminUser.id,
			actorEmail: adminUser.email,
			actorName: adminUser.displayName,
			action: "admin.setup",
			targetType: "user",
			targetId: adminUser.id,
			ip,
		});
		return c.json(
			{
				ok: true,
				accountUser: toPublicUser(adminUser),
			},
			201,
		);
	});

	app.post("/api/auth/register", async (c) => {
		const ctx = c.var.routeCtx;
		const { store } = ctx;
		const req = c.var.nodeReq!;
		const ip = extractClientIp(req);
		const body = await parseJsonBody(c);
		const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
		const password = typeof body.password === "string" ? body.password : "";
		const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
		const inviteToken = typeof body.inviteToken === "string" ? body.inviteToken.trim() : "";
		const rateKey = `register:${ip}`;
		if (!authRateLimiter.check(rateKey)) {
			throw new HttpRequestError(429, "注册请求过于频繁，请稍后再试");
		}
		if (!EMAIL_RE.test(email)) {
			authRateLimiter.recordFailure(rateKey);
			throw new HttpRequestError(400, "请输入有效的邮箱地址");
		}
		if (password.length < 8) {
			throw new HttpRequestError(400, "密码长度至少需要 8 位");
		}
		if (!displayName) {
			throw new HttpRequestError(400, "请输入显示姓名");
		}
		const settings = store.getPlatformSettings(ctx.defaultWorkspacesRoot);
		const validInvite = inviteToken ? store.peekOrgInviteByToken(inviteToken) : null;
		if (inviteToken && !validInvite) {
			authRateLimiter.recordFailure(rateKey);
			throw new HttpRequestError(400, "组织邀请码无效、已过期或已达上限");
		}
		if (settings.registrationMode === "invite_only" && !validInvite) {
			throw new HttpRequestError(403, "当前站点仅开放受邀注册，请联系管理员或组织管理员获取邀请链接");
		}
		if (store.getUserByEmail(email)) {
			authRateLimiter.recordFailure(rateKey);
			throw new HttpRequestError(409, "该邮箱已注册，请直接登录");
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
		setSessionCookie(c, req, rawToken);
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
		return c.json(
			{
				ok: true,
				pendingApproval: initialStatus === "pending_review",
				accountUser: toPublicUser(user),
			},
			201,
		);
	});

	app.post("/api/auth/login", async (c) => {
		const { store } = c.var.routeCtx;
		const req = c.var.nodeReq!;
		const ip = extractClientIp(req);
		const body = await parseJsonBody(c);
		const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
		const password = typeof body.password === "string" ? body.password : "";
		const inviteToken = typeof body.inviteToken === "string" ? body.inviteToken.trim() : "";
		const rateKey = `login:${ip}:${email}`;
		if (!authRateLimiter.check(rateKey)) {
			throw new HttpRequestError(429, "登录尝试过于频繁，请 5 分钟后再试");
		}
		if (email) {
			if (!password) {
				authRateLimiter.recordFailure(rateKey);
				throw new HttpRequestError(400, "请输入登录密码");
			}
			const user = store.authenticateUser(email, password);
			if (!user) {
				authRateLimiter.recordFailure(rateKey);
				throw new HttpRequestError(401, "邮箱或密码错误");
			}
			if (user.status === "disabled") {
				authRateLimiter.recordFailure(rateKey);
				throw new HttpRequestError(403, "当前账号已被管理员停用");
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
			setSessionCookie(c, req, rawToken);
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
			return c.json({
				ok: true,
				pendingApproval: user.status === "pending_review",
				joinedOrgId,
				accountUser: toPublicUser(user),
			});
		}
		authRateLimiter.recordFailure(rateKey);
		throw new HttpRequestError(400, "请填写邮箱与密码");
	});

	app.post("/api/auth/logout", (c) => {
		const ctx = c.var.routeCtx;
		const req = c.var.nodeReq!;
		const actor = c.var.actor;
		const rawToken = extractHeaderToken(req) || parseCookies(req)[SESSION_COOKIE_NAME]?.trim() || "";
		if (rawToken) {
			ctx.store.revokeSessionByToken(rawToken);
		}
		if (actor?.sessionTokenHash) ctx.closeAccountSession(actor.sessionTokenHash);
		clearSessionCookie(c);
		return c.json({ ok: true });
	});

	app.post("/api/auth/change-password", async (c) => {
		const ctx = c.var.routeCtx;
		const { store } = ctx;
		const req = c.var.nodeReq!;
		const res = c.var.nodeRes!;
		const actor = c.var.actor;
		if (!requireActiveActor(res, actor)) return c.body(null);
		if (!actor.user) {
			throw new HttpRequestError(400, "当前访客口令不支持修改账号密码");
		}
		const ip = extractClientIp(req);
		const body = await parseJsonBody(c);
		const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
		const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
		if (newPassword.length < 8) {
			throw new HttpRequestError(400, "新密码长度至少需要 8 位");
		}
		if (actor.user.passwordHash && !store.authenticateUser(actor.user.email, currentPassword)) {
			throw new HttpRequestError(401, "当前密码不正确");
		}
		store.updateUser(actor.user.id, { password: newPassword });
		store.revokeAllUserSessions(actor.user.id);
		const { rawToken } = store.createSession(actor.user.id, {
			ip,
			userAgent: String(req.headers["user-agent"] ?? ""),
		});
		setSessionCookie(c, req, rawToken);
		auditActorAction(ctx, req, actor, {
			action: "auth.change_password",
			targetType: "user",
			targetId: actor.user.id,
		});
		return c.json({ ok: true });
	});

	app.get("/api/auth/tokens", (c) => {
		const { store } = c.var.routeCtx;
		const res = c.var.nodeRes!;
		const actor = c.var.actor;
		if (!requireActiveActor(res, actor)) return c.body(null);
		if (!actor.user) {
			throw new HttpRequestError(400, "当前身份不支持管理访问令牌");
		}
		return c.json({ tokens: store.listUserAccessTokens(actor.user.id) });
	});

	app.post("/api/auth/tokens", async (c) => {
		const ctx = c.var.routeCtx;
		const { store } = ctx;
		const req = c.var.nodeReq!;
		const res = c.var.nodeRes!;
		const actor = c.var.actor;
		if (!requireActiveActor(res, actor)) return c.body(null);
		if (!actor.user) {
			throw new HttpRequestError(400, "当前身份不支持创建访问令牌");
		}
		if (actor.accessTokenId) {
			throw new HttpRequestError(403, "不能使用访问令牌再创建新的访问令牌，请在网页会话中操作");
		}
		const body = await parseJsonBody(c);
		const name = typeof body.name === "string" ? body.name.trim() : "";
		if (!name) {
			throw new HttpRequestError(400, "请填写访问令牌名称");
		}
		const scope = body.scope === "full" ? "full" : "read";
		const expiresInDays =
			body.expiresInDays === null || body.expiresInDays === undefined || body.expiresInDays === ""
				? null
				: Number(body.expiresInDays);
		if (expiresInDays !== null && (!Number.isFinite(expiresInDays) || expiresInDays < 0 || expiresInDays > 3650)) {
			throw new HttpRequestError(400, "有效天数需为 1–3650 或留空（永不过期）");
		}
		let allowedOrgIds: string[] | null = null;
		if (body.allowedOrgIds !== undefined && body.allowedOrgIds !== null) {
			if (!Array.isArray(body.allowedOrgIds)) {
				throw new HttpRequestError(400, "allowedOrgIds 必须为组织 ID 数组");
			}
			const ids = [
				...new Set(
					body.allowedOrgIds
						.filter((v): v is string => typeof v === "string")
						.map((v) => v.trim())
						.filter(Boolean),
				),
			];
			for (const orgId of ids) {
				if (!store.getOrganization(orgId) || !canAccessOrganization(store, actor, orgId)) {
					throw new HttpRequestError(403, `无权将组织 ${orgId} 加入访问令牌范围`);
				}
			}
			allowedOrgIds = ids.length > 0 ? ids : null;
		}
		let allowedWorkspaceIds: string[] | null = null;
		if (body.allowedWorkspaceIds !== undefined && body.allowedWorkspaceIds !== null) {
			if (!Array.isArray(body.allowedWorkspaceIds)) {
				throw new HttpRequestError(400, "allowedWorkspaceIds 必须为工作区 ID 数组");
			}
			const ids = [
				...new Set(
					body.allowedWorkspaceIds
						.filter((v): v is string => typeof v === "string")
						.map((v) => v.trim())
						.filter(Boolean),
				),
			];
			for (const workspaceId of ids) {
				const ws = store.getWorkspace(workspaceId);
				if (!ws || !canAccessWorkspace(store, actor, ws)) {
					throw new HttpRequestError(403, `无权将工作区 ${workspaceId} 加入访问令牌范围`);
				}
				if (allowedOrgIds && (!ws.orgId || !allowedOrgIds.includes(ws.orgId))) {
					throw new HttpRequestError(400, `所选工作区 ${ws.name} 不在已选组织范围内`);
				}
			}
			allowedWorkspaceIds = ids.length > 0 ? ids : null;
		}
		const created = store.createAccessToken(actor.user.id, {
			name,
			scope,
			allowedOrgIds,
			allowedWorkspaceIds,
			expiresInDays: expiresInDays && expiresInDays > 0 ? expiresInDays : null,
		});
		auditActorAction(ctx, req, actor, {
			action: "auth.token.create",
			targetType: "access_token",
			targetId: created.token.id,
			detail: {
				name: created.token.name,
				scope: created.token.scope,
				allowedOrgIds: created.token.allowedOrgIds,
				allowedWorkspaceIds: created.token.allowedWorkspaceIds,
				expiresAt: created.token.expiresAt,
			},
		});
		return c.json(created, 201);
	});

	app.delete("/api/auth/tokens/:tokenId", (c) => {
		const ctx = c.var.routeCtx;
		const { store } = ctx;
		const req = c.var.nodeReq!;
		const res = c.var.nodeRes!;
		const actor = c.var.actor;
		if (!requireActiveActor(res, actor)) return c.body(null);
		if (!actor.user) {
			throw new HttpRequestError(400, "当前身份不支持吊销访问令牌");
		}
		if (actor.accessTokenId) {
			throw new HttpRequestError(403, "不能使用访问令牌吊销访问令牌，请在网页会话中操作");
		}
		const tokenId = c.req.param("tokenId");
		const revoked = store.revokeAccessToken(actor.user.id, tokenId);
		if (!revoked) {
			throw new HttpRequestError(404, "未找到该有效访问令牌");
		}
		auditActorAction(ctx, req, actor, {
			action: "auth.token.revoke",
			targetType: "access_token",
			targetId: tokenId,
		});
		return c.json({ ok: true, id: tokenId });
	});
}

/** Register `/api/admin/*` platform super-admin endpoints on the authenticated Hono router. */
export function registerAdminRoutes(app: Hono<ApiRouterEnv>): void {
	app.get("/api/admin/overview", requireSuperAdminMiddleware, (c) => {
		const ctx = c.var.routeCtx;
		const { store, activeRuns } = ctx;
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
		return c.json({
			settings,
			users,
			organizations,
			activeRuns: runs,
			auditLogs,
		});
	});

	app.patch("/api/admin/settings", requireSuperAdminMiddleware, async (c) => {
		const ctx = c.var.routeCtx;
		const { store } = ctx;
		const req = c.var.nodeReq!;
		const actor = c.var.actor;
		const body = await parseJsonBody(c);
		let registrationMode: RegistrationMode | undefined;
		if (body.registrationMode !== undefined) {
			if (
				body.registrationMode !== "open_auto" &&
				body.registrationMode !== "open_review" &&
				body.registrationMode !== "invite_only"
			) {
				throw new HttpRequestError(400, "registrationMode 必须是 open_auto、open_review 或 invite_only");
			}
			registrationMode = body.registrationMode;
		}
		let workspacesRoot: string | undefined;
		if (body.workspacesRoot !== undefined) {
			if (typeof body.workspacesRoot !== "string" || !body.workspacesRoot.trim()) {
				throw new HttpRequestError(400, "workspacesRoot 不能为空");
			}
			workspacesRoot = resolve(body.workspacesRoot.trim());
		}
		let localWorkspaceAllowlist: string[] | undefined;
		if (body.localWorkspaceAllowlist !== undefined) {
			if (!Array.isArray(body.localWorkspaceAllowlist)) {
				throw new HttpRequestError(400, "localWorkspaceAllowlist 必须是字符串数组");
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
				...(typeof body.systemOneEnabled === "boolean" ? { systemOneEnabled: body.systemOneEnabled } : {}),
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
		if (typeof body.systemOneEnabled === "boolean") {
			if (!updated.systemOneEnabled) {
				ctx.orchestrator.setClassifier(undefined);
			} else {
				const envKey = process.env.TYPESAFE_API_KEY?.trim();
				const fileKey = envKey
					? envKey
					: (
							await readDotEnvMap(resolveEnvFilePath(ctx.orchestrator.getRuntimeConfig().defaultCwd))
						).TYPESAFE_API_KEY?.trim();
				ctx.orchestrator.setClassifier(fileKey ? createSystemOneClassifier(fileKey) : undefined);
			}
		}
		auditActorAction(ctx, req, actor, {
			action: "admin.update_settings",
			targetType: "platform_settings",
			targetId: "platform",
			detail: { ...updated },
		});
		return c.json({ settings: updated });
	});

	app.patch("/api/admin/users/:userId", requireSuperAdminMiddleware, async (c) => {
		const ctx = c.var.routeCtx;
		const { store, revokeTokenSessions } = ctx;
		const req = c.var.nodeReq!;
		const actor = c.var.actor;
		const userId = c.req.param("userId");
		const existing = store.getUserById(userId);
		if (!existing) {
			throw new HttpRequestError(404, `User not found: ${userId}`);
		}
		const body = await parseJsonBody(c);
		let platformRole: PlatformRole | undefined;
		if (body.platformRole !== undefined) {
			if (body.platformRole !== "super_admin" && body.platformRole !== "user") {
				throw new HttpRequestError(400, "platformRole 必须是 super_admin 或 user");
			}
			platformRole = body.platformRole;
		}
		let status: UserStatus | undefined;
		if (body.status !== undefined) {
			if (body.status !== "active" && body.status !== "pending_review" && body.status !== "disabled") {
				throw new HttpRequestError(400, "status 必须是 active、pending_review 或 disabled");
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
			throw new HttpRequestError(400, err instanceof Error ? err.message : String(err));
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
		return c.json({ user: toPublicUser(updated) });
	});

	app.get("/api/admin/audit", requireSuperAdminMiddleware, (c) => {
		const { store } = c.var.routeCtx;
		return c.json({ auditLogs: store.listAuditLogs({ limit: 200 }) });
	});

	app.post("/api/admin/matters/:matterId/abort", requireSuperAdminMiddleware, async (c) => {
		const ctx = c.var.routeCtx;
		const { store, orchestrator, dialogBroker, broadcast } = ctx;
		const req = c.var.nodeReq!;
		const actor = c.var.actor;
		const matterId = c.req.param("matterId");
		if (!store.getMatter(matterId)) {
			throw new HttpRequestError(404, `Matter not found: ${matterId}`);
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
		return c.json({ ok: true, aborted });
	});
}
