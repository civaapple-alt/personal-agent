import { createServer, type Server } from "node:http";
import type { TeamOrchestrator } from "../orchestrator/team-orchestrator.ts";
import type { RoleTemplate } from "../roles/types.ts";
import { MemoryValidationError, type PersonalAgentStore } from "../storage/repositories.ts";
import { resolveRequestActor } from "./auth.ts";
import type { DialogBroker } from "./dialog-broker.ts";
import { createDispatchRunner } from "./dispatch-runner.ts";
import { HttpRequestError, sendError, serveStaticAsset } from "./http.ts";
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
	const memoryUploads = new Map<string, { buffer: Buffer; mimeType: string }>();

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
		rolesDir,
		uploadsDir,
		memoryUploads,
		activeRuns,
		broadcast: sse.broadcast,
		revokeTokenSessions: sse.revokeTokenSessions,
		runDispatchInBackground,
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
