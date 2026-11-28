import { JoinOrgSchema } from "@pa/contracts/schemas";
import type { Hono } from "hono";
import { buildRuntimeOverview } from "../../orchestrator/runtime/runtime-info.ts";
import { buildSessionInsightsReport, type SessionInsightSource } from "../../orchestrator/runtime/session-insights.ts";
import { isThinkingLevel } from "../../rpc/model-selection.ts";
import { toPublicUser } from "../../storage/repositories.ts";
import type { OrgMemberRole } from "../../storage/types.ts";
import {
	canAccessMatter,
	canAccessOrganization,
	canAccessWorkspace,
	canActorUseMember,
	canManageOrganization,
	getActorOrgRole,
	requireOrgAccess,
	requireOrgAdmin,
} from "../acl.ts";
import { isSuperAdminActor, requireActiveActor } from "../auth.ts";
import { HttpRequestError } from "../http.ts";
import { type ApiRouterEnv, parseJsonBody } from "../router.ts";
import { auditActorAction, formatWorkspaceForActor } from "./context.ts";
import { validateModelSelection } from "./model-settings.ts";

function parseOrgMemberRole(raw: unknown): OrgMemberRole | null {
	if (raw === "org_owner" || raw === "org_admin" || raw === "org_member" || raw === "org_viewer") {
		return raw;
	}
	return null;
}

/** Register `/api/bootstrap`, `/api/runtime`, and per-org member/invite/AI-role routes. */
export function registerBootstrapAndCollaboratorRoutes(app: Hono<ApiRouterEnv>): void {
	app.get("/api/bootstrap", (c) => {
		const ctx = c.var.routeCtx;
		const { store, orchestrator, dialogBroker, previewManager, activeRuns } = ctx;
		const actor = c.var.actor;
		const res = c.var.nodeRes!;
		if (!requireActiveActor(res, actor)) return c.body(null);
		const liveTemplates = orchestrator.listTemplates();
		const settings = store.getPlatformSettings(ctx.defaultWorkspacesRoot);
		const scopedOrgs = store
			.listOrganizations()
			.filter((org) => canAccessOrganization(store, actor, org.id))
			.map((org) => ({
				...org,
				orgRole: getActorOrgRole(store, actor, org.id) ?? "org_member",
			}));
		const scopedWorkspaces = store
			.listWorkspaces()
			.filter((ws) => canAccessWorkspace(store, actor, ws))
			.map((ws) => formatWorkspaceForActor(store, ws, actor));
		const scopedMatters = store.listMatters().filter((matter) => canAccessMatter(store, actor, matter));
		const allowedMatterIds = new Set(scopedMatters.map((m) => m.id));
		const scopedPendingDialogs = dialogBroker.listPending().filter((d) => allowedMatterIds.has(d.matterId));
		const scopedPreviews = previewManager
			.listPreviews()
			.filter((preview) => (preview.matterId ? allowedMatterIds.has(preview.matterId) : isSuperAdminActor(actor)));
		const scopedActiveRuns = Object.fromEntries(
			[...activeRuns.entries()]
				.filter(([matterId]) => allowedMatterIds.has(matterId))
				.map(([matterId, run]) => [matterId, { ...run.progress, matterId, startedAt: run.startedAt }]),
		);

		const orgMembersByOrgId: Record<string, ReturnType<typeof store.listOrgMembers>> = {};
		const orgAiRolesByOrgId: Record<
			string,
			{
				configured: boolean;
				configs: ReturnType<typeof store.listOrgAiRoleConfigs>;
				effectiveMemberIds: string[];
			}
		> = {};
		for (const org of scopedOrgs) {
			orgMembersByOrgId[org.id] = store.listOrgMembers(org.id);
			const configured = store.hasOrgAiRolesConfigured(org.id);
			const configs = store.listOrgAiRoleConfigs(org.id);
			const effectiveMembers = store.resolveEffectiveOrgMembers(org.id);
			orgAiRolesByOrgId[org.id] = {
				configured,
				configs,
				effectiveMemberIds: effectiveMembers.map((m) => m.id),
			};
		}

		const isAdmin = isSuperAdminActor(actor);
		const visibleMembers = store.listMembers().filter((m) => canActorUseMember(store, actor, m));
		const visibleTemplateIds = new Set(visibleMembers.map((m) => m.templateId));

		return c.json({
			unifiedConversation: true,
			authKind: actor.authKind,
			currentUser: actor.collaborator,
			accountUser: actor.user ? toPublicUser(actor.user) : null,
			platformPolicy: {
				requireAuth: Boolean(ctx.requireAuth),
				registrationMode: settings.registrationMode,
				allowLocalWorkspacePath: settings.allowLocalWorkspacePath || isAdmin,
				allowCommandPreviews: settings.allowCommandPreviews || isAdmin,
			},
			members: visibleMembers,
			templates: liveTemplates
				.filter((t) => t.roleKind === "architect" || visibleTemplateIds.has(t.id))
				.map((t) => ({
					id: t.id,
					name: t.name,
					title: t.title,
					roleKind: t.roleKind ?? (t.id === "role-architect" ? "architect" : "business"),
					roleScope: t.roleScope ?? "global",
					ownerOrgId: t.ownerOrgId ?? null,
					ownerUserId: t.ownerUserId ?? null,
					version: t.version,
					skills: t.skills,
					mcpDependencies: t.mcpDependencies,
					tools: t.tools,
					keywords: t.keywords,
					shareable: t.shareable,
					antiJobs: t.antiJobs ?? [],
					responsibilities: t.sections.responsibilitiesAndBoundaries,
				})),
			workspaces: scopedWorkspaces,
			organizations: scopedOrgs,
			orgMembersByOrgId,
			orgAiRolesByOrgId,
			matters: scopedMatters,
			pendingDialogs: scopedPendingDialogs,
			previews: scopedPreviews,
			activeRuns: scopedActiveRuns,
		});
	});

	app.get("/api/runtime", async (c) => {
		const ctx = c.var.routeCtx;
		const { store, orchestrator } = ctx;
		const actor = c.var.actor;
		const res = c.var.nodeRes!;
		if (!requireActiveActor(res, actor)) return c.body(null);
		const visibleMembers = store.listMembers().filter((m) => canActorUseMember(store, actor, m));
		const overview = await buildRuntimeOverview({
			config: orchestrator.getRuntimeConfig(),
			serverConfig: ctx.getServerRuntimeConfig?.(),
			activeMembers: visibleMembers,
			isOwner: isSuperAdminActor(actor),
			probePiCli: ctx.probePiCli,
		});
		return c.json(overview);
	});

	app.get("/api/runtime/insights", (c) => {
		const { store } = c.var.routeCtx;
		const actor = c.var.actor;
		const res = c.var.nodeRes!;
		if (!requireActiveActor(res, actor)) return c.body(null);
		const matterIdParam = c.req.query("matterId")?.trim() || undefined;
		const memberIdParam = c.req.query("memberId")?.trim() || undefined;
		const limitParam = Number(c.req.query("limit") ?? "40");
		const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(100, Math.floor(limitParam))) : 40;

		if (matterIdParam) {
			const matter = store.getMatter(matterIdParam);
			if (!matter) {
				throw new HttpRequestError(404, `Matter not found: ${matterIdParam}`);
			}
			if (!canAccessMatter(store, actor, matter)) {
				throw new HttpRequestError(403, "无权访问该事项");
			}
		}

		const membersById = new Map(store.listMembers().map((m) => [m.id, m.displayName]));
		const matterAccessCache = new Map<string, boolean>();
		const rawSessions = store.listWorkerSessions({
			matterId: matterIdParam,
			memberId: memberIdParam,
			limit: limit * 2,
		});
		const sources: SessionInsightSource[] = [];
		for (const session of rawSessions) {
			if (!session.sessionFile) continue;
			let allowed = matterAccessCache.get(session.matterId);
			if (allowed === undefined) {
				const matter = store.getMatter(session.matterId);
				allowed = matter ? canAccessMatter(store, actor, matter) : false;
				matterAccessCache.set(session.matterId, allowed);
			}
			if (!allowed) continue;
			sources.push({
				sessionFile: session.sessionFile,
				sessionId: session.piSessionId ?? session.id,
				matterId: session.matterId,
				memberId: session.memberId,
				memberName: membersById.get(session.memberId) ?? session.memberId,
				updatedAt: session.lastActiveAt,
			});
			if (sources.length >= limit) break;
		}
		const report = buildSessionInsightsReport(sources, {
			matterId: matterIdParam ?? null,
			memberId: memberIdParam ?? null,
		});
		return c.json(report);
	});

	// Register `/api/organizations/join` before parameterized `/api/organizations/:orgId/*` routes.
	app.post("/api/organizations/join", async (c) => {
		const ctx = c.var.routeCtx;
		const { store, broadcast } = ctx;
		const actor = c.var.actor;
		const req = c.var.nodeReq!;
		const res = c.var.nodeRes!;
		if (!requireActiveActor(res, actor)) return c.body(null);
		if (!actor.user) {
			throw new HttpRequestError(400, "请先使用个人账号登录后再加入组织");
		}
		const { inviteToken } = await parseJsonBody(c, JoinOrgSchema);
		let result: ReturnType<typeof store.consumeOrgInviteByToken>;
		try {
			result = store.consumeOrgInviteByToken(inviteToken, actor.user.id);
		} catch (err) {
			throw new HttpRequestError(400, err instanceof Error ? err.message : String(err));
		}
		const org = store.getOrganization(result.invite.orgId);
		auditActorAction(ctx, req, actor, {
			action: "org.join_invite",
			targetType: "organization",
			targetId: result.invite.orgId,
			orgId: result.invite.orgId,
			detail: { orgRole: result.membership.orgRole },
		});
		if (org) {
			broadcast("organization_updated", { organization: org }, { orgId: org.id });
		}
		return c.json({ ok: true, organization: org, membership: result.membership });
	});

	app.get("/api/organizations/:orgId/members", (c) => {
		const { store } = c.var.routeCtx;
		const actor = c.var.actor;
		const res = c.var.nodeRes!;
		const orgId = c.req.param("orgId");
		if (!store.getOrganization(orgId)) {
			throw new HttpRequestError(404, `Organization not found: ${orgId}`);
		}
		if (!requireOrgAccess(res, store, actor, orgId)) return c.body(null);
		const canAdminOrg = canManageOrganization(store, actor, orgId);
		return c.json({
			members: store.listOrgMembers(orgId),
			invites: canAdminOrg ? store.listOrgInvites(orgId) : [],
		});
	});

	app.post("/api/organizations/:orgId/members", async (c) => {
		const ctx = c.var.routeCtx;
		const { store, broadcast } = ctx;
		const actor = c.var.actor;
		const req = c.var.nodeReq!;
		const res = c.var.nodeRes!;
		const orgId = c.req.param("orgId");
		if (!store.getOrganization(orgId)) {
			throw new HttpRequestError(404, `Organization not found: ${orgId}`);
		}
		if (!requireOrgAdmin(res, store, actor, orgId)) return c.body(null);
		const body = await parseJsonBody(c);
		const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
		const userId = typeof body.userId === "string" ? body.userId.trim() : "";
		const targetUser = email ? store.getUserByEmail(email) : userId ? store.getUserById(userId) : null;
		if (!targetUser) {
			throw new HttpRequestError(404, "未找到该注册账号，请确认对方已完成邮箱注册或改用组织邀请链接");
		}
		if (targetUser.status === "disabled") {
			throw new HttpRequestError(400, "该用户账号已被停用");
		}
		const orgRole = parseOrgMemberRole(body.orgRole) ?? "org_member";
		const actorRole = getActorOrgRole(store, actor, orgId);
		if (orgRole === "org_owner" && actorRole !== "org_owner" && !isSuperAdminActor(actor)) {
			throw new HttpRequestError(403, "仅组织所有者或超级管理员可授予 org_owner 角色");
		}
		const membership = store.upsertOrgMember({
			orgId,
			userId: targetUser.id,
			orgRole,
			roleTitle: typeof body.roleTitle === "string" ? body.roleTitle : undefined,
		});
		auditActorAction(ctx, req, actor, {
			action: "org.add_member",
			targetType: "user",
			targetId: targetUser.id,
			orgId,
			detail: { orgRole, email: targetUser.email },
		});
		const org = store.getOrganization(orgId)!;
		broadcast("organization_updated", { organization: org }, { orgId });
		return c.json({ member: membership }, 201);
	});

	app.patch("/api/organizations/:orgId/members/:targetUserId", async (c) => {
		const ctx = c.var.routeCtx;
		const { store, broadcast } = ctx;
		const actor = c.var.actor;
		const req = c.var.nodeReq!;
		const res = c.var.nodeRes!;
		const orgId = c.req.param("orgId");
		const targetUserId = c.req.param("targetUserId");
		if (!store.getOrganization(orgId)) {
			throw new HttpRequestError(404, `Organization not found: ${orgId}`);
		}
		if (!requireOrgAdmin(res, store, actor, orgId)) return c.body(null);
		const existing = store.getOrgMembership(orgId, targetUserId);
		if (!existing) {
			throw new HttpRequestError(404, "成员不属于当前组织");
		}
		const body = await parseJsonBody(c);
		const nextRole = body.orgRole !== undefined ? parseOrgMemberRole(body.orgRole) : existing.orgRole;
		if (!nextRole) {
			throw new HttpRequestError(400, "无效的 orgRole");
		}
		const actorRole = getActorOrgRole(store, actor, orgId);
		if (
			(existing.orgRole === "org_owner" || nextRole === "org_owner") &&
			actorRole !== "org_owner" &&
			!isSuperAdminActor(actor)
		) {
			throw new HttpRequestError(403, "仅组织所有者或超级管理员可变更 org_owner 权限");
		}
		const updated = store.upsertOrgMember({
			orgId,
			userId: targetUserId,
			orgRole: nextRole,
			roleTitle: typeof body.roleTitle === "string" ? body.roleTitle : existing.roleTitle,
		});
		auditActorAction(ctx, req, actor, {
			action: "org.update_member",
			targetType: "user",
			targetId: targetUserId,
			orgId,
			detail: { orgRole: updated.orgRole },
		});
		broadcast("organization_updated", { organization: store.getOrganization(orgId)! }, { orgId });
		return c.json({ member: updated });
	});

	app.delete("/api/organizations/:orgId/members/:targetUserId", (c) => {
		const ctx = c.var.routeCtx;
		const { store, broadcast } = ctx;
		const actor = c.var.actor;
		const req = c.var.nodeReq!;
		const res = c.var.nodeRes!;
		const orgId = c.req.param("orgId");
		const targetUserId = c.req.param("targetUserId");
		if (!store.getOrganization(orgId)) {
			throw new HttpRequestError(404, `Organization not found: ${orgId}`);
		}
		if (!requireActiveActor(res, actor)) return c.body(null);
		const isSelf = actor.user?.id === targetUserId;
		if (!isSelf && !canManageOrganization(store, actor, orgId)) {
			throw new HttpRequestError(403, "无权移出组织成员");
		}
		const existing = store.getOrgMembership(orgId, targetUserId);
		if (!existing) {
			throw new HttpRequestError(404, "成员不属于当前组织");
		}
		const actorRole = getActorOrgRole(store, actor, orgId);
		if (!isSelf && existing.orgRole === "org_owner" && actorRole !== "org_owner" && !isSuperAdminActor(actor)) {
			throw new HttpRequestError(403, "仅组织所有者或超级管理员可移出组织所有者");
		}
		store.removeOrgMember(orgId, targetUserId);
		auditActorAction(ctx, req, actor, {
			action: "org.remove_member",
			targetType: "user",
			targetId: targetUserId,
			orgId,
		});
		broadcast("organization_updated", { organization: store.getOrganization(orgId)! }, { orgId });
		return c.json({ ok: true, removedUserId: targetUserId });
	});

	app.get("/api/organizations/:orgId/invites", (c) => {
		const { store } = c.var.routeCtx;
		const actor = c.var.actor;
		const res = c.var.nodeRes!;
		const orgId = c.req.param("orgId");
		if (!store.getOrganization(orgId)) {
			throw new HttpRequestError(404, `Organization not found: ${orgId}`);
		}
		if (!requireOrgAdmin(res, store, actor, orgId)) return c.body(null);
		return c.json({ invites: store.listOrgInvites(orgId) });
	});

	app.post("/api/organizations/:orgId/invites", async (c) => {
		const ctx = c.var.routeCtx;
		const { store } = ctx;
		const actor = c.var.actor;
		const req = c.var.nodeReq!;
		const res = c.var.nodeRes!;
		const orgId = c.req.param("orgId");
		if (!store.getOrganization(orgId)) {
			throw new HttpRequestError(404, `Organization not found: ${orgId}`);
		}
		if (!requireOrgAdmin(res, store, actor, orgId)) return c.body(null);
		const body = await parseJsonBody(c);
		const orgRole = parseOrgMemberRole(body.orgRole) ?? "org_member";
		const actorRole = getActorOrgRole(store, actor, orgId);
		if (orgRole === "org_owner" && actorRole !== "org_owner" && !isSuperAdminActor(actor)) {
			throw new HttpRequestError(403, "仅组织所有者或超级管理员可生成 org_owner 邀请");
		}
		const { rawToken, invite } = store.createOrgInvite({
			orgId,
			orgRole,
			createdByUserId: actor.user?.id ?? actor.collaborator.id,
			maxUses: typeof body.maxUses === "number" ? body.maxUses : 20,
			expiresInHours: typeof body.expiresInHours === "number" ? body.expiresInHours : 168,
		});
		auditActorAction(ctx, req, actor, {
			action: "org.create_invite",
			targetType: "org_invite",
			targetId: invite.id,
			orgId,
			detail: { orgRole, maxUses: invite.maxUses },
		});
		return c.json({ invite, rawToken }, 201);
	});

	app.post("/api/organizations/:orgId/invites/:inviteId/revoke", (c) => {
		const ctx = c.var.routeCtx;
		const { store } = ctx;
		const actor = c.var.actor;
		const req = c.var.nodeReq!;
		const res = c.var.nodeRes!;
		const orgId = c.req.param("orgId");
		const inviteId = c.req.param("inviteId");
		if (!requireOrgAdmin(res, store, actor, orgId)) return c.body(null);
		const revoked = store.revokeOrgInvite(orgId, inviteId);
		if (!revoked) {
			throw new HttpRequestError(404, "邀请链接不存在或已失效");
		}
		auditActorAction(ctx, req, actor, {
			action: "org.revoke_invite",
			targetType: "org_invite",
			targetId: inviteId,
			orgId,
		});
		return c.json({ ok: true, inviteId });
	});

	app.get("/api/organizations/:orgId/ai-roles", (c) => {
		const { store } = c.var.routeCtx;
		const actor = c.var.actor;
		const res = c.var.nodeRes!;
		const orgId = c.req.param("orgId");
		if (!store.getOrganization(orgId)) {
			throw new HttpRequestError(404, `Organization not found: ${orgId}`);
		}
		if (!requireOrgAccess(res, store, actor, orgId)) return c.body(null);
		return c.json({
			configured: store.hasOrgAiRolesConfigured(orgId),
			configs: store.listOrgAiRoleConfigs(orgId),
			effectiveMembers: store.resolveEffectiveOrgMembers(orgId),
		});
	});

	app.patch("/api/organizations/:orgId/ai-roles", async (c) => {
		const ctx = c.var.routeCtx;
		const { store, broadcast } = ctx;
		const actor = c.var.actor;
		const req = c.var.nodeReq!;
		const res = c.var.nodeRes!;
		const orgId = c.req.param("orgId");
		if (!store.getOrganization(orgId)) {
			throw new HttpRequestError(404, `Organization not found: ${orgId}`);
		}
		if (!requireOrgAdmin(res, store, actor, orgId)) return c.body(null);
		const body = await parseJsonBody(c);
		const memberId = typeof body.primaryMemberId === "string" ? body.primaryMemberId.trim() : "";
		if (!memberId || !store.setOrgAiPrimaryContact(orgId, memberId)) {
			throw new HttpRequestError(400, "请选择本组织已启用的业务 AI 角色");
		}
		auditActorAction(ctx, req, actor, {
			action: "org.update_ai_primary",
			targetType: "organization",
			targetId: orgId,
			orgId,
			detail: { memberId },
		});
		broadcast("team_updated", { orgId }, { orgId });
		return c.json({ primaryMemberId: memberId });
	});

	app.put("/api/organizations/:orgId/ai-roles", async (c) => {
		const ctx = c.var.routeCtx;
		const { store, broadcast } = ctx;
		const actor = c.var.actor;
		const req = c.var.nodeReq!;
		const res = c.var.nodeRes!;
		const orgId = c.req.param("orgId");
		if (!store.getOrganization(orgId)) {
			throw new HttpRequestError(404, `Organization not found: ${orgId}`);
		}
		if (!requireOrgAdmin(res, store, actor, orgId)) return c.body(null);
		const body = await parseJsonBody(c);
		if (
			!Array.isArray(body.roles) ||
			body.roles.some((item) => !item || typeof item !== "object" || typeof item.enabled !== "boolean")
		) {
			throw new HttpRequestError(400, "roles 必须是包含启用状态的角色配置数组");
		}
		const parsedRoles = await Promise.all(
			body.roles
				.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
				.map(async (item) => {
					const selection = Object.hasOwn(item, "modelSelection")
						? await validateModelSelection(ctx, item.modelSelection)
						: undefined;
					return {
						memberId: typeof item.memberId === "string" ? item.memberId.trim() : "",
						enabled: Boolean(item.enabled),
						isPrimaryContact: Boolean(item.isPrimaryContact),
						displayNameOverride:
							typeof item.displayNameOverride === "string" ? item.displayNameOverride.trim() || null : null,
						providerOverride:
							selection !== undefined
								? (selection?.provider ?? null)
								: typeof item.providerOverride === "string"
									? item.providerOverride.trim() || null
									: null,
						modelOverride:
							selection !== undefined
								? (selection?.model ?? null)
								: typeof item.modelOverride === "string"
									? item.modelOverride.trim() || null
									: null,
						thinkingLevelOverride:
							selection !== undefined
								? (selection?.thinkingLevel ?? null)
								: isThinkingLevel(item.thinkingLevelOverride)
									? item.thinkingLevelOverride
									: null,
						gitNameOverride:
							typeof item.gitNameOverride === "string" ? item.gitNameOverride.trim() || null : null,
						gitEmailOverride:
							typeof item.gitEmailOverride === "string" ? item.gitEmailOverride.trim() || null : null,
					};
				}),
		);
		if (new Set(parsedRoles.map((role) => role.memberId)).size !== parsedRoles.length) {
			throw new HttpRequestError(400, "每个角色只能配置一次");
		}
		if (!parsedRoles.some((role) => role.enabled)) {
			throw new HttpRequestError(400, "每个组织至少需要启用 1 位 AI 角色");
		}
		for (const role of parsedRoles) {
			const target = store.getMember(role.memberId);
			if (!target) {
				throw new HttpRequestError(400, "角色配置包含不存在的成员");
			}
			if (target.roleScope === "personal") {
				throw new HttpRequestError(400, "个人私有 AI 角色不能加入组织共享角色配置");
			}
			if (target.roleScope === "org" && target.ownerOrgId !== orgId) {
				throw new HttpRequestError(403, `角色 ${target.displayName} 属于其他组织，无法在本组织启用`);
			}
		}
		const useRoleGitIdentity = typeof body.useRoleGitIdentity === "boolean" ? body.useRoleGitIdentity : undefined;
		const configs = store.setOrgAiRolesBatch(orgId, parsedRoles, useRoleGitIdentity);
		const updatedOrganization = useRoleGitIdentity === undefined ? null : store.getOrganization(orgId);
		const effectiveMembers = store.resolveEffectiveOrgMembers(orgId);
		auditActorAction(ctx, req, actor, {
			action: "org.update_ai_roles",
			targetType: "organization",
			targetId: orgId,
			orgId,
			detail: {
				enabledMemberIds: effectiveMembers.map((m) => m.id),
				...(typeof body.useRoleGitIdentity === "boolean" ? { useRoleGitIdentity: body.useRoleGitIdentity } : {}),
			},
		});
		if (updatedOrganization) {
			broadcast("organization_updated", { organization: updatedOrganization }, { orgId });
		}
		broadcast("team_updated", { orgId }, { orgId });
		return c.json({
			...(updatedOrganization ? { organization: updatedOrganization } : {}),
			configs,
			effectiveMembers,
		});
	});
}
