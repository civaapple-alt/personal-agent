import { createTeamBridgeClient, type PiHostToolExtensionApi } from "../../worker-runtime/pi/bridge-client.ts";

export default function boardExtension(pi: PiHostToolExtensionApi): void {
	const env = { ...process.env };
	const post = createTeamBridgeClient(env);
	const boardRole = env.PA_BOARD_ROLE?.trim() || "";

	if (boardRole === "coordinator") {
		pi.registerTool({
			name: "spawn_board_agent",
			label: "组队派工",
			description:
				"Spawn or update a dynamic builder or verifier agent on the matter's collaboration board with a clear ownedScope and acceptanceCriteria. Coordinator-only.",
			parameters: {
				type: "object",
				properties: {
					agentId: {
						type: "string",
						description: "Unique board agent id (e.g. 'storage-slice', 'api-builder', 'independent-verifier').",
					},
					boardRole: {
						type: "string",
						enum: ["builder", "verifier"],
						description:
							"Dynamic member role: builder edits/tests within scope; verifier performs independent read/test review without editing.",
					},
					displayName: {
						type: "string",
						description: "Optional human-readable display name for UI board timeline.",
					},
					sourceMemberId: {
						type: "string",
						description: "Optional base team member id to inherit capability persona/skills from.",
					},
					brief: {
						type: "string",
						description: "Mission brief describing what this agent owns and what done looks like.",
					},
					skills: {
						type: "array",
						items: { type: "string" },
						description: "Optional skill IDs to prioritize for this agent.",
					},
					ownedScope: {
						type: "array",
						items: { type: "string" },
						description: "Owned workspace paths/directories/modules for this agent.",
					},
					acceptanceCriteria: {
						type: "string",
						description: "Explicit acceptance checklist used by Coordinator/Verifier.",
					},
				},
				required: ["agentId", "boardRole", "brief"],
				additionalProperties: false,
			},
			async execute(callId, args, signal) {
				const result = await post("/tool", { tool: "spawn_board_agent", callId, args }, signal);
				return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
			},
		});
	}

	pi.registerTool({
		name: "post_to_board",
		label: "发布公告板动态",
		description:
			"Publish a structured post to the matter collaboration board and asynchronously @mention target board agents (or '@user' for human clarification/decision, '@coordinator' for escalation/summary).",
		parameters: {
			type: "object",
			properties: {
				kind: {
					type: "string",
					enum: [
						"assign",
						"progress",
						"handoff",
						"verify_pass",
						"verify_rework",
						"escalate",
						"clarification",
						"summary",
					],
				},
				mentions: {
					type: "array",
					items: { type: "string" },
					description:
						"Target agent IDs (e.g. ['builder-1'], ['verifier'], ['coordinator'], ['user'], or ['all']).",
				},
				refPostNos: {
					type: "array",
					items: { type: "integer", minimum: 1 },
					description: "Optional referenced prior board post numbers.",
				},
				summary: {
					type: "string",
					description: "Concise one-line summary shown in incremental wakeups and UI timeline.",
				},
				body: {
					type: "string",
					description:
						"Full detailed specification, diffs, test evidence, or review findings (lazy-loaded via read_board_post).",
				},
				artifacts: {
					type: "object",
					description: "Optional structured artifacts ({ files, commits, commands, spaceDocumentIds }).",
				},
				verification: {
					type: "object",
					properties: {
						target: { type: "string" },
						criteria: { type: "string" },
						verdict: { type: "string", enum: ["pass", "rework", "pending"] },
						authorAgentId: { type: "string" },
					},
					required: ["target", "verdict"],
					additionalProperties: false,
				},
			},
			required: ["kind", "mentions", "summary"],
			additionalProperties: false,
		},
		async execute(callId, args, signal) {
			const result = await post("/tool", { tool: "post_to_board", callId, args }, signal);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});

	pi.registerTool({
		name: "read_board_post",
		label: "读取公告板正文",
		description:
			"Lazy-load the complete body, artifacts, and verification details of a specific board post by postNo.",
		parameters: {
			type: "object",
			properties: {
				postNo: {
					type: "integer",
					minimum: 1,
					description: "Sequential board post number (#N) to load.",
				},
			},
			required: ["postNo"],
			additionalProperties: false,
		},
		async execute(callId, args, signal) {
			const result = await post("/tool", { tool: "read_board_post", callId, args }, signal);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});
}
