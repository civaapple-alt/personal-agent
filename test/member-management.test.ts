import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
	BUILTIN_ROLE_ARCHITECT_TEMPLATE,
	createPersonalAgentServer,
	DialogBroker,
	loadRoleTemplatesWithCustomDir,
	openPersonalAgentDatabase,
	PersonalAgentStore,
	PreviewManager,
	serializeRoleTemplateMarkdown,
	TeamOrchestrator,
} from "../src/index.ts";

async function fixture(t: test.TestContext) {
	const directory = await mkdtemp(join(tmpdir(), "pa-member-management-"));
	const rolesDir = join(directory, "roles");
	const db = openPersonalAgentDatabase(join(directory, "agent.db"));
	const store = new PersonalAgentStore(db);
	const templates = [
		...(await loadRoleTemplatesWithCustomDir(resolve("roles"), rolesDir)),
		BUILTIN_ROLE_ARCHITECT_TEMPLATE,
	];
	const orchestrator = new TeamOrchestrator({ store, templates, defaultCwd: directory, noSession: true });
	const { server } = createPersonalAgentServer({
		store,
		orchestrator,
		templates,
		rolesDir,
		dialogBroker: new DialogBroker(),
		previewManager: new PreviewManager(),
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	t.after(async () => {
		await orchestrator.shutdown();
		await new Promise<void>((done) => server.close(() => done()));
		db.close();
		await rm(directory, { recursive: true, force: true });
	});
	const request = (path: string, body: unknown, method = "POST") =>
		fetch(`http://127.0.0.1:${address.port}${path}`, {
			method,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	return { directory, rolesDir, store, orchestrator, templates, request };
}

const newRole = (id: string) => ({ id, name: "审阅员", title: "Reviewer", tools: ["read"] });

test("Member creation and import reject file paths and reserved role IDs before writing", async (t) => {
	const { directory, rolesDir, store, templates, request } = await fixture(t);
	for (const id of ["../escaped", "nested/role", "..\\escaped", "role\nname", "README"]) {
		const response = await request("/api/members", newRole(id));
		assert.equal(response.status, 400, id);
	}
	const markdown = serializeRoleTemplateMarkdown({ ...templates[0]!, id: "../import-escape" });
	assert.equal((await request("/api/members/import", { markdown })).status, 400);
	assert.equal((await request("/api/members", newRole("role-architect"))).status, 409);
	assert.equal(
		(
			await request("/api/members/import", {
				markdown: serializeRoleTemplateMarkdown(BUILTIN_ROLE_ARCHITECT_TEMPLATE),
			})
		).status,
		409,
	);
	assert.equal(store.listMembers().length, templates.length);
	assert.ok(!(await readdir(directory)).includes("escaped.md"));
	assert.deepEqual(await readdir(rolesDir).catch(() => []), []);
});

test("Batch validation and explicit ID conflicts leave roles and files unchanged", async (t) => {
	const { rolesDir, store, request } = await fixture(t);
	assert.equal((await request("/api/members", newRole("reviewer"))).status, 201);
	const original = await readFile(join(rolesDir, "reviewer.md"), "utf8");
	assert.equal((await request("/api/members", { ...newRole("reviewer"), name: "替换" })).status, 409);
	assert.equal(await readFile(join(rolesDir, "reviewer.md"), "utf8"), original);
	assert.equal(
		(await request("/api/members/batch", { members: [newRole("safe"), newRole("../unsafe")] })).status,
		400,
	);
	assert.equal(store.getMember("safe"), null);
	assert.equal(
		(
			await request("/api/members/batch", {
				members: [newRole("safe"), { ...newRole("invalid"), name: "" }],
			})
		).status,
		400,
	);
	assert.equal(store.getMember("safe"), null);
	assert.equal(
		(await request("/api/members", { ...newRole("injected"), name: "名称\nid: injected-key" })).status,
		400,
	);
	assert.equal(
		(await request("/api/members/batch", { members: [newRole("duplicate"), newRole("duplicate")] })).status,
		409,
	);
	assert.equal(store.getMember("duplicate"), null);
	assert.deepEqual(await readdir(rolesDir), ["reviewer.md"]);
	const results = await Promise.all([
		request("/api/members", newRole("concurrent")),
		request("/api/members", newRole("concurrent")),
	]);
	assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
});

test("Invalid role adjustments do not partially apply proposals, and dismissed proposals stay dismissed", async (t) => {
	const { store, request } = await fixture(t);
	const matter = store.createMatter({ title: "规划", leadMemberId: "role-architect" });
	const message = store.appendMessage({
		matterId: matter.id,
		channel: "user",
		senderType: "member",
		senderId: "role-architect",
		content: "建议",
		metadata: { roleProposals: { status: "pending" } },
	});
	const path = `/api/matters/${matter.id}/messages/${message.id}/apply-role-proposals`;
	assert.equal(
		(await request(path, { members: [newRole("partial")], adjustments: [{ memberId: "missing", tools: [] }] }))
			.status,
		404,
	);
	assert.equal(store.getMember("partial"), null);
	assert.deepEqual(store.getMessage(message.id)?.metadata?.roleProposals, { status: "pending" });
	assert.equal((await request(path, { action: "dismiss" })).status, 200);
	assert.equal((await request(path, { members: [newRole("dismissed")] })).status, 409);
	assert.equal(store.getMember("dismissed"), null);
});

test("Deleted baseline role stays absent after restart, and explicit import restores it", async (t) => {
	const { directory, rolesDir, templates, request } = await fixture(t);
	assert.equal((await request("/api/members/engineering-manager", undefined, "DELETE")).status, 200);
	const reloaded = await loadRoleTemplatesWithCustomDir(resolve("roles"), rolesDir);
	const reopenedDb = openPersonalAgentDatabase(join(directory, "agent.db"));
	const reopenedStore = new PersonalAgentStore(reopenedDb);
	const restarted = new TeamOrchestrator({
		store: reopenedStore,
		templates: reloaded,
		defaultCwd: directory,
		noSession: true,
	});
	try {
		assert.equal(reopenedStore.getMember("engineering-manager"), null);
		assert.ok(reopenedStore.isRoleTemplateRemoved("engineering-manager"));
		assert.ok(!restarted.listTemplates().some((role) => role.id === "engineering-manager"));
		const original = templates.find((role) => role.id === "engineering-manager");
		assert.ok(original);
		assert.equal(
			(await request("/api/members/import", { markdown: serializeRoleTemplateMarkdown(original) })).status,
			201,
		);
		assert.ok(reopenedStore.getMember("engineering-manager"));
		assert.equal(reopenedStore.isRoleTemplateRemoved("engineering-manager"), false);
		assert.equal((await request("/api/members/product-manager", undefined, "DELETE")).status, 409);
		assert.equal(reopenedStore.isRoleTemplateRemoved("product-manager"), false);
	} finally {
		await restarted.shutdown();
		reopenedDb.close();
	}
});

test("Concurrent proposal application creates one role and the queue survives invalid requests", async (t) => {
	const { store, request } = await fixture(t);
	const matter = store.createMatter({ title: "规划", leadMemberId: "role-architect" });
	const message = store.appendMessage({
		matterId: matter.id,
		channel: "user",
		senderType: "member",
		senderId: "role-architect",
		content: "建议",
		metadata: { roleProposals: { status: "pending" } },
	});
	const path = `/api/matters/${matter.id}/messages/${message.id}/apply-role-proposals`;
	const payload = { members: [{ name: "审阅员", title: "Concurrent Reviewer" }] };
	const responses = await Promise.all([request(path, payload), request(path, payload)]);
	assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
	assert.ok(store.getMember("concurrent-reviewer"));
	assert.equal(store.getMember("concurrent-reviewer-2"), null);
	assert.equal((await request("/api/members", newRole("../invalid"))).status, 400);
	assert.equal((await request("/api/members", newRole("after-error"))).status, 201);
});

test("Role writes replace a symlink without changing its target or leaving staging files", async (t) => {
	const { directory, rolesDir, request } = await fixture(t);
	const target = join(directory, "preserved.md");
	await writeFile(target, "original");
	await mkdir(rolesDir);
	await symlink(target, join(rolesDir, "reviewer.md"));
	assert.equal((await request("/api/members", newRole("reviewer"))).status, 201);
	assert.equal(await readFile(target, "utf8"), "original");
	assert.match(await readFile(join(rolesDir, "reviewer.md"), "utf8"), /id: reviewer/);
	assert.deepEqual(await readdir(rolesDir), ["reviewer.md"]);
});

test("Repeated adjustments are rejected before changing any role", async (t) => {
	const { store, orchestrator, request } = await fixture(t);
	const member = store.getMember("product-manager");
	assert.ok(member);
	const original = orchestrator.getTemplateForMember(member);
	assert.ok(original);
	const response = await request("/api/members/adjustments/apply", {
		adjustments: [
			{ memberId: member.id, tools: [] },
			{ memberId: member.id, tools: ["read"] },
		],
	});
	assert.equal(response.status, 409);
	assert.deepEqual(orchestrator.getTemplateForMember(member), original);
	assert.equal(
		(
			await request("/api/members/adjustments/apply", {
				adjustments: [{ memberId: "role-architect", tools: ["bash"] }],
			})
		).status,
		409,
	);
});

test("Deleting the last observer removes the role from both rosters", async (t) => {
	const { store, request } = await fixture(t);
	const memberId = "retired-reviewer";
	assert.equal((await request("/api/members", newRole(memberId))).status, 201);
	const matter = store.createMatter({
		title: "Role roster",
		leadMemberId: "product-manager",
		aiMemberIds: ["product-manager", memberId],
		consultMemberIds: [memberId],
		observerMemberIds: [memberId],
	});
	assert.equal((await request(`/api/members/${memberId}`, {}, "DELETE")).status, 200);
	const updated = store.getMatter(matter.id);
	assert.deepEqual(updated?.aiMemberIds, ["product-manager"]);
	assert.deepEqual(updated?.consultMemberIds, []);
	assert.deepEqual(updated?.observerMemberIds, []);
	assert.equal(updated?.observersEnabled, false);
});

test("Workspace writes roll back invalid grants and protect existing organization history", async (t) => {
	const { store, request, directory } = await fixture(t);
	const first = store.upsertOrganization({ name: "Origin" });
	const second = store.upsertOrganization({ name: "Destination" });
	const path = "/api/workspaces";
	const createWorkspace = (repoPath: string, orgId: string, change = {}) =>
		request(path, { name: "Repository", repoPath, orgId, ...change });
	const invalidGrant = { visibility: "restricted", allowedUserIds: ["unknown-user"] };
	assert.equal((await createWorkspace(directory, first.id, invalidGrant)).status, 400);
	assert.deepEqual(store.listWorkspaces(), []);

	const created = await createWorkspace(directory, first.id);
	assert.equal(created.status, 201);
	const workspace = store.listWorkspaces()[0]!;
	const edit = (body: unknown) => request(`${path}/${workspace.id}`, body, "PATCH");
	assert.equal((await edit({ ...invalidGrant, name: "Partially applied" })).status, 400);
	assert.deepEqual(store.getWorkspace(workspace.id), workspace);

	const user = store.ensureLocalBootstrapAdmin("Workspace owner");
	assert.equal((await edit({ visibility: "restricted", allowedUserIds: [user.id] })).status, 200);
	assert.equal((await edit({ ...invalidGrant, name: "Partially applied" })).status, 400);
	assert.deepEqual(store.listWorkspaceMemberIds(workspace.id), [user.id]);
	assert.equal(store.getWorkspace(workspace.id)?.name, workspace.name);

	assert.equal((await edit({ orgId: second.id })).status, 409);
	assert.equal((await edit({ visibility: "org" })).status, 200);
	assert.equal((await edit({ orgId: second.id })).status, 200);
	const matter = store.createMatter({ title: "History", workspaceId: workspace.id });
	assert.equal((await edit({ orgId: first.id })).status, 409);
	assert.equal((await createWorkspace(directory, first.id)).status, 409);
	assert.equal(store.getWorkspace(workspace.id)?.orgId, second.id);
	assert.equal(store.getMatter(matter.id)?.orgId, second.id);
});
