import type { IncomingMessage, ServerResponse } from "node:http";
import { buildRuntimeOverview } from "../../orchestrator/runtime-info.ts";
import { DEFAULT_OWNER_COLLABORATOR_ID, toPublicCollaborator } from "../../storage/repositories.ts";
import type { CollaboratorRole } from "../../storage/types.ts";
import {
	extractHeaderToken,
	isLoopbackRemote,
	parseCookies,
	type RequestActor,
	requireOwner,
	SESSION_COOKIE_NAME,
} from "../auth.ts";
import { readJsonBody, sendError, sendJson } from "../http.ts";
import { enrichWorkspace, formatMemoryMap, type RouteRequest, type ServerRouteContext } from "./context.ts";

/** Handle pre-auth session endpoints; returns true if request is completed. */
export async function handleAuthRoutes(
	ctx: ServerRouteContext,
	req: IncomingMessage,
	res: ServerResponse,
	method: string,
	pathname: string,
	actor: RequestActor | null,
	requireAuth: boolean,
): Promise<boolean> {
	const { store } = ctx;

	if (method === "GET" && pathname === "/api/auth/session") {
		const presentedToken = Boolean(extractHeaderToken(req) || parseCookies(req)[SESSION_COOKIE_NAME]?.trim());
		sendJson(res, 200, {
			authenticated: Boolean(actor),
			permissionRequired: requireAuth || !isLoopbackRemote(req),
			revokedSession: Boolean(!actor && presentedToken),
			currentUser: actor ? toPublicCollaborator(actor.collaborator) : null,
		});
		return true;
	}

	if (method === "POST" && pathname === "/api/auth/login") {
		const body = await readJsonBody(req);
		const token = typeof body.token === "string" ? body.token.trim() : "";
		if (!token) {
			sendError(res, 400, "token is required");
			return true;
		}
		const matched = store.getCollaboratorByToken(token);
		if (!matched) {
			sendError(res, 401, "无效或已失效的邀请口令");
			return true;
		}
		res.setHeader(
			"Set-Cookie",
			`${SESSION_COOKIE_NAME}=${encodeURIComponent(matched.token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
		);
		sendJson(res, 200, {
			ok: true,
			currentUser: toPublicCollaborator(matched),
		});
		return true;
	}

	if (method === "POST" && pathname === "/api/auth/logout") {
		res.setHeader("Set-Cookie", `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
		sendJson(res, 200, { ok: true });
		return true;
	}

	return false;
}

/** Handle `/api/bootstrap` and `/api/collaborators*` endpoints. */
export async function handleBootstrapAndCollaboratorRoutes(ctx: ServerRouteContext, r: RouteRequest): Promise<boolean> {
	const { store, orchestrator, dialogBroker, previewManager, activeRuns, broadcast, revokeTokenSessions } = ctx;
	const { req, res, method, pathname, actor } = r;

	if (method === "GET" && pathname === "/api/bootstrap") {
		const liveTemplates = orchestrator.listTemplates();
		const allCollaborators = store.listCollaborators();
		sendJson(res, 200, {
			innerDemoAvailable: Boolean(ctx.innerMatterDemo),
			currentUser: toPublicCollaborator(actor!.collaborator),
			collaborators:
				actor!.collaborator.permissionRole === "owner"
					? allCollaborators
					: allCollaborators.map(toPublicCollaborator),
			members: store.listMembers(),
			templates: liveTemplates.map((t) => ({
				id: t.id,
				name: t.name,
				title: t.title,
				roleKind: t.roleKind ?? (t.id === "role-architect" ? "architect" : "business"),
				version: t.version,
				skills: t.skills,
				mcpDependencies: t.mcpDependencies,
				tools: t.tools,
				keywords: t.keywords,
				shareable: t.shareable,
				antiJobs: t.antiJobs ?? [],
				responsibilities: t.sections.responsibilitiesAndBoundaries,
			})),
			workspaces: store.listWorkspaces().map(enrichWorkspace),
			organizations: store.listOrganizations(),
			matters: store.listMatters(),
			deliverables: store.listDeliverables(),
			pendingDialogs: dialogBroker.listPending(),
			previews: previewManager.listPreviews(),
			memoriesByMember: formatMemoryMap(store),
			activeRuns: Object.fromEntries(
				[...activeRuns.entries()].map(([matterId, run]) => [
					matterId,
					{ ...run.progress, matterId, startedAt: run.startedAt },
				]),
			),
		});
		return true;
	}

	if (method === "GET" && pathname === "/api/runtime") {
		const overview = await buildRuntimeOverview({
			config: orchestrator.getRuntimeConfig(),
			serverConfig: ctx.getServerRuntimeConfig?.(),
			activeMembers: store.listMembers(),
			isOwner: actor!.collaborator.permissionRole === "owner",
			probePiCli: ctx.probePiCli,
		});
		sendJson(res, 200, overview);
		return true;
	}

	if (method === "GET" && pathname === "/api/collaborators") {
		const list = store.listCollaborators();
		sendJson(res, 200, {
			collaborators: actor!.collaborator.permissionRole === "owner" ? list : list.map(toPublicCollaborator),
		});
		return true;
	}

	if (method === "POST" && pathname === "/api/collaborators") {
		if (!requireOwner(res, actor)) return true;
		const body = await readJsonBody(req);
		const name = typeof body.name === "string" ? body.name.trim() : "";
		if (!name) {
			sendError(res, 400, "name is required");
			return true;
		}
		const roleTitle = typeof body.roleTitle === "string" ? body.roleTitle.trim() : "";
		const orgId = typeof body.orgId === "string" && body.orgId.trim() ? body.orgId.trim() : null;
		if (orgId && !store.getOrganization(orgId)) {
			sendError(res, 404, `Organization not found: ${orgId}`);
			return true;
		}
		const permissionRole: CollaboratorRole = body.permissionRole === "owner" ? "owner" : "collaborator";
		const collaborator = store.upsertCollaborator({
			id: typeof body.id === "string" && body.id.trim() ? body.id.trim() : undefined,
			name,
			roleTitle: roleTitle || (permissionRole === "owner" ? "团队所有者" : "协同同事"),
			permissionRole,
			orgId,
		});
		broadcast("collaborator_updated", { collaborator: toPublicCollaborator(collaborator) });
		sendJson(res, 201, { collaborator });
		return true;
	}

	const collabRegenMatch = pathname.match(/^\/api\/collaborators\/([^/]+)\/regenerate-token$/);
	if (method === "POST" && collabRegenMatch) {
		if (!requireOwner(res, actor)) return true;
		const collabId = decodeURIComponent(collabRegenMatch[1]!);
		const collaborator = store.regenerateCollaboratorToken(collabId);
		if (!collaborator) {
			sendError(res, 404, `Collaborator not found: ${collabId}`);
			return true;
		}
		revokeTokenSessions(collabId, "token_regenerated");
		broadcast("collaborator_updated", { collaborator: toPublicCollaborator(collaborator) });
		sendJson(res, 200, { collaborator });
		return true;
	}

	const collabItemMatch = pathname.match(/^\/api\/collaborators\/([^/]+)$/);
	if (method === "PATCH" && collabItemMatch) {
		if (!requireOwner(res, actor)) return true;
		const collabId = decodeURIComponent(collabItemMatch[1]!);
		const existing = store.getCollaborator(collabId);
		if (!existing) {
			sendError(res, 404, `Collaborator not found: ${collabId}`);
			return true;
		}
		const body = await readJsonBody(req);
		const orgId =
			body.orgId === null
				? null
				: typeof body.orgId === "string" && body.orgId.trim()
					? body.orgId.trim()
					: existing.orgId;
		if (orgId && !store.getOrganization(orgId)) {
			sendError(res, 404, `Organization not found: ${orgId}`);
			return true;
		}
		const permissionRole: CollaboratorRole =
			collabId === DEFAULT_OWNER_COLLABORATOR_ID
				? "owner"
				: body.permissionRole === "owner"
					? "owner"
					: body.permissionRole === "collaborator"
						? "collaborator"
						: existing.permissionRole;
		const collaborator = store.upsertCollaborator({
			id: collabId,
			name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : existing.name,
			roleTitle:
				typeof body.roleTitle === "string" && body.roleTitle.trim() ? body.roleTitle.trim() : existing.roleTitle,
			permissionRole,
			orgId,
		});
		broadcast("collaborator_updated", { collaborator: toPublicCollaborator(collaborator) });
		sendJson(res, 200, { collaborator });
		return true;
	}

	if (method === "DELETE" && collabItemMatch) {
		if (!requireOwner(res, actor)) return true;
		const collabId = decodeURIComponent(collabItemMatch[1]!);
		if (collabId === DEFAULT_OWNER_COLLABORATOR_ID) {
			sendError(res, 400, "Cannot delete the default owner collaborator");
			return true;
		}
		if (!store.getCollaborator(collabId)) {
			sendError(res, 404, `Collaborator not found: ${collabId}`);
			return true;
		}
		for (const matter of store.listMatters()) {
			if (matter.collaboratorIds.includes(collabId)) {
				store.updateMatterCollaborators(
					matter.id,
					matter.collaboratorIds.filter((id) => id !== collabId),
				);
			}
		}
		store.deleteCollaborator(collabId);
		revokeTokenSessions(collabId, "collaborator_deleted");
		broadcast("collaborator_updated", { deletedId: collabId });
		sendJson(res, 200, { ok: true, deletedId: collabId });
		return true;
	}

	return false;
}
