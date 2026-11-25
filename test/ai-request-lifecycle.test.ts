import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
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
	TeamOrchestrator,
} from "../packages/server/src/index.ts";
import { reportReady } from "./worker-helpers.ts";

async function fixture(
	t: test.TestContext,
	hold?: Promise<void>,
	settings?: {
		requireAuth: boolean;
		host?: string;
		inheritLocalPiResources?: boolean | "auto" | "always" | "off";
		ownerToken?: boolean;
	},
) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pa-request-lifecycle-")));
	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db);
	const owner = store.setupInitialAdmin({
		email: "owner@request.test",
		password: "TestPass123!",
		displayName: "Owner",
	});
	const ownerToken = store.createSession(owner.id).rawToken;
	const org = store.ensureDefaultOrganization();
	store.upsertOrgMember({ orgId: org.id, userId: owner.id, orgRole: "org_owner" });
	const templates = await loadRoleTemplatesFromDir(resolve("roles"));
	let runs = 0;
	const runStarted = Promise.withResolvers<void>();
	const workerStarted = Promise.withResolvers<PiRpcWorkerOptions>();
	const orchestrator = new TeamOrchestrator({
		store,
		templates,
		defaultCwd: root,
		noSession: true,
		workerFactory: (options) => ({
			async start() {
				await reportReady(options);
				workerStarted.resolve(options);
			},
			async stop() {},
			async getState() {
				return { sessionId: "fixture" };
			},
			onNotice() {
				return () => {};
			},
			setDialogHandler() {},
			async runPromptAndWait() {
				runs++;
				runStarted.resolve();
				await hold;
				return {
					disposition: "started",
					aborted: false,
					assistantText: "done",
					assistantMessages: [],
					toolExecutions: [],
					notices: [],
					dialogs: [],
					events: [],
				};
			},
		}),
	});
	const { server } = createPersonalAgentServer({
		store,
		orchestrator,
		templates,
		dialogBroker: new DialogBroker(),
		previewManager: new PreviewManager(),
		uploadsDir: join(root, "uploads"),
		requireAuth: settings?.requireAuth ?? true,
		inheritLocalPiResources: settings?.inheritLocalPiResources,
	});
	await new Promise<void>((done) => server.listen(0, settings?.host ?? "127.0.0.1", done));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const post = (path: string, body: unknown = {}, method = "POST") =>
		fetch(`http://127.0.0.1:${address.port}${path}`, {
			method,
			headers: {
				"Content-Type": "application/json",
				...((settings?.ownerToken ?? settings?.requireAuth ?? true) ? { "x-pa-token": ownerToken } : {}),
			},
			body: JSON.stringify(body),
		});
	const matter = store.createMatter({
		title: "request",
		leadMemberId: "product-manager",
		orgId: org.id,
		createdByUserId: owner.id,
	});
	const message = (mode = "ai_request", status = "pending") =>
		store.appendMessage({
			matterId: matter.id,
			channel: "user",
			senderType: "user",
			senderId: owner.id,
			content: "inspect the design",
			metadata: { mode, aiRequestStatus: status, workspaceId: matter.workspaceId, repoPath: root },
		});
	const endpoint = (id: string, action = "approve-ai") => `/api/matters/${matter.id}/messages/${id}/${action}`;
	t.after(async () => {
		await orchestrator.shutdown();
		server.closeAllConnections();
		await new Promise<void>((done) => server.close(() => done()));
		db.close();
		await rm(root, { recursive: true, force: true });
	});
	return {
		root,
		owner,
		org,
		store,
		orchestrator,
		matter,
		message,
		post,
		endpoint,
		runs: () => runs,
		runStarted: runStarted.promise,
		workerStarted: workerStarted.promise,
	};
}

test("only pending AI requests may be approved or dismissed; other messages never start a worker", async (t) => {
	const f = await fixture(t);
	for (const msg of [
		f.message("discussion"),
		f.message("ai_request", "dismissed"),
		f.message("ai_request", "approved"),
	]) {
		for (const action of ["approve-ai", "dismiss-ai"]) {
			const response = await f.post(f.endpoint(msg.id, action));
			assert.equal(response.status, 409);
		}
	}
	assert.equal(f.runs(), 0);
});

test("concurrent approval claims one request once and validates execution settings before changing its status", async (t) => {
	const f = await fixture(t);
	const msg = f.message();
	const invalid = await f.post(f.endpoint(msg.id), { preferredMemberId: "does-not-exist" });
	assert.equal(invalid.status, 404);
	assert.equal(f.store.getMessage(msg.id)?.metadata?.aiRequestStatus, "pending");
	const responses = await Promise.all([f.post(f.endpoint(msg.id)), f.post(f.endpoint(msg.id))]);
	assert.deepEqual(responses.map((r) => r.status).sort(), [202, 409]);
	assert.equal(f.store.getMessage(msg.id)?.metadata?.aiRequestStatus, "approved");
	await f.runStarted;
	assert.equal(f.runs(), 1);
});

test("an old request cannot silently execute after its matter moves to another organization", async (t) => {
	const f = await fixture(t);
	const org = f.store.upsertOrganization({ name: "Other org" });
	f.store.upsertOrgMember({ orgId: org.id, userId: f.owner.id, orgRole: "org_owner" });
	const msg = f.message();
	f.store.updateMatterOrganization(f.matter.id, org.id);
	const response = await f.post(f.endpoint(msg.id));
	assert.equal(response.status, 409);
	assert.equal(f.store.getMessage(msg.id)?.metadata?.aiRequestStatus, "pending");
	assert.equal(f.runs(), 0);
});

test("missing request attachments leave the request pending instead of starting an incomplete task", async (t) => {
	const f = await fixture(t);
	const msg = f.message();
	f.store.updateMessageMetadata(msg.id, {
		...msg.metadata,
		images: [{ url: "/api/uploads/missing.png", mimeType: "image/png" }],
	});
	const response = await f.post(f.endpoint(msg.id));
	assert.equal(response.status, 410);
	assert.equal(f.store.getMessage(msg.id)?.metadata?.aiRequestStatus, "pending");
	assert.equal(f.runs(), 0);
});

test("workspace organization cannot be reassigned through PATCH or upsert during an active turn", async (t) => {
	const finish = Promise.withResolvers<void>();
	const f = await fixture(t, finish.promise);
	const a = f.store.upsertOrganization({ name: "A" });
	const b = f.store.upsertOrganization({ name: "B" });
	for (const org of [a, b]) f.store.upsertOrgMember({ orgId: org.id, userId: f.owner.id, orgRole: "org_owner" });
	const workspace = f.store.upsertWorkspace({ name: "repo", repoPath: f.root, orgId: a.id });
	const pending = f.orchestrator.dispatchMatter({ prompt: "work", workspaceId: workspace.id });
	try {
		await f.runStarted;
		assert.equal((await f.post(`/api/workspaces/${workspace.id}`, { orgId: b.id }, "PATCH")).status, 409);
		assert.equal((await f.post("/api/workspaces", { name: "repo", repoPath: f.root, orgId: b.id })).status, 409);
		assert.equal(f.store.getWorkspace(workspace.id)?.orgId, a.id);
	} finally {
		finish.resolve();
		await pending;
	}
});

test("concurrent image dispatch cannot overwrite the active run or mark it failed", async (t) => {
	const finish = Promise.withResolvers<void>();
	const f = await fixture(t, finish.promise);
	try {
		const body = {
			mode: "dispatch",
			prompt: "look",
			images: [
				{
					name: "one.png",
					mimeType: "image/png",
					data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1QAAAAASUVORK5CYII=",
				},
			],
		};
		const path = `/api/matters/${f.matter.id}/messages`;
		const responses = await Promise.all([f.post(path, body), f.post(path, body)]);
		assert.deepEqual(responses.map((r) => r.status).sort(), [202, 409]);
		await f.runStarted;
		assert.equal(f.runs(), 1);
		assert.equal(f.store.listMessages(f.matter.id, "user").filter((msg) => msg.metadata?.failed).length, 0);
	} finally {
		finish.resolve();
	}
});

test("Tri-state PA_LOCAL_PI_RESOURCES controls native Pi resource inheritance across personal and team modes", async (t) => {
	const scenarios = [
		{ name: "personal owner (auto)", requireAuth: false, inherit: true },
		{ name: "explicit opt-out (off)", requireAuth: false, inheritLocalPiResources: "off" as const, inherit: false },
		{ name: "LAN listener (auto)", requireAuth: false, host: "0.0.0.0", inherit: false },
		{ name: "signed-in owner (auto)", requireAuth: false, ownerToken: true, inherit: false },
		{ name: "team server (auto)", requireAuth: true, inherit: false },
		{
			name: "team server (always)",
			requireAuth: true,
			inheritLocalPiResources: "always" as const,
			inherit: true,
		},
		{
			name: "LAN listener (always)",
			requireAuth: false,
			host: "0.0.0.0",
			inheritLocalPiResources: "always" as const,
			inherit: true,
		},
	];
	for (const { name, inherit, ...settings } of scenarios) {
		await t.test(name, async (t) => {
			const f = await fixture(t, undefined, settings);
			const workspace = f.store.upsertWorkspace({ name: "local fixture", repoPath: f.root, orgId: f.org.id });
			const response = await f.post("/api/matters", {
				prompt: "Inspect the fixture",
				workspaceId: workspace.id,
				preferredMemberId: "product-manager",
				inheritLocalPiResources: true,
			});
			assert.equal(response.status, 202, await response.text());
			const worker = await f.workerStarted;
			assert.equal(worker.args?.includes("--no-extensions"), !inherit);
			assert.equal(worker.args?.includes("--no-skills"), false);
			assert.ok(worker.args?.includes("--skill"));
			assert.ok(worker.args?.includes("builtin:mcp"));
			assert.ok(worker.args?.includes("--tools"));
			assert.equal(worker.cwd, f.root);
		});
	}
});
