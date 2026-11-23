import { readdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { buildWorkspaceCustomizations } from "../../orchestrator/workspace-customizations.ts";
import {
	canAccessWorkspace,
	canManageOrganization,
	isGlobalUnscopedActor,
	validateLocalWorkspaceBindingPath,
} from "../acl.ts";
import { isSuperAdminActor, requireActiveActor } from "../auth.ts";
import { readJsonBody, sendError, sendJson } from "../http.ts";
import type { RouteRequest, ServerRouteContext } from "./context.ts";

/** Handle multi-folder workspace attachments and cross-folder Rules/Skills customizations breakdown. */
export async function handleWorkspaceFolderRoutes(ctx: ServerRouteContext, r: RouteRequest): Promise<boolean> {
	const { store, broadcast, dataDir, defaultWorkspacesRoot } = ctx;
	const { actor, req, res, method, pathname } = r;

	if (method === "GET" && pathname === "/api/workspaces/directory-browser") {
		if (!requireActiveActor(res, actor)) return true;
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const workspaceId = url.searchParams.get("workspaceId");
		const orgId = url.searchParams.get("orgId");
		if (workspaceId) {
			const workspace = store.getWorkspace(workspaceId);
			if (
				!workspace ||
				!canAccessWorkspace(store, actor, workspace) ||
				(!isSuperAdminActor(actor) && !canManageOrganization(store, actor, workspace.orgId))
			) {
				sendError(res, 403, "无权管理该工作区目录");
				return true;
			}
		} else if (!isSuperAdminActor(actor) && (!orgId || !canManageOrganization(store, actor, orgId))) {
			sendError(res, 403, "仅组织管理员可浏览服务器目录");
			return true;
		}
		const settings = store.getPlatformSettings(defaultWorkspacesRoot);
		const validate = (rawPath: string) => validateLocalWorkspaceBindingPath({ rawPath, settings, actor, dataDir });
		const requested = url.searchParams.get("path")?.trim();
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
			sendJson(res, 200, { path: current, parent, roots, directories });
		} catch (error) {
			sendError(res, 403, error instanceof Error ? error.message : "无法读取目录");
		}
		return true;
	}

	const customizationsMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/customizations$/);
	if (customizationsMatch && method === "GET") {
		if (!requireActiveActor(res, actor)) return true;
		const workspaceId = decodeURIComponent(customizationsMatch[1]!);
		const workspace = store.getWorkspace(workspaceId);
		if (!workspace) {
			sendError(res, 404, "工作区不存在");
			return true;
		}
		if (!canAccessWorkspace(store, actor, workspace)) {
			sendError(res, 403, "无权访问该工作区");
			return true;
		}
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const folderIdFilter = url.searchParams.get("folderId")?.trim() || null;
		const allFolders = store.workspaceFolders.listFolders(workspaceId);
		const scopedFolders = folderIdFilter ? allFolders.filter((f) => f.id === folderIdFilter) : allFolders;
		const report = buildWorkspaceCustomizations(scopedFolders);
		sendJson(res, 200, {
			workspaceId,
			folders: allFolders,
			report: {
				...report,
				// Strip full markdown bodies from the overview API; UI only needs preview, path, and token breakdown.
				rules: report.rules.map(({ content: _content, ...rest }) => rest),
			},
		});
		return true;
	}

	const folderItemMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/folders\/([^/]+)$/);
	if (folderItemMatch) {
		if (!requireActiveActor(res, actor)) return true;
		const workspaceId = decodeURIComponent(folderItemMatch[1]!);
		const folderId = decodeURIComponent(folderItemMatch[2]!);
		const workspace = store.getWorkspace(workspaceId);
		if (!workspace) {
			sendError(res, 404, "工作区不存在");
			return true;
		}
		const canManage =
			isGlobalUnscopedActor(actor) ||
			isSuperAdminActor(actor) ||
			canManageOrganization(store, actor, workspace.orgId);
		if (!canManage) {
			sendError(res, 403, "仅组织管理员或超级管理员可调整工作区目录");
			return true;
		}

		if (method === "PATCH") {
			const body = await readJsonBody(req);
			if (body.setPrimary === true) {
				const updated = store.workspaceFolders.setPrimaryFolder(workspaceId, folderId);
				if (!updated) {
					sendError(res, 404, "目录不存在");
					return true;
				}
				broadcast("workspace_updated", { workspaceId });
				sendJson(res, 200, { folder: updated, folders: store.workspaceFolders.listFolders(workspaceId) });
				return true;
			}
			const updated = store.workspaceFolders.updateFolder(folderId, {
				label: typeof body.label === "string" ? body.label : undefined,
				loadRules: typeof body.loadRules === "boolean" ? body.loadRules : undefined,
				loadSkills: typeof body.loadSkills === "boolean" ? body.loadSkills : undefined,
			});
			if (!updated) {
				sendError(res, 404, "目录不存在");
				return true;
			}
			broadcast("workspace_updated", { workspaceId });
			sendJson(res, 200, { folder: updated, folders: store.workspaceFolders.listFolders(workspaceId) });
			return true;
		}

		if (method === "DELETE") {
			try {
				const removed = store.workspaceFolders.removeFolder(folderId);
				if (!removed) {
					sendError(res, 404, "目录不存在");
					return true;
				}
				broadcast("workspace_updated", { workspaceId });
				sendJson(res, 200, { folders: store.workspaceFolders.listFolders(workspaceId) });
			} catch (error) {
				sendError(res, 400, error instanceof Error ? error.message : String(error));
			}
			return true;
		}
		return false;
	}

	const foldersMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/folders$/);
	if (foldersMatch) {
		if (!requireActiveActor(res, actor)) return true;
		const workspaceId = decodeURIComponent(foldersMatch[1]!);
		const workspace = store.getWorkspace(workspaceId);
		if (!workspace) {
			sendError(res, 404, "工作区不存在");
			return true;
		}
		if (!canAccessWorkspace(store, actor, workspace)) {
			sendError(res, 403, "无权访问该工作区");
			return true;
		}
		if (method === "GET") {
			const folders = store.workspaceFolders.listFolders(workspaceId);
			sendJson(res, 200, { folders });
			return true;
		}
		if (method === "POST") {
			const canManage =
				isGlobalUnscopedActor(actor) ||
				isSuperAdminActor(actor) ||
				canManageOrganization(store, actor, workspace.orgId);
			if (!canManage) {
				sendError(res, 403, "仅组织管理员或超级管理员可向工作区添加目录");
				return true;
			}
			const body = await readJsonBody(req);
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
				sendJson(res, 201, { folder, folders: store.workspaceFolders.listFolders(workspaceId) });
			} catch (error) {
				sendError(res, 400, error instanceof Error ? error.message : String(error));
			}
			return true;
		}
		return false;
	}

	return false;
}
