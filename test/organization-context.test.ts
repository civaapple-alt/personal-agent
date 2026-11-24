import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { collectTeamFrictionDigest } from "../packages/server/src/orchestrator/meta-architect.ts";
import { TeamOrchestrator } from "../packages/server/src/orchestrator/team-orchestrator.ts";
import { loadRoleTemplatesFromDir } from "../packages/server/src/roles/template-loader.ts";
import type { PiRpcWorkerOptions, PromptRunResult } from "../packages/server/src/rpc/pi-rpc-worker.ts";
import { canActorAccessMemory } from "../packages/server/src/server/acl.ts";
import type { RequestActor } from "../packages/server/src/server/auth.ts";
import { userToCollaboratorView } from "../packages/server/src/server/auth.ts";
import { openPersonalAgentDatabase } from "../packages/server/src/storage/database.ts";
import { PersonalAgentStore } from "../packages/server/src/storage/repositories.ts";
import { reportReady } from "./worker-helpers.ts";

const result = (text: string): PromptRunResult => ({
	disposition: "started",
	aborted: false,
	assistantText: text,
	assistantMessages: [],
	toolExecutions: [],
	notices: [],
	dialogs: [],
	events: [],
});

async function fixture(t: test.TestContext, reflect?: (prompt: string) => Promise<string>) {
	const root = await mkdtemp(join(tmpdir(), "pa-org-context-"));
	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db);
	const templates = await loadRoleTemplatesFromDir(resolve("roles"));
	const calls: Array<{ options: PiRpcWorkerOptions; prompt: string; file: string }> = [];
	const orchestrator = new TeamOrchestrator({
		store,
		templates,
		defaultCwd: root,
		sessionDir: join(root, "sessions"),
		workerFactory: (options) => {
			const id = randomUUID();
			const file = options.sessionFile ?? join(root, "sessions", `${id}.jsonl`);
			return {
				async start() {
					if (!options.noSession) {
						await mkdir(join(root, "sessions"), { recursive: true });
						if (!options.sessionFile)
							await writeFile(file, `${JSON.stringify({ type: "session", id, cwd: options.cwd })}\n`);
					}
					if (options.env?.PA_TEAM_BRIDGE_URL) await reportReady(options);
				},
				async getState() {
					return {
						sessionId: options.sessionFile ? options.sessionFile.split("/").at(-1)!.replace(".jsonl", "") : id,
						sessionFile: file,
					};
				},
				async stop() {},
				onNotice() {
					return () => {};
				},
				setDialogHandler() {},
				async runPromptAndWait(prompt) {
					calls.push({ options, prompt, file });
					return result(options.noSession ? ((await reflect?.(prompt)) ?? '{"candidates":[]}') : "scoped reply");
				},
			};
		},
	});
	const a = store.upsertOrganization({ name: "Org A" });
	const b = store.upsertOrganization({ name: "Org B" });
	t.after(async () => {
		await orchestrator.shutdown();
		db.close();
		await rm(root, { recursive: true, force: true });
	});
	return { root, db, store, orchestrator, calls, a, b };
}

test("workspace-less organization switches isolate native sessions and bounded history, and switching back resumes", async (t) => {
	const f = await fixture(t);
	const matter = f.store.createMatter({ title: "org test", orgId: f.a.id, leadMemberId: "product-manager" });
	await f.orchestrator.dispatchMatter({ matterId: matter.id, prompt: "PRIVATE_A_ONLY" });
	f.store.updateMatterOrganization(matter.id, f.b.id);
	await f.orchestrator.dispatchMatter({ matterId: matter.id, prompt: "CURRENT_B" });
	assert.equal(f.calls[1]?.options.sessionFile, undefined);
	assert.doesNotMatch(f.calls[1]!.prompt, /PRIVATE_A_ONLY/);
	f.store.updateMatterOrganization(matter.id, f.a.id);
	await f.orchestrator.dispatchMatter({ matterId: matter.id, prompt: "BACK_A" });
	assert.equal(f.calls[2]?.options.sessionFile, f.calls[0]?.file);
});

test("organization reflection includes its memories and excludes evidence from another organization", async (t) => {
	let prompt = "";
	const f = await fixture(t, async (value) => {
		prompt = value;
		return '{"candidates":[]}';
	});
	const matter = f.store.createMatter({ title: "reflection", orgId: f.a.id, leadMemberId: "product-manager" });
	await f.orchestrator.dispatchMatter({ matterId: matter.id, prompt: "PRIVATE_ORG_A" });
	f.store.updateMatterOrganization(matter.id, f.b.id);
	f.store.addMemory({
		memberId: "product-manager",
		scope: "company_private",
		orgId: f.b.id,
		content: "ORG_B_EXISTING_RULE",
	});
	await f.orchestrator.dispatchMatter({ matterId: matter.id, prompt: "ORG_B_EVIDENCE" });
	await f.orchestrator.distillExperiences({ matterId: matter.id });
	assert.doesNotMatch(prompt, /PRIVATE_ORG_A/);
	assert.match(prompt, /ORG_B_EXISTING_RULE/);
	assert.match(prompt, /ORG_B_EVIDENCE/);
});

test("an organization change during reflection invalidates its candidate instead of saving under the old org", async (t) => {
	const entered = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<string>();
	const f = await fixture(t, async () => {
		entered.resolve();
		return finish.promise;
	});
	const matter = f.store.createMatter({
		title: "change during reflection",
		orgId: f.a.id,
		leadMemberId: "product-manager",
	});
	const pending = f.orchestrator.distillExperiences({ matterId: matter.id });
	await entered.promise;
	f.store.updateMatterOrganization(matter.id, f.b.id);
	finish.resolve('{"candidates":[{"scope":"company_private","content":"STALE_A_RULE"}]}');
	await assert.rejects(pending, /[Oo]rganization.*changed/);
	assert.equal(f.store.listMemberMemories("product-manager").length, 0);
});

test("legacy workspace reassignment isolates sessions and workspace-private memory", async (t) => {
	const f = await fixture(t);
	const workspace = f.store.upsertWorkspace({ name: "reassigned", repoPath: f.root, orgId: f.a.id });
	const first = await f.orchestrator.dispatchMatter({
		prompt: "PRIVATE_WORKSPACE_A",
		workspaceId: workspace.id,
		preferredMemberId: "product-manager",
		observerMemberIds: ["engineering-manager"],
	});
	const memory = f.store.addMemory({
		memberId: "product-manager",
		scope: "project_private",
		workspaceId: workspace.id,
		content: "PRIVATE_WORKSPACE_A_MEMORY",
		category: "user_correction",
		verified: true,
	});
	const localOwner: RequestActor = {
		authKind: "loopback",
		collaborator: userToCollaboratorView(f.store, f.store.ensureLocalBootstrapAdmin("Fixture owner")),
		user: null,
		viaToken: false,
	};
	assert.ok(canActorAccessMemory(f.store, localOwner, memory));
	assert.ok(f.store.listRelevantMemories("product-manager", workspace.id).some((item) => item.id === memory.id));
	assert.throws(() => f.store.updateWorkspace(workspace.id, { orgId: f.b.id }), /无法更改所属组织/);
	assert.equal(f.store.getWorkspace(workspace.id)?.orgId, f.a.id);

	// Emulate a reassignment already stored by an older version.
	f.db.prepare("UPDATE workspace_links SET org_id = ? WHERE id = ?").run(f.b.id, workspace.id);
	assert.equal(f.store.hasWorkspaceScopeConflict(workspace.id), true);
	assert.equal(canActorAccessMemory(f.store, localOwner, memory), false);
	assert.equal(f.store.getMemory(memory.id)?.content, "PRIVATE_WORKSPACE_A_MEMORY");
	assert.ok(!f.store.listRelevantMemories("product-manager", workspace.id).some((item) => item.id === memory.id));
	const teamDigest = collectTeamFrictionDigest(f.store, new Map(), { orgId: f.b.id });
	assert.doesNotMatch(teamDigest, /PRIVATE_WORKSPACE_A_MEMORY/);
	await f.orchestrator.dispatchMatter({ matterId: first.matter.id, prompt: "CURRENT_WORKSPACE_B" });
	assert.equal(f.calls.length, 4);
	for (const call of f.calls.slice(2)) {
		assert.equal(call.options.sessionFile, undefined);
		assert.doesNotMatch(call.prompt, /PRIVATE_WORKSPACE_A/);
	}
});

test("v1 sessions and messages without organization provenance remain archived, never guessed into the current org", async (t) => {
	const f = await fixture(t);
	const matter = f.store.createMatter({ title: "legacy", orgId: f.a.id, leadMemberId: "product-manager" });
	await f.orchestrator.dispatchMatter({ matterId: matter.id, prompt: "UNKNOWN_ORG_SECRET" });
	f.db.prepare("UPDATE worker_sessions SET context_key = ?").run(JSON.stringify(["v1", null, f.root, "user"]));
	f.db.exec("UPDATE matter_messages SET metadata_json = json_remove(metadata_json, '$.orgId')");
	await f.orchestrator.dispatchMatter({ matterId: matter.id, prompt: "continue with known scope" });
	assert.equal(f.calls[1]?.options.sessionFile, undefined);
	assert.doesNotMatch(f.calls[1]!.prompt, /UNKNOWN_ORG_SECRET/);
	assert.equal(f.db.prepare("SELECT count(*) AS n FROM worker_sessions").get()?.n, 2);
	assert.ok(f.store.listMessages(matter.id).some((msg) => msg.content === "UNKNOWN_ORG_SECRET"));
});

test("Native resource discovery separates sessions, includes observers, and isolates managed workspaces", async (t) => {
	const f = await fixture(t);
	const local = f.store.upsertWorkspace({ name: "local", repoPath: f.root, orgId: f.a.id });
	const matter = f.store.createMatter({
		title: "local resource scope",
		leadMemberId: "product-manager",
		workspaceId: local.id,
	});
	const input = { matterId: matter.id, prompt: "Inspect the fixture" };
	await f.orchestrator.dispatchMatter(input);
	await f.orchestrator.dispatchMatter({ ...input, inheritLocalPiResources: true });
	await f.orchestrator.dispatchMatter(input);
	await f.orchestrator.dispatchMatter({ ...input, inheritLocalPiResources: true });
	assert.equal(f.calls[1]?.options.sessionFile, undefined);
	assert.equal(f.calls[2]?.options.sessionFile, f.calls[0]?.file);
	assert.equal(f.calls[3]?.options.sessionFile, f.calls[1]?.file);
	assert.ok(f.calls[1]?.options.args?.includes("--offline"));
	assert.ok(!f.calls[1]?.options.args?.includes("--no-approve"));

	await f.orchestrator.dispatchMatter({
		prompt: "Check the fixture with an observer",
		workspaceId: local.id,
		preferredMemberId: "product-manager",
		observerMemberIds: ["engineering-manager"],
		inheritLocalPiResources: true,
	});
	assert.ok(!f.calls[4]?.options.args?.includes("--no-extensions"));
	assert.ok(!f.calls[5]?.options.args?.includes("--no-extensions"));
	assert.ok(!f.calls[5]?.options.args?.includes("--no-skills"));

	const managed = f.store.upsertWorkspace({
		name: "managed clone",
		repoPath: join(f.root, "managed"),
		orgId: f.a.id,
		sourceType: "cloned",
	});
	await f.orchestrator.dispatchMatter({
		prompt: "Inspect the managed fixture",
		workspaceId: managed.id,
		preferredMemberId: "product-manager",
		inheritLocalPiResources: true,
	});
	assert.ok(f.calls[6]?.options.args?.includes("--no-extensions"));
	assert.ok(!f.calls[6]?.options.args?.includes("--no-skills"));
	assert.ok(f.calls[6]?.options.args?.includes("--no-approve"));

	await f.orchestrator.dispatchMatter({
		prompt: "Inspect the unbound fixture",
		preferredMemberId: "product-manager",
		inheritLocalPiResources: true,
	});
	assert.ok(!f.calls[7]?.options.args?.includes("--no-skills"));
	assert.ok(f.calls[7]?.options.args?.includes("--no-approve"));
});
