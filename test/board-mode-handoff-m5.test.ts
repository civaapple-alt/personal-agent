import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { readSkillProposals } from "../packages/contracts/src/skill-proposal.ts";
import {
	openPersonalAgentDatabase,
	PersonalAgentStore,
	type RpcWorkerLike,
	TeamOrchestrator,
} from "../packages/server/src/index.ts";
import {
	buildBoardToLeadHandoffBlock,
	buildLeadToBoardHandoffBlock,
} from "../packages/server/src/orchestrator/execution/mode-handoff.ts";
import type { BoardWorkerContext } from "../packages/server/src/orchestrator/execution/worker-runner.ts";
import { emptyEffects } from "../packages/server/src/orchestrator/types.ts";
import { loadRoleTemplatesFromDir } from "../packages/server/src/roles/template-loader.ts";
import { parseCall } from "../packages/server/src/rpc/team-tool-bridge.ts";

test("Lead -> Board handoff injects prior conversation turns and Space anchors only when present", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pa-handoff-l2b-"));
	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db, { spacesDir: join(dir, "spaces") });
	try {
		const org = store.ensureDefaultOrganization();
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

		// Fresh Board matter has empty handoff context.
		const freshMatter = store.createMatter({
			title: "Fresh Board Matter",
			leadMemberId: "product-manager",
			collaborationMode: "board",
			coordinatorMemberId: "product-manager",
			orgId: org.id,
		});
		assert.equal(buildLeadToBoardHandoffBlock(store, freshMatter.id), "");

		// Prior Lead conversation + Space document gets packaged for Coordinator.
		const leadMatter = store.createMatter({
			title: "Upgrade From Lead",
			leadMemberId: "product-manager",
			collaborationMode: "lead",
			orgId: org.id,
		});
		const msg1 = store.appendMessage({
			matterId: leadMatter.id,
			channel: "user",
			senderType: "user",
			senderId: "usr_local_owner",
			content: "Please draft the v2 rate-limit design first.",
		});
		const msg2 = store.appendMessage({
			matterId: leadMatter.id,
			channel: "user",
			senderType: "member",
			senderId: "product-manager",
			content: "Settled design: sliding window with 100 req/min per org.",
		});
		const upgradeTriggerMsg = store.appendMessage({
			matterId: leadMatter.id,
			channel: "user",
			senderType: "user",
			senderId: "usr_local_owner",
			content: "Now implement and verify on the board.",
		});
		const space = store.spaces.resolveMatterDefaultSpace(leadMatter);
		const doc = await store.spaces.createDocument({
			spaceId: space.id,
			matterId: leadMatter.id,
			title: "Rate Limit PRD",
			content: "# Rate Limit PRD\nSliding window spec",
			actorId: "product-manager",
			actorName: "Product Manager",
		});

		const handoff = buildLeadToBoardHandoffBlock(store, leadMatter.id, upgradeTriggerMsg.id);
		assert.match(handoff, /\[Lead -> Board Handoff Context\]/);
		assert.match(handoff, new RegExp(msg1.content.slice(0, 20)));
		assert.match(handoff, new RegExp(msg2.content.slice(0, 20)));
		assert.doesNotMatch(handoff, /Now implement and verify on the board/);
		assert.match(handoff, new RegExp(doc.id));
		assert.match(handoff, /Rate Limit PRD/);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("Board -> Lead handoff injects roster, key board posts, and Space anchors into subsequent Lead turn", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pa-handoff-b2l-"));
	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db, { spacesDir: join(dir, "spaces") });
	try {
		const org = store.ensureDefaultOrganization();
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

		// Pure Lead matter with no board activity (even with mirrored internal_collab bpost_msg_* posts) has empty handoff block.
		const pureLead = store.createMatter({
			title: "Pure Lead",
			leadMemberId: "product-manager",
			collaborationMode: "lead",
			orgId: org.id,
		});
		store.appendMessage({
			matterId: pureLead.id,
			channel: "internal_collab",
			senderType: "member",
			senderId: "engineering-manager",
			content: "Internal Lead delegation update",
		});
		assert.equal(buildBoardToLeadHandoffBlock(store, pureLead.id), "");

		// Board matter switched back to Lead preserves board roster, key posts, and Space deliverables.
		const boardMatter = store.createMatter({
			title: "Board Then Lead",
			leadMemberId: "product-manager",
			collaborationMode: "board",
			coordinatorMemberId: "product-manager",
			orgId: org.id,
		});
		store.upsertBoardMember({
			matterId: boardMatter.id,
			agentId: "builder-api",
			displayName: "API Builder",
			boardRole: "builder",
			status: "waiting",
			ownedScope: ["packages/server/"],
		});
		store.createBoardPost({
			matterId: boardMatter.id,
			authorType: "agent",
			authorId: "builder-api",
			kind: "handoff",
			mentions: ["verifier-qa"],
			summary: "Implemented rate-limiter middleware and unit tests",
			artifacts: { files: [{ path: "packages/server/src/rate-limit.ts" }] },
		});
		store.createBoardPost({
			matterId: boardMatter.id,
			authorType: "agent",
			authorId: "verifier-qa",
			kind: "verify_pass",
			mentions: ["coordinator"],
			refPostNos: [1],
			summary: "Verified 100 req/min limit passes tests",
			verification: { verdict: "pass", target: "builder-api" },
		});

		const capturedPrompts: string[] = [];
		const orchestrator = new TeamOrchestrator({
			store,
			templates,
			defaultCwd: dir,
			workerFactory: (opts) =>
				({
					onEvent: () => () => {},
					onNotice: () => () => {},
					setDialogHandler: () => {},
					start: async () => {
						if (opts.env?.PA_TEAM_BRIDGE_URL && opts.env?.PA_TEAM_BRIDGE_TOKEN) {
							const res = await fetch(`${opts.env.PA_TEAM_BRIDGE_URL}/ready`, {
								method: "POST",
								headers: {
									"Content-Type": "application/json",
									Authorization: `Bearer ${opts.env.PA_TEAM_BRIDGE_TOKEN}`,
								},
								body: opts.env.PA_REQUIRED_TOOLS ?? "[]",
							});
							assert.equal(res.ok, true);
						}
					},
					stop: async () => {},
					getState: async () => ({ sessionId: "lead-after-board", isStreaming: false }),
					runPromptAndWait: async (prompt: string) => {
						capturedPrompts.push(prompt);
						return {
							disposition: "started",
							aborted: false,
							assistantText: "Grounded in board deliverables.",
							assistantMessages: [],
							toolExecutions: [],
							notices: [],
							dialogs: [],
							events: [],
						};
					},
				}) as unknown as RpcWorkerLike,
		});

		store.updateMatterBoardMeta(boardMatter.id, { collaborationMode: "lead", coordinatorMemberId: null });
		const followUp = await orchestrator.dispatchMatter({
			matterId: boardMatter.id,
			prompt: "Can we also bump the burst limit to 120?",
		});

		assert.equal(followUp.replyText, "Grounded in board deliverables.");
		assert.equal(capturedPrompts.length, 1);
		assert.match(capturedPrompts[0]!, /\[Board -> Lead Handoff Context\]/);
		assert.match(capturedPrompts[0]!, /@builder-api/);
		assert.match(capturedPrompts[0]!, /Verified 100 req\/min limit passes tests/);
		assert.match(capturedPrompts[0]!, /packages\/server\/src\/rate-limit\.ts/);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("spawn_board_agent parses modelOverride, passes it to Verifier worker, and preserves Coordinator artifacts", async () => {
	const parsed = parseCall({
		tool: "spawn_board_agent",
		callId: "call-1",
		args: {
			agentId: "verifier-math",
			boardRole: "verifier",
			brief: "Verify clamp fix independently",
			modelOverride: {
				provider: "opencode-go",
				model: "deepseek-v4.1-flash",
				thinkingLevel: "high",
			},
		},
	});
	assert.equal(parsed.tool, "spawn_board_agent");
	assert.deepEqual(parsed.modelOverride, {
		provider: "opencode-go",
		model: "deepseek-v4.1-flash",
		thinkingLevel: "high",
	});

	const dir = mkdtempSync(join(tmpdir(), "pa-board-m5-"));
	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db, { spacesDir: join(dir, "spaces") });
	try {
		const org = store.ensureDefaultOrganization();
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

		// Pre-populate a prior Lead message so Lead -> Board handoff is also exercised on Coordinator turn 1.
		const matter = store.createMatter({
			title: "Lead Upgrade + Cross-Model Verifier",
			leadMemberId: "product-manager",
			collaborationMode: "board",
			coordinatorMemberId: "product-manager",
			orgId: org.id,
		});
		store.appendMessage({
			matterId: matter.id,
			channel: "user",
			senderType: "user",
			senderId: "usr_local_owner",
			content: "Agreed scope: keep API backwards compatible.",
		});

		let coordinatorPrompt = "";

		// Use runBoardCollaborationTurn with realistic executeWithWorker stub (matching M2 harness pattern).
		const { runBoardCollaborationTurn } = await import(
			"../packages/server/src/orchestrator/execution/board-runner.ts"
		);
		const boardLaunches: Array<{ agentId: string; modelOverride: unknown }> = [];
		const coordinatorTurns = { count: 0 };

		await runBoardCollaborationTurn(
			{
				store,
				defaultCwd: dir,
				requireMatter: (id) => store.getMatter(id)!,
				executeWithWorker: async (workerInput) => {
					const boardCtx: BoardWorkerContext = workerInput.boardContext!;
					boardLaunches.push({ agentId: boardCtx.agentId, modelOverride: boardCtx.modelOverride ?? null });
					if (boardCtx.agentId === "coordinator") {
						coordinatorTurns.count += 1;
						if (coordinatorTurns.count === 1) {
							coordinatorPrompt = workerInput.taskPrompt;
							await boardCtx.onToolCall(
								{
									tool: "spawn_board_agent",
									callId: "spawn-v",
									agentId: "verifier-cross",
									boardRole: "verifier",
									brief: "Independent verifier on alternate model",
									modelOverride: {
										provider: "opencode-go",
										model: "deepseek-v4.1-flash",
										thinkingLevel: "high",
									},
								},
								workerInput.signal,
							);
							await boardCtx.onToolCall(
								{
									tool: "post_to_board",
									callId: "post-1",
									kind: "assign",
									mentions: ["verifier-cross"],
									summary: "Run check",
								},
								workerInput.signal,
							);
						} else {
							const space = store.spaces.resolveMatterDefaultSpace(matter);
							const savedDoc = await store.spaces.createDocument({
								spaceId: space.id,
								matterId: matter.id,
								title: "Board Verification Report",
								content: "# Report\nPassed",
								actorId: "product-manager",
								actorName: "Product Manager",
							});
							workerInput.effectsTarget.savedDocuments.push({
								...savedDoc,
								memberId: "product-manager",
							});
							workerInput.effectsTarget.skillProposals.push({
								id: "skp_board_1",
								name: "board-smoke-check",
								description: "Check board outputs",
								body: "# Skill",
								storageScope: "org",
								rationale: "Preserve repeatable verification workflow",
								scripts: [],
								status: "pending",
							});
							await boardCtx.onToolCall(
								{
									tool: "post_to_board",
									callId: "post-sum",
									kind: "summary",
									mentions: [],
									summary: "All verified and archived",
								},
								workerInput.signal,
							);
							return {
								disposition: "started",
								aborted: false,
								assistantText: "Final verified board report archived.",
								assistantMessages: [],
								toolExecutions: [],
								notices: [],
								dialogs: [],
								events: [],
							};
						}
					} else if (boardCtx.agentId === "verifier-cross") {
						await boardCtx.onToolCall(
							{
								tool: "post_to_board",
								callId: "post-v",
								kind: "verify_pass",
								mentions: ["coordinator"],
								refPostNos: [1],
								summary: "Verified pass",
								verification: { target: "builder", verdict: "pass" },
							},
							workerInput.signal,
						);
					}
					return {
						disposition: "started",
						aborted: false,
						assistantText: "",
						assistantMessages: [],
						toolExecutions: [],
						notices: [],
						dialogs: [],
						events: [],
					};
				},
			},
			{
				matter,
				workspace: null,
				coordinatorBaseMember: store.getMember("product-manager")!,
				effectiveOrgId: org.id,
				input: { matterId: matter.id, prompt: "Proceed with board implementation" },
				run: {
					settled: Promise.resolve(),
					finish: () => {},
					controller: new AbortController(),
					cancelled: false,
					workers: new Set(),
					contexts: new Set(),
					delegations: new Map(),
					activeDelegations: new Map(),
					draftVerifications: new Map(),
					recentLogs: [],
					delegationCount: 0,
					effects: emptyEffects(),
					userMessageId: "msg_trigger_l2b",
					startedByUserId: null,
					keepMatterLead: false,
					startedAt: Date.now(),
					timeoutMs: 0,
					deadlineAt: null,
				},
				emitDispatchProgress: () => {},
			},
		);

		assert.match(coordinatorPrompt, /\[Lead -> Board Handoff Context\]/);
		assert.match(coordinatorPrompt, /Agreed scope: keep API backwards compatible/);
		assert.deepEqual(boardLaunches.find((entry) => entry.agentId === "verifier-cross")?.modelOverride, {
			provider: "opencode-go",
			model: "deepseek-v4.1-flash",
			thinkingLevel: "high",
		});

		const savedVerifier = store.getBoardMember(matter.id, "verifier-cross");
		assert.deepEqual(savedVerifier?.modelOverride, {
			provider: "opencode-go",
			model: "deepseek-v4.1-flash",
			thinkingLevel: "high",
		});

		const userMessages = store.listMessages(matter.id, "user");
		const finalReply = userMessages.at(-1);
		assert.equal(finalReply?.senderType, "member");
		const attachedDocs = Array.isArray(finalReply?.metadata?.spaceDocuments)
			? finalReply.metadata.spaceDocuments
			: [];
		assert.equal(attachedDocs.length, 1);
		assert.equal(readSkillProposals(finalReply?.metadata).length, 1);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
