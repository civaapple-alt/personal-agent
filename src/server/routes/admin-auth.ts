import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { createSystemOneClassifier } from "../../orchestrator/system-one.ts";
import { readDotEnvMap, resolveEnvFilePath } from "../../pa-extensions/env-credentials.ts";
import { toPublicUser } from "../../storage/repositories.ts";
import type { PlatformRole, RegistrationMode, UserStatus } from "../../storage/types.ts";
import { canAccessOrganization, canAccessWorkspace } from "../acl.ts";
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
import { handleWebAccessRoutes } from "./web-access.ts";

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
			currentUser: actor ? actor.collaborator : null,
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
		const inviteToken = typeof body.inviteToken === "string" ? body.inviteToken.trim() : "";
		const rateKey = `login:${ip}:${email}`;
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
		authRateLimiter.recordFailure(rateKey);
		sendError(res, 400, "请填写邮箱与密码");
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

	if (method === "GET" && pathname === "/api/auth/tokens") {
		if (!requireActiveActor(res, actor)) return true;
		if (!actor.user) {
			sendError(res, 400, "当前身份不支持管理访问令牌");
			return true;
		}
		sendJson(res, 200, { tokens: store.listUserAccessTokens(actor.user.id) });
		return true;
	}

	if (method === "POST" && pathname === "/api/auth/tokens") {
		if (!requireActiveActor(res, actor)) return true;
		if (!actor.user) {
			sendError(res, 400, "当前身份不支持创建访问令牌");
			return true;
		}
		if (actor.accessTokenId) {
			sendError(res, 403, "不能使用访问令牌再创建新的访问令牌，请在网页会话中操作");
			return true;
		}
		const body = await readJsonBody(req);
		const name = typeof body.name === "string" ? body.name.trim() : "";
		if (!name) {
			sendError(res, 400, "请填写访问令牌名称");
			return true;
		}
		const scope = body.scope === "full" ? "full" : "read";
		const expiresInDays =
			body.expiresInDays === null || body.expiresInDays === undefined || body.expiresInDays === ""
				? null
				: Number(body.expiresInDays);
		if (expiresInDays !== null && (!Number.isFinite(expiresInDays) || expiresInDays < 0 || expiresInDays > 3650)) {
			sendError(res, 400, "有效天数需为 1–3650 或留空（永不过期）");
			return true;
		}
		let allowedOrgIds: string[] | null = null;
		if (body.allowedOrgIds !== undefined && body.allowedOrgIds !== null) {
			if (!Array.isArray(body.allowedOrgIds)) {
				sendError(res, 400, "allowedOrgIds 必须为组织 ID 数组");
				return true;
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
					sendError(res, 403, `无权将组织 ${orgId} 加入访问令牌范围`);
					return true;
				}
			}
			allowedOrgIds = ids.length > 0 ? ids : null;
		}
		let allowedWorkspaceIds: string[] | null = null;
		if (body.allowedWorkspaceIds !== undefined && body.allowedWorkspaceIds !== null) {
			if (!Array.isArray(body.allowedWorkspaceIds)) {
				sendError(res, 400, "allowedWorkspaceIds 必须为工作区 ID 数组");
				return true;
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
					sendError(res, 403, `无权将工作区 ${workspaceId} 加入访问令牌范围`);
					return true;
				}
				if (allowedOrgIds && (!ws.orgId || !allowedOrgIds.includes(ws.orgId))) {
					sendError(res, 400, `所选工作区 ${ws.name} 不在已选组织范围内`);
					return true;
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
		sendJson(res, 201, created);
		return true;
	}

	const revokeTokenMatch = pathname.match(/^\/api\/auth\/tokens\/([^/]+)$/);
	if (method === "DELETE" && revokeTokenMatch) {
		if (!requireActiveActor(res, actor)) return true;
		if (!actor.user) {
			sendError(res, 400, "当前身份不支持吊销访问令牌");
			return true;
		}
		if (actor.accessTokenId) {
			sendError(res, 403, "不能使用访问令牌吊销访问令牌，请在网页会话中操作");
			return true;
		}
		const tokenId = decodeURIComponent(revokeTokenMatch[1]!);
		const revoked = store.revokeAccessToken(actor.user.id, tokenId);
		if (!revoked) {
			sendError(res, 404, "未找到该有效访问令牌");
			return true;
		}
		auditActorAction(ctx, req, actor, {
			action: "auth.token.revoke",
			targetType: "access_token",
			targetId: tokenId,
		});
		sendJson(res, 200, { ok: true, id: tokenId });
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
	if (await handleWebAccessRoutes(ctx, r, actor)) return true;

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

	return false;
}
