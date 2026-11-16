import { request as httpRequest } from "node:http";

/** Minimal structural subset of Pi's extension API. No dependency on Pi's installation path. */
export interface PiExtensionApi {
	registerTool(tool: {
		name: string;
		label: string;
		description: string;
		parameters: object;
		execute(
			callId: string,
			args: unknown,
			signal?: AbortSignal,
		): Promise<{ content: { type: "text"; text: string }[]; details: unknown }>;
	}): void;
	on(event: "session_start", handler: () => Promise<void>): void;
	on(event: "before_agent_start", handler: (event: { systemPrompt: string }) => { systemPrompt: string }): void;
	getActiveTools(): string[];
	getAllTools(): { name: string }[];
	setActiveTools(names: string[]): void;
}

export default function teamExtension(pi: PiExtensionApi): void {
	const env = { ...process.env };
	async function post(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
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
	}

	for (const tool of [
		{
			name: "delegate_to_member",
			label: "咨询团队成员",
			description:
				"Ask an existing colleague to perform specialist work and return evidence. Include the objective, relevant decisions, constraints and expected result in task. Internal conversation is kept off the user channel. Do not delegate to yourself or an ancestor.",
			parameters: {
				type: "object",
				properties: { memberId: { type: "string" }, task: { type: "string" } },
				required: ["memberId", "task"],
				additionalProperties: false,
			},
		},
		{
			name: "publish_deliverable",
			label: "登记成果",
			description:
				"Publish a reviewable milestone, an explicitly requested version, or a substantial change for the user. Keep changeNote to 1-3 concise sentences with key changes and evidence. For a document saved in the workspace, use sourcePath ONLY: the host reads its exact UTF-8 text, snapshots it, and rejects changes before turn completion unless you publish again. Do not regenerate that document in content. For a document without a saved file, use content ONLY for full Markdown text. Never supply both. artifact/prototype_image: existing workspace file path in content; service_url: http(s) URL in content. Use a stable title for versioning; re-publishing a same-title document within this turn replaces its draft. Ordinary conversation and progress stay in chat; specialists return to the lead. Staged results are finalized only when this user turn succeeds.",
			parameters: {
				type: "object",
				properties: {
					type: { type: "string", enum: ["document", "artifact", "prototype_image", "service_url"] },
					title: { type: "string" },
					content: { type: "string" },
					sourcePath: {
						type: "string",
						description:
							"Document only: final UTF-8 file inside the workspace, at most 1 MiB. Supply sourcePath instead of content.",
					},
					summary: { type: "string" },
					changeNote: {
						type: "string",
						description:
							"Concise 1-3 sentence summary of this version's conclusion, key changes, and verification/process basis (shown at top of deliverable card).",
					},
				},
				required: ["type", "title", "changeNote"],
				oneOf: [
					{
						properties: { type: { const: "document" } },
						required: ["sourcePath"],
						not: { required: ["content"] },
					},
					{ required: ["content"], not: { required: ["sourcePath"] } },
				],
				additionalProperties: false,
			},
		},
		{
			name: "propose_experience",
			label: "提炼候选经验",
			description:
				"Record a reusable lesson learned during execution, debugging, user correction, or team collaboration (not status logs). Focus on efficiency improvements, root-cause troubleshooting, collaboration handoffs, user-corrected constraints, or project conventions. Distinguish role_general (cross-organization/cross-project method), company_private (organization-wide shared rules/memories), and project_private (repository-specific rules).",
			parameters: {
				type: "object",
				properties: {
					scope: { type: "string", enum: ["role_general", "company_private", "project_private"] },
					category: {
						type: "string",
						enum: [
							"efficiency",
							"troubleshooting",
							"collaboration",
							"user_correction",
							"domain_constraint",
							"general",
						],
						description:
							"Dimension: efficiency, troubleshooting, collaboration, user_correction, domain_constraint, or general.",
					},
					content: { type: "string" },
					rationale: { type: "string" },
					supersedesMemoryId: { type: "string" },
				},
				required: ["scope", "content", "rationale"],
				additionalProperties: false,
			},
		},
	]) {
		if (tool.name === "delegate_to_member" && env.PA_CAN_DELEGATE === "false") continue;
		if (tool.name === "publish_deliverable" && env.PA_CAN_PUBLISH === "false") continue;
		if (tool.name === "propose_experience" && env.PA_CAN_EXPERIENCE === "false") continue;
		pi.registerTool({
			...tool,
			async execute(callId, args, signal) {
				const result = await post("/tool", { tool: tool.name, callId, args }, signal);
				return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
			},
		});
	}
	pi.on("session_start", async () => {
		// MCP/custom tools may register after session_start. Never block later extensions' startup handlers.
		const prepare = async () => {
			const config: unknown = JSON.parse(env.PA_REQUIRED_TOOLS ?? "[]");
			if (!Array.isArray(config) || !config.every((name) => typeof name === "string"))
				throw new Error("Invalid capability configuration");
			const expected: string[] = config;
			const matches = (pattern: string, name: string) =>
				pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
			const deadline = Date.now() + 10_000;
			let available = pi.getAllTools().map((tool) => tool.name);
			while (
				!expected.every((pattern) => available.some((name) => matches(pattern, name))) &&
				Date.now() < deadline
			) {
				await new Promise((resolve) => setTimeout(resolve, 100));
				available = pi.getAllTools().map((tool) => tool.name);
			}
			if (expected.length)
				pi.setActiveTools(available.filter((name) => expected.some((pattern) => matches(pattern, name))));
			await post("/ready", pi.getActiveTools());
		};
		void prepare().catch(() => {
			process.stderr.write("Personal Agent capability handshake failed\n");
		});
	});
	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${env.PA_MEMBER_CONTEXT ?? ""}\n\n当前已装配工具：${pi.getActiveTools().join(", ")}。仅能使用实际工具，不得把依赖声明当作工具已执行。`,
	}));
}
