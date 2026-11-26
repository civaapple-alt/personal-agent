import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { collectTeamFrictionDigest } from "../packages/server/src/orchestrator/architect/meta-architect.ts";
import {
	ensureDefaultWorkspaceDir,
	readPiProjectTrustDecision,
	resolveLocalWorkspacePiArgs,
	writePiProjectTrustDecision,
} from "../packages/server/src/orchestrator/execution/execution-context.ts";
import { TeamOrchestrator } from "../packages/server/src/orchestrator/team-orchestrator.ts";
import { loadRoleTemplatesFromDir } from "../packages/server/src/roles/template-loader.ts";
import type { PiRpcWorkerOptions, PromptRunResult } from "../packages/server/src/rpc/pi-rpc-worker.ts";
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

test("legacy workspace reassignment isolates sessions", async (t) => {
	const f = await fixture(t);
	const workspace = f.store.upsertWorkspace({ name: "reassigned", repoPath: f.root, orgId: f.a.id });
	const first = await f.orchestrator.dispatchMatter({
		prompt: "PRIVATE_WORKSPACE_A",
		workspaceId: workspace.id,
		preferredMemberId: "product-manager",
		observerMemberIds: ["engineering-manager"],
	});
	assert.throws(() => f.store.updateWorkspace(workspace.id, { orgId: f.b.id }), /无法更改所属组织/);
	assert.equal(f.store.getWorkspace(workspace.id)?.orgId, f.a.id);

	// Emulate a reassignment already stored by an older version.
	f.db.prepare("UPDATE workspace_links SET org_id = ? WHERE id = ?").run(f.b.id, workspace.id);
	assert.equal(f.store.hasWorkspaceScopeConflict(workspace.id), true);
	const teamDigest = collectTeamFrictionDigest(f.store, new Map(), { orgId: f.b.id });
	assert.doesNotMatch(teamDigest, /PRIVATE_WORKSPACE_A/);
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

test("ensureDefaultWorkspaceDir seeds AGENTS.md without overwriting user customizations", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pa-default-ws-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const target = join(root, "workspaces", "default");

	const created = ensureDefaultWorkspaceDir(target);
	assert.equal(created, resolve(target));
	const initial = await readFile(join(target, "AGENTS.md"), "utf8");
	assert.match(initial, /Default Workspace/);

	await writeFile(join(target, "AGENTS.md"), "# Custom User Rules\n", "utf8");
	ensureDefaultWorkspaceDir(target);
	const preserved = await readFile(join(target, "AGENTS.md"), "utf8");
	assert.equal(preserved, "# Custom User Rules\n");
});

test("readPiProjectTrustDecision and resolveLocalWorkspacePiArgs honor trust.json and defaultWorkspaceDir", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pa-trust-json-"));
	t.after(async () => rm(root, { recursive: true, force: true }));
	const agentDir = join(root, "pi-agent");
	const codeDir = join(root, "code");
	const trustedRepo = join(codeDir, "trusted-app");
	const deniedRepo = join(codeDir, "denied-app");
	const undecidedRepo = join(root, "other", "new-app");
	await mkdir(agentDir, { recursive: true });
	await mkdir(trustedRepo, { recursive: true });
	await mkdir(deniedRepo, { recursive: true });
	await mkdir(undecidedRepo, { recursive: true });

	await writeFile(
		join(agentDir, "trust.json"),
		JSON.stringify({
			[codeDir]: true,
			[deniedRepo]: false,
		}),
		"utf8",
	);

	assert.equal(readPiProjectTrustDecision(trustedRepo, agentDir), true);
	assert.equal(readPiProjectTrustDecision(deniedRepo, agentDir), false);
	assert.equal(readPiProjectTrustDecision(undecidedRepo, agentDir), null);

	// Local workspace: undecided or trusted -> --offline --approve; explicit false -> --offline --no-approve
	assert.deepEqual(
		resolveLocalWorkspacePiArgs({
			inheritsLocalResources: true,
			hasWorkspace: true,
			cwd: undecidedRepo,
			hasDedicatedDefaultWorkspace: true,
			agentDir,
		}),
		["--offline", "--approve"],
	);
	assert.deepEqual(
		resolveLocalWorkspacePiArgs({
			inheritsLocalResources: true,
			hasWorkspace: true,
			cwd: deniedRepo,
			hasDedicatedDefaultWorkspace: true,
			agentDir,
		}),
		["--offline", "--no-approve"],
	);

	// Flip an explicitly denied directory (false) to trusted (true) in trust.json, preserving other entries
	const flipped = writePiProjectTrustDecision(deniedRepo, true, agentDir);
	assert.equal(flipped.decision, true);
	assert.equal(readPiProjectTrustDecision(deniedRepo, agentDir), true);
	assert.equal(readPiProjectTrustDecision(trustedRepo, agentDir), true);
	assert.deepEqual(
		resolveLocalWorkspacePiArgs({
			inheritsLocalResources: true,
			hasWorkspace: true,
			cwd: deniedRepo,
			hasDedicatedDefaultWorkspace: true,
			agentDir,
		}),
		["--offline", "--approve"],
	);

	// Clearing the explicit entry falls back to ancestor trust (codeDir: true)
	const cleared = writePiProjectTrustDecision(deniedRepo, null, agentDir);
	assert.equal(cleared.decision, true);

	// Unbound matter with dedicated default workspace -> --offline (no --no-approve needed)
	assert.deepEqual(
		resolveLocalWorkspacePiArgs({
			inheritsLocalResources: true,
			hasWorkspace: false,
			cwd: join(root, "default-ws"),
			hasDedicatedDefaultWorkspace: true,
			agentDir,
		}),
		["--offline"],
	);

	// Isolated / team / cloned mode -> --no-extensions --no-approve
	assert.deepEqual(
		resolveLocalWorkspacePiArgs({
			inheritsLocalResources: false,
			hasWorkspace: true,
			cwd: trustedRepo,
			hasDedicatedDefaultWorkspace: true,
			agentDir,
		}),
		["--no-extensions", "--no-approve"],
	);

	// End-to-end orchestrator check with dedicated defaultWorkspaceDir
	const defaultWorkspaceDir = ensureDefaultWorkspaceDir(join(root, "pa-default"));
	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db);
	const templates = await loadRoleTemplatesFromDir(resolve("roles"));
	const calls: Array<PiRpcWorkerOptions> = [];
	const orchestrator = new TeamOrchestrator({
		store,
		templates,
		defaultCwd: root,
		defaultWorkspaceDir,
		noSession: true,
		workerFactory: (options) => {
			calls.push(options);
			return {
				async start() {
					if (options.env?.PA_TEAM_BRIDGE_URL) await reportReady(options);
				},
				async getState() {
					return { sessionId: randomUUID(), sessionFile: undefined, isStreaming: false };
				},
				async runPromptAndWait() {
					return result("ok");
				},
				onNotice() {
					return () => {};
				},
				setDialogHandler() {},
				async stop() {},
			};
		},
	});
	t.after(async () => {
		await orchestrator.shutdown();
		db.close();
	});

	await orchestrator.dispatchMatter({
		prompt: "General question without workspace",
		preferredMemberId: "product-manager",
		inheritLocalPiResources: true,
	});
	assert.equal(calls[0]?.cwd, defaultWorkspaceDir);
	assert.ok(calls[0]?.args?.includes("--offline"));
	assert.ok(!calls[0]?.args?.includes("--no-approve"));
});
