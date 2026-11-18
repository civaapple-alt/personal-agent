import { createServer, type Server } from "node:http";
import type { PiCliProbeResult, ServerRuntimeConfig } from "../orchestrator/runtime-info.ts";
import type { TeamOrchestrator } from "../orchestrator/team-orchestrator.ts";
import type { RoleTemplate } from "../roles/types.ts";
import { MemoryValidationError, type PersonalAgentStore } from "../storage/repositories.ts";
import { requireOwner, resolveRequestActor } from "./auth.ts";
import type { DialogBroker } from "./dialog-broker.ts";
import { createDispatchRunner } from "./dispatch-runner.ts";
import { HttpRequestError, sendError, sendJson, serveStaticAsset } from "./http.ts";
import { InnerMatterDemo } from "./inner-matter.ts";
import type { PreviewManager } from "./preview-manager.ts";
import { handleAuthRoutes, handleBootstrapAndCollaboratorRoutes } from "./routes/auth-collaborators.ts";
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
	uploadsDir?: string;
	requireAuth?: boolean;
	innerMatterDir?: string;
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
	const sse = createSseHub();
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
	};

	const handlers = [
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
			const requireAuth = Boolean(options.requireAuth);
			const actor = resolveRequestActor(req, store, requireAuth);

			if (await handleAuthRoutes(routeCtx, req, res, method, pathname, actor, requireAuth)) {
				return;
			}

			if (pathname.startsWith("/api/") && !actor) {
				sendError(res, 401, "未认证，请使用邀请链接或口令登录");
				return;
			}
			if (method === "POST" && pathname === "/api/demos/inner-matter") {
				if (!requireOwner(res, actor)) return;
				if (!innerMatterDemo) {
					sendError(res, 404, "当前服务未启用内置演示");
					return;
				}
				const matter = await innerMatterDemo.prepare();
				sse.broadcast("matter_updated", { matterId: matter.id });
				sendJson(res, 200, { matter });
				return;
			}

			if (method === "GET" && pathname === "/api/events") {
				sse.handleEventsStream(req, res, actor);
				return;
			}

			const uploadMatch = pathname.match(/^\/api\/uploads\/([a-zA-Z0-9._-]+)$/);
			if (method === "GET" && uploadMatch) {
				await handleUploadGet(res, uploadMatch[1]!, uploadsDir, memoryUploads);
				return;
			}

			const routeReq: RouteRequest = { req, res, method, pathname, actor };
			for (const handle of handlers) {
				if (await handle(routeCtx, routeReq)) return;
			}

			if (method === "GET" && (await serveStaticAsset(res, pathname, webDistDir))) {
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
