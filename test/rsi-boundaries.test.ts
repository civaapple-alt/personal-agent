import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { type RpcWorkerLike, TeamOrchestrator } from "../src/orchestrator/team-orchestrator.ts";
import { loadRoleTemplatesFromDir } from "../src/roles/template-loader.ts";
import type { PiRpcWorkerOptions, PromptRunResult, RunPromptOptions } from "../src/rpc/pi-rpc-worker.ts";
import { openPersonalAgentDatabase } from "../src/storage/database.ts";
import { PersonalAgentStore } from "../src/storage/repositories.ts";
import { invokeTool, reportReady } from "./worker-helpers.ts";

function result(text = "done"): PromptRunResult {
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
}
async function fixture(
	t: test.TestContext,
	handler: (options: PiRpcWorkerOptions, prompt: string, run: RunPromptOptions) => Promise<PromptRunResult>,
) {
	const root = await mkdtemp(join(tmpdir(), "pa-rsi-boundary-"));
	const db = openPersonalAgentDatabase();
	const store = new PersonalAgentStore(db);
	const templates = await loadRoleTemplatesFromDir(resolve("roles"));
	const factory = (options: PiRpcWorkerOptions): RpcWorkerLike => ({
		async start() {
			if (options.env?.PA_TEAM_BRIDGE_URL) await reportReady(options);
		},
		async stop() {},
		async abort() {},
		async getState() {
			return { sessionId: "fixture" };
		},
		onNotice() {
			return () => {};
		},
		setDialogHandler() {},
		async runPromptAndWait(prompt, run = {}) {
			return await handler(options, prompt, run);
		},
	});
	const options = { store, templates, defaultCwd: root, sessionDir: join(root, "sessions"), workerFactory: factory };
	const orchestrator = new TeamOrchestrator(options);
	t.after(async () => {
		await orchestrator.shutdown();
		db.close();
		await rm(root, { recursive: true, force: true });
	});
	return { root, db, store, orchestrator, options };
}

test("memory replacement cannot retire another member or workspace and cannot form cycles", async (t) => {
	const f = await fixture(t, async () => result());
	const a = f.store.upsertWorkspace({ name: "A", repoPath: f.root });
	const b = f.store.upsertWorkspace({ name: "B", repoPath: join(f.root, "B") });
	const original = f.store.addMemory({
		memberId: "engineering-manager",
		scope: "project_private",
		workspaceId: a.id,
		content: "A rule",
		verified: true,
	});
	for (const patch of [
		{ memberId: "qa-manager", workspaceId: a.id },
		{ memberId: "engineering-manager", workspaceId: b.id },
	]) {
		await assert.rejects(
			async () =>
				f.store.addMemory({
					...patch,
					scope: "project_private",
					content: "invalid replacement",
					verified: true,
					supersedesMemoryId: original.id,
				}),
			/same member.*scope.*workspace/,
		);
		assert.equal(f.store.getMemory(original.id)?.status, "verified");
	}
	const replacement = f.store.addMemory({
		memberId: original.memberId,
		scope: original.scope,
		workspaceId: a.id,
		content: "new A rule",
		supersedesMemoryId: original.id,
	});
	await assert.rejects(
		async () => f.store.updateMemory(replacement.id, { memberId: "qa-manager", status: "verified" }),
		/same member.*scope.*workspace/,
	);
	await assert.rejects(async () => f.store.updateMemory(original.id, { supersedesMemoryId: replacement.id }), /cycle/);
	assert.equal(f.store.getMemory(replacement.id)?.memberId, original.memberId);
});

test("RSI only reflects current workspace evidence and rejects candidate owners who did not participate", async (t) => {
	let prompt = "";
	const f = await fixture(t, async (_options, input) => {
		prompt = input;
		return result(
			JSON.stringify({
				summary: "current scope",
				candidates: [
					{ memberId: "product-manager", scope: "project_private", content: "B new rule" },
					{ memberId: "marketing-lead", scope: "role_general", content: "outsider rule" },
				],
			}),
		);
	});
	const a = f.store.upsertWorkspace({ name: "A", repoPath: f.root });
	const b = f.store.upsertWorkspace({ name: "B", repoPath: join(f.root, "B") });
	const matter = f.store.createMatter({ title: "scope test", leadMemberId: "product-manager", workspaceId: a.id });
	f.store.appendMessage({
		matterId: matter.id,
		channel: "user",
		senderType: "user",
		senderId: "user",
		content: "PRIVATE_COMPANY_A",
		metadata: { workspaceId: a.id, repoPath: a.repoPath },
	});
	f.store.appendMessage({
		matterId: matter.id,
		channel: "internal_collab",
		senderType: "member",
		senderId: "engineering-manager",
		content: "PRIVATE_COLLAB_A",
		metadata: { workspaceId: a.id },
	});
	const old = f.store.recordDeliverable({
		matterId: matter.id,
		memberId: "product-manager",
		type: "document",
		title: "PRIVATE_ARTIFACT_A",
		contentOrPath: "PRIVATE_CONTENT_A",
	});
	f.store.appendMessage({
		matterId: matter.id,
		channel: "user",
		senderType: "member",
		senderId: "product-manager",
		content: "A answer",
		metadata: { workspaceId: a.id, repoPath: a.repoPath, deliverableIds: [old.id] },
	});
	f.store.updateMatterWorkspace(matter.id, b.id);
	f.store.appendMessage({
		matterId: matter.id,
		channel: "user",
		senderType: "user",
		senderId: "user",
		content: "CURRENT_B_EVIDENCE",
		metadata: { workspaceId: b.id, repoPath: b.repoPath },
	});
	const distilled = await f.orchestrator.distillExperiences({ matterId: matter.id });
	assert.doesNotMatch(prompt, /PRIVATE_/);
	assert.match(prompt, /CURRENT_B_EVIDENCE/);
	assert.deepEqual(
		distilled.createdMemories.map((m) => m.memberId),
		["product-manager"],
	);
	assert.deepEqual(distilled.participatingMemberIds, ["product-manager"]);
	await assert.rejects(f.orchestrator.distillExperiences({ matterId: matter.id, deliverableId: old.id }), /workspace/);
});

test("RSI reads feedback only from accessible space documents in the current workspace", async (t) => {
	let prompt = "";
	const f = await fixture(t, async (_options, text) => {
		prompt = text;
		return result(JSON.stringify({ summary: "review", candidates: [] }));
	});
	const a = f.store.upsertWorkspace({ name: "A", repoPath: f.root });
	const b = f.store.upsertWorkspace({ name: "B", repoPath: join(f.root, "B") });
	const admin = f.store.ensureLocalBootstrapAdmin("Owner");
	const matter = f.store.createMatter({ title: "Feedback", leadMemberId: "product-manager", workspaceId: b.id });
	f.store.spaces.ensureAllDefaultSpaces();
	const spaces = f.store.spaces.listSpaces();
	const spaceA = spaces.find((entry) => entry.workspaceId === a.id);
	const spaceB = spaces.find((entry) => entry.workspaceId === b.id);
	const userSpace = spaces.find((entry) => entry.ownerUserId === admin.id && entry.kind === "user");
	assert.ok(spaceA && spaceB && userSpace);
	for (const [space, text] of [
		[spaceA, "OLD_WORKSPACE_SECRET"],
		[userSpace, "OTHER_USER_SECRET"],
		[spaceB, "CURRENT_FEEDBACK"],
	] as const) {
		const doc = await f.store.spaces.createDocument({
			spaceId: space.id,
			matterId: matter.id,
			title: text,
			content: text,
			actorId: admin.id,
		});
		await f.store.spaces.saveDocumentFeedback({
			documentId: doc.id,
			commitHash: doc.headCommit,
			actorId: admin.id,
			actorName: "Owner",
			feedback: text,
			rating: "positive",
		});
	}
	await f.orchestrator.distillExperiences({
		matterId: matter.id,
		canReadSpace: (spaceId) => spaceId !== userSpace.id,
	});
	assert.match(prompt, /CURRENT_FEEDBACK/);
	assert.doesNotMatch(prompt, /OLD_WORKSPACE_SECRET|OTHER_USER_SECRET/);
});

test("a successful colleague proposal is still discarded if the lead fails afterward", async (t) => {
	const f = await fixture(t, async (options) => {
		if (options.env?.PA_CAN_SAVE_SPACE === "false") {
			await invokeTool(options, "propose_experience", {
				scope: "role_general",
				content: "child draft",
				rationale: "not finalized",
			});
			return result("child answer");
		}
		await invokeTool(options, "delegate_to_member", { memberId: "engineering-manager", task: "review" });
		throw new Error("lead failed after colleague");
	});
	await assert.rejects(
		f.orchestrator.dispatchMatter({ prompt: "test", preferredMemberId: "product-manager" }),
		/lead failed/,
	);
	assert.equal(f.store.listMemberMemories("engineering-manager").length, 0);
});

test("feedback scores only memories injected for the reviewed space version", async (t) => {
	let first = true;
	const f = await fixture(t, async (options) => {
		await invokeTool(options, "save_space_page", {
			type: "document",
			title: "design",
			content: first ? "V1" : "V2",
			changeNote: "explicit version",
		});
		return result();
	});
	const a = f.store.upsertWorkspace({ name: "A", repoPath: f.root });
	const b = f.store.upsertWorkspace({ name: "B", repoPath: join(f.root, "B") });
	const ma = f.store.addMemory({
		memberId: "product-manager",
		scope: "project_private",
		workspaceId: a.id,
		content: "A memory",
	});
	const mb = f.store.addMemory({
		memberId: "product-manager",
		scope: "project_private",
		workspaceId: b.id,
		content: "B memory",
	});
	const v1 = await f.orchestrator.dispatchMatter({
		prompt: "first",
		preferredMemberId: "product-manager",
		workspaceId: a.id,
	});
	first = false;
	await f.orchestrator.dispatchMatter({ matterId: v1.matter.id, prompt: "second", workspaceId: b.id });
	const doc = f.store.spaces
		.listDocuments({ matterId: v1.matter.id })
		.find((entry) => entry.spaceId === `spc_ws_${b.id}`);
	assert.ok(doc);
	for (const rating of ["positive", "negative", "positive"] as const) {
		await f.store.spaces.saveDocumentFeedback({
			documentId: doc.id,
			commitHash: doc.headCommit,
			actorId: "reviewer",
			actorName: "Reviewer",
			feedback: rating,
			rating,
		});
	}
	assert.equal(f.store.getMemory(ma.id)?.positiveCount, 0);
	assert.equal(f.store.getMemory(ma.id)?.negativeCount, 0);
	assert.equal(f.store.getMemory(mb.id)?.positiveCount, 1);
	assert.equal(f.store.getMemory(mb.id)?.negativeCount, 0);
});

test("verified replacement links cannot be bypassed by clearing a pointer or moving either endpoint", async (t) => {
	const f = await fixture(t, async () => result());
	const workspace = f.store.upsertWorkspace({ name: "A", repoPath: f.root });
	const old = f.store.addMemory({
		memberId: "product-manager",
		scope: "role_general",
		content: "old",
		verified: true,
	});
	const replacement = f.store.addMemory({
		memberId: old.memberId,
		scope: old.scope,
		content: "new",
		supersedesMemoryId: old.id,
		verified: true,
	});
	for (const patch of [
		{ memberId: "qa-manager", supersedesMemoryId: null },
		{ scope: "project_private" as const, workspaceId: workspace.id, supersedesMemoryId: null },
	]) {
		assert.throws(() => f.store.updateMemory(replacement.id, patch), /same member.*scope.*workspace/);
	}
	assert.throws(() => f.store.updateMemory(replacement.id, { supersedesMemoryId: null }), /detach/);
	assert.throws(() => f.store.updateMemory(old.id, { memberId: "qa-manager" }), /same member.*scope.*workspace/);
	assert.equal(f.store.getMemory(old.id)?.supersededBy, replacement.id);
	assert.equal(f.store.getMemory(replacement.id)?.supersedesMemoryId, old.id);
});

test("shutdown awaits reflection cleanup before database close and discards a completed but cancelled payload", async (t) => {
	const f = await fixture(t, async () => result());
	const started = Promise.withResolvers<void>();
	const stopEntered = Promise.withResolvers<void>();
	const allowStop = Promise.withResolvers<void>();
	let stopped = false;
	const orchestrator = new TeamOrchestrator({
		...f.options,
		workerFactory: () => ({
			async start() {},
			async abort() {},
			async stop() {
				stopEntered.resolve();
				await allowStop.promise;
				f.db.prepare("SELECT 1").get();
				stopped = true;
			},
			async getState() {
				return { sessionId: "reflection" };
			},
			onNotice() {
				return () => {};
			},
			setDialogHandler() {},
			async runPromptAndWait(_prompt, options) {
				started.resolve();
				await new Promise<void>((resolve) =>
					options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
				);
				return result(
					JSON.stringify({
						summary: "partial",
						candidates: [{ scope: "role_general", content: "must not persist" }],
					}),
				);
			},
		}),
	});
	const matter = f.store.createMatter({ title: "shutdown", leadMemberId: "product-manager" });
	const pending = orchestrator.distillExperiences({ matterId: matter.id });
	const rejected = assert.rejects(pending, /aborted/);
	await started.promise;
	let shutdownDone = false;
	const shutdown = orchestrator.shutdown().then(() => {
		shutdownDone = true;
	});
	await stopEntered.promise;
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(shutdownDone, false);
	allowStop.resolve();
	await shutdown;
	await rejected;
	assert.equal(stopped, true);
	assert.equal(f.store.listMemberMemories("product-manager").length, 0);
	assert.equal(orchestrator.abortDistillation(matter.id), false);
	await assert.rejects(orchestrator.distillExperiences({ matterId: matter.id }), /shutting down/);
});

test("a workspace change during reflection invalidates its result and factory failures release cancellation state", async (t) => {
	const started = Promise.withResolvers<void>();
	const answer = Promise.withResolvers<void>();
	const f = await fixture(t, async () => {
		started.resolve();
		await answer.promise;
		return result(JSON.stringify({ candidates: [{ scope: "role_general", content: "stale" }] }));
	});
	const workspace = f.store.upsertWorkspace({ name: "new", repoPath: f.root });
	const matter = f.store.createMatter({ title: "race", leadMemberId: "product-manager" });
	const pending = f.orchestrator.distillExperiences({ matterId: matter.id });
	const rejected = assert.rejects(pending, /Workspace changed/);
	await started.promise;
	f.store.updateMatterWorkspace(matter.id, workspace.id);
	answer.resolve();
	await rejected;
	assert.equal(f.store.listMemberMemories("product-manager").length, 0);
	const failed = new TeamOrchestrator({
		...f.options,
		workerFactory: () => {
			throw new Error("factory failure");
		},
	});
	await assert.rejects(failed.distillExperiences({ matterId: matter.id }), /factory failure/);
	assert.equal(failed.abortDistillation(matter.id), false);
	await failed.shutdown();
});

test("neutral feedback retracts a version vote while manual evaluations remain independent", async (t) => {
	const f = await fixture(t, async (options) => {
		await invokeTool(options, "save_space_page", {
			type: "document",
			title: "version",
			content: "document",
			changeNote: "milestone",
		});
		return result();
	});
	const memory = f.store.addMemory({ memberId: "product-manager", scope: "role_general", content: "method" });
	const turn = await f.orchestrator.dispatchMatter({ prompt: "publish", preferredMemberId: "product-manager" });
	const doc = f.store.spaces.listDocuments({ matterId: turn.matter.id })[0];
	assert.ok(doc);
	f.store.evaluateMemory({ memoryId: memory.id, outcome: "feedback_positive" });
	for (const rating of ["positive", "positive", "negative", "positive", "neutral"] as const)
		await f.store.spaces.saveDocumentFeedback({
			documentId: doc.id,
			commitHash: doc.headCommit,
			actorId: "reviewer",
			actorName: "Reviewer",
			feedback: rating,
			rating,
		});
	assert.equal(f.store.getMemory(memory.id)?.positiveCount, 1, "manual positive remains");
	assert.equal(f.store.getMemory(memory.id)?.negativeCount, 0);
	assert.equal(f.store.spaces.listDocumentFeedback(doc.id)[0]?.rating, "neutral");
});

test("an invalid candidate rolls back the turn and unlinked memories are not scored", async (t) => {
	const f = await fixture(t, async () => result());
	const matter = f.store.createMatter({ title: "atomic", leadMemberId: "product-manager" });
	assert.throws(
		() =>
			f.store.recordTurnOutcome({
				candidates: [
					{ memberId: "product-manager", scope: "role_general", content: "should roll back" },
					{ memberId: "missing", scope: "role_general", content: "invalid" },
				],
				applicationIds: [],
			}),
		/FOREIGN KEY/,
	);
	assert.equal(f.store.listMemberMemories("product-manager").length, 0);
	const memory = f.store.addMemory({ memberId: "product-manager", scope: "role_general", content: "method" });
	f.store.recordMemoryApplications({ memoryIds: [memory.id], matterId: matter.id, memberId: "product-manager" });
	const space = f.store.spaces.resolveMatterDefaultSpace(matter);
	const document = await f.store.spaces.createDocument({
		spaceId: space.id,
		matterId: matter.id,
		title: "Manually saved",
		content: "body",
		actorId: "reviewer",
	});
	await f.store.spaces.saveDocumentFeedback({
		documentId: document.id,
		commitHash: document.headCommit,
		actorId: "reviewer",
		actorName: "Reviewer",
		feedback: "Good",
		rating: "positive",
	});
	assert.equal(f.store.getMemory(memory.id)?.positiveCount, 0);
});

test("explicit reflection abort normalizes transport rejection to the public cancellation result", async (t) => {
	const started = Promise.withResolvers<void>();
	const f = await fixture(t, async (_options, _prompt, run) => {
		started.resolve();
		await new Promise<void>((_resolve, reject) =>
			run.signal?.addEventListener("abort", () => reject(new Error("Prompt cancelled")), { once: true }),
		);
		return result();
	});
	const matter = f.store.createMatter({ title: "cancel", leadMemberId: "product-manager" });
	const pending = f.orchestrator.distillExperiences({ matterId: matter.id });
	const rejected = assert.rejects(pending, /^Error: Experience distillation was aborted$/);
	await started.promise;
	assert.equal(f.orchestrator.abortDistillation(matter.id), true);
	await rejected;
});

test("org-bound propose_experience and distillation route company_private to orgId shared across org repos", async (t) => {
	let phase: "execute" | "distill" = "execute";
	const f = await fixture(t, async (options) => {
		if (phase === "execute") {
			await invokeTool(options, "propose_experience", {
				scope: "company_private",
				category: "collaboration",
				content: "ORG_COLLAB: PRD signoff required before DB migrations across Acme repos",
				rationale: "Avoid breaking downstream services in the same org",
			});
			return result("done");
		}
		return result(
			JSON.stringify({
				summary: "提炼组织经验与仓库规范",
				candidates: [
					{
						memberId: "product-manager",
						category: "domain_constraint",
						scope: "company_private",
						content: "ORG_CONSTRAINT: Use UTC ISO-8601 timestamps across Acme APIs",
						rationale: "Shared multi-repo API standard",
					},
					{
						memberId: "product-manager",
						category: "efficiency",
						scope: "project_private",
						content: "WS_A_ONLY: Run fast sqlite smoke test in service-a",
						rationale: "Specific to service-a",
					},
				],
			}),
		);
	});

	const org = f.store.upsertOrganization({ name: "Acme Corp", gitEmailDomain: "acme.dev" });
	const wsA = f.store.upsertWorkspace({ orgId: org.id, name: "service-a", repoPath: "/tmp/rsi-org-a" });
	const wsB = f.store.upsertWorkspace({ orgId: org.id, name: "service-b", repoPath: "/tmp/rsi-org-b" });

	await f.orchestrator.dispatchMatter({
		prompt: "在 service-a 协作",
		preferredMemberId: "product-manager",
		workspaceId: wsA.id,
	});
	const matter = f.store.listMatters()[0]!;
	phase = "distill";
	const distilled = await f.orchestrator.distillExperiences({ matterId: matter.id });
	assert.equal(distilled.createdMemories.length, 2);

	const memories = f.store.listMemberMemories("product-manager");
	const orgCollab = memories.find((m) => m.content.includes("ORG_COLLAB"))!;
	const orgConstraint = memories.find((m) => m.content.includes("ORG_CONSTRAINT"))!;
	const wsAOnly = memories.find((m) => m.content.includes("WS_A_ONLY"))!;

	assert.equal(orgCollab.orgId, org.id);
	assert.equal(orgCollab.workspaceId, null);
	assert.equal(orgConstraint.orgId, org.id);
	assert.equal(orgConstraint.workspaceId, null);
	assert.equal(wsAOnly.orgId, null);
	assert.equal(wsAOnly.workspaceId, wsA.id);

	// Both org memories are visible in sibling repo wsB; wsA-only project memory is NOT visible in wsB
	const wsBRelevant = f.store.listRelevantMemories("product-manager", wsB.id);
	assert.ok(wsBRelevant.some((m) => m.id === orgCollab.id));
	assert.ok(wsBRelevant.some((m) => m.id === orgConstraint.id));
	assert.ok(!wsBRelevant.some((m) => m.id === wsAOnly.id));

	// Cross-org memory replacement must be rejected
	const otherOrg = f.store.upsertOrganization({ name: "Other Corp" });
	assert.throws(
		() =>
			f.store.addMemory({
				memberId: "product-manager",
				scope: "company_private",
				orgId: otherOrg.id,
				content: "Cross org override",
				supersedesMemoryId: orgConstraint.id,
			}),
		/same member, scope, organization and workspace/,
	);
});

test("Promoting a competing experience keeps the accepted replacement authoritative", async (t) => {
	const f = await fixture(t, async () => result());
	const original = f.store.addMemory({
		memberId: "product-manager",
		scope: "role_general",
		content: "Original rule",
		verified: true,
	});
	const candidate = (content: string) =>
		f.store.addMemory({
			memberId: original.memberId,
			scope: original.scope,
			content,
			supersedesMemoryId: original.id,
		});
	const accepted = candidate("Accepted rule");
	const competing = candidate("Competing rule");

	assert.deepEqual(
		f.store.listRelevantMemories(original.memberId, null).map(({ id }) => id),
		[original.id],
	);
	f.store.updateMemory(accepted.id, { status: "verified" });
	assert.equal(f.store.updateMemory(accepted.id, { status: "verified" }).status, "verified");
	assert.throws(() => f.store.updateMemory(competing.id, { status: "verified" }), /already has a replacement/);
	assert.throws(() => f.store.updateMemory(original.id, { status: "verified" }), /established replacement/);
	assert.equal(f.store.getMemory(competing.id)?.status, "candidate");
	assert.equal(f.store.getMemory(original.id)?.supersededBy, accepted.id);
	assert.deepEqual(
		f.store.listRelevantMemories(original.memberId, null).map(({ id }) => id),
		[accepted.id],
	);
});
