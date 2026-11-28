import { createServer, type Server } from "node:http";
import { dirname, resolve, sep } from "node:path";
import type { PiNativeSkillDto } from "@pa/contracts/skill-trust";
import { readPiDiscoveredSkills } from "@pa/pi-rpc";
import { resolveRepoAssetPath } from "../build-support.ts";
import { resolveBuiltinExtensionPath } from "../extensions/builtin-paths.ts";
import { type InstalledPiWebAccess, installPiWebAccess } from "../extensions/web-access/package.ts";
import {
	type LocalPiResourcesPolicy,
	normalizeLocalPiResourcesPolicy,
	type PiCliProbeResult,
	probePiCli,
	type ServerRuntimeConfig,
} from "../orchestrator/runtime/runtime-info.ts";
import type { TeamOrchestrator } from "../orchestrator/team-orchestrator.ts";
import type { RoleTemplate } from "../roles/types.ts";
import { type PersonalAgentStore, WorkspaceMutationError } from "../storage/repositories.ts";
import { canActorAccessUpload } from "./acl.ts";
import { isLoopbackAddress, type RequestActor, requireActiveActor, resolveRequestActor } from "./auth.ts";
import type { DialogBroker } from "./dialog-broker.ts";
import { createDispatchRunner } from "./dispatch-runner.ts";
import { HttpRequestError, isAllowedMutatingOrigin, sendError, serveStaticAsset } from "./http.ts";
import type { PreviewManager } from "./preview-manager.ts";
import { createApiRouter, dispatchHonoRequest, requireAuthMiddleware } from "./router.ts";
import { handleAdminAndAuthRoutes, handleAdminRoutes } from "./routes/admin-auth.ts";
import { handleBootstrapAndCollaboratorRoutes } from "./routes/auth-collaborators.ts";
import type { RouteRequest, ServerRouteContext } from "./routes/context.ts";
import { handleDeliverableOrgPreviewRoutes } from "./routes/deliverables-orgs.ts";
import { handleHumanDecisionRoutes } from "./routes/human-decisions.ts";
import { handleMatterBoardRoutes } from "./routes/matter-board.ts";
import { handleMatterMessageRoutes } from "./routes/matter-messages.ts";
import { handleMatterSettingsRoutes } from "./routes/matter-settings.ts";
import { handleMatterRoutes } from "./routes/matters.ts";
import { handleModelSettingsRoutes } from "./routes/model-settings.ts";
import { handleRoleDesignRoutes } from "./routes/role-design.ts";
import { handleSkillTrustRoutes } from "./routes/skill-trust.ts";
import { handleSpaceRoutes } from "./routes/spaces.ts";
import { handleTeamRoutes } from "./routes/team.ts";
import { handleWorkspaceFolderRoutes } from "./routes/workspace-folders.ts";
import { createSseHub, type SseBroadcastFn } from "./sse.ts";
import { handleUploadGet } from "./uploads.ts";

export interface PersonalAgentServerOptions {
	store: PersonalAgentStore;
	orchestrator: TeamOrchestrator;
	templates: RoleTemplate[];
	previewManager: PreviewManager;
	dialogBroker: DialogBroker;
	webDistDir?: string;
	rolesDir?: string;
	skillsDir?: string;
	uploadsDir?: string;
	requireAuth?: boolean;
	/**
	 * Control host `~/.pi` resource inheritance (`--offline` vs `--no-extensions`):
	 * - `"auto"` (default / `true`): inherit only for unauthenticated loopback owner.
	 * - `"always"`: inherit for all authorized business dispatches, including team/auth/LAN modes.
	 * - `"off"` (`false`): never inherit; always pass `--no-extensions`.
	 */
	inheritLocalPiResources?: boolean | LocalPiResourcesPolicy;
	defaultWorkspacesRoot?: string;
	dataDir?: string;
	probePiCli?: () => Promise<PiCliProbeResult>;
	readPiNativeSkills?: (options: { inheritLocalPiResources: boolean }) => Promise<PiNativeSkillDto[]>;
	runtimeMeta?: Pick<ServerRuntimeConfig, "host" | "port" | "dbPath" | "builtinRolesDir">;
}

/**
 * Create the Phase 3 HTTP + SSE server backing the V4 workbench UI.
 */
export function createPersonalAgentServer(options: PersonalAgentServerOptions): {
	server: Server;
	broadcast: SseBroadcastFn;
} {
	const { store, orchestrator, previewManager, dialogBroker, webDistDir, rolesDir, uploadsDir } = options;
	const skillsDir =
		options.skillsDir ??
		(options.dataDir
			? resolve(options.dataDir, "skills")
			: rolesDir
				? resolve(dirname(rolesDir), "skills")
				: undefined);
	const sse = createSseHub(store);
	const memoryUploads = new Map<string, { buffer: Buffer; mimeType: string }>();
	let roleMutationTail = Promise.resolve();
	let webAccessInstallation: Promise<InstalledPiWebAccess> | undefined;
	let packageInstallTail = Promise.resolve();
	const probeRuntimePi = options.probePiCli ?? probePiCli;

	function queuePiInstall<T>(install: (executable: string) => Promise<T>): Promise<T> {
		const result = packageInstallTail.then(async () => {
			const pi = await probeRuntimePi();
			if (!pi.available) throw new HttpRequestError(503, "Pi CLI 不可用，请查看服务启动日志");
			return install(pi.executable);
		});
		packageInstallTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	const offDialog = dialogBroker.onEvent((evt) => {
		if (evt.type === "dialog_requested") {
			sse.broadcast("dialog_requested", evt);
		} else {
			sse.broadcast("dialog_resolved", evt);
		}
	});

	const localPiResourcesPolicy = normalizeLocalPiResourcesPolicy(options.inheritLocalPiResources);
	const inheritsLocalPiResources = (actor?: RequestActor) => {
		if (localPiResourcesPolicy === "always") return true;
		if (localPiResourcesPolicy === "off") return false;
		const address = server.address();
		return (
			!options.requireAuth &&
			address !== null &&
			typeof address !== "string" &&
			isLoopbackAddress(address.address) &&
			(!actor || actor.authKind === "loopback")
		);
	};
	const { activeRuns, runDispatchInBackground } = createDispatchRunner({
		store,
		orchestrator,
		broadcast: sse.broadcast,
		inheritsLocalPiResources,
	});

	const piSkillsCache = new Map<boolean, { expiresAt: number; skills: PiNativeSkillDto[] }>();
	const readPiNativeSkills = async (opts: { inheritLocalPiResources: boolean; refresh?: boolean }) => {
		const now = Date.now();
		const cached = piSkillsCache.get(opts.inheritLocalPiResources);
		if (!opts.refresh && cached && cached.expiresAt > now) {
			return cached.skills;
		}
		const roleSkillsDir = resolveRepoAssetPath("pi-extensions/role-skills");
		const workflowSkillsDir = resolveRepoAssetPath("pa-extensions/workflow/skills");
		const selfInspectSkillsDir = resolveRepoAssetPath("pa-extensions/self-inspect/skills");
		const loader =
			options.readPiNativeSkills ??
			(async (o: { inheritLocalPiResources: boolean }) => {
				const raw = await readPiDiscoveredSkills({
					inheritLocalPiResources: o.inheritLocalPiResources,
					extraExtensions: [resolveBuiltinExtensionPath("role-skills")],
					extraSkillPaths: [workflowSkillsDir, selfInspectSkillsDir],
				});
				return raw.map((item) => {
					const fullPath = item.filePath ? resolve(item.filePath) : "";
					if (fullPath.startsWith(`${roleSkillsDir}${sep}`)) {
						return { ...item, source: "pa-builtin:role-skills", origin: "package" };
					}
					if (fullPath.startsWith(`${workflowSkillsDir}${sep}`)) {
						return { ...item, source: "pa-builtin:workflow", origin: "package" };
					}
					if (fullPath.startsWith(`${selfInspectSkillsDir}${sep}`)) {
						return { ...item, source: "pa-builtin:self-inspect", origin: "package" };
					}
					return item;
				});
			});
		const skills = await loader({ inheritLocalPiResources: opts.inheritLocalPiResources });
		piSkillsCache.set(opts.inheritLocalPiResources, { expiresAt: now + 30_000, skills });
		return skills;
	};

	const routeCtx: ServerRouteContext = {
		store,
		orchestrator,
		previewManager,
		dialogBroker,
		probePiCli: probeRuntimePi,
		readPiNativeSkills,
		installWebAccess: () => {
			webAccessInstallation ??= queuePiInstall(installPiWebAccess).finally(() => {
				webAccessInstallation = undefined;
			});
			return webAccessInstallation;
		},
		getServerRuntimeConfig: () => {
			const addr = server.address();
			const listeningPort = addr && typeof addr !== "string" ? addr.port : undefined;
			return {
				host: options.runtimeMeta?.host,
				port: listeningPort ?? options.runtimeMeta?.port,
				dbPath: options.runtimeMeta?.dbPath,
				builtinRolesDir: options.runtimeMeta?.builtinRolesDir,
				rolesDir,
				uploadsDir,
				webDistDir,
				requireAuth: Boolean(options.requireAuth),
				inheritLocalPiResources: inheritsLocalPiResources(),
				localPiResourcesPolicy,
			};
		},
		rolesDir,
		skillsDir,
		withRoleMutation: (action) => {
			const result = roleMutationTail.then(action);
			roleMutationTail = result.then(
				() => undefined,
				() => undefined,
			);
			return result;
		},
		uploadsDir,
		memoryUploads,
		activeRuns,
		broadcast: sse.broadcast,
		revokeTokenSessions: sse.revokeTokenSessions,
		closeAccountSession: sse.closeAccountSession,
		runDispatchInBackground,
		requireAuth: Boolean(options.requireAuth),
		defaultWorkspacesRoot: options.defaultWorkspacesRoot,
		dataDir: options.dataDir,
	};

	const publicApiRouter = createApiRouter();
	const apiRouter = createApiRouter();
	apiRouter.use("/api/*", requireAuthMiddleware);

	const handlers = [
		handleModelSettingsRoutes,
		handleAdminRoutes,
		handleBootstrapAndCollaboratorRoutes,
		handleMatterRoutes,
		handleMatterBoardRoutes,
		handleMatterSettingsRoutes,
		handleMatterMessageRoutes,
		handleHumanDecisionRoutes,
		handleSpaceRoutes,
		handleWorkspaceFolderRoutes,
		handleDeliverableOrgPreviewRoutes,
		handleRoleDesignRoutes,
		handleSkillTrustRoutes,
		handleTeamRoutes,
	];

	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const method = req.method ?? "GET";
		const pathname = url.pathname;

		try {
			if (pathname.startsWith("/api/") && !isAllowedMutatingOrigin(req)) {
				sendError(res, 403, "跨站写请求已被拦截");
				return;
			}
			const requireAuth = Boolean(options.requireAuth);
			const actor = resolveRequestActor(req, store, requireAuth);

			if (
				pathname.startsWith("/api/") &&
				actor?.tokenScope === "read" &&
				method !== "GET" &&
				method !== "HEAD" &&
				method !== "OPTIONS"
			) {
				sendError(res, 403, "该只读访问令牌不支持修改操作");
				return;
			}

			if (
				pathname.startsWith("/api/") &&
				(await dispatchHonoRequest(publicApiRouter, req, res, {
					routeCtx,
					actor,
					requireAuth,
				}))
			) {
				return;
			}
			if (await handleAdminAndAuthRoutes(routeCtx, req, res, method, pathname, actor, requireAuth)) {
				return;
			}

			if (pathname.startsWith("/api/") && !actor) {
				sendError(res, 401, "未认证，请登录或通过有效邀请进入工作台");
				return;
			}
			if (pathname.startsWith("/api/") && !requireActiveActor(res, actor)) {
				return;
			}
			if (method === "GET" && pathname === "/api/events") {
				sse.handleEventsStream(res, actor);
				return;
			}

			const uploadMatch = pathname.match(/^\/api\/uploads\/([a-zA-Z0-9._-]+)$/);
			if (method === "GET" && uploadMatch) {
				const filename = uploadMatch[1]!;
				if (!canActorAccessUpload(store, actor, filename)) {
					sendError(res, 403, "无权访问该附件");
					return;
				}
				await handleUploadGet(res, filename, uploadsDir, memoryUploads);
				return;
			}

			if (
				pathname.startsWith("/api/") &&
				(await dispatchHonoRequest(apiRouter, req, res, {
					routeCtx,
					actor,
					requireAuth,
				}))
			) {
				return;
			}

			const routeReq: RouteRequest = { req, res, method, pathname, actor };
			for (const handle of handlers) {
				if (await handle(routeCtx, routeReq)) return;
			}

			const documentTitle = requireAuth ? "Personal Agent · 团队版" : "Personal Agent · 个人版";
			if (method === "GET" && (await serveStaticAsset(res, pathname, webDistDir, { documentTitle }))) {
				return;
			}

			sendError(res, 404, `Not found: ${method} ${pathname}`);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			const statusCode =
				error instanceof HttpRequestError || error instanceof WorkspaceMutationError ? error.statusCode : 500;
			sendError(res, statusCode, message);
		}
	});

	server.once("close", () => {
		offDialog();
		dialogBroker.cancelAll();
		sse.closeAll();
	});

	return { server, broadcast: sse.broadcast };
}
