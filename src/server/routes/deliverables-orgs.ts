import type { FeedbackRating } from "../../storage/types.ts";
import { requireOwner } from "../auth.ts";
import { readJsonBody, responseCancellation, sendError, sendJson } from "../http.ts";
import { broadcastDistilledMemories, enrichWorkspace, type RouteRequest, type ServerRouteContext } from "./context.ts";

function workspaceHasActiveTurn(ctx: ServerRouteContext, workspaceId: string): boolean {
	return ctx.store
		.listMatters()
		.some((matter) => matter.workspaceId === workspaceId && ctx.orchestrator.isMatterRunning(matter.id));
}

/** Handle deliverables feedback, organizations, workspaces, and preview services. */
export async function handleDeliverableOrgPreviewRoutes(ctx: ServerRouteContext, r: RouteRequest): Promise<boolean> {
	const { store, orchestrator, previewManager, broadcast } = ctx;
	const { req, res, method, pathname, actor } = r;

	const feedbackMatch = pathname.match(/^\/api\/deliverables\/([^/]+)\/feedback$/);
	if (method === "POST" && feedbackMatch) {
		const deliverableId = decodeURIComponent(feedbackMatch[1]!);
		const existing = store.getDeliverable(deliverableId);
		if (!existing) {
			sendError(res, 404, `Deliverable not found: ${deliverableId}`);
			return true;
		}
		const body = await readJsonBody(req);
		if (body.autoDistill === true && !requireOwner(res, actor)) return true;
		const rawFeedback = typeof body.feedback === "string" ? body.feedback.trim() : "";
		const feedback =
			rawFeedback && actor!.collaborator.permissionRole !== "owner"
				? `[${actor!.collaborator.name} (${actor!.collaborator.roleTitle})]: ${rawFeedback}`
				: rawFeedback;
		const rawRating = body.rating;
		const rating: FeedbackRating | undefined =
			rawRating === "positive" || rawRating === "negative" || rawRating === "neutral" ? rawRating : undefined;
		if (!feedback && !rating) {
			sendError(res, 400, "feedback or rating is required");
			return true;
		}
		const { deliverable: updatedDeliverable, evaluatedMemories } = store.recordDeliverableFeedback(
			deliverableId,
			feedback || existing.feedback || "",
			rating,
		);
		const evaluatedMemoryIds = evaluatedMemories.map((memory) => memory.id);
		for (const memberId of new Set(evaluatedMemories.map((memory) => memory.memberId)))
			broadcast("memory_updated", { memberId, evaluatedMemoryIds });
		let distilledMemories: unknown[] = [];
		let distillationError: string | undefined;
		if (body.autoDistill === true) {
			const cancellation = responseCancellation(res);
			try {
				const distilled = await orchestrator.distillExperiences({
					matterId: existing.matterId,
					deliverableId: existing.id,
					feedback,
					rating: rating ?? null,
					scopeMode: body.scopeMode === "single" || body.scopeMode === "team" ? body.scopeMode : undefined,
					signal: cancellation.signal,
				});
				distilledMemories = distilled.createdMemories;
				broadcastDistilledMemories(broadcast, distilled.member.id, distilled.createdMemories);
			} catch (error) {
				distillationError = error instanceof Error ? error.message : String(error);
			} finally {
				cancellation.dispose();
			}
		}
		broadcast("deliverable_updated", {
			deliverableId,
			feedback: updatedDeliverable?.feedback ?? feedback,
			rating: updatedDeliverable?.feedbackRating ?? null,
		});
		sendJson(res, 200, {
			ok: true,
			deliverableId,
			feedback: updatedDeliverable?.feedback ?? feedback,
			rating: updatedDeliverable?.feedbackRating ?? null,
			evaluatedMemoryIds,
			distilledMemories,
			distillationError,
		});
		return true;
	}

	if (method === "GET" && pathname === "/api/organizations") {
		sendJson(res, 200, { organizations: store.listOrganizations() });
		return true;
	}

	if (method === "POST" && pathname === "/api/organizations") {
		if (!requireOwner(res, actor)) return true;
		const body = await readJsonBody(req);
		const name = typeof body.name === "string" ? body.name.trim() : "";
		if (!name) {
			sendError(res, 400, "name is required");
			return true;
		}
		const organization = store.upsertOrganization({
			id: typeof body.id === "string" && body.id.trim() ? body.id.trim() : undefined,
			name,
			gitEmailDomain: typeof body.gitEmailDomain === "string" ? body.gitEmailDomain : "",
			description: typeof body.description === "string" ? body.description : "",
			isDefault: typeof body.isDefault === "boolean" ? body.isDefault : undefined,
		});
		broadcast("organization_updated", { organization });
		sendJson(res, 201, { organization });
		return true;
	}

	const orgDefaultMatch = pathname.match(/^\/api\/organizations\/([^/]+)\/default$/);
	if (method === "POST" && orgDefaultMatch) {
		if (!requireOwner(res, actor)) return true;
		const orgId = decodeURIComponent(orgDefaultMatch[1]!);
		if (!store.getOrganization(orgId)) {
			sendError(res, 404, `Organization not found: ${orgId}`);
			return true;
		}
		const organization = store.setDefaultOrganization(orgId);
		broadcast("organization_updated", { organization });
		sendJson(res, 200, { organization });
		return true;
	}

	const orgPatchMatch = pathname.match(/^\/api\/organizations\/([^/]+)$/);
	if (method === "PATCH" && orgPatchMatch) {
		if (!requireOwner(res, actor)) return true;
		const orgId = decodeURIComponent(orgPatchMatch[1]!);
		if (!store.getOrganization(orgId)) {
			sendError(res, 404, `Organization not found: ${orgId}`);
			return true;
		}
		const body = await readJsonBody(req);
		const organization = store.updateOrganization(orgId, {
			name: typeof body.name === "string" ? body.name : undefined,
			gitEmailDomain: typeof body.gitEmailDomain === "string" ? body.gitEmailDomain : undefined,
			description: typeof body.description === "string" ? body.description : undefined,
			isDefault: typeof body.isDefault === "boolean" ? body.isDefault : undefined,
		});
		broadcast("organization_updated", { organization });
		sendJson(res, 200, { organization });
		return true;
	}

	if (method === "POST" && pathname === "/api/workspaces") {
		if (!requireOwner(res, actor)) return true;
		const body = await readJsonBody(req);
		const name = typeof body.name === "string" ? body.name.trim() : "";
		const repoPath = typeof body.repoPath === "string" ? body.repoPath.trim() : "";
		if (!name || !repoPath) {
			sendError(res, 400, "name and repoPath are required");
			return true;
		}
		let orgId: string | null | undefined =
			body.orgId === null
				? null
				: typeof body.orgId === "string" && body.orgId.trim()
					? body.orgId.trim()
					: undefined;
		if (orgId && !store.getOrganization(orgId)) {
			sendError(res, 404, `Organization not found: ${orgId}`);
			return true;
		}
		if (orgId === undefined) {
			const fallbackOrg = store.getDefaultOrganization() ?? store.ensureDefaultOrganization();
			orgId = fallbackOrg.id;
		}
		const existingWorkspace = store.listWorkspaces().find((ws) => ws.repoPath === repoPath);
		if (existingWorkspace && existingWorkspace.orgId !== orgId && workspaceHasActiveTurn(ctx, existingWorkspace.id)) {
			sendError(res, 409, "Stop active workspace turns before changing its organization");
			return true;
		}
		const ws = enrichWorkspace(
			store.upsertWorkspace({
				orgId,
				name,
				repoPath,
				defaultBranch: typeof body.defaultBranch === "string" ? body.defaultBranch : "main",
				description: typeof body.description === "string" ? body.description : "",
			}),
		);
		broadcast("workspace_updated", ws);
		sendJson(res, 201, { workspace: ws });
		return true;
	}

	const wsPatchMatch = pathname.match(/^\/api\/workspaces\/([^/]+)$/);
	if (method === "PATCH" && wsPatchMatch) {
		if (!requireOwner(res, actor)) return true;
		const workspaceId = decodeURIComponent(wsPatchMatch[1]!);
		if (!store.getWorkspace(workspaceId)) {
			sendError(res, 404, `Workspace not found: ${workspaceId}`);
			return true;
		}
		const body = await readJsonBody(req);
		const orgId =
			body.orgId === null
				? null
				: typeof body.orgId === "string" && body.orgId.trim()
					? body.orgId.trim()
					: undefined;
		if (orgId && !store.getOrganization(orgId)) {
			sendError(res, 404, `Organization not found: ${orgId}`);
			return true;
		}
		if (
			orgId !== undefined &&
			orgId !== store.getWorkspace(workspaceId)!.orgId &&
			workspaceHasActiveTurn(ctx, workspaceId)
		) {
			sendError(res, 409, "Stop active workspace turns before changing its organization");
			return true;
		}
		const ws = enrichWorkspace(
			store.updateWorkspace(workspaceId, {
				orgId,
				name: typeof body.name === "string" ? body.name : undefined,
				defaultBranch: typeof body.defaultBranch === "string" ? body.defaultBranch : undefined,
				description: typeof body.description === "string" ? body.description : undefined,
			}),
		);
		broadcast("workspace_updated", ws);
		sendJson(res, 200, { workspace: ws });
		return true;
	}

	if (method === "GET" && pathname === "/api/previews") {
		sendJson(res, 200, { previews: previewManager.listPreviews() });
		return true;
	}

	if (method === "POST" && pathname === "/api/previews") {
		if (!requireOwner(res, actor)) return true;
		const body = await readJsonBody(req);
		const title = typeof body.title === "string" ? body.title.trim() : "独立预览服务";
		const deliverableId = typeof body.deliverableId === "string" ? body.deliverableId : null;

		if (typeof body.url === "string" && body.url.trim().length > 0) {
			const info = previewManager.registerExternalPreview({
				title,
				url: body.url.trim(),
				deliverableId,
			});
			broadcast("preview_updated", info);
			sendJson(res, 201, { preview: info });
			return true;
		}

		const command = typeof body.command === "string" ? body.command.trim() : "";
		if (!command) {
			sendError(res, 400, "command or url is required");
			return true;
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
			deliverableId,
		});
		broadcast("preview_updated", info);
		sendJson(res, 201, { preview: info });
		return true;
	}

	const previewStopMatch = pathname.match(/^\/api\/previews\/([^/]+)\/stop$/);
	if (method === "POST" && previewStopMatch) {
		if (!requireOwner(res, actor)) return true;
		const previewId = decodeURIComponent(previewStopMatch[1]!);
		const info = await previewManager.stopPreview(previewId);
		if (!info) {
			sendError(res, 404, `Preview not found: ${previewId}`);
			return true;
		}
		broadcast("preview_updated", info);
		sendJson(res, 200, { preview: info });
		return true;
	}

	return false;
}
