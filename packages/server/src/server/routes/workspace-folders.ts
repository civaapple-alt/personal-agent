import { readdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { UpdateWorkspaceFolderSchema, UpdateWorkspacePiTrustSchema } from "@pa/contracts/schemas";
import type { Hono } from "hono";
import {
	readPiProjectTrustState,
	writePiProjectTrustDecision,
} from "../../orchestrator/execution/execution-context.ts";
import { buildWorkspaceCustomizations } from "../../orchestrator/runtime/workspace-customizations.ts";
import {
	canAccessWorkspace,
	canManageOrganization,
	isGlobalUnscopedActor,
	validateLocalWorkspaceBindingPath,
} from "../acl.ts";
import { isSuperAdminActor, requireActiveActor } from "../auth.ts";
import { HttpRequestError } from "../http.ts";
import { type ApiRouterEnv, parseJsonBody } from "../router.ts";

/** Register multi-folder workspace attachment, customizations breakdown, and Pi trust routes. */
export function registerWorkspaceFolderRoutes(app: Hono<ApiRouterEnv>): void {
	app.get("/api/workspaces/directory-browser", async (c) => {
		const { store, dataDir, defaultWorkspacesRoot } = c.var.routeCtx;
		const actor = c.var.actor;
		const res = c.var.nodeRes!;
		if (!requireActiveActor(res, actor)) return c.body(null);
		const workspaceId = c.req.query("workspaceId");
		const orgId = c.req.query("orgId");
		if (workspaceId) {
			const workspace = store.getWorkspace(workspaceId);
			if (
				!workspace ||
				!canAccessWorkspace(store, actor, workspace) ||
				(!isSuperAdminActor(actor) && !canManageOrganization(store, actor, workspace.orgId))
			) {
				throw new HttpRequestError(403, "无权管理该工作区目录");
			}
		} else if (!isSuperAdminActor(actor) && (!orgId || !canManageOrganization(store, actor, orgId))) {
			throw new HttpRequestError(403, "仅组织管理员可浏览服务器目录");
		}
		const settings = store.getPlatformSettings(defaultWorkspacesRoot);
		const validate = (rawPath: string) => validateLocalWorkspaceBindingPath({ rawPath, settings, actor, dataDir });
		const requested = c.req.query("path")?.trim();
		try {
			if (requested && !isAbsolute(requested)) throw new Error("请输入服务器上的绝对路径");
			const candidates = requested
				? [requested]
				: !isSuperAdminActor(actor) && settings.localWorkspaceAllowlist.length > 0
					? settings.localWorkspaceAllowlist
					: [process.cwd()];
			let current: string | undefined;
			for (const candidate of candidates) {
				try {
					current = validate(candidate);
					break;
				} catch {
					/* Try the next permitted root. */
				}
			}
			if (!current) throw new Error("无法访问该目录，或目录不在允许范围内");
			const entries = await readdir(current, { withFileTypes: true });
			const roots: string[] = [];
			if (!isSuperAdminActor(actor)) {
				for (const candidate of settings.localWorkspaceAllowlist) {
					try {
						const root = validate(candidate);
						if (!roots.includes(root)) roots.push(root);
					} catch {
						/* Skip unavailable or forbidden roots. */
					}
				}
			}
			const directories: Array<{ name: string; path: string }> = [];
			for (const entry of entries) {
				if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
				try {
					directories.push({ name: entry.name, path: validate(join(current, entry.name)) });
				} catch {
					/* Exclude inaccessible paths. */
				}
			}
			directories.sort((a, b) => a.name.localeCompare(b.name));
			let parent: string | null = null;
			if (dirname(current) !== current) {
				try {
					parent = validate(dirname(current));
				} catch {
					/* The parent is outside the permitted scope. */
				}
			}
			return c.json({ path: current, parent, roots, directories });
		} catch (error) {
			throw new HttpRequestError(403, error instanceof Error ? error.message : "无法读取目录");
		}
	});

	app.get("/api/workspaces/:workspaceId/customizations", (c) => {
		const { store } = c.var.routeCtx;
		const actor = c.var.actor;
		const res = c.var.nodeRes!;
		if (!requireActiveActor(res, actor)) return c.body(null);
		const workspaceId = c.req.param("workspaceId");
		const workspace = store.getWorkspace(workspaceId);
		if (!workspace) {
			throw new HttpRequestError(404, "工作区不存在");
		}
		if (!canAccessWorkspace(store, actor, workspace)) {
			throw new HttpRequestError(403, "无权访问该工作区");
		}
		const folderIdFilter = c.req.query("folderId")?.trim() || null;
		const allFolders = store.workspaceFolders.listFolders(workspaceId);
		const scopedFolders = folderIdFilter ? allFolders.filter((f) => f.id === folderIdFilter) : allFolders;
		const report = buildWorkspaceCustomizations(scopedFolders);
		const canEditPiTrust = isGlobalUnscopedActor(actor) || isSuperAdminActor(actor);
		const piTrust =
			workspace.sourceType === "cloned"
				? {
						eligible: false,
						decision: null as boolean | null,
						matchedPath: null as string | null,
						effectiveTrusted: false,
						canEdit: false,
					}
				: (() => {
						const state = readPiProjectTrustState(workspace.repoPath);
						return {
							eligible: true,
							decision: state.decision,
							matchedPath: state.matchedPath,
							effectiveTrusted: state.decision !== false,
							canEdit: canEditPiTrust,
						};
					})();
		return c.json({
			workspaceId,
			folders: allFolders,
			piTrust,
			report: {
				...report,
				// Strip full markdown bodies from the overview API; UI only needs preview, path, and token breakdown.
				rules: report.rules.map(({ content: _content, ...rest }) => rest),
			},
		});
	});

	app.patch("/api/workspaces/:workspaceId/pi-trust", async (c) => {
		const { store, broadcast } = c.var.routeCtx;
		const actor = c.var.actor;
		const res = c.var.nodeRes!;
		if (!requireActiveActor(res, actor)) return c.body(null);
		const workspaceId = c.req.param("workspaceId");
		const workspace = store.getWorkspace(workspaceId);
		if (!workspace) {
			throw new HttpRequestError(404, "工作区不存在");
		}
		if (!isGlobalUnscopedActor(actor) && !isSuperAdminActor(actor)) {
			throw new HttpRequestError(403, "仅本机所有者或超级管理员可调整 Pi 目录信任状态");
		}
		if (workspace.sourceType === "cloned") {
			throw new HttpRequestError(400, "托管克隆仓固定保持隔离，不支持切换 Pi 目录信任");
		}
		const body = await parseJsonBody(c, UpdateWorkspacePiTrustSchema);
		const state = writePiProjectTrustDecision(workspace.repoPath, body.trusted);
		broadcast("workspace_updated", { workspaceId });
		return c.json({
			workspaceId,
			piTrust: {
				eligible: true,
				decision: state.decision,
				matchedPath: state.matchedPath,
				effectiveTrusted: state.decision !== false,
				canEdit: true,
			},
		});
	});

	app.patch("/api/workspaces/:workspaceId/folders/:folderId", async (c) => {
		const { store, broadcast } = c.var.routeCtx;
		const actor = c.var.actor;
		const res = c.var.nodeRes!;
		if (!requireActiveActor(res, actor)) return c.body(null);
		const workspaceId = c.req.param("workspaceId");
		const folderId = c.req.param("folderId");
		const workspace = store.getWorkspace(workspaceId);
		if (!workspace) {
			throw new HttpRequestError(404, "工作区不存在");
		}
		const canManage =
			isGlobalUnscopedActor(actor) ||
			isSuperAdminActor(actor) ||
			canManageOrganization(store, actor, workspace.orgId);
		if (!canManage) {
			throw new HttpRequestError(403, "仅组织管理员或超级管理员可调整工作区目录");
		}
		const body = await parseJsonBody(c, UpdateWorkspaceFolderSchema);
		if (body.setPrimary === true) {
			const updated = store.workspaceFolders.setPrimaryFolder(workspaceId, folderId);
			if (!updated) {
				throw new HttpRequestError(404, "目录不存在");
			}
			broadcast("workspace_updated", { workspaceId });
			return c.json({ folder: updated, folders: store.workspaceFolders.listFolders(workspaceId) });
		}
		const updated = store.workspaceFolders.updateFolder(folderId, {
			label: body.label,
			loadRules: body.loadRules,
			loadSkills: body.loadSkills,
		});
		if (!updated) {
			throw new HttpRequestError(404, "目录不存在");
		}
		broadcast("workspace_updated", { workspaceId });
		return c.json({ folder: updated, folders: store.workspaceFolders.listFolders(workspaceId) });
	});

	app.delete("/api/workspaces/:workspaceId/folders/:folderId", (c) => {
		const { store, broadcast } = c.var.routeCtx;
		const actor = c.var.actor;
		const res = c.var.nodeRes!;
		if (!requireActiveActor(res, actor)) return c.body(null);
		const workspaceId = c.req.param("workspaceId");
		const folderId = c.req.param("folderId");
		const workspace = store.getWorkspace(workspaceId);
		if (!workspace) {
			throw new HttpRequestError(404, "工作区不存在");
		}
		const canManage =
			isGlobalUnscopedActor(actor) ||
			isSuperAdminActor(actor) ||
			canManageOrganization(store, actor, workspace.orgId);
		if (!canManage) {
			throw new HttpRequestError(403, "仅组织管理员或超级管理员可调整工作区目录");
		}
		try {
			const removed = store.workspaceFolders.removeFolder(folderId);
			if (!removed) {
				throw new HttpRequestError(404, "目录不存在");
			}
			broadcast("workspace_updated", { workspaceId });
			return c.json({ folders: store.workspaceFolders.listFolders(workspaceId) });
		} catch (error) {
			if (error instanceof HttpRequestError) throw error;
			throw new HttpRequestError(400, error instanceof Error ? error.message : String(error));
		}
	});

	app.get("/api/workspaces/:workspaceId/folders", (c) => {
		const { store } = c.var.routeCtx;
		const actor = c.var.actor;
		const res = c.var.nodeRes!;
		if (!requireActiveActor(res, actor)) return c.body(null);
		const workspaceId = c.req.param("workspaceId");
		const workspace = store.getWorkspace(workspaceId);
		if (!workspace) {
			throw new HttpRequestError(404, "工作区不存在");
		}
		if (!canAccessWorkspace(store, actor, workspace)) {
			throw new HttpRequestError(403, "无权访问该工作区");
		}
		return c.json({ folders: store.workspaceFolders.listFolders(workspaceId) });
	});

	app.post("/api/workspaces/:workspaceId/folders", async (c) => {
		const { store, broadcast, dataDir, defaultWorkspacesRoot } = c.var.routeCtx;
		const actor = c.var.actor;
		const res = c.var.nodeRes!;
		if (!requireActiveActor(res, actor)) return c.body(null);
		const workspaceId = c.req.param("workspaceId");
		const workspace = store.getWorkspace(workspaceId);
		if (!workspace) {
			throw new HttpRequestError(404, "工作区不存在");
		}
		if (!canAccessWorkspace(store, actor, workspace)) {
			throw new HttpRequestError(403, "无权访问该工作区");
		}
		const canManage =
			isGlobalUnscopedActor(actor) ||
			isSuperAdminActor(actor) ||
			canManageOrganization(store, actor, workspace.orgId);
		if (!canManage) {
			throw new HttpRequestError(403, "仅组织管理员或超级管理员可向工作区添加目录");
		}
		const body = await parseJsonBody(c);
		const rawPath = typeof body.path === "string" ? body.path.trim() : "";
		const label = typeof body.label === "string" ? body.label.trim() : undefined;
		const loadRules = typeof body.loadRules === "boolean" ? body.loadRules : true;
		const loadSkills = typeof body.loadSkills === "boolean" ? body.loadSkills : true;
		try {
			const settings = store.getPlatformSettings(defaultWorkspacesRoot);
			const validatedPath = validateLocalWorkspaceBindingPath({
				rawPath,
				settings,
				actor,
				dataDir,
			});
			const folder = store.workspaceFolders.addFolder({
				workspaceId,
				label,
				path: validatedPath,
				sourceType: "local",
				loadRules,
				loadSkills,
			});
			broadcast("workspace_updated", { workspaceId });
			return c.json({ folder, folders: store.workspaceFolders.listFolders(workspaceId) }, 201);
		} catch (error) {
			throw new HttpRequestError(400, error instanceof Error ? error.message : String(error));
		}
	});
}
