import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { createTeamBridgeClient } from "./bridge-client.ts";
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
}
