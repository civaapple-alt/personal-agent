import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { type RpcWorkerLike, TeamOrchestrator } from "../packages/server/src/orchestrator/team-orchestrator.ts";
import { loadRoleTemplatesFromDir } from "../packages/server/src/roles/template-loader.ts";
import type {
	PiRpcWorkerOptions,
	PromptRunResult,
	RunPromptOptions,
} from "../packages/server/src/rpc/pi-rpc-worker.ts";
import { openPersonalAgentDatabase } from "../packages/server/src/storage/database.ts";
import { PersonalAgentStore } from "../packages/server/src/storage/repositories.ts";
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

test("a successful colleague proposal is still discarded if the lead fails afterward", async (t) => {
	const f = await fixture(t, async (options) => {
		if (options.env?.PA_CAN_SAVE_SPACE === "false") {
			await invokeTool(options, "propose_skill", {
				name: "child-draft-skill",
				description: "Child draft workflow",
				body: "Step 1: check draft.",
				storageScope: "personal",
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
	const matters = f.store.listMatters();
	const allMessages = matters.flatMap((m) => f.store.listMessages(m.id, "user"));
	assert.equal(
		allMessages.some((m) => Array.isArray(m.metadata?.skillProposals) && m.metadata.skillProposals.length > 0),
		false,
	);
});

test("org-bound propose_skill routes org scopes cleanly across org repos", async (t) => {
	const f = await fixture(t, async (options) => {
		await invokeTool(options, "propose_skill", {
			name: "acme-migration-signoff",
			description: "PRD signoff checklist before DB migrations across Acme repos",
			body: "Always get PRD signoff before DB migrations.",
			storageScope: "org",
			rationale: "Avoid breaking downstream services in the same org",
		});
		return result("done");
	});

	const org = f.store.upsertOrganization({ name: "Acme Corp", gitEmailDomain: "acme.dev" });
	const wsA = f.store.upsertWorkspace({ orgId: org.id, name: "service-a", repoPath: "/tmp/rsi-org-a" });

	const dispatched = await f.orchestrator.dispatchMatter({
		prompt: "在 service-a 协作",
		preferredMemberId: "product-manager",
		workspaceId: wsA.id,
	});
	const replyMsg = f.store.listMessages(dispatched.matter.id, "user").find((m) => m.senderType === "member");
	assert.equal(
		(replyMsg?.metadata?.skillProposals as Array<{ name: string; storageScope: string }> | undefined)?.[0]
			?.storageScope,
		"org",
	);
});
