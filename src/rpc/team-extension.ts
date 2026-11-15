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
		const response = await fetch(`${env.PA_TEAM_BRIDGE_URL}${path}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${env.PA_TEAM_BRIDGE_TOKEN}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal,
		});
		const value: unknown = await response.json();
		if (!response.ok) {
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
				"Publish a reviewable milestone, an explicitly requested version, or a substantial change for the user. Explain what changed and the evidence/decision behind this version in changeNote. document: full finished document in content; artifact/prototype_image: existing workspace file path; service_url: http(s) URL. Give a stable title for versioning. Ordinary conversation, clarification, progress updates and minor discussion edits stay in chat. Do not decide from response length or number of turns. Specialist consultations return to the lead rather than becoming user deliverables. Staged results are finalized only when this user turn succeeds.",
			parameters: {
				type: "object",
				properties: {
					type: { type: "string", enum: ["document", "artifact", "prototype_image", "service_url"] },
					title: { type: "string" },
					content: { type: "string" },
					summary: { type: "string" },
					changeNote: {
						type: "string",
						description:
							"Why this is a reviewable milestone or substantial revision; cite relevant feedback, decisions or verification.",
					},
				},
				required: ["type", "title", "content", "changeNote"],
				additionalProperties: false,
			},
		},
	]) {
		if (tool.name === "publish_deliverable" && env.PA_CAN_PUBLISH === "false") continue;
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
