import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

interface RecordedWorkerLaunch {
	agentId: string;
	boardRole: string;
	memberId: string;
	prompt: string;
	turnContext: string;
	requiredTools: string[];
	provider?: string;
	model?: string;
	sessionFile?: string;
	args: string[];
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

function createBoardTestOrchestrator(input: {
	store: PersonalAgentStore;
	templates: Awaited<ReturnType<typeof loadRoleTemplatesFromDir>>;
	sessionDir?: string;
	noSession?: boolean;
	onWorkerTurn: (ctx: {
		opts: PiRpcWorkerOptions;
		agentId: string;
		boardRole: string;
		turnIndex: number;
		prompt: string;
		callTool: (
			tool: string,
			args: Record<string, unknown>,
		) => Promise<{ status: number; json: Record<string, unknown> }>;
		emitEvent: (ev: { type: string; [key: string]: unknown }) => void;
	}) => Promise<{ assistantText?: string } | undefined>;
}) {
	const launches: RecordedWorkerLaunch[] = [];
	const turnCounts = new Map<string, number>();

	const orchestrator = new TeamOrchestrator({
		store: input.store,
		templates: input.templates,
		sessionDir: input.sessionDir,
		noSession: input.noSession ?? true,
		readPiModels: async () => ({
			models: [
				{
					provider: "anthropic",
					model: "claude-sonnet-4",
					name: "Claude Sonnet 4",
					reasoning: true,
					thinkingLevels: ["low", "medium", "high"],
				},
				{
					provider: "openai",
					model: "gpt-5.2",
					name: "GPT-5.2",
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
			const memberId = opts.env?.PA_MEMBER_ID || "";
			const requiredTools = opts.env?.PA_REQUIRED_TOOLS ? (JSON.parse(opts.env.PA_REQUIRED_TOOLS) as string[]) : [];
			const eventListeners = new Set<(event: { type: string; [key: string]: unknown }) => void>();
			const noticeListeners = new Set<(notice: { method: string; [key: string]: unknown }) => void>();
			const sessionId = `sess_${agentId}`;
			const sessionFile =
				opts.sessionFile ??
				(input.sessionDir ? join(input.sessionDir, `${agentId.replace(/[^a-z0-9_-]/gi, "_")}.jsonl`) : undefined);

			return {
				async start() {
					if (sessionFile) {
						writeFileSync(
							sessionFile,
							`${JSON.stringify({ type: "session", id: sessionId, cwd: opts.cwd })}\n`,
							"utf8",
						);
					}
					await postBridge(opts.env ?? {}, "/ready", requiredTools);
				},
				async stop() {},
				async abort() {},
				async getState() {
					return {
						sessionId,
						...(sessionFile ? { sessionFile } : {}),
						...(opts.provider && opts.model
							? { model: { provider: opts.provider, id: opts.model, name: opts.model } }
							: {}),
					};
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
				async runPromptAndWait(prompt) {
					const turnIndex = (turnCounts.get(agentId) ?? 0) + 1;
					turnCounts.set(agentId, turnIndex);
					launches.push({
						agentId,
						boardRole,
						memberId,
						prompt,
						turnContext: opts.env?.PA_TURN_CONTEXT ?? "",
						requiredTools,
						provider: opts.provider,
						model: opts.model,
						sessionFile: opts.sessionFile,
						args: opts.args ?? [],
					});
					const emitEvent = (ev: { type: string; [key: string]: unknown }) => {
						for (const listener of eventListeners) listener(ev);
					};
					let callCounter = 0;
					const callTool = async (tool: string, args: Record<string, unknown>) => {
						callCounter += 1;
						const callId = `${agentId}_t${turnIndex}_c${callCounter}`;
						emitEvent({ type: "tool_execution_start", toolCallId: callId, toolName: tool, args });
						const res = await postBridge(opts.env ?? {}, "/tool", { tool, callId, args });
						emitEvent({
							type: "tool_execution_end",
							toolCallId: callId,
							toolName: tool,
							isError: res.status >= 400,
						});
						return res;
					};
					const outcome = await input.onWorkerTurn({
						opts,
						agentId,
						boardRole,
						turnIndex,
						prompt,
						callTool,
						emitEvent,
					});
					return {
						disposition: "started",
						aborted: false,
						assistantText: outcome?.assistantText ?? `${agentId} turn ${turnIndex} done`,
						assistantMessages: [],
						toolExecutions: [],
						notices: [],
						dialogs: [],
						events: [],
					};
				},
			};
		},
	});

	return { orchestrator, launches, turnCounts };
}

test("M2 Scenario 1: dynamic spawning, async @mention loop, summary-only cursor wakeup, lazy read, and observe-by-default coordinator", async () => {
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
	const heavySecretBody = "UNIQUE_FULL_SPEC_BODY_NEVER_IN_WAKEUP_PROMPT_XYZ987";
	let builderLazyReadBody = "";

	const { orchestrator, launches, turnCounts } = createBoardTestOrchestrator({
		store,
		templates,
		async onWorkerTurn({ agentId, turnIndex, callTool }) {
			if (agentId === "coordinator" && turnIndex === 1) {
				const spawnBuilder = await callTool("spawn_board_agent", {
					agentId: "builder-1",
					boardRole: "builder",
					displayName: "Storage & API Builder",
					ownedScope: ["packages/server/src/storage/"],
					acceptanceCriteria: "Tests pass and code formatted",
					brief: "Implement feature A cleanly",
				});
				assert.equal(spawnBuilder.status, 200);
				const spawnVerifier = await callTool("spawn_board_agent", {
					agentId: "verifier",
					boardRole: "verifier",
					displayName: "Independent Verifier",
					brief: "Verify builder-1 output independently without editing files",
				});
				assert.equal(spawnVerifier.status, 200);
				const assignPost = await callTool("post_to_board", {
					kind: "assign",
					mentions: ["builder-1"],
					summary: "Implement Board task A",
					body: heavySecretBody,
				});
				assert.equal(assignPost.status, 200);
				return { assistantText: "Assigned to @builder-1." };
			}
			if (agentId === "builder-1" && turnIndex === 1) {
				const full = await callTool("read_board_post", { postNo: 1 });
				assert.equal(full.status, 200);
				builderLazyReadBody = String((full.json.result as { post: { body: string } }).post.body);
				const handoff = await callTool("post_to_board", {
					kind: "handoff",
					mentions: ["verifier"],
					refPostNos: [1],
					summary: "Draft implementation ready for verification",
					body: "Initial patch details",
				});
				assert.equal(handoff.status, 200);
				return;
			}
			if (agentId === "verifier" && turnIndex === 1) {
				// Observe-by-default: rework directly back to builder-1 without waking coordinator
				const rework = await callTool("post_to_board", {
					kind: "verify_rework",
					mentions: ["builder-1"],
					refPostNos: [2],
					summary: "Missing edge-case assertion, please fix",
					verification: {
						target: "post#2",
						criteria: "All edge cases covered",
						verdict: "rework",
						authorAgentId: "builder-1",
					},
				});
				assert.equal(rework.status, 200);
				return;
			}
			if (agentId === "builder-1" && turnIndex === 2) {
				const handoff2 = await callTool("post_to_board", {
					kind: "handoff",
					mentions: ["verifier"],
					refPostNos: [3],
					summary: "Added edge-case assertion and re-ran tests",
				});
				assert.equal(handoff2.status, 200);
				return;
			}
			if (agentId === "verifier" && turnIndex === 2) {
				const pass = await callTool("post_to_board", {
					kind: "verify_pass",
					mentions: ["coordinator"],
					refPostNos: [4],
					summary: "Verification passed cleanly",
					verification: {
						target: "post#4",
						criteria: "All edge cases covered",
						verdict: "pass",
						authorAgentId: "builder-1",
					},
				});
				assert.equal(pass.status, 200);
				return;
			}
			if (agentId === "coordinator" && turnIndex === 2) {
				const summaryPost = await callTool("post_to_board", {
					kind: "summary",
					mentions: [],
					refPostNos: [5],
					summary: "Board collaboration finished & verified",
					body: "Final verified deliverable summary.",
				});
				assert.equal(summaryPost.status, 200);
				return { assistantText: "Final verified deliverable summary." };
			}
		},
	});

	const ssePosts: number[] = [];
	const sseEvents: string[] = [];
	try {
		const matter = store.createMatter({
			title: "Board E2E Loop",
			leadMemberId: "product-manager",
			collaborationMode: "board",
			coordinatorMemberId: "product-manager",
			orgId: org.id,
		});
		const result = await orchestrator.dispatchMatter({
			matterId: matter.id,
			prompt: "Execute Task A via dynamic team board",
			onBoardPostCreated: ({ post }) => ssePosts.push(post.postNo),
			onMatterEventAppended: ({ event }) => sseEvents.push(event.eventType),
		});

		assert.equal(result.replyText, "Final verified deliverable summary.");
		assert.equal(builderLazyReadBody, heavySecretBody);

		// Summary-only injection: heavy body was NOT injected directly into builder-1 prompt or turnContext
		const builderLaunch1 = launches.find((l) => l.agentId === "builder-1");
		assert.ok(builderLaunch1);
		assert.equal(builderLaunch1.prompt.includes(heavySecretBody), false);
		assert.equal(builderLaunch1.turnContext.includes(heavySecretBody), false);
		assert.ok(builderLaunch1.turnContext.includes("Implement Board task A"));

		// Observe by default: coordinator only ran TWICE (initial split + after @coordinator verify_pass),
		// skipping intermediate handoff (#2), verify_rework (#3), and handoff (#4)
		assert.equal(turnCounts.get("coordinator"), 2);
		assert.equal(turnCounts.get("builder-1"), 2);
		assert.equal(turnCounts.get("verifier"), 2);

		// Incremental read cursor persisted monotonically
		const members = store.listBoardMembers(matter.id);
		const b = members.find((m) => m.agentId === "builder-1");
		const v = members.find((m) => m.agentId === "verifier");
		const c = members.find((m) => m.agentId === "coordinator");
		assert.equal(b?.status, "waiting");
		assert.ok((b?.lastReadPostNo ?? 0) >= 3);
		assert.ok((v?.lastReadPostNo ?? 0) >= 4);
		assert.equal(c?.lastReadPostNo, 5);

		// SSE callbacks & matter_events telemetry recorded
		assert.deepEqual(ssePosts, [1, 2, 3, 4, 5, 6]);
		assert.ok(sseEvents.includes("tool_start"));
		assert.ok(sseEvents.includes("tool_end"));
		assert.ok(sseEvents.includes("turn_summary"));
		assert.equal(store.getLatestBoardPostNo(matter.id), 6);
	} finally {
		db.close();
	}
});

test("M2 Scenario 2: hard runtime security boundaries (builder spawn blocked, verifier no write/edit, anti-self-verification)", async () => {
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

	let builderSpawnErr: string | undefined;
	let builderVerifyErr: string | undefined;
	let verifierSelfVerifyErr: string | undefined;

	const { orchestrator, launches } = createBoardTestOrchestrator({
		store,
		templates,
		async onWorkerTurn({ agentId, turnIndex, callTool }) {
			if (agentId === "coordinator" && turnIndex === 1) {
				await callTool("spawn_board_agent", {
					agentId: "builder-sec",
					boardRole: "builder",
					brief: "Attempt security violation tests",
				});
				await callTool("spawn_board_agent", {
					agentId: "verifier-sec",
					boardRole: "verifier",
					brief: "Verify read-only boundary & self-verify rejection",
				});
				await callTool("post_to_board", {
					kind: "assign",
					mentions: ["builder-sec"],
					summary: "Run builder task",
				});
				return;
			}
			if (agentId === "builder-sec" && turnIndex === 1) {
				// 1) Builder must NOT register or invoke spawn_board_agent
				const spawnRes = await callTool("spawn_board_agent", {
					agentId: "rogue-agent",
					boardRole: "builder",
					brief: "Unauthorized spawn",
				});
				assert.equal(spawnRes.status, 400);
				builderSpawnErr = String(spawnRes.json.error ?? "");

				// 2) Builder must NOT post verify_pass
				const badVerifyRes = await callTool("post_to_board", {
					kind: "verify_pass",
					mentions: ["coordinator"],
					summary: "Self passed!",
					verification: { target: "post#1", verdict: "pass", authorAgentId: "builder-sec" },
				});
				assert.equal(badVerifyRes.status, 400);
				builderVerifyErr = String(badVerifyRes.json.error ?? "");

				await callTool("post_to_board", {
					kind: "handoff",
					mentions: ["verifier-sec"],
					refPostNos: [1],
					summary: "Handoff for verifier",
				});
				return;
			}
			if (agentId === "verifier-sec" && turnIndex === 1) {
				// 3) Verifier cannot verify a post it authored (self-verify guard)
				const selfHandoff = await callTool("post_to_board", {
					kind: "progress",
					mentions: [],
					summary: "Verifier note",
				});
				assert.equal(selfHandoff.status, 200);
				const selfPostNo = (selfHandoff.json.result as { post: { postNo: number } }).post.postNo;

				const selfVerdict = await callTool("post_to_board", {
					kind: "verify_pass",
					mentions: ["coordinator"],
					refPostNos: [selfPostNo],
					summary: "Verify my own post",
					verification: { target: `post#${selfPostNo}`, verdict: "pass" },
				});
				assert.equal(selfVerdict.status, 400);
				verifierSelfVerifyErr = String(selfVerdict.json.error ?? "");

				await callTool("post_to_board", {
					kind: "verify_pass",
					mentions: ["coordinator"],
					refPostNos: [2],
					summary: "Verified builder handoff",
					verification: { target: "post#2", verdict: "pass", authorAgentId: "builder-sec" },
				});
				return;
			}
			if (agentId === "coordinator" && turnIndex === 2) {
				await callTool("post_to_board", {
					kind: "summary",
					mentions: [],
					refPostNos: [4],
					summary: "Security test verified",
				});
			}
		},
	});

	try {
		const matter = store.createMatter({
			title: "Security Boundaries",
			leadMemberId: "product-manager",
			collaborationMode: "board",
			coordinatorMemberId: "product-manager",
			orgId: org.id,
		});
		await orchestrator.dispatchMatter({ matterId: matter.id, prompt: "Verify boundaries" });

		assert.match(builderSpawnErr ?? "", /coordinator/i);
		assert.match(builderVerifyErr ?? "", /Builders cannot post verification verdicts/i);
		assert.match(verifierSelfVerifyErr ?? "", /Self-verification is forbidden/i);

		const builderLaunch = launches.find((l) => l.agentId === "builder-sec");
		const verifierLaunch = launches.find((l) => l.agentId === "verifier-sec");
		const coordinatorLaunch = launches.find((l) => l.agentId === "coordinator");

		assert.ok(builderLaunch?.requiredTools.includes("write"));
		assert.ok(builderLaunch?.requiredTools.includes("edit"));
		assert.ok(builderLaunch?.requiredTools.includes("post_to_board"));
		assert.equal(builderLaunch?.requiredTools.includes("spawn_board_agent"), false);
		assert.equal(builderLaunch?.requiredTools.includes("delegate_to_member"), false);

		assert.ok(verifierLaunch);
		assert.equal(verifierLaunch.requiredTools.includes("write"), false);
		assert.equal(verifierLaunch.requiredTools.includes("edit"), false);
		assert.ok(verifierLaunch.requiredTools.includes("read"));

		assert.ok(coordinatorLaunch?.requiredTools.includes("spawn_board_agent"));
		assert.equal(coordinatorLaunch?.requiredTools.includes("write"), false);
		assert.equal(coordinatorLaunch?.requiredTools.includes("edit"), false);
	} finally {
		db.close();
	}
});

test("M2 Scenario 3: @monitor detects silent stall, emits monitor_alert, nudges twice, then escalates to @coordinator", async () => {
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

	const { orchestrator, turnCounts } = createBoardTestOrchestrator({
		store,
		templates,
		async onWorkerTurn({ agentId, turnIndex, callTool }) {
			if (agentId === "coordinator" && turnIndex === 1) {
				await callTool("spawn_board_agent", {
					agentId: "builder-stalled",
					boardRole: "builder",
					brief: "Stall simulation",
				});
				await callTool("post_to_board", {
					kind: "assign",
					mentions: ["builder-stalled"],
					summary: "Please implement task",
				});
				return;
			}
			if (agentId === "builder-stalled") {
				// Intentionally return silently without posting progress/handoff on initial assign AND both nudges!
				return { assistantText: "" };
			}
			if (agentId === "coordinator" && turnIndex === 2) {
				await callTool("post_to_board", {
					kind: "summary",
					mentions: [],
					summary: "Handled @monitor escalation for stalled builder",
				});
				return { assistantText: "Took over after monitor escalation." };
			}
		},
	});

	try {
		const matter = store.createMatter({
			title: "Monitor Stall Test",
			leadMemberId: "product-manager",
			collaborationMode: "board",
			coordinatorMemberId: "product-manager",
			orgId: org.id,
		});
		const result = await orchestrator.dispatchMatter({
			matterId: matter.id,
			prompt: "Simulate silent stall",
			boardMonitorSilenceMs: 25,
		});

		assert.equal(result.replyText, "Took over after monitor escalation.");
		// builder-stalled ran initial assign (1) + 2 monitor nudges = 3 turns
		assert.equal(turnCounts.get("builder-stalled"), 3);
		// coordinator woke again on @monitor escalation
		assert.equal(turnCounts.get("coordinator"), 2);

		const posts = store.listBoardPostSummaries(matter.id, { order: "asc" });
		const monitorPosts = posts.filter((p) => p.authorType === "monitor");
		assert.equal(monitorPosts.length, 3);
		assert.equal(monitorPosts[0]?.kind, "progress");
		assert.deepEqual(monitorPosts[0]?.mentions, ["builder-stalled"]);
		assert.equal(monitorPosts[1]?.kind, "progress");
		assert.equal(monitorPosts[2]?.kind, "escalate");
		assert.deepEqual(monitorPosts[2]?.mentions, ["coordinator"]);

		const alerts = store.listEvents(matter.id, { eventType: "monitor_alert", order: "asc" });
		assert.equal(alerts.total, 3);
		assert.equal(alerts.events[0]?.payload.nudgeCount, 1);
		assert.equal(alerts.events[2]?.payload.nudgeCount, 3);
		assert.equal(alerts.events[2]?.payload.reason, "silent_stall_escalate");
	} finally {
		db.close();
	}
});

test("M2 Scenarios 4 & 5: waiting-only model hot-swap (409 on working), session continuity, and HITL @user pause + POST /board/posts resume", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pa-board-m2-"));
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

	let releaseBuilderWait!: () => void;
	const builderWorkingGate = new Promise<void>((resolveGate) => {
		releaseBuilderWait = resolveGate;
	});
	let signalBuilderWorking!: () => void;
	const builderEnteredWorking = new Promise<void>((resolveEntered) => {
		signalBuilderWorking = resolveEntered;
	});

	const { orchestrator, launches } = createBoardTestOrchestrator({
		store,
		templates,
		sessionDir: dir,
		noSession: false,
		async onWorkerTurn({ agentId, turnIndex, callTool }) {
			if (agentId === "coordinator" && turnIndex === 1) {
				await callTool("spawn_board_agent", {
					agentId: "builder-swap",
					boardRole: "builder",
					brief: "Build module & pause for clarification",
				});
				await callTool("spawn_board_agent", {
					agentId: "verifier-swap",
					boardRole: "verifier",
					brief: "Verify after hot-swap",
				});
				await callTool("post_to_board", {
					kind: "assign",
					mentions: ["builder-swap"],
					summary: "Start swap & clarification flow",
				});
				return;
			}
			if (agentId === "builder-swap" && turnIndex === 1) {
				signalBuilderWorking();
				await builderWorkingGate;
				// Pause via HITL @user clarification
				await callTool("post_to_board", {
					kind: "clarification",
					mentions: ["user"],
					summary: "Need human confirmation on API schema",
					body: "Should field X be required?",
				});
				return;
			}
			if (agentId === "builder-swap" && turnIndex === 2) {
				await callTool("post_to_board", {
					kind: "handoff",
					mentions: ["verifier-swap"],
					summary: "Completed after user clarification",
				});
				return;
			}
			if (agentId === "verifier-swap" && turnIndex === 1) {
				await callTool("post_to_board", {
					kind: "verify_pass",
					mentions: ["coordinator"],
					summary: "Verified with hot-swapped model",
					verification: { target: "post#4", verdict: "pass", authorAgentId: "builder-swap" },
				});
				return;
			}
			if (agentId === "coordinator" && turnIndex === 2) {
				await callTool("post_to_board", {
					kind: "summary",
					mentions: [],
					summary: "Resumed and completed cleanly",
					body: "All human clarifications resolved & verified.",
				});
				return { assistantText: "All human clarifications resolved & verified." };
			}
		},
	});

	const dialogBroker = new DialogBroker();
	const previewManager = new PreviewManager();
	const { server } = createPersonalAgentServer({
		store,
		orchestrator,
		templates,
		dialogBroker,
		previewManager,
		requireAuth: true,
	});
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const baseUrl = `http://127.0.0.1:${address.port}`;

	try {
		const owner = store.createUser({
			email: "owner@example.com",
			displayName: "Owner",
			password: "password-123",
			platformRole: "user",
		});
		const viewer = store.createUser({
			email: "viewer@example.com",
			displayName: "Viewer",
			password: "password-123",
			platformRole: "user",
		});
		const org = store.upsertOrganization({ name: "Board Org", createdByUserId: owner.id });
		store.upsertOrgMember({ orgId: org.id, userId: owner.id, orgRole: "org_owner" });
		store.upsertOrgMember({ orgId: org.id, userId: viewer.id, orgRole: "org_viewer" });

		const ownerCookie = `pa_session=${store.createSession(owner.id).rawToken}`;
		const viewerCookie = `pa_session=${store.createSession(viewer.id).rawToken}`;

		// Create matter via HTTP POST /api/matters with collaborationMode: "board"
		const createRes = await fetch(`${baseUrl}/api/matters`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: ownerCookie },
			body: JSON.stringify({
				prompt: "Build & clarify schema",
				orgId: org.id,
				collaborationMode: "board",
				coordinatorMemberId: "product-manager",
			}),
		});
		assert.equal(createRes.status, 202);
		const createdJson = (await createRes.json()) as { matter: { id: string; collaborationMode: string } };
		assert.equal(createdJson.matter.collaborationMode, "board");
		const matterId = createdJson.matter.id;

		// Wait until builder-swap is actively working
		await builderEnteredWorking;

		// While running: switching collaborationMode on PATCH /api/matters/:id -> 409
		const switchWhileRunning = await fetch(`${baseUrl}/api/matters/${matterId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Cookie: ownerCookie },
			body: JSON.stringify({ collaborationMode: "lead" }),
		});
		assert.equal(switchWhileRunning.status, 409);

		// While builder-swap is working: hot-swap modelOverride -> 409
		const swapWorkingRes = await fetch(`${baseUrl}/api/matters/${matterId}/board/members/builder-swap`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Cookie: ownerCookie },
			body: JSON.stringify({ modelOverride: { provider: "openai", model: "gpt-5.2" } }),
		});
		assert.equal(swapWorkingRes.status, 409);

		// While verifier-swap is waiting: hot-swap modelOverride -> 200
		const swapWaitingRes = await fetch(`${baseUrl}/api/matters/${matterId}/board/members/verifier-swap`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Cookie: ownerCookie },
			body: JSON.stringify({ modelOverride: { provider: "openai", model: "gpt-5.2" } }),
		});
		assert.equal(swapWaitingRes.status, 200);
		const swapWaitingJson = (await swapWaitingRes.json()) as {
			member: { modelOverride: { provider: string; model: string } | null };
		};
		assert.equal(swapWaitingJson.member.modelOverride?.model, "gpt-5.2");

		// Coordinator cannot be retired
		const retireCoordinatorRes = await fetch(`${baseUrl}/api/matters/${matterId}/board/members/coordinator`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Cookie: ownerCookie },
			body: JSON.stringify({ status: "retired" }),
		});
		assert.equal(retireCoordinatorRes.status, 400);

		// Release builder-swap so it posts clarification @user and pauses the board run
		releaseBuilderWait();

		// Poll until matter settles into waiting_user
		for (let i = 0; i < 60; i += 1) {
			if (!orchestrator.isMatterRunning(matterId) && store.getMatter(matterId)?.status === "waiting_user") {
				break;
			}
			await new Promise((r) => setTimeout(r, 20));
		}
		assert.equal(store.getMatter(matterId)?.status, "waiting_user");
		assert.equal(store.getBoardMember(matterId, "builder-swap")?.status, "blocked_human");

		// org_viewer cannot post to board -> 403
		const viewerPostRes = await fetch(`${baseUrl}/api/matters/${matterId}/board/posts`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: viewerCookie },
			body: JSON.stringify({ kind: "clarification", mentions: ["builder-swap"], summary: "Nope" }),
		});
		assert.equal(viewerPostRes.status, 403);

		// Owner posts answer to @builder-swap -> unblocks & resumes board loop automatically
		const userPostRes = await fetch(`${baseUrl}/api/matters/${matterId}/board/posts`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: ownerCookie },
			body: JSON.stringify({
				kind: "clarification",
				mentions: ["builder-swap"],
				refPostNos: [2],
				summary: "Field X is required",
				body: "Make field X non-null.",
			}),
		});
		assert.equal(userPostRes.status, 201);

		// Wait until resumed run completes
		for (let i = 0; i < 100; i += 1) {
			if (!orchestrator.isMatterRunning(matterId) && store.getLatestBoardPostNo(matterId) >= 5) {
				break;
			}
			await new Promise((r) => setTimeout(r, 20));
		}

		// Verify builder-swap resumed same Pi sessionFile on turn 2
		const builderLaunches = launches.filter((l) => l.agentId === "builder-swap");
		assert.equal(builderLaunches.length, 2);
		assert.ok(builderLaunches[1]?.sessionFile, "Expected builder-swap turn 2 to reuse persisted sessionFile");

		// Verify verifier-swap launched with the hot-swapped gpt-5.2 model
		const verifierLaunch = launches.find((l) => l.agentId === "verifier-swap");
		assert.equal(verifierLaunch?.provider, "openai");
		assert.equal(verifierLaunch?.model, "gpt-5.2");

		// Verify final board snapshot via GET /api/matters/:id/board includes latestPostNo
		const snapshotRes = await fetch(`${baseUrl}/api/matters/${matterId}/board`, {
			headers: { Cookie: ownerCookie },
		});
		assert.equal(snapshotRes.status, 200);
		const snapshot = (await snapshotRes.json()) as {
			latestPostNo: number;
			collaborationMode: string;
			members: Array<{ agentId: string }>;
		};
		assert.equal(snapshot.collaborationMode, "board");
		assert.ok(snapshot.latestPostNo >= 5);
		assert.equal(snapshot.members.length, 3);
	} finally {
		await previewManager.stopAll();
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("Board matter created via Web conversation mode enters runBoardCollaborationTurn without conversation intent hijack", async () => {
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

	const { orchestrator, turnCounts } = createBoardTestOrchestrator({
		store,
		templates,
		async onWorkerTurn({ agentId, turnIndex, callTool }) {
			if (agentId === "coordinator" && turnIndex === 1) {
				await callTool("spawn_board_agent", {
					agentId: "builder-web",
					boardRole: "builder",
					brief: "Fix feature from Web conversation mode",
					ownedScope: ["src/index.ts"],
				});
				await callTool("post_to_board", {
					kind: "assign",
					mentions: ["builder-web"],
					summary: "Start web conversation task",
				});
				return;
			}
			if (agentId === "builder-web") {
				await callTool("post_to_board", {
					kind: "handoff",
					mentions: ["coordinator"],
					summary: "Task done",
				});
				return { assistantText: "Built via board mode" };
			}
			if (agentId === "coordinator" && turnIndex === 2) {
				await callTool("post_to_board", {
					kind: "summary",
					mentions: [],
					summary: "Final web board summary",
				});
				return { assistantText: "Final coordinator report" };
			}
		},
	});

	try {
		const matter = store.createMatter({
			title: "Web Conversation Board Test",
			leadMemberId: null,
			collaborationMode: "board",
			coordinatorMemberId: "product-manager",
			orgId: org.id,
		});
		const userMsg = store.appendMessage({
			matterId: matter.id,
			channel: "user",
			senderType: "user",
			senderId: "usr_local_owner",
			content: "Start board collaboration from conversation endpoint",
			metadata: {
				mode: "conversation",
				workspaceId: null,
				repoPath: process.cwd(),
			},
		});

		const result = await orchestrator.dispatchMatter({
			matterId: matter.id,
			interactionMode: "conversation",
			existingUserMessageId: userMsg.id,
			prompt: userMsg.content,
		});

		assert.equal(turnCounts.get("coordinator"), 2);
		assert.equal(turnCounts.get("builder-web"), 1);
		assert.equal(store.getMatter(matter.id)?.leadMemberId, "product-manager");
		assert.ok(store.getBoardMember(matter.id, "coordinator"));
		assert.ok(store.getBoardMember(matter.id, "builder-web"));
		assert.equal(result.replyText, "Final coordinator report");
	} finally {
		db.close();
	}
});
