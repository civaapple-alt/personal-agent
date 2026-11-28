import type { Hono } from "hono";
import type { WorkspaceVisibility } from "../../storage/types.ts";
import {
	canAccessMatter,
	canAccessOrganization,
	canManageOrganization,
	isGlobalUnscopedActor,
	requireOrgAdmin,
	validateLocalWorkspaceBindingPath,
} from "../acl.ts";
import { isSuperAdminActor, requireActiveActor, requireOwner, requireSuperAdmin } from "../auth.ts";
import { cloneGitWorkspaceIntoOrgRoot, resolveOrgWorkspacesDir } from "../git-clone.ts";
import { HttpRequestError } from "../http.ts";
import { type ApiRouterEnv, parseJsonBody } from "../router.ts";
import { auditActorAction, formatWorkspaceForActor, type ServerRouteContext } from "./context.ts";

function workspaceHasActiveTurn(ctx: ServerRouteContext, workspaceId: string): boolean {
	return ctx.store
		.listMatters()
		.some((matter) => matter.workspaceId === workspaceId && ctx.orchestrator.isMatterRunning(matter.id));
}

function parseUserIdList(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	return raw.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((s) => s.trim());
}

/** Register routes for self-serve organizations, cloned/local workspaces, and preview services. */
export function registerDeliverableOrgPreviewRoutes(app: Hono<ApiRouterEnv>): void {
	app.get("/api/organizations", (c) => {
		const { store } = c.var.routeCtx;
		const actor = c.var.actor;
		const res = c.var.nodeRes!;
		if (!requireActiveActor(res, actor)) return c.body(null);
		const orgs = store.listOrganizations().filter((org) => canAccessOrganization(store, actor, org.id));
		return c.json({ organizations: orgs });
	});

	app.post("/api/organizations", async (c) => {
		const ctx = c.var.routeCtx;
		const { store, broadcast } = ctx;
		const actor = c.var.actor;
		const req = c.var.nodeReq!;
		const res = c.var.nodeRes!;
		if (!requireActiveActor(res, actor)) return c.body(null);
		const body = await parseJsonBody(c);
		const name = typeof body.name === "string" ? body.name.trim() : "";
		if (!name) {
			throw new HttpRequestError(400, "name is required");
		}
		if (actor.authKind === "session" && actor.user && !isSuperAdminActor(actor)) {
			const owned = store.countOwnedOrganizations(actor.user.id);
			if (owned >= actor.user.maxOrgs) {
				throw new HttpRequestError(
					403,
					`当前账号最多可创建 ${actor.user.maxOrgs} 个组织，如需扩容请联系超级管理员`,
				);
			}
		}
		const settings = store.getPlatformSettings(ctx.defaultWorkspacesRoot);
		const isDefaultFlag =
			isSuperAdminActor(actor) && typeof body.isDefault === "boolean" ? body.isDefault : undefined;
		const organization = store.upsertOrganization({
			id: typeof body.id === "string" && body.id.trim() ? body.id.trim() : undefined,
			name,
			gitEmailDomain: typeof body.gitEmailDomain === "string" ? body.gitEmailDomain : "",
			useRoleGitIdentity: typeof body.useRoleGitIdentity === "boolean" ? body.useRoleGitIdentity : false,
			description: typeof body.description === "string" ? body.description : "",
			isDefault: isDefaultFlag,
			createdByUserId: actor.user?.id ?? null,
		});
		const workspacesDir = resolveOrgWorkspacesDir(settings.workspacesRoot, organization);
		const orgWithDir = store.upsertOrganization({
			id: organization.id,
			name: organization.name,
			slug: organization.slug,
			gitEmailDomain: organization.gitEmailDomain,
			useRoleGitIdentity: organization.useRoleGitIdentity,
			description: organization.description,
			isDefault: organization.isDefault,
			workspacesDir,
		});
		if (actor.user) {
			store.upsertOrgMember({
				orgId: orgWithDir.id,
				userId: actor.user.id,
				orgRole: "org_owner",
				roleTitle: "组织所有者",
			});
		}
		if (Array.isArray(body.aiMemberIds)) {
			const enabledSet = new Set(parseUserIdList(body.aiMemberIds));
			const allMembers = store
				.listMembers()
				.filter((m) => m.roleScope === "global" || (m.roleScope === "org" && m.ownerOrgId === orgWithDir.id));
			const primaryId =
				typeof body.primaryAiMemberId === "string" && enabledSet.has(body.primaryAiMemberId)
					? body.primaryAiMemberId
					: null;
			const configs = allMembers.map((m) => ({
				memberId: m.id,
				enabled: enabledSet.has(m.id),
				isPrimaryContact: primaryId ? m.id === primaryId : Boolean(m.isPrimaryContact && enabledSet.has(m.id)),
			}));
			if (configs.some((cfg) => cfg.enabled)) {
				store.setOrgAiRolesBatch(orgWithDir.id, configs);
			}
		}
		auditActorAction(ctx, req, actor, {
			action: "org.create",
			targetType: "organization",
			targetId: orgWithDir.id,
			orgId: orgWithDir.id,
			detail: { name: orgWithDir.name },
		});
		broadcast("organization_updated", { organization: orgWithDir }, { orgId: orgWithDir.id });
		return c.json({ organization: orgWithDir }, 201);
	});

	app.post("/api/organizations/:orgId/default", (c) => {
		const { store, broadcast } = c.var.routeCtx;
		const actor = c.var.actor;
		const res = c.var.nodeRes!;
		if (!requireOwner(res, actor)) return c.body(null);
		const orgId = c.req.param("orgId");
		if (!store.getOrganization(orgId)) {
			throw new HttpRequestError(404, `Organization not found: ${orgId}`);
		}
		const organization = store.setDefaultOrganization(orgId);
		broadcast("organization_updated", { organization }, { orgId: organization.id });
		return c.json({ organization });
	});

	app.patch("/api/organizations/:orgId", async (c) => {
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
		const isDefaultUpdate =
			typeof body.isDefault === "boolean" && isSuperAdminActor(actor) ? body.isDefault : undefined;
		const organization = store.updateOrganization(orgId, {
			name: typeof body.name === "string" ? body.name : undefined,
			gitEmailDomain: typeof body.gitEmailDomain === "string" ? body.gitEmailDomain : undefined,
			useRoleGitIdentity: typeof body.useRoleGitIdentity === "boolean" ? body.useRoleGitIdentity : undefined,
			description: typeof body.description === "string" ? body.description : undefined,
			isDefault: isDefaultUpdate,
		});
		auditActorAction(ctx, req, actor, {
			action: "org.update",
			targetType: "organization",
			targetId: orgId,
			orgId,
		});
		broadcast("organization_updated", { organization }, { orgId });
		return c.json({ organization });
	});

	app.post("/api/workspaces", async (c) => {
		const ctx = c.var.routeCtx;
		const { store, broadcast } = ctx;
		const actor = c.var.actor;
		const req = c.var.nodeReq!;
		const res = c.var.nodeRes!;
		if (!requireActiveActor(res, actor)) return c.body(null);
		const body = await parseJsonBody(c);
		const name = typeof body.name === "string" ? body.name.trim() : "";
		const rawCloneUrl = typeof body.cloneUrl === "string" ? body.cloneUrl.trim() : "";
		const rawRepoPath = typeof body.repoPath === "string" ? body.repoPath.trim() : "";
		const requestedSourceType =
			body.sourceType === "clone" || body.sourceType === "cloned" || rawCloneUrl ? "clone" : "local";
		if (!name) {
			throw new HttpRequestError(400, "项目名称不能为空");
		}
		if (requestedSourceType === "local" && !rawRepoPath) {
			throw new HttpRequestError(400, "name and repoPath are required");
		}
		let orgId: string | null | undefined =
			body.orgId === null
				? null
				: typeof body.orgId === "string" && body.orgId.trim()
					? body.orgId.trim()
					: undefined;
		if (orgId && !store.getOrganization(orgId)) {
			throw new HttpRequestError(404, `Organization not found: ${orgId}`);
		}
		if (orgId === undefined) {
			if (actor.authKind === "session" && actor.user && !isSuperAdminActor(actor)) {
				const userOrgs = store.listUserOrganizations(actor.user.id);
				orgId = userOrgs.find((o) => o.orgRole === "org_owner" || o.orgRole === "org_admin")?.id ?? null;
			} else {
				const fallbackOrg = store.getDefaultOrganization() ?? store.ensureDefaultOrganization();
				orgId = fallbackOrg.id;
			}
		}
		if (orgId === null) {
			if (!isSuperAdminActor(actor)) {
				throw new HttpRequestError(403, "非超级管理员必须将项目绑定到有管理权限的组织");
			}
		} else if (!canManageOrganization(store, actor, orgId)) {
			throw new HttpRequestError(403, "仅组织所有者或管理员可在该组织内登记或克隆项目");
		}

		const settings = store.getPlatformSettings(ctx.defaultWorkspacesRoot);
		const targetOrg = orgId ? store.getOrganization(orgId) : null;
		const visibility: WorkspaceVisibility = body.visibility === "restricted" ? "restricted" : "org";
		const allowedUserIds = parseUserIdList(body.allowedUserIds);
		if (visibility === "restricted" && actor.user && !allowedUserIds.includes(actor.user.id)) {
			allowedUserIds.push(actor.user.id);
		}

		let resolvedRepoPath = rawRepoPath;
		let defaultBranch =
			typeof body.defaultBranch === "string" && body.defaultBranch.trim() ? body.defaultBranch.trim() : "main";
		let sourceType: "local" | "cloned" = "local";
		let cloneUrl: string | null = null;

		if (requestedSourceType === "clone") {
			if (!targetOrg) {
				throw new HttpRequestError(400, "从 Git 地址克隆仓库前必须选定目标组织");
			}
			const cloned = await cloneGitWorkspaceIntoOrgRoot({
				workspacesRoot: settings.workspacesRoot,
				org: targetOrg,
				name,
				cloneUrl: rawCloneUrl,
				branch: typeof body.defaultBranch === "string" ? body.defaultBranch : undefined,
			});
			resolvedRepoPath = cloned.repoPath;
			defaultBranch = cloned.detectedBranch;
			sourceType = "cloned";
			cloneUrl = rawCloneUrl;
		} else if (!isGlobalUnscopedActor(actor)) {
			try {
				resolvedRepoPath = validateLocalWorkspaceBindingPath({
					rawPath: rawRepoPath,
					settings,
					actor,
					dataDir: ctx.dataDir,
				});
			} catch (err) {
				throw new HttpRequestError(403, err instanceof Error ? err.message : String(err));
			}
		}

		const existingWorkspace = store.listWorkspaces().find((ws) => ws.repoPath === resolvedRepoPath);
		if (existingWorkspace) {
			if (!canManageOrganization(store, actor, existingWorkspace.orgId) && !isSuperAdminActor(actor)) {
				throw new HttpRequestError(403, "无权覆盖已登记的项目仓库");
			}
			if (existingWorkspace.orgId !== orgId && workspaceHasActiveTurn(ctx, existingWorkspace.id)) {
				throw new HttpRequestError(409, "Stop active workspace turns before changing its organization");
			}
		}
		const savedWs = store.upsertWorkspace({
			orgId,
			name,
			repoPath: resolvedRepoPath,
			defaultBranch,
			description: typeof body.description === "string" ? body.description : "",
			sourceType,
			cloneUrl,
			visibility,
			allowedUserIds,
		});
		const ws = formatWorkspaceForActor(store, savedWs, actor);
		auditActorAction(ctx, req, actor, {
			action: sourceType === "cloned" ? "workspace.clone" : "workspace.create_local",
			targetType: "workspace",
			targetId: ws.id,
			orgId: ws.orgId,
			detail: { name: ws.name, sourceType, visibility },
		});
		broadcast("workspace_updated", { id: ws.id, orgId: ws.orgId }, { workspaceId: ws.id });
		return c.json({ workspace: ws }, 201);
	});

	app.patch("/api/workspaces/:workspaceId", async (c) => {
		const ctx = c.var.routeCtx;
		const { store, broadcast } = ctx;
		const actor = c.var.actor;
		const req = c.var.nodeReq!;
		const res = c.var.nodeRes!;
		const workspaceId = c.req.param("workspaceId");
		const body = await parseJsonBody(c);
		const existingWs = store.getWorkspace(workspaceId);
		if (!existingWs) {
			throw new HttpRequestError(404, `Workspace not found: ${workspaceId}`);
		}
		if (!requireOrgAdmin(res, store, actor, existingWs.orgId)) return c.body(null);
		const orgId =
			body.orgId === null
				? null
				: typeof body.orgId === "string" && body.orgId.trim()
					? body.orgId.trim()
					: undefined;
		if (orgId && !store.getOrganization(orgId)) {
			throw new HttpRequestError(404, `Organization not found: ${orgId}`);
		}
		if (orgId === null && !isSuperAdminActor(actor)) {
			throw new HttpRequestError(403, "非超级管理员不能将项目设为无组织状态");
		}
		if (orgId !== undefined && orgId !== null && !canManageOrganization(store, actor, orgId)) {
			throw new HttpRequestError(403, "无权把项目移入未管理的组织");
		}
		if (orgId !== undefined && orgId !== existingWs.orgId && workspaceHasActiveTurn(ctx, workspaceId)) {
			throw new HttpRequestError(409, "Stop active workspace turns before changing its organization");
		}
		const nextVisibility: WorkspaceVisibility | undefined =
			body.visibility === "restricted" ? "restricted" : body.visibility === "org" ? "org" : undefined;
		const updated = store.updateWorkspace(workspaceId, {
			orgId,
			name: typeof body.name === "string" ? body.name : undefined,
			defaultBranch: typeof body.defaultBranch === "string" ? body.defaultBranch : undefined,
			description: typeof body.description === "string" ? body.description : undefined,
			visibility: nextVisibility,
			allowedUserIds: Array.isArray(body.allowedUserIds) ? parseUserIdList(body.allowedUserIds) : undefined,
		});
		const ws = formatWorkspaceForActor(store, updated, actor);
		auditActorAction(ctx, req, actor, {
			action: "workspace.update",
			targetType: "workspace",
			targetId: ws.id,
			orgId: ws.orgId,
			detail: { visibility: ws.visibility ?? "org" },
		});
		broadcast("workspace_updated", { id: ws.id, orgId: ws.orgId }, { workspaceId: ws.id });
		return c.json({ workspace: ws });
	});

	app.get("/api/previews", (c) => {
		const { store, previewManager } = c.var.routeCtx;
		const actor = c.var.actor;
		const res = c.var.nodeRes!;
		if (!requireActiveActor(res, actor)) return c.body(null);
		const isAdmin = isSuperAdminActor(actor);
		const previews = previewManager.listPreviews().filter((preview) => {
			if (!preview.matterId) return isAdmin;
			const matter = store.getMatter(preview.matterId);
			return matter ? canAccessMatter(store, actor, matter) : isAdmin;
		});
		return c.json({ previews });
	});

	app.post("/api/previews", async (c) => {
		const ctx = c.var.routeCtx;
		const { store, previewManager, broadcast } = ctx;
		const actor = c.var.actor;
		const req = c.var.nodeReq!;
		const res = c.var.nodeRes!;
		if (!requireActiveActor(res, actor)) return c.body(null);
		const body = await parseJsonBody(c);
		const title = typeof body.title === "string" ? body.title.trim() : "独立预览服务";
		const matterId = typeof body.matterId === "string" && body.matterId.trim() ? body.matterId.trim() : null;
		const matter = matterId ? store.getMatter(matterId) : null;
		if (matterId && !matter) {
			throw new HttpRequestError(404, `Matter not found: ${matterId}`);
		}

		if (typeof body.url === "string" && body.url.trim().length > 0) {
			if (!isSuperAdminActor(actor)) {
				if (
					!matter ||
					!canAccessMatter(store, actor, matter) ||
					!canManageOrganization(store, actor, matter.orgId)
				) {
					throw new HttpRequestError(403, "仅所有者（Owner）或对应组织管理员可登记预览链接");
				}
			}
			const info = previewManager.registerExternalPreview({
				title,
				url: body.url.trim(),
				matterId,
			});
			broadcast("preview_updated", info);
			return c.json({ preview: info }, 201);
		}

		if (!requireSuperAdmin(res, actor)) return c.body(null);
		const command = typeof body.command === "string" ? body.command.trim() : "";
		if (!command) {
			throw new HttpRequestError(400, "command or url is required");
		}
		const args = Array.isArray(body.args) ? body.args.map(String) : [];
		const cwd = typeof body.cwd === "string" && body.cwd.length > 0 ? body.cwd : process.cwd();
		const port = typeof body.port === "number" ? body.port : undefined;

		const info = await previewManager.startCommandPreview({
			title,
			command,
			args,
			cwd,
			port,
			matterId,
		});
		auditActorAction(ctx, req, actor, {
			action: "preview.start_command",
			targetType: "preview",
			targetId: info.id,
			detail: { title, command },
		});
		broadcast("preview_updated", info);
		return c.json({ preview: info }, 201);
	});

	app.post("/api/previews/:previewId/stop", async (c) => {
		const { store, previewManager, broadcast } = c.var.routeCtx;
		const actor = c.var.actor;
		const res = c.var.nodeRes!;
		if (!requireActiveActor(res, actor)) return c.body(null);
		const previewId = c.req.param("previewId");
		const existingPreview = previewManager.listPreviews().find((item) => item.id === previewId);
		if (!existingPreview) {
			throw new HttpRequestError(404, `Preview not found: ${previewId}`);
		}
		if (!(isGlobalUnscopedActor(actor) || isSuperAdminActor(actor))) {
			const linkedMatter = existingPreview.matterId ? store.getMatter(existingPreview.matterId) : null;
			if (
				!linkedMatter ||
				!canAccessMatter(store, actor, linkedMatter) ||
				!canManageOrganization(store, actor, linkedMatter.orgId)
			) {
				throw new HttpRequestError(403, "仅所有者或对应组织管理员可停止该预览服务");
			}
		}
		const info = await previewManager.stopPreview(previewId);
		if (!info) {
			throw new HttpRequestError(404, `Preview not found: ${previewId}`);
		}
		broadcast("preview_updated", info);
		return c.json({ preview: info });
	});
}
