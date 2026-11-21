import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { createTeamBridgeClient } from "../shared/team-bridge-client.ts";

interface BeforeAgentStartResult {
	systemPrompt?: string;
	message?: { customType: string; content: string; display: boolean };
}

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
	on(event: "tool_call", handler: (event: { toolName: string; input: Record<string, unknown> }) => void): void;
	on(
		event: "before_agent_start",
		handler: (
			event: {
				systemPrompt: string;
				systemPromptOptions?: {
					cwd?: string;
					contextFiles?: Array<{ path: string; content: string }>;
					appendSystemPrompt?: string;
					forceSystemPrompt?: string;
				};
			},
			ctx?: {
				sessionManager?: {
					buildSessionProjection?(): { messages: Array<{ role: string; customType?: string; content?: unknown }> };
				};
			},
		) => BeforeAgentStartResult | undefined,
	): void;
	getActiveTools(): string[];
	getAllTools(): { name: string }[];
	setActiveTools(names: string[]): void;
}

function resolveCanonicalPath(target: string): string {
	const normalized = resolve(target);
	try {
		return realpathSync(normalized);
	} catch {
		return normalized;
	}
}

/**
 * Drop ancestor/host AGENTS.md/CLAUDE.md files outside the assigned target workspace root.
 * When `PA_TARGET_WORKSPACE_ROOT` is `"__none__"`, clears all auto-discovered context files so
 * unbound matters do not absorb the workbench checkout's own repository instructions.
 */
export function filterContextFilesForTargetWorkspace<T extends { path: string }>(
	contextFiles: T[],
	targetWorkspaceRoot: string | undefined,
): T[] {
	if (targetWorkspaceRoot === undefined) return contextFiles;
	const trimmed = targetWorkspaceRoot.trim();
	if (!trimmed || trimmed === "__none__") return [];
	const canonicalRoot = resolveCanonicalPath(trimmed);
	return contextFiles.filter((file) => {
		if (!file || typeof file.path !== "string") return false;
		const rel = relative(canonicalRoot, resolveCanonicalPath(file.path));
		return rel === "" || (rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute(rel));
	});
}

export default function teamExtension(pi: PiExtensionApi): void {
	const env = { ...process.env };
	const post = createTeamBridgeClient(env);

	for (const tool of [
		{
			name: "read_pa_help",
			label: "Read PA help",
			description:
				"Read the installed workbench guide or live facts about this matter. Use the topic IDs from the Personal Agent help index. This tool does not operate the workbench.",
			parameters: {
				type: "object",
				properties: {
					topics: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 },
					language: { type: "string", enum: ["zh", "en"] },
				},
				required: ["topics"],
				additionalProperties: false,
			},
		},
		{
			name: "delegate_to_member",
			label: "咨询团队成员",
			description:
				"Ask an existing colleague to perform specialist work and return evidence. Include the objective, constraints, and expected evidence. During authorized work, the lead can set verification to assign independent review of a commit, workspace text file, or a staged document draft. Use a different member from the author and refer to their completed assignment when applicable. The answer includes the assignment number for this turn's handoff board.",
			parameters: {
				type: "object",
				properties: {
					memberId: { type: "string" },
					task: { type: "string" },
					verification: {
						type: "object",
						properties: {
							assignmentNumber: {
								type: "integer",
								minimum: 1,
								description: "Completed assignment number in this turn, when there is one",
							},
							target: {
								type: "object",
								properties: {
									kind: { type: "string", enum: ["commit", "file", "draft"] },
									reference: {
										type: "string",
										description:
											"Full commit hash, workspace-relative text path, or exact staged document title",
									},
								},
								required: ["kind", "reference"],
								additionalProperties: false,
							},
							criteria: { type: "string" },
						},
						required: ["target", "criteria"],
						additionalProperties: false,
					},
				},
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
	if (env.PA_WEB_SEARCH_ENABLED === "true") {
		pi.on("tool_call", (event) => {
			if (event.toolName !== "web_search") return;
			event.input.workflow = "none";
			event.input.includeContent = false;
			delete event.input.proxy;
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
	pi.on("before_agent_start", (event, ctx) => {
		const options = event.systemPromptOptions;
		if (env.PA_TARGET_WORKSPACE_ROOT !== undefined && Array.isArray(options?.contextFiles)) {
			options.contextFiles = filterContextFilesForTargetWorkspace(
				options.contextFiles,
				env.PA_TARGET_WORKSPACE_ROOT,
			);
		}
		const context = [
			env.PA_MEMBER_CONTEXT,
			`Active tools: ${pi.getActiveTools().join(", ")}. Use only active tools. Claim execution only when a tool actually ran.`,
		]
			.filter(Boolean)
			.join("\n\n");
		const snapshot = env.PA_TURN_CONTEXT?.replaceAll(/<\/?pa_runtime_context>/gi, (tag) => tag.replace("<", "&lt;"));
		const content = snapshot ? `<pa_runtime_context>\n${snapshot}\n</pa_runtime_context>` : undefined;
		// Inspect the projected history so a snapshot removed by compaction is sent again.
		const customType = "pa.runtime-context";
		const previous = content
			? ctx?.sessionManager
					?.buildSessionProjection?.()
					.messages.findLast((entry) => entry.role === "custom" && entry.customType === customType)
			: undefined;
		const message = content && previous?.content !== content ? { customType, content, display: false } : undefined;
		if (options && options.forceSystemPrompt === undefined) {
			// Keep Pi's structured prompt so later hooks and tool-loadout updates can still contribute.
			options.appendSystemPrompt = [options.appendSystemPrompt, context].filter(Boolean).join("\n\n");
			return message ? { message } : undefined;
		}
		return {
			systemPrompt: `${event.systemPrompt}\n\n${context}`,
			...(message ? { message } : {}),
		};
	});
}
