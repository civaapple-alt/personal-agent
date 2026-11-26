import type { ServerResponse } from "node:http";
import type { SseEventName, SseEventPayloadMap } from "@pa/contracts/sse-events";
import type { PersonalAgentStore } from "../storage/repositories.ts";
import { canAccessMatter, canAccessOrganization, canAccessWorkspace } from "./acl.ts";
import { isSuperAdminActor, type RequestActor } from "./auth.ts";

export interface SseBroadcastScope {
	orgId?: string | null;
	matterId?: string | null;
	workspaceId?: string | null;
	userId?: string | null;
	adminOnly?: boolean;
}

export type SseBroadcastFn = <K extends SseEventName>(
	eventName: K,
	payload: SseEventPayloadMap[K],
	scope?: SseBroadcastScope,
) => void;

interface SseClientMeta {
	actor: RequestActor;
}

/** Manages Server-Sent Event subscriptions, heartbeats, scoped broadcasts, and revoked-session teardown. */
export function createSseHub(store?: PersonalAgentStore) {
	const clients = new Map<ServerResponse, SseClientMeta>();
	const endClient = (client: ServerResponse): void => {
		clients.delete(client);
		if (!client.destroyed && !client.writableEnded) client.end();
	};

	const refreshAccountActor = (actor: RequestActor): RequestActor | null => {
		if (!store || actor.authKind !== "session") return actor;
		const user = actor.sessionTokenHash ? store.getSessionAndUserByHash(actor.sessionTokenHash)?.user : null;
		return user?.status === "active" ? { ...actor, user } : null;
	};

	const isRecipientAuthorized = (actor: RequestActor, scope?: SseBroadcastScope): boolean => {
		if (!scope || !store) return true;
		if (actor.user && actor.user.status !== "active") return false;
		if (scope.adminOnly) {
			return isSuperAdminActor(actor);
		}
		if (scope.userId) {
			return Boolean(actor.user && actor.user.id === scope.userId);
		}
		if (scope.matterId) {
			return canAccessMatter(store, actor, store.getMatter(scope.matterId));
		}
		if (scope.workspaceId) {
			return canAccessWorkspace(store, actor, store.getWorkspace(scope.workspaceId));
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
		if (eventName === "preview_updated") return { adminOnly: true };
		return undefined;
	};

	const broadcast: SseBroadcastFn = (eventName, payload, scope) => {
		const effectiveScope = scope ?? inferScope(eventName, payload);
		const frame = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
		for (const [client, meta] of [...clients.entries()]) {
			if (client.destroyed || client.writableEnded) {
				clients.delete(client);
				continue;
			}
			const actor = refreshAccountActor(meta.actor);
			if (!actor) {
				endClient(client);
				continue;
			}
			if (!isRecipientAuthorized(actor, effectiveScope)) continue;
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

	const closeAccountSession = (sessionHash: string): void => {
		for (const [client, { actor }] of clients) {
			if (actor.sessionTokenHash === sessionHash) endClient(client);
		}
	};

	const handleEventsStream = (res: ServerResponse, actor: RequestActor | null): void => {
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
			if (res.destroyed || res.writableEnded) return;
			if (actor && !refreshAccountActor(actor)) {
				endClient(res);
				return;
			}
			res.write(": ping\n\n");
		}, 15000);
		res.on("close", () => {
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

	return { broadcast, revokeTokenSessions, closeAccountSession, handleEventsStream, closeAll };
}
