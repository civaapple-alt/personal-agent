import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { createTeamBridgeClient, type PiHostToolExtensionApi } from "./bridge-client.ts";
import {
	buildCompactionCarryover,
	type CompactBranchEntry,
	PA_COMPACTION_CARRYOVER_CUSTOM_TYPE,
} from "./compaction-carryover.ts";
import { classifyGithubFetches, temporaryClonePaths } from "./web-fetch-evidence.js";

interface BeforeAgentStartResult {
	systemPrompt?: string;
	message?: { customType: string; content: string; display: boolean };
}

/** Minimal structural subset of Pi's extension API used by PA's worker runtime guard. */
export interface WorkerRuntimeExtensionApi {
	on(event: "session_start", handler: () => Promise<void>): void;
	on(event: "tool_call", handler: (event: { toolName: string; input: Record<string, unknown> }) => void): void;
	on(
		event: "tool_result",
		handler: (event: {
			toolName: string;
			input: Record<string, unknown>;
			content: Array<{ type: string; [key: string]: unknown }>;
			isError: boolean;
			structuredContent?: unknown;
		}) => { content: Array<{ type: string; [key: string]: unknown }>; structuredContent?: unknown } | undefined,
	): void;
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
					buildSessionProjection?(): {
						messages: Array<{
							role: string;
							customType?: string;
							toolName?: string;
							isError?: boolean;
							content?: unknown;
						}>;
					};
				};
			},
		) => BeforeAgentStartResult | undefined,
	): void;
	on(
		event: "session_compact",
		handler: (
			event: { compactionEntry?: { firstKeptEntryId?: string } },
			ctx?: {
				cwd?: string;
				sessionManager?: {
					getBranch?(): readonly CompactBranchEntry[];
				};
			},
		) => void,
	): void;
	sendMessage?(
		message: { customType: string; content: string; display: boolean },
		options?: { triggerTurn?: boolean },
	): void;
	registerTool?: PiHostToolExtensionApi["registerTool"];
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

/**
 * Build a concise Pi-style `<pa_docs>` routing block pointing to the installed Personal Agent
 * documentation and runnable examples (works identically for `git clone` and extracted prebuilt archives).
 */
export function buildPaDocumentationSection(
	installRoot: string,
	deploymentMode: "local" | "multi_tenant" = "local",
): string {
	const root = resolve(installRoot).replaceAll("\\", "/");
	const modeNote =
		deploymentMode === "multi_tenant"
			? "- Deployment mode: multi_tenant (shared team server). Use PA docs freely to answer accurately, and avoid unnecessarily exposing unrelated host machine paths or other tenants' data."
			: "- Deployment mode: local (personal loopback workbench).";
	return [
		"<pa_docs>",
		"Personal Agent (PA) & Pi dual documentation (read on demand via `read` only when asked about PA or Pi itself, architecture, extensions, roles, spaces, skills, MCP, or troubleshooting):",
		modeNote,
		"- Pi harness docs: follow the `<docs>` section above (installed Pi README, docs/, examples/) for Pi extensions, skills, MCP, RPC, models, sessions, and SDK.",
		`- PA installation root: ${root}`,
		`- PA main navigation: ${root}/AGENTS.md and ${root}/docs/README.md`,
		`- PA docs: ${root}/docs (resolve docs/... under PA docs, not the business workspace cwd)`,
		`- PA runnable examples: ${root}/examples (dual-half external extension, Skill + script, custom role template)`,
		"- When asked about PA: architecture & boundaries (docs/concepts/architecture-and-plan.md), collaboration & sessions (docs/reference/runtime-collaboration.md), Git spaces (docs/concepts/space-design.md), configuration & env (docs/reference/configuration.md), roles & capabilities (docs/reference/role-design.md, roles/README.md), PA host extensions (pa-extensions/README.md), portable Pi extensions (pi-extensions/README.md), self-inspection & session insights (pa-extensions/self-inspect/skills/pa-self-inspection/SKILL.md).",
		"- For live state of THIS matter, use the runtime context snapshot (current matter, active tools, team capabilities, pending decisions) and `read_space` for saved space documents. Before explaining or modifying PA or Pi internals, read the relevant docs and examples in full, following cross-references.",
		"</pa_docs>",
	].join("\n");
}

export default function workerRuntimeExtension(pi: WorkerRuntimeExtensionApi): void {
	const env = { ...process.env };
	const post = createTeamBridgeClient(env);
	const cloneRoots = new Set<string>();

	if (env.PA_CAN_MANAGE_ROLES === "true" && typeof pi.registerTool === "function") {
		pi.registerTool({
			name: "read_team_roles",
			label: "读取当前团队角色",
			description:
				"Read the currently visible AI team roles (id, name, title, scope, responsibilities, anti-jobs, skills, MCP dependencies) in this organization/matter scope, plus optional full matter capability cards (past internal startup tool snapshots) or collaboration health evidence.",
			promptSnippet:
				"Read the visible AI team roster, full capability cards (`includeCapabilities: true`), or collaboration health evidence (`includeHealthEvidence: true`).",
			promptGuidelines: [
				"Call read_team_roles({ includeCapabilities: true }) when you need colleagues' full responsibilities, anti-jobs, declared skills/MCP, or past internal startup tool evidence.",
				"Call read_team_roles before proposing new roles or role adjustments so proposals reuse existing members and avoid overlapping responsibilities.",
			],
			parameters: {
				type: "object",
				properties: {
					includeCapabilities: {
						type: "boolean",
						description:
							"Include full scoped team capability cards and past internal-delegation startup tool snapshots for this matter and workspace (default false).",
					},
					includeHealthEvidence: {
						type: "boolean",
						description: "Include recent team collaboration friction and health evidence digest (default false).",
					},
				},
				additionalProperties: false,
			},
			async execute(callId, args, signal) {
				const result = await post("/tool", { tool: "read_team_roles", callId, args: args ?? {} }, signal);
				return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
			},
		});

		pi.registerTool({
			name: "propose_role",
			label: "提议创建或调整 AI 角色",
			description:
				"Propose creating a new AI role (with optional bundled SKILL.md drafts) or updating an existing role's boundaries/workflow notes for human confirmation. Never modifies role files directly until the user approves the confirmation card.",
			promptSnippet:
				"Propose creating a new AI role or updating an existing role's boundaries for human confirmation (never writes role files without approval).",
			promptGuidelines: [
				"When key role boundaries are still unclear, clarify with the user first; call propose_role once the role's core job and boundaries are confirmed.",
				"Roles share Pi's default runtime tools; focus on oneJob, antiJobs, skills, and collaboration boundaries rather than tool permission toggles.",
				"When drafting bundled newSkills, follow the `skill-design` Skill (trigger-first description, single source of truth, and concise imperative steps without duplicating role boundaries).",
			],
			parameters: {
				type: "object",
				properties: {
					action: {
						type: "string",
						enum: ["create", "update"],
						description:
							"'create' to propose a new role, or 'update' to propose boundary/workflow adjustments to an existing role.",
					},
					rationale: {
						type: "string",
						description: "Concrete evidence-based rationale for creating or updating this role.",
					},
					id: { type: "string", description: "Optional kebab-case slug for a new role (action='create')." },
					name: { type: "string", description: "Display name for a new role (action='create')." },
					title: { type: "string", description: "Role title for a new role (action='create')." },
					oneJob: {
						type: "string",
						description: "Required for action='create': single core outcome this role owns.",
					},
					antiJobs: {
						type: "array",
						items: { type: "string" },
						description: "Explicit boundaries / non-goals for a new role (action='create').",
					},
					quietWhen: { type: "string", description: "When this new role should remain silent (action='create')." },
					interactionStyle: {
						type: "string",
						enum: ["lead_direct", "consult_specialist", "risk_observer", "mixed"],
						description: "Recommended participation pattern (action='create').",
					},
					workflowRules: { type: "string", description: "Workflow and handoff conventions (action='create')." },
					communicationStyle: { type: "string", description: "Communication style notes (action='create')." },
					verificationPlan: {
						type: "string",
						description: "Concrete verification task, success criteria, and boundary check (action='create').",
					},
					skills: {
						type: "array",
						items: { type: "string" },
						description: "Existing skill names to attach to a new role (action='create').",
					},
					mcpDependencies: {
						type: "array",
						items: { type: "string" },
						description: "Optional MCP server names referenced by this role (action='create').",
					},
					newSkills: {
						type: "array",
						description: "Optional bundled SKILL.md drafts to create alongside the new role (action='create').",
						items: {
							type: "object",
							properties: {
								name: { type: "string" },
								description: { type: "string" },
								body: { type: "string" },
								storageScope: { type: "string", enum: ["role_local", "org", "personal", "global"] },
							},
							required: ["name", "description", "body"],
							additionalProperties: false,
						},
					},
					memberId: {
						type: "string",
						description: "Required for action='update': existing visible team member ID.",
					},
					addAntiJobs: {
						type: "array",
						items: { type: "string" },
						description: "New Anti-Jobs boundaries to append to an existing role (action='update').",
					},
					workflowNote: {
						type: "string",
						description: "New collaboration or workflow convention note to append (action='update').",
					},
				},
				required: ["action", "rationale"],
				additionalProperties: false,
			},
			async execute(callId, args, signal) {
				const result = await post("/tool", { tool: "propose_role", callId, args }, signal);
				return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
			},
		});
	}

	if (env.PA_WEB_SEARCH_ENABLED === "true") {
		pi.on("tool_call", (event) => {
			if (event.toolName === "web_search") {
				event.input.workflow = "none";
				event.input.includeContent = false;
				delete event.input.proxy;
				if (!event.input.provider && env.PA_WEB_SEARCH_PROVIDER) {
					event.input.provider = env.PA_WEB_SEARCH_PROVIDER;
				}
				return;
			}
			if (event.toolName === "fetch_content") {
				delete event.input.proxy;
			}
		});
	}

	pi.on("tool_result", (event) => {
		if (event.toolName === "fetch_content") {
			const evidenceList = classifyGithubFetches(event.input, event.content, event.isError, event.structuredContent);
			if (!evidenceList.length) return;
			const notes = evidenceList.map((evidence) => {
				if (evidence.clonePath) cloneRoots.add(resolve(evidence.clonePath));
				const note =
					evidence.kind === "temporary_clone"
						? "PA evidence: The tool reports a temporary GitHub clone for this worker. It can be cleaned up when this worker/session ends; it is not a registered or durable workspace. On a later turn check the path or fetch again. Report the actual files read and any truncation; do not infer a commit, file counts, or successful operations without evidence."
						: evidence.kind === "github_api"
							? "PA evidence: The tool reports an API-only GitHub view, not a clone. Report which content was returned and any truncation; do not infer a local checkout, commit, file counts, or successful operations without evidence."
							: "PA evidence: GitHub content was returned, but the retrieval mechanism is not established by the tool output. Do not claim a clone or API method without further evidence. Report actual files read and any truncation.";
				return { type: "text", text: `${evidence.source}: ${note}` };
			});
			return {
				content: [...event.content, ...notes],
				...(event.structuredContent !== undefined ? { structuredContent: event.structuredContent } : {}),
			};
		}
		if (event.toolName !== "read" || !event.isError || typeof event.input.path !== "string") return;
		const target = resolve(event.input.path);
		const knownClone = [...cloneRoots].some((root) => {
			const rel = relative(root, target);
			return rel === "" || (rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute(rel));
		});
		if (
			!knownClone ||
			!event.content.some(
				(part) => part.type === "text" && typeof part.text === "string" && /\bENOENT\b/.test(part.text),
			)
		)
			return;
		return {
			content: [
				...event.content,
				{
					type: "text",
					text: "PA evidence: This path came from an earlier temporary GitHub clone and is now missing. Do not treat it as a durable checkout. Fetch the source again, or arrange a persistent workspace when needed.",
				},
			],
			...(event.structuredContent !== undefined ? { structuredContent: event.structuredContent } : {}),
		};
	});

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
			pi.setActiveTools(available);
			await post("/ready", pi.getActiveTools());
		};
		void prepare().catch(() => {
			process.stderr.write("Personal Agent capability handshake failed\n");
		});
	});

	pi.on("before_agent_start", (event, ctx) => {
		for (const message of ctx?.sessionManager?.buildSessionProjection?.().messages ?? []) {
			if (message.role !== "toolResult" || message.toolName !== "fetch_content" || message.isError) continue;
			for (const root of temporaryClonePaths(message.content)) cloneRoots.add(resolve(root));
		}
		const options = event.systemPromptOptions;
		if (env.PA_TARGET_WORKSPACE_ROOT !== undefined && Array.isArray(options?.contextFiles)) {
			options.contextFiles = filterContextFilesForTargetWorkspace(
				options.contextFiles,
				env.PA_TARGET_WORKSPACE_ROOT,
			);
		}
		if (env.PA_ATTACHED_CONTEXT_FILES_JSON && options) {
			try {
				const parsed = JSON.parse(env.PA_ATTACHED_CONTEXT_FILES_JSON) as Array<{ path?: string; content?: string }>;
				if (Array.isArray(parsed) && parsed.length > 0) {
					const existing = Array.isArray(options.contextFiles) ? [...options.contextFiles] : [];
					const seen = new Set(existing.map((f) => f.path));
					for (const item of parsed) {
						if (typeof item?.path === "string" && typeof item?.content === "string" && !seen.has(item.path)) {
							seen.add(item.path);
							existing.push({ path: item.path, content: item.content });
						}
					}
					options.contextFiles = existing;
				}
			} catch {
				// Ignore malformed attached context files payload.
			}
		}
		const deploymentMode = env.PA_DEPLOYMENT_MODE === "multi_tenant" ? "multi_tenant" : "local";
		const paDocsSection = env.PA_INSTALL_ROOT?.trim()
			? buildPaDocumentationSection(env.PA_INSTALL_ROOT.trim(), deploymentMode)
			: undefined;
		const context = [
			env.PA_MEMBER_CONTEXT,
			paDocsSection,
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

	pi.on("session_compact", (event, ctx) => {
		if (typeof pi.sendMessage !== "function") return;
		const branchEntries = ctx?.sessionManager?.getBranch?.();
		if (!Array.isArray(branchEntries) || branchEntries.length === 0) return;
		const carryover = buildCompactionCarryover(branchEntries, {
			cwd: ctx?.cwd ?? process.cwd(),
			firstKeptEntryId: event.compactionEntry?.firstKeptEntryId,
		});
		if (!carryover) return;
		pi.sendMessage(
			{ customType: PA_COMPACTION_CARRYOVER_CUSTOM_TYPE, content: carryover, display: false },
			{ triggerTurn: false },
		);
	});
}
