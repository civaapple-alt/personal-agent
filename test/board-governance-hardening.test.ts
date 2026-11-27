import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
	createPersonalAgentServer,
	DialogBroker,
	loadRoleTemplatesFromDir,
	openPersonalAgentDatabase,
	PersonalAgentStore,
	type PiRpcWorkerOptions,
	PreviewManager,
	type RpcWorkerLike,
	TeamOrchestrator,
} from "../packages/server/src/index.ts";
import { createBoardExtension } from "../pi-extensions/board/index.ts";
import { LocalBoardEngine } from "../pi-extensions/board/local-engine.ts";
import { LocalBoardStore } from "../pi-extensions/board/local-store.ts";
import { extractWriteTargetPath, isPathWithinOwnedScope } from "../pi-extensions/board/scope-guard.ts";
import type { BoardExtensionApi, BoardToolResult } from "../pi-extensions/board/types.ts";

interface RecordedWorkerLaunch {
	agentId: string;
	boardRole: string;
	env: Record<string, string | undefined>;
	startedAt: number;
	finishedAt: number;
}

async function postBridge(
	env: Record<string, string | undefined>,
	path: "/ready" | "/tool",
	payload: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
	const url = env.PA_TEAM_BRIDGE_URL;
	const token = env.PA_TEAM_BRIDGE_TOKEN;
	assert.ok(url && token, "Missing bridge env in worker");
	const res = await fetch(`${url}${path}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify(payload),
	});
	const json = (await res.json()) as Record<string, unknown>;
	return { status: res.status, json };
}

function createHardeningOrchestrator(input: {
	store: PersonalAgentStore;
	templates: Awaited<ReturnType<typeof loadRoleTemplatesFromDir>>;
	onWorkerTurn: (ctx: {
		opts: PiRpcWorkerOptions;
		agentId: string;
		boardRole: string;
		turnIndex: number;
		callTool: (
			tool: string,
			args: Record<string, unknown>,
		) => Promise<{ status: number; json: Record<string, unknown> }>;
	}) => Promise<{ assistantText?: string } | undefined>;
}) {
	const launches: RecordedWorkerLaunch[] = [];
	const turnCounts = new Map<string, number>();

	const orchestrator = new TeamOrchestrator({
		store: input.store,
		templates: input.templates,
		noSession: true,
		readPiModels: async () => ({
			models: [
				{
					provider: "anthropic",
					model: "claude-sonnet-4",
					name: "Claude Sonnet 4",
					reasoning: true,
					thinkingLevels: ["low", "medium", "high"],
				},
			],
			defaultModel: { provider: "anthropic", model: "claude-sonnet-4", thinkingLevel: "medium" },
			sources: [],
		}),
		workerFactory: (opts): RpcWorkerLike => {
			const agentId = opts.env?.PA_BOARD_AGENT_ID || "unknown";
			const boardRole = opts.env?.PA_BOARD_ROLE || "";
			const requiredTools = opts.env?.PA_REQUIRED_TOOLS ? (JSON.parse(opts.env.PA_REQUIRED_TOOLS) as string[]) : [];
			const eventListeners = new Set<(event: { type: string; [key: string]: unknown }) => void>();
			const noticeListeners = new Set<(notice: { method: string; [key: string]: unknown }) => void>();
			let callCounter = 0;
			return {
				async start() {
					await postBridge(opts.env ?? {}, "/ready", requiredTools);
				},
				async stop() {},
				async abort() {},
				async getState() {
					return { sessionId: `sess_${agentId}` };
				},
				onEvent(listener) {
					eventListeners.add(listener);
					return () => eventListeners.delete(listener);
				},
				onNotice(listener) {
					noticeListeners.add(listener);
					return () => noticeListeners.delete(listener);
				},
				setDialogHandler() {},
				async runPromptAndWait() {
					const startedAt = Date.now();
					const turnIndex = (turnCounts.get(agentId) ?? 0) + 1;
					turnCounts.set(agentId, turnIndex);
					const callTool = async (tool: string, args: Record<string, unknown>) => {
						callCounter += 1;
						return postBridge(opts.env ?? {}, "/tool", {
							tool,
							callId: `call_${agentId}_${turnIndex}_${callCounter}`,
							args,
						});
					};
					try {
						const res = await input.onWorkerTurn({
							opts,
							agentId,
							boardRole,
							turnIndex,
							callTool,
						});
						const text = res?.assistantText ?? `${agentId} turn ${turnIndex} done`;
						for (const listener of eventListeners) {
							listener({ type: "agent_settled", messages: [] });
						}
						return {
							disposition: "started",
							aborted: false,
							assistantText: text,
							assistantMessages: [],
							toolExecutions: [],
							notices: [],
							dialogs: [],
							events: [],
						};
					} finally {
						launches.push({
							agentId,
							boardRole,
							env: opts.env ?? {},
							startedAt,
							finishedAt: Date.now(),
						});
					}
				},
			};
		},
	});

	return { orchestrator, launches, turnCounts };
}

test("Hardening 1: @all mentions are rejected in PA board-runner, HTTP POST /board/posts, and standalone LocalBoardStore", async () => {
	// 1) Standalone LocalBoardStore rejects @all
	const tmpDir = mkdtempSync(join(tmpdir(), "pa-all-block-"));
	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db);
	const templates = await loadRoleTemplatesFromDir(resolve(process.cwd(), "roles"));
	for (const tpl of templates) {
		store.upsertMember({
			id: tpl.id,
			templateId: tpl.id,
			displayName: tpl.name,
			roleTitle: tpl.title,
			isPrimaryContact: tpl.isPrimaryContact,
			keywords: tpl.keywords,
		});
	}

	try {
		const localStore = new LocalBoardStore(join(tmpDir, "board"), "no-all");
		localStore.ensureCoordinator();
		assert.throws(
			() =>
				localStore.createPost({
					kind: "assign",
					authorType: "agent",
					authorId: "coordinator",
					mentions: ["all"],
					summary: "Broadcast should fail",
				}),
			/Unrestricted @all mentions are forbidden/,
		);
		assert.throws(
			() =>
				localStore.createPost({
					kind: "assign",
					authorType: "agent",
					authorId: "coordinator",
					mentions: ["@ALL"],
					summary: "Case-insensitive @ALL should fail",
				}),
			/Unrestricted @all mentions are forbidden/,
		);

		// 2) PA board-runner rejects @all in post_to_board tool bridge
		let toolErrorStatus = 0;
		let toolErrorMessage = "";
		const { orchestrator } = createHardeningOrchestrator({
			store,
			templates,
			async onWorkerTurn({ agentId, turnIndex, callTool }) {
				if (agentId === "coordinator" && turnIndex === 1) {
					const res = await callTool("post_to_board", {
						kind: "assign",
						mentions: ["@all"],
						summary: "Forbidden @all broadcast",
					});
					toolErrorStatus = res.status;
					toolErrorMessage = String(res.json.error ?? "");
					return { assistantText: "Checked @all rejection" };
				}
			},
		});

		const org = store.ensureDefaultOrganization();
		const matter = store.createMatter({
			title: "No @all test",
			leadMemberId: "product-manager",
			collaborationMode: "board",
			coordinatorMemberId: "product-manager",
			orgId: org.id,
		});
		await orchestrator.dispatchMatter({ matterId: matter.id, prompt: "Test @all rejection" });
		assert.equal(toolErrorStatus, 400);
		assert.match(toolErrorMessage, /Unrestricted @all mentions are forbidden/);

		// 3) HTTP POST /api/matters/:id/board/posts returns 400 on @all
		const dialogBroker = new DialogBroker();
		const previewManager = new PreviewManager();
		const { server } = createPersonalAgentServer({
			store,
			orchestrator,
			templates,
			dialogBroker,
			previewManager,
			requireAuth: false,
		});
		await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
		const address = server.address();
		assert.ok(address && typeof address === "object");
		try {
			const postRes = await fetch(`http://127.0.0.1:${address.port}/api/matters/${matter.id}/board/posts`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					kind: "clarification",
					mentions: ["all"],
					summary: "HTTP @all forbidden",
				}),
			});
			assert.equal(postRes.status, 400);
			const errBody = (await postRes.json()) as { error?: string };
			assert.match(errBody.error ?? "", /Unrestricted @all mentions are forbidden/);
		} finally {
			await previewManager.stopAll();
			await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		}
	} finally {
		db.close();
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("Hardening 2: ownedScope guard blocks out-of-scope edit/write via tool_call hook while allowing in-scope writes & reads", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pa-scope-guard-"));
	try {
		assert.equal(isPathWithinOwnedScope("src/parser.mjs", ["src/parser.mjs"], dir), true);
		assert.equal(isPathWithinOwnedScope("./src/nested/new.mjs", ["src/"], dir), true);
		assert.equal(isPathWithinOwnedScope("src/formatter.mjs", ["src/parser.mjs"], dir), false);
		assert.equal(isPathWithinOwnedScope("../outside.mjs", ["src/parser.mjs"], dir), false);
		// Non-path command hints in ownedScope must not false-block file writes
		assert.equal(isPathWithinOwnedScope("anything.mjs", ["node --test"], dir), true);
		assert.equal(extractWriteTargetPath("read", { path: "src/formatter.mjs" }), null);

		const toolCallHandlers: Array<
			(
				event: { toolName: string; input: Record<string, unknown> },
				ctx?: { cwd?: string },
			) => Promise<{ block: true; reason: string } | undefined> | { block: true; reason: string } | undefined
		> = [];
		const tools = new Map<
			string,
			{ execute: (id: string, args: Record<string, unknown>) => Promise<BoardToolResult> }
		>();
		const api: BoardExtensionApi = {
			registerTool(def) {
				tools.set(def.name, { execute: def.execute });
			},
			on(event, handler) {
				if (event === "tool_call") toolCallHandlers.push(handler);
			},
		};

		createBoardExtension({
			cwd: dir,
			env: {
				PA_TEAM_BRIDGE_URL: "http://127.0.0.1:9999",
				PA_TEAM_BRIDGE_TOKEN: "tok",
				PA_BOARD_ROLE: "builder",
				PA_BOARD_OWNED_SCOPE: JSON.stringify(["src/parser.mjs"]),
			},
		})(api);

		assert.equal(toolCallHandlers.length, 1);
		const hook = toolCallHandlers[0]!;
		assert.equal(await hook({ toolName: "read", input: { path: "src/formatter.mjs" } }, { cwd: dir }), undefined);
		assert.equal(await hook({ toolName: "edit", input: { path: "src/parser.mjs" } }, { cwd: dir }), undefined);

		const blocked = await hook({ toolName: "write", input: { path: "src/formatter.mjs" } }, { cwd: dir });
		assert.equal(blocked?.block, true);
		assert.match(blocked?.reason ?? "", /ownedScope/);

		const traversalBlocked = await hook({ toolName: "edit", input: { path: "../secret.txt" } }, { cwd: dir });
		assert.equal(traversalBlocked?.block, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("Hardening 3: same-repo builders serialize writes while read-only verifier runs without blocking", async () => {
	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db);
	const templates = await loadRoleTemplatesFromDir(resolve(process.cwd(), "roles"));
	for (const tpl of templates) {
		store.upsertMember({
			id: tpl.id,
			templateId: tpl.id,
			displayName: tpl.name,
			roleTitle: tpl.title,
			isPrimaryContact: tpl.isPrimaryContact,
			keywords: tpl.keywords,
		});
	}

	let activeBuilders = 0;
	let maxConcurrentBuilders = 0;
	const builderIntervals: Array<{ agentId: string; start: number; end: number }> = [];

	const { orchestrator } = createHardeningOrchestrator({
		store,
		templates,
		async onWorkerTurn({ opts, agentId, boardRole, turnIndex, callTool }) {
			if (boardRole === "builder") {
				assert.ok(opts.env?.PA_BOARD_OWNED_SCOPE, "Builder must receive PA_BOARD_OWNED_SCOPE env");
			}
			if (agentId === "coordinator" && turnIndex === 1) {
				await callTool("spawn_board_agent", {
					agentId: "builder-a",
					boardRole: "builder",
					brief: "Slice A",
					ownedScope: ["src/a.mjs"],
				});
				await callTool("spawn_board_agent", {
					agentId: "builder-b",
					boardRole: "builder",
					brief: "Slice B",
					ownedScope: ["src/b.mjs"],
				});
				await callTool("spawn_board_agent", {
					agentId: "verifier-1",
					boardRole: "verifier",
					brief: "Verify A & B",
				});
				await callTool("post_to_board", {
					kind: "assign",
					mentions: ["builder-a", "builder-b"],
					summary: "Build A and B",
				});
				return;
			}
			if (agentId === "builder-a" || agentId === "builder-b") {
				activeBuilders += 1;
				maxConcurrentBuilders = Math.max(maxConcurrentBuilders, activeBuilders);
				const start = Date.now();
				await new Promise((r) => setTimeout(r, 35));
				const end = Date.now();
				builderIntervals.push({ agentId, start, end });
				activeBuilders -= 1;
				await callTool("post_to_board", {
					kind: "handoff",
					mentions: agentId === "builder-b" ? ["verifier-1"] : [],
					summary: `${agentId} finished`,
				});
				return;
			}
			if (agentId === "verifier-1") {
				await callTool("post_to_board", {
					kind: "verify_pass",
					mentions: ["coordinator"],
					summary: "Both slices passed",
					verification: { target: "post#3", verdict: "pass", authorAgentId: "builder-b" },
				});
				return;
			}
			if (agentId === "coordinator" && turnIndex === 2) {
				await callTool("post_to_board", {
					kind: "summary",
					mentions: [],
					summary: "All slices serialized & verified",
				});
				return { assistantText: "Serialized builders complete" };
			}
		},
	});

	try {
		const org = store.ensureDefaultOrganization();
		const matter = store.createMatter({
			title: "Builder serialization test",
			leadMemberId: "product-manager",
			collaborationMode: "board",
			coordinatorMemberId: "product-manager",
			orgId: org.id,
		});
		const res = await orchestrator.dispatchMatter({ matterId: matter.id, prompt: "Run two builders" });
		assert.equal(res.replyText, "Serialized builders complete");
		assert.equal(maxConcurrentBuilders, 1, "Same-repo builders must not write concurrently");
		assert.equal(builderIntervals.length, 2);
		assert.ok(
			builderIntervals[1]!.start >= builderIntervals[0]!.end,
			"Second builder must start only after first builder completes",
		);
	} finally {
		db.close();
	}
});

test("Hardening 4: verify_rework circuit breaker stops rework loop at threshold in PA board-runner & standalone LocalBoardEngine", async () => {
	// 1) PA board-runner with boardMaxReworkRounds = 2
	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db);
	const templates = await loadRoleTemplatesFromDir(resolve(process.cwd(), "roles"));
	for (const tpl of templates) {
		store.upsertMember({
			id: tpl.id,
			templateId: tpl.id,
			displayName: tpl.name,
			roleTitle: tpl.title,
			isPrimaryContact: tpl.isPrimaryContact,
			keywords: tpl.keywords,
		});
	}

	const { orchestrator, turnCounts } = createHardeningOrchestrator({
		store,
		templates,
		async onWorkerTurn({ agentId, turnIndex, callTool }) {
			if (agentId === "coordinator" && turnIndex === 1) {
				await callTool("spawn_board_agent", {
					agentId: "builder-loop",
					boardRole: "builder",
					brief: "Fix feature",
					ownedScope: ["src/x.mjs"],
				});
				await callTool("spawn_board_agent", {
					agentId: "verifier-strict",
					boardRole: "verifier",
					brief: "Verify feature",
				});
				await callTool("post_to_board", {
					kind: "assign",
					mentions: ["builder-loop"],
					summary: "Start work",
				});
				return;
			}
			if (agentId === "builder-loop") {
				await callTool("post_to_board", {
					kind: "handoff",
					mentions: ["verifier-strict"],
					summary: `Handoff round ${turnIndex}`,
				});
				return;
			}
			if (agentId === "verifier-strict") {
				await callTool("post_to_board", {
					kind: "verify_rework",
					mentions: ["builder-loop"],
					summary: `Rework required #${turnIndex}`,
					verification: { target: "post#2", verdict: "rework", authorAgentId: "builder-loop" },
				});
				return;
			}
			if (agentId === "coordinator" && turnIndex === 2) {
				await callTool("post_to_board", {
					kind: "summary",
					mentions: [],
					summary: "Handled rework circuit breaker escalation",
				});
				return { assistantText: "Circuit breaker handled by coordinator" };
			}
		},
	});

	const dir = mkdtempSync(join(tmpdir(), "pa-rework-breaker-"));
	try {
		const org = store.ensureDefaultOrganization();
		const matter = store.createMatter({
			title: "Rework circuit breaker",
			leadMemberId: "product-manager",
			collaborationMode: "board",
			coordinatorMemberId: "product-manager",
			orgId: org.id,
		});
		const result = await orchestrator.dispatchMatter({
			matterId: matter.id,
			prompt: "Test rework circuit breaker",
			boardMaxReworkRounds: 2,
		});
		assert.equal(result.replyText, "Circuit breaker handled by coordinator");
		// Round 1: builder(1) -> verifier(1) -> rework #1 -> builder(2) -> verifier(2) -> rework #2 (trips breaker, no builder(3))
		assert.equal(turnCounts.get("builder-loop"), 2);
		assert.equal(turnCounts.get("verifier-strict"), 2);
		assert.equal(turnCounts.get("coordinator"), 2);

		const alerts = store.listEvents(matter.id, { eventType: "monitor_alert", order: "asc" });
		assert.equal(
			alerts.events.some((e) => e.payload.reason === "rework_limit_exceeded"),
			true,
		);

		// 2) Standalone LocalBoardEngine with maxReworkRounds = 2
		const engine = new LocalBoardEngine({
			cwd: dir,
			boardId: "rework-local",
			maxReworkRounds: 2,
			extensionEntryPath: "/virtual/board.ts",
			executor: async (req) => {
				if (req.agentId === "builder-1") {
					engine.store.createPost({
						kind: "handoff",
						authorType: "agent",
						authorId: "builder-1",
						mentions: ["verifier-1"],
						summary: "Handed off",
					});
				} else if (req.agentId === "verifier-1") {
					engine.store.createPost({
						kind: "verify_rework",
						authorType: "agent",
						authorId: "verifier-1",
						mentions: ["builder-1"],
						summary: "Still failing",
						verification: { target: "builder-1", verdict: "rework", authorAgentId: "builder-1" },
					});
				}
				return { assistantText: "ok" };
			},
		});
		engine.spawnBoardAgent({ agentId: "builder-1", boardRole: "builder", brief: "Build" });
		engine.spawnBoardAgent({ agentId: "verifier-1", boardRole: "verifier", brief: "Verify" });
		const out = await engine.postToBoard({
			kind: "assign",
			mentions: ["builder-1"],
			summary: "Start",
		});
		assert.equal(out.reworkLimitExceeded?.agentId, "builder-1");
		assert.equal(out.reworkLimitExceeded?.count, 2);
		assert.equal(out.wakeupsExecuted, 4);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("Hardening 5: fault governance handles builder crash, coordinator 1x auto-retry, and persistent coordinator failure without silent success", async () => {
	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db);
	const templates = await loadRoleTemplatesFromDir(resolve(process.cwd(), "roles"));
	for (const tpl of templates) {
		store.upsertMember({
			id: tpl.id,
			templateId: tpl.id,
			displayName: tpl.name,
			roleTitle: tpl.title,
			isPrimaryContact: tpl.isPrimaryContact,
			keywords: tpl.keywords,
		});
	}
	const org = store.ensureDefaultOrganization();

	try {
		// Case A: Builder throws -> marked stopped + @monitor escalates to @coordinator; Coordinator retries once on first crash
		let coordFailOnce = true;
		const caseA = createHardeningOrchestrator({
			store,
			templates,
			async onWorkerTurn({ agentId, turnIndex, callTool }) {
				if (agentId === "coordinator" && coordFailOnce) {
					coordFailOnce = false;
					throw new Error("Transient coordinator RPC drop");
				}
				if (agentId === "coordinator" && turnIndex === 2) {
					await callTool("spawn_board_agent", {
						agentId: "builder-crash",
						boardRole: "builder",
						brief: "Crashes",
					});
					await callTool("post_to_board", {
						kind: "assign",
						mentions: ["builder-crash"],
						summary: "Run task",
					});
					return;
				}
				if (agentId === "builder-crash") {
					throw new Error("Simulated builder crash");
				}
				if (agentId === "coordinator" && turnIndex === 3) {
					await callTool("post_to_board", {
						kind: "summary",
						mentions: [],
						summary: "Recovered after builder crash escalation",
					});
					return { assistantText: "Recovered cleanly after builder crash" };
				}
			},
		});
		const matterA = store.createMatter({
			title: "Fault recovery A",
			leadMemberId: "product-manager",
			collaborationMode: "board",
			coordinatorMemberId: "product-manager",
			orgId: org.id,
		});
		const resA = await caseA.orchestrator.dispatchMatter({ matterId: matterA.id, prompt: "Test fault recovery" });
		assert.equal(resA.replyText, "Recovered cleanly after builder crash");
		assert.equal(store.getBoardMember(matterA.id, "builder-crash")?.status, "stopped");
		const alertsA = store.listEvents(matterA.id, { eventType: "monitor_alert", order: "asc" }).events;
		assert.equal(
			alertsA.some((e) => e.payload.reason === "coordinator_retry"),
			true,
		);
		assert.equal(
			alertsA.some((e) => e.payload.reason === "worker_execution_failed" && e.agentId === "builder-crash"),
			true,
		);

		// Case B: Coordinator fails persistently -> must NOT return silent "已完成本轮看板协同。"
		const caseB = createHardeningOrchestrator({
			store,
			templates,
			async onWorkerTurn({ agentId }) {
				if (agentId === "coordinator") {
					throw new Error("Persistent coordinator outage");
				}
			},
		});
		const matterB = store.createMatter({
			title: "Fault fail B",
			leadMemberId: "product-manager",
			collaborationMode: "board",
			coordinatorMemberId: "product-manager",
			orgId: org.id,
		});
		const resB = await caseB.orchestrator.dispatchMatter({ matterId: matterB.id, prompt: "Test persistent failure" });
		assert.match(resB.replyText, /看板总控执行失败/);
		assert.match(resB.replyText, /Persistent coordinator outage/);
		assert.notEqual(resB.replyText, "已完成本轮看板协同。");
		assert.equal(store.getBoardMember(matterB.id, "coordinator")?.status, "stopped");
		const msgsB = store.listMessages(matterB.id, "user");
		const lastMsgB = msgsB.at(-1);
		assert.equal((lastMsgB?.metadata?.progressSnapshot as { outcome?: string } | undefined)?.outcome, "failed");
	} finally {
		db.close();
	}
});
