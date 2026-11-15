import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

export type TeamToolCall =
	| { tool: "delegate_to_member"; callId: string; memberId: string; task: string }
	| {
			tool: "publish_deliverable";
			callId: string;
			type: "document" | "artifact" | "prototype_image" | "service_url";
			title: string;
			content: string;
			summary: string;
			changeNote: string;
	  };

function requiredString(value: unknown, name: string, max = 64_000): string {
	if (typeof value !== "string" || !value.trim() || value.length > max) {
		throw new Error(`${name} must be nonempty text (max ${max} characters)`);
	}
	return value.trim();
}

function parseCall(value: unknown): TeamToolCall {
	if (!value || typeof value !== "object") throw new Error("Expected a tool request");
	if (!("tool" in value) || !("callId" in value) || !("args" in value)) throw new Error("Invalid tool request");
	const callId = requiredString(value.callId, "callId", 256);
	const args = value.args;
	if (!args || typeof args !== "object") throw new Error("Expected tool arguments");
	if (value.tool === "delegate_to_member" && "memberId" in args && "task" in args) {
		return {
			tool: value.tool,
			callId,
			memberId: requiredString(args.memberId, "memberId", 256),
			task: requiredString(args.task, "task", 16_000),
		};
	}
	if (value.tool === "publish_deliverable" && "type" in args && "title" in args && "content" in args) {
		const changeNote =
			"changeNote" in args
				? requiredString(args.changeNote, "changeNote", 2000)
				: requiredString(undefined, "changeNote");
		const type = args.type;
		if (type !== "document" && type !== "artifact" && type !== "prototype_image" && type !== "service_url") {
			throw new Error("Unsupported deliverable type");
		}
		return {
			tool: value.tool,
			callId,
			type,
			title: requiredString(args.title, "title", 200),
			content: requiredString(args.content, "content"),
			changeNote,
			summary: "summary" in args && typeof args.summary === "string" ? args.summary.slice(0, 1000) : "",
		};
	}
	throw new Error("Unsupported tool or invalid arguments");
}

/** Abort host waits even when the external dialog/transport promise has not completed. */
export function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			signal.removeEventListener("abort", onAbort);
			reject(signal.reason);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		void pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

/** Per-worker loopback transport. The caller identity and scope are bound by the host, never model arguments. */
export async function createTeamToolBridge(
	handle: (call: TeamToolCall, signal: AbortSignal) => Promise<unknown>,
	signal: AbortSignal,
) {
	const token = randomBytes(32).toString("hex");
	const operations = new Set<Promise<void>>();
	const calls = new Map<string, { fingerprint: string; result: Promise<unknown> }>();
	let readyResolve!: (tools: string[]) => void;
	const ready = new Promise<string[]>((resolve) => {
		readyResolve = resolve;
	});
	const server = createServer((req, res) => {
		req.setTimeout(0);
		res.setTimeout(0);
		const operation = (async () => {
			const controller = new AbortController();
			res.on("close", () => {
				if (!res.writableEnded) controller.abort(new Error("Tool connection closed"));
			});
			try {
				if (req.method !== "POST" || req.headers.authorization !== `Bearer ${token}`) {
					res.writeHead(403).end();
					return;
				}
				const buffers: Buffer[] = [];
				let size = 0;
				for await (const chunk of req) {
					size += chunk.length;
					if (size > 262_144) throw new Error("Tool request too large");
					buffers.push(chunk);
				}
				const value: unknown = JSON.parse(Buffer.concat(buffers).toString("utf8"));
				const requestSignal = AbortSignal.any([signal, controller.signal]);
				requestSignal.throwIfAborted();
				let result: unknown;
				if (req.url === "/ready") {
					if (!Array.isArray(value) || !value.every((name) => typeof name === "string"))
						throw new Error("Invalid tool manifest");
					readyResolve(value);
					result = { ready: true };
				} else if (req.url === "/tool") {
					const call = parseCall(value);
					const fingerprint = JSON.stringify(call);
					const prior = calls.get(call.callId);
					if (prior && prior.fingerprint !== fingerprint)
						throw new Error("Tool call ID reused with different arguments");
					const pending = prior?.result ?? handle(call, requestSignal);
					calls.set(call.callId, { fingerprint, result: pending });
					result = await pending;
				} else {
					throw new Error("Unknown bridge route");
				}
				res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ result }));
			} catch (error) {
				res.writeHead(400, { "Content-Type": "application/json" }).end(
					JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
				);
			}
		})();
		operations.add(operation);
		void operation.finally(() => operations.delete(operation));
	});
	server.requestTimeout = 0;
	server.headersTimeout = 0;
	server.keepAliveTimeout = 0;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing bridge address");
	return {
		env: { PA_TEAM_BRIDGE_URL: `http://127.0.0.1:${address.port}`, PA_TEAM_BRIDGE_TOKEN: token },
		async waitReady(): Promise<string[]> {
			return await abortable(ready, AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
		},
		async close(): Promise<void> {
			const closed = new Promise<void>((resolve) => server.close(() => resolve()));
			server.closeAllConnections();
			await Promise.allSettled([...operations]);
			await closed;
		},
	};
}
