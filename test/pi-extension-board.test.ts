import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBoardExtension } from "../pi-extensions/board/index.ts";
import { LocalBoardEngine } from "../pi-extensions/board/local-engine.ts";
import { buildWorkerPiArgs, buildWorkerTools } from "../pi-extensions/board/local-rpc-worker.ts";
import { LocalBoardStore } from "../pi-extensions/board/local-store.ts";
import type { BoardExtensionApi, BoardToolResult, BoardUiContext } from "../pi-extensions/board/types.ts";

interface RegisteredTool {
	name: string;
	execute(
		callId: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
		onUpdate?: unknown,
		ctx?: BoardUiContext,
	): Promise<BoardToolResult>;
}

interface RegisteredCommand {
	handler(args: string, ctx?: BoardUiContext): Promise<string | undefined> | string | undefined;
}

function createHarnessApi() {
	const tools = new Map<string, RegisteredTool & { promptSnippet?: string; promptGuidelines?: string[] }>();
	const commands = new Map<string, RegisteredCommand>();
	const sentMessages: string[] = [];
	const api: BoardExtensionApi = {
		registerTool(def) {
			tools.set(def.name, {
				name: def.name,
				execute: def.execute,
				promptSnippet: def.promptSnippet,
				promptGuidelines: def.promptGuidelines,
			});
		},
		registerCommand(name, def) {
			commands.set(name, { handler: def.handler });
		},
		sendUserMessage(content) {
			sentMessages.push(content);
		},
	};
	return { api, tools, commands, sentMessages };
}

test("pi-extensions/board routes to PA bridge when PA_TEAM_BRIDGE_URL is set", async () => {
	const received: Array<{ auth?: string; body: Record<string, unknown> }> = [];
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			received.push({
				auth: req.headers.authorization,
				body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
			});
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true, postNo: 1 }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const url = `http://127.0.0.1:${address.port}`;

	try {
		// Coordinator registers spawn_board_agent + post_to_board + read_board_post (no standalone tools/commands).
		const coordHarness = createHarnessApi();
		createBoardExtension({
			env: { PA_TEAM_BRIDGE_URL: url, PA_TEAM_BRIDGE_TOKEN: "secret-tok", PA_BOARD_ROLE: "coordinator" },
		})(coordHarness.api);
		assert.deepEqual(Array.from(coordHarness.tools.keys()).sort(), [
			"post_to_board",
			"read_board_post",
			"spawn_board_agent",
		]);
		assert.equal(coordHarness.commands.size, 0);

		const res = await coordHarness.tools.get("spawn_board_agent")!.execute("call-1", {
			agentId: "builder-1",
			boardRole: "builder",
			brief: "Build module",
		});
		assert.equal(JSON.parse(res.content[0]!.text).ok, true);
		assert.equal(received[0]?.auth, "Bearer secret-tok");
		assert.equal(received[0]?.body.tool, "spawn_board_agent");

		// Verifier omits spawn_board_agent.
		const verifierHarness = createHarnessApi();
		createBoardExtension({
			env: { PA_TEAM_BRIDGE_URL: url, PA_TEAM_BRIDGE_TOKEN: "secret-tok", PA_BOARD_ROLE: "verifier" },
		})(verifierHarness.api);
		assert.deepEqual(Array.from(verifierHarness.tools.keys()).sort(), ["post_to_board", "read_board_post"]);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("LocalBoardStore persists members/posts, separates summaries from lazy body, and blocks self-verification", () => {
	const dir = mkdtempSync(join(tmpdir(), "pa-local-store-"));
	try {
		const store = new LocalBoardStore(join(dir, "board"), "alpha");
		const coordinator = store.ensureCoordinator();
		assert.equal(coordinator.boardRole, "coordinator");

		store.upsertMember({
			agentId: "builder-api",
			boardRole: "builder",
			brief: "Implement limiter",
			ownedScope: ["src/limit.ts"],
		});

		const post1 = store.createPost({
			kind: "handoff",
			authorType: "agent",
			authorId: "builder-api",
			mentions: ["verifier-qa"],
			summary: "Limiter implemented",
			body: "Detailed diff and 5 unit test results.",
			artifacts: { files: ["src/limit.ts"] },
		});
		assert.equal(post1.postNo, 1);

		const summaries = store.listPostSummaries(0);
		assert.equal(summaries.length, 1);
		assert.equal(summaries[0]!.hasBody, true);
		assert.equal("body" in summaries[0]!, false);

		const full = store.getPost(1);
		assert.equal(full?.body, "Detailed diff and 5 unit test results.");
		assert.deepEqual(full?.artifacts, { files: ["src/limit.ts"] });

		// Self-verification targeting self or own refPostNos must throw.
		assert.throws(
			() =>
				store.createPost({
					kind: "verify_pass",
					authorType: "agent",
					authorId: "builder-api",
					mentions: ["coordinator"],
					refPostNos: [1],
					summary: "Self pass",
					verification: { target: "builder-api", verdict: "pass" },
				}),
			/Self-verification blocked/,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("Standalone board extension runs async Coordinator -> Builder <-> Verifier loop, strips verifier write tools, and handles HITL + /board", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pa-standalone-board-"));
	try {
		const observedCalls: Array<{
			agentId: string;
			tools: string[];
			args: string[];
			prompt: string;
		}> = [];
		let builderRunCount = 0;
		let verifierRunCount = 0;

		const ext = createBoardExtension({
			cwd: dir,
			env: {},
			extensionEntryPath: "/virtual/pi-extensions/board/index.ts",
			executor: async (req) => {
				const tools = buildWorkerTools(req.boardRole, req.readOnly);
				const piArgs = buildWorkerPiArgs(req);
				observedCalls.push({ agentId: req.agentId, tools, args: piArgs, prompt: req.prompt });

				// Run inside a simulated sub-worker instance to verify child permission isolation + real local-store writes.
				const childHarness = createHarnessApi();
				createBoardExtension({
					cwd: req.cwd,
					boardDir: req.env.PA_LOCAL_BOARD_DIR,
					env: req.env,
					extensionEntryPath: req.extensionEntryPath,
				})(childHarness.api);
				assert.equal(childHarness.tools.has("spawn_board_agent"), false);
				assert.equal(childHarness.commands.has("board"), false);

				if (req.agentId === "builder-api") {
					builderRunCount += 1;
					const readFirst = await childHarness.tools.get("read_board_post")!.execute("r1", {
						postNo: builderRunCount === 1 ? 1 : 3,
					});
					const loaded = JSON.parse(readFirst.content[0]!.text) as { body?: string };
					assert.ok(loaded.body);

					await childHarness.tools.get("post_to_board")!.execute("p1", {
						kind: "handoff",
						mentions: ["verifier-qa"],
						refPostNos: [builderRunCount === 1 ? 1 : 3],
						summary: builderRunCount === 1 ? "Initial build ready" : "Fixed edge case after rework",
						body: `Builder pass #${builderRunCount}`,
					});
					return { assistantText: "handed off" };
				}

				if (req.agentId === "verifier-qa") {
					verifierRunCount += 1;
					const isSecondPass = verifierRunCount >= 2;
					await childHarness.tools.get("post_to_board")!.execute("pv", {
						kind: isSecondPass ? "verify_pass" : "verify_rework",
						mentions: [isSecondPass ? "coordinator" : "builder-api"],
						refPostNos: [isSecondPass ? 4 : 2],
						summary: isSecondPass ? "All checks pass" : "Missing clamp on burst",
						body: isSecondPass ? "Verified all burst cases." : "Rework: clamp burst at 120.",
						verification: {
							target: "builder-api",
							verdict: isSecondPass ? "pass" : "rework",
							criteria: "Burst <= 120",
						},
					});
					return { assistantText: isSecondPass ? "pass" : "rework" };
				}

				return { assistantText: "unexpected" };
			},
		});

		const root = createHarnessApi();
		ext(root.api);
		assert.deepEqual(Array.from(root.tools.keys()).sort(), ["post_to_board", "read_board_post", "spawn_board_agent"]);
		assert.equal(root.commands.has("board"), true);

		await root.tools.get("spawn_board_agent")!.execute("s1", {
			agentId: "builder-api",
			boardRole: "builder",
			brief: "Build burst limit",
			ownedScope: ["packages/server/"],
		});
		await root.tools.get("spawn_board_agent")!.execute("s2", {
			agentId: "verifier-qa",
			boardRole: "verifier",
			brief: "Independently verify burst limit",
			acceptanceCriteria: "Burst <= 120",
			modelOverride: { provider: "opencode-go", model: "deepseek-v4.1-flash", thinkingLevel: "high" },
		});

		const turnRes = await root.tools.get("post_to_board")!.execute("a1", {
			kind: "assign",
			mentions: ["builder-api"],
			summary: "Implement burst limit and hand off to verifier-qa",
			body: "Detailed spec for burst limit <= 120.",
		});
		const turnPayload = JSON.parse(turnRes.content[0]!.text) as {
			wakeupsExecuted: number;
			recentPosts: Array<{ postNo: number; kind: string }>;
		};
		assert.equal(turnPayload.wakeupsExecuted, 4); // builder -> verifier -> builder -> verifier
		assert.equal(builderRunCount, 2);
		assert.equal(verifierRunCount, 2);

		// Verifier invocations must strip edit/write and forward heterogeneous modelOverride flags.
		const verifierCalls = observedCalls.filter((c) => c.agentId === "verifier-qa");
		assert.equal(verifierCalls.length, 2);
		assert.equal(verifierCalls[0]!.tools.includes("edit"), false);
		assert.equal(verifierCalls[0]!.tools.includes("write"), false);
		assert.equal(verifierCalls[0]!.tools.includes("post_to_board"), true);
		assert.equal(verifierCalls[0]!.tools.includes("read_board_post"), true);
		assert.ok(verifierCalls[0]!.args.includes("--exclude-tools"));
		assert.ok(verifierCalls[0]!.args.includes("--provider"));
		assert.ok(verifierCalls[0]!.args.includes("opencode-go"));
		assert.ok(verifierCalls[0]!.args.includes("--model"));
		assert.ok(verifierCalls[0]!.args.includes("deepseek-v4.1-flash"));
		assert.ok(verifierCalls[0]!.args.includes("--thinking"));
		assert.ok(verifierCalls[0]!.args.includes("high"));

		// Verify incremental wakeup cursors only showed new summaries (builder run #2 does not replay post #1).
		const builderCalls = observedCalls.filter((c) => c.agentId === "builder-api");
		assert.match(builderCalls[0]!.prompt, /#1 \[assign\]/);
		assert.doesNotMatch(builderCalls[1]!.prompt, /#1 \[assign\]/);
		assert.match(builderCalls[1]!.prompt, /#3 \[verify_rework\]/);

		// Standalone root Coordinator exposes promptGuidelines so users do not need to name tools manually.
		assert.ok((root.tools.get("spawn_board_agent")!.promptGuidelines?.length ?? 0) >= 1);
		assert.ok((root.tools.get("post_to_board")!.promptGuidelines?.length ?? 0) >= 1);

		// /board status & posts inspect live persisted state without triggering turns.
		const statusOut = await root.commands.get("board")!.handler("status");
		assert.match(statusOut ?? "", /@builder-api \(builder, waiting, cursor=#4/);
		assert.match(statusOut ?? "", /#5 \[verify_pass\]/);
		assert.equal(root.sentMessages.length, 0);

		// /board <goal> triggers Coordinator turn via sendUserMessage.
		const kickoff = await root.commands.get("board")!.handler("Fix burst rate limiter with independent QA");
		assert.match(kickoff ?? "", /Coordinator/);
		assert.equal(root.sentMessages.length, 1);
		assert.match(root.sentMessages[0]!, /Fix burst rate limiter with independent QA/);

		// HITL clarification @user via ctx.ui.input resolves cleanly and resets status.
		const hitlRes = await root.tools
			.get("post_to_board")!
			.execute(
				"c1",
				{ kind: "clarification", mentions: ["user"], summary: "Approve rollout?" },
				undefined,
				undefined,
				{
					hasUI: true,
					ui: { input: async () => "Approved for staging" },
				},
			);
		const hitlPayload = JSON.parse(hitlRes.content[0]!.text) as {
			clarificationReply?: { authorType: string; summary: string };
		};
		assert.equal(hitlPayload.clarificationReply?.authorType, "user");
		assert.equal(hitlPayload.clarificationReply?.summary, "Approved for staging");

		// Sub-worker attempting spawnBoardAgent directly on LocalBoardEngine throws.
		const subEngine = new LocalBoardEngine({
			cwd: dir,
			boardId: "default",
			boardRole: "builder",
			agentId: "builder-api",
			isSubWorker: true,
			extensionEntryPath: "/virtual/pi-extensions/board/index.ts",
		});
		assert.throws(
			() => subEngine.spawnBoardAgent({ agentId: "rogue", boardRole: "builder", brief: "Bypass" }),
			/restricted to the root coordinator/,
		);

		// /board new switches isolated board storage cleanly.
		const switched = await root.commands.get("board")!.handler("new sprint-2");
		assert.match(switched ?? "", /Board: sprint-2/);

		// Verify pi-extensions/board bundles workflow SKILL.md cleanly in its package manifest.
		const manifest = JSON.parse(readFileSync(join(process.cwd(), "pi-extensions/board/package.json"), "utf8")) as {
			pi?: { extensions?: string[]; skills?: string[] };
		};
		assert.deepEqual(manifest.pi, { extensions: ["./index.ts"], skills: ["./skills"] });
		const skillMd = readFileSync(
			join(process.cwd(), "pi-extensions/board/skills/board-collaboration/SKILL.md"),
			"utf8",
		);
		assert.match(skillMd, /^---\nname: board-collaboration\ndescription: /);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
