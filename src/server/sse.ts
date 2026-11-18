import type { IncomingMessage, ServerResponse } from "node:http";
import type { PersonalAgentStore } from "../storage/repositories.ts";
import { canAccessMatter, canAccessOrganization, canAccessWorkspace } from "./acl.ts";
import type { RequestActor } from "./auth.ts";

export interface SseBroadcastScope {
	orgId?: string | null;
	matterId?: string | null;
	workspaceId?: string | null;
	userId?: string | null;
	adminOnly?: boolean;
}

interface SseClientMeta {
	actor: RequestActor;
}

/** Manages Server-Sent Event subscriptions, heartbeats, scoped broadcasts, and revoked-session teardown. */
export function createSseHub(store?: PersonalAgentStore) {
	const clients = new Map<ServerResponse, SseClientMeta>();

	const isRecipientAuthorized = (meta: SseClientMeta, scope?: SseBroadcastScope): boolean => {
		if (!scope || !store) return true;
		const { actor } = meta;
		if (actor.user && actor.user.status !== "active") return false;
		if (scope.adminOnly) {
			return (
				actor.authKind === "loopback" ||
				actor.user?.platformRole === "super_admin" ||
				(actor.authKind === "legacy_token" && actor.collaborator.permissionRole === "owner")
			);
		}
		if (scope.userId) {
			return Boolean(actor.user && actor.user.id === scope.userId);
		}
		if (scope.matterId) {
			const matter = store.getMatter(scope.matterId);
			if (matter) return canAccessMatter(store, actor, matter);
		}
		if (scope.workspaceId) {
			const ws = store.getWorkspace(scope.workspaceId);
			if (ws) return canAccessWorkspace(store, actor, ws);
		}
		if (scope.orgId !== undefined) {
			return canAccessOrganization(store, actor, scope.orgId);
		}
		return true;
	};

	const inferScope = (eventName: string, payload: unknown): SseBroadcastScope | undefined => {
		if (!store || !payload || typeof payload !== "object") return undefined;
		const obj = payload as Record<string, unknown>;
		if (typeof obj.matterId === "string" && obj.matterId) {
			return { matterId: obj.matterId };
		}
		if (eventName === "workspace_updated") {
			const wsId = typeof obj.id === "string" ? obj.id : undefined;
			const orgId = obj.orgId === null || typeof obj.orgId === "string" ? (obj.orgId as string | null) : undefined;
			if (wsId || orgId !== undefined) return { workspaceId: wsId, orgId };
		}
		if (eventName === "organization_updated") {
			const orgObj = obj.organization as Record<string, unknown> | undefined;
			const orgId = typeof orgObj?.id === "string" ? orgObj.id : undefined;
			if (orgId) return { orgId };
		}
		if (eventName === "deliverable_updated" && typeof obj.deliverableId === "string") {
			const deliv = store.getDeliverable(obj.deliverableId);
			if (deliv) return { matterId: deliv.matterId };
		}
		if (eventName === "memory_updated") {
			const mem = obj.memory as Record<string, unknown> | undefined;
			if (typeof mem?.orgId === "string") return { orgId: mem.orgId };
		}
		return undefined;
	};

	const broadcast = (eventName: string, payload: unknown, scope?: SseBroadcastScope): void => {
		const effectiveScope = scope ?? inferScope(eventName, payload);
		const frame = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
		for (const [client, meta] of [...clients.entries()]) {
			if (client.destroyed || client.writableEnded) {
				clients.delete(client);
				continue;
			}
			if (!isRecipientAuthorized(meta, effectiveScope)) continue;
			client.write(frame);
		}
	};

	const revokeTokenSessions = (collaboratorOrUserId: string, reason: string): void => {
		const frame = `event: auth_revoked\ndata: ${JSON.stringify({ collaboratorId: collaboratorOrUserId, reason })}\n\n`;
		for (const [client, meta] of [...clients.entries()]) {
			if (!meta.actor.viaToken) continue;
			const matchesUser = meta.actor.user?.id === collaboratorOrUserId;
			const matchesCollab = meta.actor.collaborator.id === collaboratorOrUserId;
			if (!matchesUser && !matchesCollab) continue;
			clients.delete(client);
			if (!client.destroyed && !client.writableEnded) {
				client.write(frame);
				client.end();
			}
		}
	};

	const handleEventsStream = (req: IncomingMessage, res: ServerResponse, actor: RequestActor | null): void => {
		res.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
		});
		res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);
		if (actor) {
			clients.set(res, { actor });
		}
		const heartbeat = setInterval(() => {
			if (!res.destroyed && !res.writableEnded) {
				res.write(": ping\n\n");
			}
		}, 15000);
		req.on("close", () => {
			clearInterval(heartbeat);
			clients.delete(res);
		});
	};

	const closeAll = (): void => {
		for (const client of clients.keys()) {
			client.end();
		}
		clients.clear();
	};

	return { broadcast, revokeTokenSessions, handleEventsStream, closeAll };
}
