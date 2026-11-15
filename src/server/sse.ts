import type { IncomingMessage, ServerResponse } from "node:http";
import type { RequestActor } from "./auth.ts";

/** Manages Server-Sent Event subscriptions, heartbeats, and revoked-session teardown. */
export function createSseHub() {
	const clients = new Map<ServerResponse, { collaboratorId: string; viaToken: boolean }>();

	const broadcast = (eventName: string, payload: unknown): void => {
		const frame = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
		for (const client of [...clients.keys()]) {
			if (client.destroyed || client.writableEnded) {
				clients.delete(client);
				continue;
			}
			client.write(frame);
		}
	};

	const revokeTokenSessions = (collaboratorId: string, reason: string): void => {
		const frame = `event: auth_revoked\ndata: ${JSON.stringify({ collaboratorId, reason })}\n\n`;
		for (const [client, meta] of [...clients.entries()]) {
			if (!meta.viaToken || meta.collaboratorId !== collaboratorId) continue;
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
			clients.set(res, { collaboratorId: actor.collaborator.id, viaToken: actor.viaToken });
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
