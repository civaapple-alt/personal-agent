import { createServer, type Server } from "node:http";
import { dirname, resolve } from "node:path";
import type { PiCliProbeResult, ServerRuntimeConfig } from "../orchestrator/runtime-info.ts";
import type { TeamOrchestrator } from "../orchestrator/team-orchestrator.ts";
import type { RoleTemplate } from "../roles/types.ts";
import { MemoryValidationError, type PersonalAgentStore } from "../storage/repositories.ts";
import { canActorAccessUpload } from "./acl.ts";
import { requireActiveActor, requireOwner, resolveRequestActor } from "./auth.ts";
import type { DialogBroker } from "./dialog-broker.ts";
import { createDispatchRunner } from "./dispatch-runner.ts";
import { HttpRequestError, isAllowedMutatingOrigin, sendError, sendJson, serveStaticAsset } from "./http.ts";
import { InnerMatterDemo } from "./inner-matter.ts";
import type { PreviewManager } from "./preview-manager.ts";
import { handleAdminAndAuthRoutes, handleAdminRoutes } from "./routes/admin-auth.ts";
import { handleBootstrapAndCollaboratorRoutes } from "./routes/auth-collaborators.ts";
import type { RouteRequest, ServerRouteContext } from "./routes/context.ts";
import { handleDeliverableOrgPreviewRoutes } from "./routes/deliverables-orgs.ts";
import { handleMatterRoutes } from "./routes/matters.ts";
import { handleTeamMemoryRoutes } from "./routes/team-memories.ts";
import { createSseHub } from "./sse.ts";
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
	innerMatterDir?: string;
	defaultWorkspacesRoot?: string;
	dataDir?: string;
	probePiCli?: () => Promise<PiCliProbeResult>;
	runtimeMeta?: Pick<ServerRuntimeConfig, "host" | "port" | "dbPath" | "builtinRolesDir">;
}

/**
 * Create the Phase 3 HTTP + SSE server backing the V4 workbench UI.
 */
export function createPersonalAgentServer(options: PersonalAgentServerOptions): {
	server: Server;
	broadcast: (eventName: string, payload: unknown) => void;
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
	const innerMatterDemo = options.innerMatterDir ? new InnerMatterDemo(store, options.innerMatterDir) : undefined;
	const memoryUploads = new Map<string, { buffer: Buffer; mimeType: string }>();
	let roleMutationTail = Promise.resolve();

	const offDialog = dialogBroker.onEvent((evt) => {
		sse.broadcast(evt.type, evt);
	});

	const { activeRuns, runDispatchInBackground } = createDispatchRunner({
		store,
		orchestrator,
		broadcast: sse.broadcast,
	});

	const routeCtx: ServerRouteContext = {
		store,
		orchestrator,
		previewManager,
		dialogBroker,
		probePiCli: options.probePiCli,
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
				innerMatterDir: options.innerMatterDir,
				webDistDir,
				requireAuth: Boolean(options.requireAuth),
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
		runDispatchInBackground,
		innerMatterDemo,
		requireAuth: Boolean(options.requireAuth),
		defaultWorkspacesRoot: options.defaultWorkspacesRoot,
		dataDir: options.dataDir,
	};

	const handlers = [
		handleAdminRoutes,
		handleBootstrapAndCollaboratorRoutes,
		handleMatterRoutes,
		handleDeliverableOrgPreviewRoutes,
		handleTeamMemoryRoutes,
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
			if (method === "POST" && pathname === "/api/demos/inner-matter") {
				if (!requireOwner(res, actor)) return;
				if (!innerMatterDemo) {
					sendError(res, 404, "当前服务未启用内置演示");
					return;
				}
				const matter = await innerMatterDemo.prepare();
				sse.broadcast("matter_updated", { matterId: matter.id }, { matterId: matter.id });
				sendJson(res, 200, { matter });
				return;
			}

			if (method === "GET" && pathname === "/api/events") {
				sse.handleEventsStream(req, res, actor);
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
				error instanceof HttpRequestError ? error.statusCode : error instanceof MemoryValidationError ? 400 : 500;
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
