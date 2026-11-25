import { request as httpRequest } from "node:http";

/** Minimal structural subset of Pi's extension API needed by PA host-bridge Pi entries. */
export interface PiHostToolExtensionApi {
	registerTool(tool: {
		name: string;
		label: string;
		description: string;
		promptSnippet?: string;
		promptGuidelines?: string[];
		parameters: object;
		execute(
			callId: string,
			args: unknown,
			signal?: AbortSignal,
		): Promise<{ content: { type: "text"; text: string }[]; details: unknown }>;
	}): void;
}

export function createTeamBridgeClient(env: { PA_TEAM_BRIDGE_URL?: string; PA_TEAM_BRIDGE_TOKEN?: string }) {
	return async function post(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
		signal?.throwIfAborted();
		const target = new URL(path, env.PA_TEAM_BRIDGE_URL);
		const payload = JSON.stringify(body);
		// Use node:http with timeout disabled instead of fetch() so long-running delegations never hit Undici's 300s headersTimeout.
		const { status, raw } = await new Promise<{ status: number; raw: string }>((resolve, reject) => {
			let settled = false;
			const finishError = (err: unknown) => {
				if (settled) return;
				settled = true;
				signal?.removeEventListener("abort", onAbort);
				reject(err instanceof Error ? err : new Error(String(err)));
			};
			const req = httpRequest(
				target,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${env.PA_TEAM_BRIDGE_TOKEN}`,
						"Content-Type": "application/json",
						"Content-Length": String(Buffer.byteLength(payload)),
					},
					timeout: 0,
				},
				(res) => {
					const chunks: Buffer[] = [];
					res.on("data", (chunk: Buffer) => chunks.push(chunk));
					res.on("end", () => {
						if (settled) return;
						settled = true;
						signal?.removeEventListener("abort", onAbort);
						resolve({ status: res.statusCode ?? 500, raw: Buffer.concat(chunks).toString("utf8") });
					});
					res.on("error", finishError);
				},
			);
			const onAbort = () => {
				const reason = signal?.reason instanceof Error ? signal.reason : new Error("Tool request aborted");
				req.destroy(reason);
				finishError(reason);
			};
			if (signal) {
				if (signal.aborted) {
					onAbort();
					return;
				}
				signal.addEventListener("abort", onAbort, { once: true });
			}
			req.setTimeout(0);
			req.on("error", finishError);
			req.end(payload);
		});
		const value: unknown = JSON.parse(raw);
		if (status < 200 || status >= 300) {
			throw new Error(
				value && typeof value === "object" && "error" in value ? String(value.error) : "Team bridge failed",
			);
		}
		return value;
	};
}
