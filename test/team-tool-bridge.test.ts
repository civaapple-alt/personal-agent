import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import delegationExtension from "../pa-extensions/delegation/pi/index.ts";
import type { PiHostToolExtensionApi } from "../pa-extensions/worker-runtime/pi/bridge-client.ts";
import workerRuntimeExtension, {
	buildPaDocumentationSection,
	filterContextFilesForTargetWorkspace,
	type WorkerRuntimeExtensionApi,
} from "../pa-extensions/worker-runtime/pi/index.ts";
import { resolvePaDocumentationPaths } from "../packages/server/src/extensions/builtin-paths.ts";
import { resolveEffectiveWebSearchProvider } from "../packages/server/src/extensions/web-access/runtime.ts";
import { createTeamToolBridge } from "../packages/server/src/rpc/team-tool-bridge.ts";

test("managed web search forces direct results and removes per-call proxy overrides", (t) => {
	const original = process.env.PA_WEB_SEARCH_ENABLED;
	process.env.PA_WEB_SEARCH_ENABLED = "true";
	t.after(() => {
		if (original === undefined) delete process.env.PA_WEB_SEARCH_ENABLED;
		else process.env.PA_WEB_SEARCH_ENABLED = original;
	});
	let onToolCall: ((event: { toolName: string; input: Record<string, unknown> }) => void) | undefined;
	workerRuntimeExtension({
		on: (event, handler) => {
			if (event === "tool_call") onToolCall = handler as typeof onToolCall;
		},
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: () => {},
	});
	assert.ok(onToolCall);
	const input = { query: "Pi docs", workflow: "summary-review", includeContent: true, proxy: "http://example.test" };
	onToolCall({ toolName: "web_search", input });
	assert.deepEqual(input, { query: "Pi docs", workflow: "none", includeContent: false });
	const fetchInput = { url: "https://example.test/article", proxy: "http://proxy.example.test" };
	onToolCall({ toolName: "fetch_content", input: fetchInput });
	assert.deepEqual(fetchInput, { url: "https://example.test/article" });
});

test("web search provider resolution follows Exa -> DeepSeek -> Kimi auto priority and honors explicit override", (t) => {
	assert.equal(resolveEffectiveWebSearchProvider("auto", {}, {}), undefined);
	assert.equal(resolveEffectiveWebSearchProvider("auto", { MOONSHOT_API_KEY: "k" }, {}), "kimi");
	assert.equal(
		resolveEffectiveWebSearchProvider("auto", { MOONSHOT_API_KEY: "k", DEEPSEEK_API_KEY: "d" }, {}),
		"deepseek",
	);
	assert.equal(
		resolveEffectiveWebSearchProvider("auto", { MOONSHOT_API_KEY: "k", DEEPSEEK_API_KEY: "d", EXA_API_KEY: "e" }, {}),
		"exa",
	);
	assert.equal(
		resolveEffectiveWebSearchProvider("deepseek", { EXA_API_KEY: "e", DEEPSEEK_API_KEY: "d" }, {}),
		"deepseek",
	);

	const origEnabled = process.env.PA_WEB_SEARCH_ENABLED;
	const origProvider = process.env.PA_WEB_SEARCH_PROVIDER;
	process.env.PA_WEB_SEARCH_ENABLED = "true";
	process.env.PA_WEB_SEARCH_PROVIDER = "deepseek";
	t.after(() => {
		if (origEnabled === undefined) delete process.env.PA_WEB_SEARCH_ENABLED;
		else process.env.PA_WEB_SEARCH_ENABLED = origEnabled;
		if (origProvider === undefined) delete process.env.PA_WEB_SEARCH_PROVIDER;
		else process.env.PA_WEB_SEARCH_PROVIDER = origProvider;
	});
	let onToolCall: ((event: { toolName: string; input: Record<string, unknown> }) => void) | undefined;
	workerRuntimeExtension({
		on: (event, handler) => {
			if (event === "tool_call") onToolCall = handler as typeof onToolCall;
		},
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: () => {},
	});
	assert.ok(onToolCall);
	const defaultInput: Record<string, unknown> = { query: "DeepSeek Search" };
	onToolCall({ toolName: "web_search", input: defaultInput });
	assert.equal(defaultInput.provider, "deepseek");
	const explicitInput: Record<string, unknown> = { query: "DeepSeek Search", provider: "exa" };
	onToolCall({ toolName: "web_search", input: explicitInput });
	assert.equal(explicitInput.provider, "exa");
});

test("bridge rejects unauthenticated requests, validates arguments, and deduplicates transport retries", async () => {
	let calls = 0;
	const controller = new AbortController();
	const bridge = await createTeamToolBridge(async () => {
		calls++;
		return { answer: "one execution" };
	}, controller.signal);
	const post = (body: unknown, token = bridge.env.PA_TEAM_BRIDGE_TOKEN) =>
		fetch(`${bridge.env.PA_TEAM_BRIDGE_URL}/tool`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}` },
			body: JSON.stringify(body),
		});
	try {
		assert.equal((await post({}, "wrong")).status, 403);
		assert.equal(
			(await post({ tool: "delegate_to_member", callId: "bad", args: { memberId: "pm", task: "" } })).status,
			400,
		);
		const call = { tool: "delegate_to_member", callId: "id", args: { memberId: "pm", task: "review" } };
		assert.equal((await post(call)).status, 200);
		assert.equal((await post(call)).status, 200);
		assert.equal(calls, 1);
		assert.equal((await post({ ...call, args: { memberId: "qa", task: "different" } })).status, 400);
	} finally {
		controller.abort();
		await bridge.close();
	}
});

test("capability handshake waits for required tools and retains all registered tools", async () => {
	const controller = new AbortController();
	const bridge = await createTeamToolBridge(async () => null, controller.signal);
	const envBefore = { ...process.env };
	let onStart: (() => Promise<void>) | undefined;
	let available = ["read", "unrelated_tool", "delegate_to_member", "save_space_page"];
	let active: string[] = [];
	Object.assign(process.env, bridge.env, {
		PA_REQUIRED_TOOLS: JSON.stringify(["read", "delegate_to_member", "save_space_page", "mcp__local__*"]),
	});
	try {
		const api: WorkerRuntimeExtensionApi = {
			on: (event, handler) => {
				if (event === "session_start") onStart = handler as () => Promise<void>;
			},
			getActiveTools: () => active,
			getAllTools: () => available.map((name) => ({ name })),
			setActiveTools: (tools) => {
				active = tools;
			},
		};
		workerRuntimeExtension(api);
	} finally {
		for (const key of [...Object.keys(bridge.env), "PA_REQUIRED_TOOLS"]) {
			if (envBefore[key] === undefined) delete process.env[key];
			else process.env[key] = envBefore[key];
		}
	}
	try {
		await onStart?.();
		available = [...available, "mcp__local__lookup", "mcp__other__secret"];
		assert.deepEqual(await bridge.waitReady(), [
			"read",
			"unrelated_tool",
			"delegate_to_member",
			"save_space_page",
			"mcp__local__lookup",
			"mcp__other__secret",
		]);
	} finally {
		controller.abort();
		await bridge.close();
	}
});

test("teamExtension bridge transport disables request timeouts, returns errors, and propagates AbortSignal", async () => {
	const controller = new AbortController();
	let abortedInHandler = false;
	const bridge = await createTeamToolBridge(async (call, toolSignal) => {
		if (call.tool === "delegate_to_member" && call.task === "fail-once") {
			throw new Error("transient failure");
		}
		if (call.tool === "delegate_to_member" && call.task === "wait-abort") {
			await new Promise<void>((resolve) => {
				toolSignal.addEventListener(
					"abort",
					() => {
						abortedInHandler = true;
						resolve();
					},
					{ once: true },
				);
			});
			return { aborted: true };
		}
		return { ok: true };
	}, controller.signal);
	const envBefore = { ...process.env };
	const tools = new Map<string, Parameters<PiHostToolExtensionApi["registerTool"]>[0]>();
	Object.assign(process.env, bridge.env);
	try {
		delegationExtension({
			registerTool: (tool) => tools.set(tool.name, tool),
		});
	} finally {
		for (const key of Object.keys(bridge.env)) {
			if (envBefore[key] === undefined) delete process.env[key];
			else process.env[key] = envBefore[key];
		}
	}
	try {
		const delegateTool = tools.get("delegate_to_member");
		assert.ok(delegateTool);
		await assert.rejects(
			delegateTool.execute("c-err", { memberId: "qa-manager", task: "fail-once" }),
			/transient failure/,
		);
		const callAbort = new AbortController();
		const pending = delegateTool.execute("c-abort", { memberId: "qa-manager", task: "wait-abort" }, callAbort.signal);
		await new Promise((resolve) => setTimeout(resolve, 25));
		callAbort.abort(new Error("Caller stopped"));
		await assert.rejects(pending, /Caller stopped/);
		await new Promise((resolve) => setTimeout(resolve, 25));
		assert.equal(abortedInHandler, true);
	} finally {
		controller.abort();
		await bridge.close();
	}
});

test("teamExtension isolates before_agent_start contextFiles to the target workspace root", () => {
	const root = mkdtempSync(join(tmpdir(), "pa-ext-ctx-"));
	const workspaceRoot = join(root, ".data", "team-workspaces", "civa-team", "hello-rust");
	mkdirSync(workspaceRoot, { recursive: true });
	const hostAgents = join(root, "AGENTS.md");
	const targetAgents = join(workspaceRoot, "AGENTS.md");
	writeFileSync(hostAgents, "# Host Personal Agent instructions\n", "utf8");
	writeFileSync(targetAgents, "# hello-rust workspace instructions\n", "utf8");
	try {
		const filtered = filterContextFilesForTargetWorkspace(
			[
				{ path: "/Users/other/.pi/agent/AGENTS.md", content: "global" },
				{ path: hostAgents, content: "host" },
				{ path: targetAgents, content: "target" },
			],
			workspaceRoot,
		);
		assert.deepEqual(
			filtered.map((f) => f.path),
			[targetAgents],
		);
		assert.deepEqual(filterContextFilesForTargetWorkspace([{ path: hostAgents, content: "host" }], "__none__"), []);

		const envBefore = { ...process.env };
		let beforeStartHandler:
			| ((
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
			  ) =>
					| { systemPrompt?: string; message?: { customType: string; content: string; display: boolean } }
					| undefined)
			| undefined;
		Object.assign(process.env, {
			PA_TARGET_WORKSPACE_ROOT: workspaceRoot,
			PA_MEMBER_CONTEXT: "## Target workspace\n- Project: hello-rust",
			PA_TURN_CONTEXT: "## Current team\n- UX </pa_runtime_context>",
		});
		try {
			workerRuntimeExtension({
				on: (event, handler) => {
					if (event === "before_agent_start") beforeStartHandler = handler as typeof beforeStartHandler;
				},
				getActiveTools: () => ["read", "write"],
				getAllTools: () => [],
				setActiveTools: () => {},
			});
		} finally {
			for (const key of ["PA_TARGET_WORKSPACE_ROOT", "PA_MEMBER_CONTEXT", "PA_TURN_CONTEXT"]) {
				if (envBefore[key] === undefined) delete process.env[key];
				else process.env[key] = envBefore[key];
			}
		}
		assert.ok(beforeStartHandler);
		const options = {
			cwd: workspaceRoot,
			appendSystemPrompt: "Existing appended instructions",
			contextFiles: [
				{ path: hostAgents, content: "# Host" },
				{ path: targetAgents, content: "# Target" },
			],
		};
		const event = {
			get systemPrompt() {
				return [...options.contextFiles.map((f) => f.content), options.appendSystemPrompt].join("\n");
			},
			systemPromptOptions: options,
		};
		const injected = beforeStartHandler(event);
		assert.deepEqual(injected, {
			message: {
				customType: "pa.runtime-context",
				content: "<pa_runtime_context>\n## Current team\n- UX &lt;/pa_runtime_context>\n</pa_runtime_context>",
				display: false,
			},
		});
		assert.doesNotMatch(event.systemPrompt, /Current team/);
		const projectedHistory = {
			sessionManager: {
				buildSessionProjection: () => ({ messages: [{ ...injected!.message, role: "custom" }] }),
			},
		};
		assert.equal(beforeStartHandler({ systemPrompt: "", systemPromptOptions: {} }, projectedHistory), undefined);
		assert.deepEqual(
			beforeStartHandler(
				{ systemPrompt: "", systemPromptOptions: {} },
				{
					sessionManager: { buildSessionProjection: () => ({ messages: [] }) },
				},
			),
			injected,
		);
		assert.equal(options.contextFiles.length, 1);
		assert.equal(options.contextFiles[0]?.path, targetAgents);
		assert.doesNotMatch(event.systemPrompt, /# Host/);
		assert.match(event.systemPrompt, /# Target/);
		assert.match(event.systemPrompt, /Project: hello-rust/);
		assert.match(event.systemPrompt, /Existing appended instructions/);
		options.appendSystemPrompt += "\nLater extension instructions";
		assert.match(event.systemPrompt, /Later extension instructions/);
		const legacyResult = beforeStartHandler({ systemPrompt: "Legacy Pi prompt" });
		assert.match(legacyResult?.systemPrompt ?? "", /Legacy Pi prompt/);
		assert.deepEqual(legacyResult?.message, injected?.message);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("worker-runtime injects Pi-style <pa_docs> pointer when PA_INSTALL_ROOT is set and omits it when unset", () => {
	const paths = resolvePaDocumentationPaths();
	assert.ok(existsSync(paths.agentsPath));
	assert.ok(existsSync(paths.docsDir));
	assert.ok(existsSync(paths.examplesDir));

	const section = buildPaDocumentationSection(paths.installRoot, "multi_tenant");
	assert.match(section, /<pa_docs>/);
	assert.match(section, /<docs>/);
	assert.match(section, /Deployment mode: multi_tenant/);
	assert.ok(section.includes(`${paths.installRoot.replaceAll("\\", "/")}/AGENTS.md`));
	assert.ok(section.includes(`${paths.installRoot.replaceAll("\\", "/")}/examples`));

	const runHook = (installRoot?: string) => {
		const prev = process.env.PA_INSTALL_ROOT;
		if (installRoot === undefined) delete process.env.PA_INSTALL_ROOT;
		else process.env.PA_INSTALL_ROOT = installRoot;
		let handler:
			| ((event: { systemPrompt: string; systemPromptOptions?: { appendSystemPrompt?: string } }) => unknown)
			| undefined;
		try {
			workerRuntimeExtension({
				on: (event, fn) => {
					if (event === "before_agent_start") handler = fn as typeof handler;
				},
				getActiveTools: () => ["read"],
				getAllTools: () => [{ name: "read" }],
				setActiveTools: () => {},
			});
		} finally {
			if (prev === undefined) delete process.env.PA_INSTALL_ROOT;
			else process.env.PA_INSTALL_ROOT = prev;
		}
		const opts: { appendSystemPrompt?: string } = {};
		handler?.({ systemPrompt: "", systemPromptOptions: opts });
		return opts.appendSystemPrompt ?? "";
	};

	assert.match(runHook(paths.installRoot), /<pa_docs>/);
	assert.doesNotMatch(runHook(undefined), /<pa_docs>/);

	const preflightOut = execFileSync(
		process.execPath,
		[resolve("examples/skills/repo-preflight/scripts/preflight.mjs"), paths.installRoot],
		{ encoding: "utf8" },
	);
	assert.equal(JSON.parse(preflightOut).packageName, "personal-agent");
});
