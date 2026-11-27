import { fileURLToPath } from "node:url";
import { createTeamBridgeClient } from "../shared/team-bridge-client.ts";
import { LocalBoardEngine } from "./local-engine.ts";
import { sanitizeSlug } from "./local-store.ts";
import type {
	BoardExtensionApi,
	BoardRole,
	LocalWorkerExecutor,
	PostToBoardArgs,
	ReadBoardPostArgs,
	SpawnBoardAgentArgs,
} from "./types.ts";

export interface CreateBoardExtensionOptions {
	env?: Record<string, string | undefined>;
	cwd?: string;
	boardDir?: string;
	extensionEntryPath?: string;
	executor?: LocalWorkerExecutor;
}

const MODEL_OVERRIDE_SCHEMA = {
	type: "object",
	properties: {
		provider: { type: "string" },
		model: { type: "string" },
		thinkingLevel: {
			type: "string",
			enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
		},
	},
	required: ["provider", "model"],
	additionalProperties: false,
	description: "Optional explicit provider/model override (e.g. heterogeneous cross-model Verifier).",
};

const SPAWN_BOARD_AGENT_PARAMETERS = {
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
		modelOverride: MODEL_OVERRIDE_SCHEMA,
	},
	required: ["agentId", "boardRole", "brief"],
	additionalProperties: false,
};

const POST_TO_BOARD_PARAMETERS = {
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
			description: "Target agent IDs (e.g. ['builder-1'], ['verifier'], ['coordinator'], ['user'], or ['all']).",
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
};

const READ_BOARD_POST_PARAMETERS = {
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
};

function toToolResult(value: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
}

function registerPaBridgeTools(pi: BoardExtensionApi, env: Record<string, string | undefined>): void {
	const post = createTeamBridgeClient(env);
	const boardRole = env.PA_BOARD_ROLE?.trim() || "";

	if (boardRole === "coordinator") {
		pi.registerTool({
			name: "spawn_board_agent",
			label: "组队派工",
			description:
				"Spawn or update a dynamic builder or verifier agent on the matter's collaboration board with a clear ownedScope and acceptanceCriteria. Coordinator-only.",
			parameters: SPAWN_BOARD_AGENT_PARAMETERS,
			async execute(callId, args, signal) {
				const result = await post("/tool", { tool: "spawn_board_agent", callId, args }, signal);
				return toToolResult(result);
			},
		});
	}

	pi.registerTool({
		name: "post_to_board",
		label: "发布公告板动态",
		description:
			"Publish a structured post to the matter collaboration board and asynchronously @mention target board agents (or '@user' for human clarification/decision, '@coordinator' for escalation/summary).",
		parameters: POST_TO_BOARD_PARAMETERS,
		async execute(callId, args, signal) {
			const result = await post("/tool", { tool: "post_to_board", callId, args }, signal);
			return toToolResult(result);
		},
	});

	pi.registerTool({
		name: "read_board_post",
		label: "读取公告板正文",
		description:
			"Lazy-load the complete body, artifacts, and verification details of a specific board post by postNo.",
		parameters: READ_BOARD_POST_PARAMETERS,
		async execute(callId, args, signal) {
			const result = await post("/tool", { tool: "read_board_post", callId, args }, signal);
			return toToolResult(result);
		},
	});
}

function registerStandaloneTools(pi: BoardExtensionApi, options: CreateBoardExtensionOptions = {}): void {
	const env = options.env ?? process.env;
	const cwd = options.cwd ?? process.cwd();
	const isSubWorker = env.PA_LOCAL_BOARD_SUBWORKER === "1";
	const boardRole = (env.PA_BOARD_ROLE?.trim() || (isSubWorker ? "builder" : "coordinator")) as BoardRole;
	const agentId = env.PA_BOARD_AGENT_ID?.trim() || "coordinator";
	const extensionEntryPath = options.extensionEntryPath ?? fileURLToPath(import.meta.url);

	let activeBoardId = env.PA_LOCAL_BOARD_ID?.trim() || "default";
	let explicitBoardDir = options.boardDir ?? (env.PA_LOCAL_BOARD_DIR?.trim() || undefined);
	let cachedEngine: LocalBoardEngine | undefined;

	const getEngine = (): LocalBoardEngine => {
		if (!cachedEngine || cachedEngine.boardId !== activeBoardId) {
			cachedEngine = new LocalBoardEngine({
				cwd,
				boardId: activeBoardId,
				boardDir: explicitBoardDir,
				boardRole,
				agentId,
				isSubWorker,
				extensionEntryPath,
				executor: options.executor,
			});
		}
		return cachedEngine;
	};

	if (!isSubWorker && boardRole === "coordinator") {
		pi.registerTool({
			name: "spawn_board_agent",
			label: "组队派工",
			description:
				"Spawn or update a dynamic builder or verifier agent on the local collaboration board with ownedScope, acceptanceCriteria, and optional modelOverride. Root coordinator only.",
			promptSnippet: "Spawn a builder or read-only verifier on the local collaboration board for multi-agent work",
			promptGuidelines: [
				"When a complex task benefits from splitting build and independent verification (or parallel module owners), spawn builder/verifier agents on the board and kick off work via post_to_board.",
				"Never combine implementation and final verification in the same agent; assign a separate verifier role.",
			],
			parameters: SPAWN_BOARD_AGENT_PARAMETERS,
			async execute(_callId, args) {
				const result = getEngine().spawnBoardAgent(args as unknown as SpawnBoardAgentArgs);
				return toToolResult(result);
			},
		});
	}

	pi.registerTool({
		name: "post_to_board",
		label: "发布公告板动态",
		description:
			"Publish a structured post to the local collaboration board and asynchronously wake @mentioned builder/verifier sessions via incremental summaries (or ask '@user' via Pi UI).",
		promptSnippet: "Post an assignment, handoff, or verification verdict to wake @mentioned board agents",
		promptGuidelines: [
			"Use post_to_board after spawning board agents to issue #1 assign, and always tag @coordinator on final verify_pass.",
		],
		parameters: POST_TO_BOARD_PARAMETERS,
		async execute(_callId, args, signal, _onUpdate, ctx) {
			const result = await getEngine().postToBoard(args as unknown as PostToBoardArgs, signal, ctx);
			return toToolResult(result);
		},
	});

	pi.registerTool({
		name: "read_board_post",
		label: "读取公告板正文",
		description: "Lazy-load the complete body, artifacts, and verification details of a local board post by postNo.",
		parameters: READ_BOARD_POST_PARAMETERS,
		async execute(_callId, args) {
			const result = getEngine().readBoardPost(args as unknown as ReadBoardPostArgs);
			return toToolResult(result);
		},
	});

	if (!isSubWorker) {
		pi.registerCommand?.("board", {
			description: "Run a Board multi-agent task or manage local boards (/board <goal> | status | posts | new <id>)",
			async handler(rawArgs, ctx) {
				const trimmed = rawArgs.trim();
				const parts = trimmed.split(/\s+/).filter(Boolean);
				const sub = parts[0]?.toLowerCase() ?? "status";
				if (!trimmed || sub === "status") {
					const text = getEngine().formatStatus();
					ctx?.ui?.notify?.(text, "info");
					return text;
				}
				if (sub === "posts") {
					const text = getEngine().formatPosts(15);
					ctx?.ui?.notify?.(text, "info");
					return text;
				}
				if (sub === "new") {
					const nextId = sanitizeSlug(parts[1] ?? `board-${Date.now().toString(36)}`, "boardId");
					activeBoardId = nextId;
					explicitBoardDir = undefined;
					cachedEngine = undefined;
					const status = getEngine().formatStatus();
					ctx?.ui?.notify?.(`Switched to local board "${nextId}"`, "info");
					return status;
				}
				const kickoffPrompt = [
					`Run this goal using the local collaboration board (boardId="${activeBoardId}"):`,
					trimmed,
					"",
					"As root Coordinator:",
					"1. Call spawn_board_agent to form focused builder agent(s) and an independent read-only verifier agent.",
					"2. Call post_to_board (kind='assign') mentioning the builder to run implementation -> handoff -> verification.",
					"3. Wait for the board loop results and summarize verified outcomes concisely.",
				].join("\n");
				pi.sendUserMessage?.(kickoffPrompt);
				return kickoffPrompt;
			},
		});
	}
}

export function createBoardExtension(options: CreateBoardExtensionOptions = {}) {
	return function configuredBoardExtension(pi: BoardExtensionApi): void {
		// Snapshot env at registration time so callers restoring process.env after registration still retain bridge credentials.
		const env = { ...(options.env ?? process.env) };
		if (env.PA_TEAM_BRIDGE_URL?.trim()) {
			registerPaBridgeTools(pi, env);
			return;
		}
		registerStandaloneTools(pi, { ...options, env });
	};
}

export default function boardExtension(pi: BoardExtensionApi): void {
	createBoardExtension()(pi);
}
