import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
	buildRuntimeOverview,
	createPersonalAgentServer,
	DialogBroker,
	loadRoleTemplatesFromDir,
	openPersonalAgentDatabase,
	PersonalAgentStore,
	PreviewManager,
	type RoleTemplate,
	type RuntimeOverviewPayload,
	resolveBuiltinExtensionPath,
	TeamOrchestrator,
} from "../src/index.ts";
import { DEFAULT_PSTACK_CLONE_URL, resolveDefaultPstackRepoDir } from "../src/server/git-clone.ts";

function createValidPstackFixture(dir: string): void {
	mkdirSync(join(dir, "skills", "poteto-mode"), { recursive: true });
	mkdirSync(join(dir, "skills", "principle-test"), { recursive: true });
	writeFileSync(join(dir, "plugin.json"), JSON.stringify({ name: "pstack", version: "0.15.42" }), "utf8");
	writeFileSync(
		join(dir, "skills", "poteto-mode", "SKILL.md"),
		"---\nname: poteto-mode\ndescription: Poteto mode fixture\n---\n# Mode\n",
		"utf8",
	);
	writeFileSync(
		join(dir, "skills", "principle-test", "SKILL.md"),
		"---\nname: principle-test\ndescription: Principle fixture\n---\n# Principle\n",
		"utf8",
	);
}

test("GET /api/runtime reports Pi base, built-in and operator extensions, MCP dependencies, and collaborator redaction", async (t) => {
	const tempDir = mkdtempSync(join(tmpdir(), "pa-runtime-settings-"));
	t.after(() => rmSync(tempDir, { recursive: true, force: true }));

	const pstackDir = join(tempDir, "pstack-pack");
	createValidPstackFixture(pstackDir);

	const customExtFile = join(tempDir, "custom-audit-ext.ts");
	writeFileSync(customExtFile, "export default function customExt() {}\n", "utf8");
	const missingExtFile = join(tempDir, "missing-ext.ts");

	const templates = await loadRoleTemplatesFromDir(resolve(process.cwd(), "roles"));
	const mcpTemplate: RoleTemplate = {
		...templates[0]!,
		id: "docs-researcher",
		name: "文档研究员",
		title: "Docs Researcher",
		mcpDependencies: ["context7", "github"],
		isPrimaryContact: false,
	};
	const allTemplates = [...templates, mcpTemplate];

	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db);
	store.ensureOwnerCollaborator("Owner");
	const collaborator = store.upsertCollaborator({
		name: "Alice",
		roleTitle: "Reviewer",
		permissionRole: "collaborator",
	});

	const sessionDir = join(tempDir, "pi-sessions");
	mkdirSync(sessionDir, { recursive: true });

	const orchestrator = new TeamOrchestrator({
		store,
		templates: allTemplates,
		defaultCwd: tempDir,
		sessionDir,
		noSession: false,
		pstackDir,
		extensions: [customExtFile, missingExtFile, "builtin:telemetry"],
	});

	const { server } = createPersonalAgentServer({
		store,
		orchestrator,
		templates: allTemplates,
		previewManager: new PreviewManager(),
		dialogBroker: new DialogBroker(),
		requireAuth: true,
		probePiCli: async () => ({
			available: true,
			executable: "pi",
			version: "1.5.2",
			error: null,
		}),
	});

	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
	t.after(() => new Promise<void>((resolveClose) => server.close(() => resolveClose())));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const baseUrl = `http://127.0.0.1:${address.port}`;

	// Unauthenticated requests are rejected.
	const unauthRes = await fetch(`${baseUrl}/api/runtime`);
	assert.equal(unauthRes.status, 401);

	const ownerToken = store.listCollaborators().find((c) => c.permissionRole === "owner")?.token;
	assert.ok(ownerToken);

	const ownerRes = await fetch(`${baseUrl}/api/runtime`, {
		headers: { Authorization: `Bearer ${ownerToken}` },
	});
	assert.equal(ownerRes.status, 200);
	const ownerPayload = (await ownerRes.json()) as RuntimeOverviewPayload;

	assert.equal(ownerPayload.base.name, "Pi CLI");
	assert.equal(ownerPayload.base.available, true);
	assert.equal(ownerPayload.base.version, "1.5.2");
	assert.equal(ownerPayload.base.pathsRedacted, false);
	assert.equal(ownerPayload.base.sessionMode, "persisted");
	assert.equal(ownerPayload.base.sessionDir, sessionDir);
	assert.equal(ownerPayload.base.defaultCwd, tempDir);
	assert.equal(ownerPayload.base.pstack.configured, true);
	assert.equal(ownerPayload.base.pstack.available, true);
	assert.equal(ownerPayload.base.pstack.version, "0.15.42");
	assert.equal(ownerPayload.base.pstack.skillCount, 2);
	assert.ok(ownerPayload.base.pstack.modeSha256);
	assert.equal(ownerPayload.base.isolationModes.length, 4);

	const teamExt = ownerPayload.extensions.find((ext) => ext.id === "builtin-team-extension");
	assert.ok(teamExt);
	assert.equal(teamExt.status, "active");
	assert.equal(teamExt.fileStatus, "present");
	assert.deepEqual(teamExt.registeredTools, ["delegate_to_member", "publish_deliverable", "propose_experience"]);

	const pstackExt = ownerPayload.extensions.find((ext) => ext.id === "builtin-pstack-extension");
	assert.ok(pstackExt);
	assert.equal(pstackExt.status, "active");
	assert.equal(pstackExt.fileStatus, "present");
	assert.deepEqual(pstackExt.registeredTools, ["load_pstack_skill"]);

	const mcpExt = ownerPayload.extensions.find((ext) => ext.id === "pi-builtin-mcp");
	assert.ok(mcpExt);
	assert.equal(mcpExt.status, "conditional");
	assert.deepEqual(mcpExt.mcpServers, ["context7", "github"]);
	assert.deepEqual(mcpExt.declaredByRoles, ["文档研究员"]);
	assert.deepEqual(mcpExt.registeredTools, ["mcp__context7__*", "mcp__github__*"]);

	const presentCustom = ownerPayload.extensions.find((ext) => ext.name === "custom-audit-ext.ts");
	assert.ok(presentCustom);
	assert.equal(presentCustom.sourceKind, "operator_env");
	assert.equal(presentCustom.status, "active");
	assert.equal(presentCustom.fileStatus, "present");
	assert.equal(presentCustom.entryPath, customExtFile);

	const missingCustom = ownerPayload.extensions.find((ext) => ext.name === "missing-ext.ts");
	assert.ok(missingCustom);
	assert.equal(missingCustom.status, "error");
	assert.equal(missingCustom.fileStatus, "missing");

	const builtinTelemetry = ownerPayload.extensions.find((ext) => ext.name === "builtin:telemetry");
	assert.ok(builtinTelemetry);
	assert.equal(builtinTelemetry.status, "active");
	assert.equal(builtinTelemetry.fileStatus, "builtin");

	assert.equal(ownerPayload.summary.activeCount, 4);
	assert.equal(ownerPayload.summary.conditionalCount, 1);
	assert.equal(ownerPayload.summary.operatorCount, 3);
	assert.equal(ownerPayload.summary.errorCount, 1);

	assert.deepEqual(
		ownerPayload.configSections.map((sec) => sec.id),
		["env", "paths", "rpc", "orchestrator"],
	);
	const envSec = ownerPayload.configSections.find((sec) => sec.id === "env");
	assert.ok(envSec);
	assert.equal(envSec.items.find((item) => item.key === "PORT")?.value, String(address.port));
	assert.equal(envSec.items.find((item) => item.key === "PA_PI_EXTENSIONS")?.overridden, true);
	assert.equal(envSec.items.find((item) => item.key === "PA_PSTACK_DIR")?.overridden, true);

	// Collaborator view redacts host filesystem paths while keeping capability info intact.
	const collabRes = await fetch(`${baseUrl}/api/runtime`, {
		headers: { Authorization: `Bearer ${collaborator.token}` },
	});
	assert.equal(collabRes.status, 200);
	const collabPayload = (await collabRes.json()) as RuntimeOverviewPayload;
	assert.equal(collabPayload.base.pathsRedacted, true);
	assert.equal(collabPayload.base.sessionDir, "pi-sessions");
	assert.equal(collabPayload.base.pstack.root, "pstack-pack");
	assert.equal(
		collabPayload.extensions.find((ext) => ext.name === "custom-audit-ext.ts")?.entryPath,
		"custom-audit-ext.ts",
	);
	assert.ok(
		!collabPayload.extensions.find((ext) => ext.id === "builtin-team-extension")?.entryPath?.includes(tempDir),
	);
	const collabPathsSec = collabPayload.configSections.find((sec) => sec.id === "paths");
	assert.equal(collabPathsSec?.items.find((item) => item.key === ".data/pi-sessions")?.value, "pi-sessions");
});

test("buildRuntimeOverview reports missing Pi CLI, unconfigured/invalid pstack, and inactive MCP cleanly", async (t) => {
	const tempDir = mkdtempSync(join(tmpdir(), "pa-runtime-missing-"));
	t.after(() => rmSync(tempDir, { recursive: true, force: true }));

	const prevTurn = process.env.PA_TURN_TIMEOUT_MS;
	const prevIdle = process.env.PA_IDLE_TIMEOUT_MS;
	process.env.PA_TURN_TIMEOUT_MS = "not-a-number";
	process.env.PA_IDLE_TIMEOUT_MS = "-10";
	t.after(() => {
		if (prevTurn === undefined) delete process.env.PA_TURN_TIMEOUT_MS;
		else process.env.PA_TURN_TIMEOUT_MS = prevTurn;
		if (prevIdle === undefined) delete process.env.PA_IDLE_TIMEOUT_MS;
		else process.env.PA_IDLE_TIMEOUT_MS = prevIdle;
	});

	const templates = await loadRoleTemplatesFromDir(resolve(process.cwd(), "roles"));
	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db);
	const orchestrator = new TeamOrchestrator({
		store,
		templates,
		defaultCwd: tempDir,
		noSession: true,
		pstackDir: join(tempDir, "non-existent-pstack"),
	});

	const payload = await buildRuntimeOverview({
		config: orchestrator.getRuntimeConfig(),
		activeMembers: store.listMembers(),
		isOwner: true,
		probePiCli: async () => ({
			available: false,
			executable: "pi",
			version: null,
			error: "未在 PATH 中找到 pi 命令",
		}),
	});

	assert.equal(payload.base.available, false);
	assert.equal(payload.base.version, null);
	assert.match(payload.base.probeError ?? "", /pi/);
	assert.equal(payload.base.sessionMode, "no_session");
	assert.equal(payload.base.pstack.configured, true);
	assert.equal(payload.base.pstack.available, false);
	assert.ok(payload.base.pstack.error);
	assert.equal(payload.base.envFlags.turnTimeoutMs, 0);
	assert.equal(payload.base.envFlags.idleTimeoutMs, 900_000);

	const pstackExt = payload.extensions.find((ext) => ext.id === "builtin-pstack-extension");
	assert.equal(pstackExt?.status, "error");

	const mcpExt = payload.extensions.find((ext) => ext.id === "pi-builtin-mcp");
	assert.equal(mcpExt?.status, "inactive");
	assert.deepEqual(mcpExt?.declaredByRoles, []);

	assert.ok(statSync(resolveBuiltinExtensionPath("team-extension")).isFile());
	assert.ok(statSync(resolveBuiltinExtensionPath("pstack-extension")).isFile());
});

async function startBarePstackHttpRepo(
	rootDir: string,
	name: string,
	populate: (workDir: string) => void,
): Promise<{ cloneUrl: string; publish: (change: (dir: string) => void) => void; close: () => Promise<void> }> {
	const workDir = join(rootDir, `${name}-src`);
	const bareDir = join(rootDir, `${name}.git`);
	mkdirSync(workDir, { recursive: true });
	execFileSync("git", ["init", "-b", "main", workDir], { stdio: "ignore" });
	execFileSync("git", ["config", "user.name", "Test User"], { cwd: workDir, stdio: "ignore" });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: workDir, stdio: "ignore" });
	populate(workDir);
	execFileSync("git", ["add", "."], { cwd: workDir, stdio: "ignore" });
	execFileSync("git", ["commit", "-m", "init"], { cwd: workDir, stdio: "ignore" });
	execFileSync("git", ["clone", "--bare", workDir, bareDir], { stdio: "ignore" });
	execFileSync("git", ["update-server-info"], { cwd: bareDir, stdio: "ignore" });

	const httpServer = http.createServer((req, res) => {
		const urlPath = (req.url ?? "/").split("?")[0] ?? "/";
		const prefix = `/${name}.git/`;
		const cleanRel = urlPath.startsWith(prefix) ? urlPath.slice(prefix.length) : urlPath.replace(/^\/+/, "");
		const target = resolve(bareDir, cleanRel);
		if (!target.startsWith(bareDir) || !existsSync(target) || statSync(target).isDirectory()) {
			res.writeHead(404);
			res.end("Not found");
			return;
		}
		res.writeHead(200);
		res.end(readFileSync(target));
	});
	await new Promise<void>((resolveListen) => httpServer.listen(0, "127.0.0.1", () => resolveListen()));
	const addr = httpServer.address();
	assert.ok(addr && typeof addr === "object");
	return {
		cloneUrl: `http://127.0.0.1:${addr.port}/${name}.git`,
		publish: (change) => {
			change(workDir);
			execFileSync("git", ["add", "-A"], { cwd: workDir, stdio: "ignore" });
			execFileSync("git", ["commit", "-m", "Update fixture"], { cwd: workDir, stdio: "ignore" });
			execFileSync("git", ["push", bareDir, "main"], { cwd: workDir, stdio: "ignore" });
			execFileSync("git", ["update-server-info"], { cwd: bareDir, stdio: "ignore" });
		},
		close: () => new Promise<void>((resolveClose) => httpServer.close(() => resolveClose())),
	};
}

test("Super admin can clone/enable pstack into .data/extensions/repo/<name>, persist setting, and disable cleanly", async (t) => {
	const tempDir = mkdtempSync(join(tmpdir(), "pa-pstack-install-"));
	t.after(() => rmSync(tempDir, { recursive: true, force: true }));

	const dataDir = join(tempDir, ".data");
	const repoContainerDir = join(dataDir, "extensions", "repo");
	mkdirSync(repoContainerDir, { recursive: true });
	const expectedValidDir = join(repoContainerDir, "valid-pstack");

	const prevEnvPstack = process.env.PA_PSTACK_DIR;
	delete process.env.PA_PSTACK_DIR;
	t.after(() => {
		if (prevEnvPstack === undefined) delete process.env.PA_PSTACK_DIR;
		else process.env.PA_PSTACK_DIR = prevEnvPstack;
	});

	const validRepo = await startBarePstackHttpRepo(tempDir, "valid-pstack", createValidPstackFixture);
	t.after(() => validRepo.close());
	const invalidRepo = await startBarePstackHttpRepo(tempDir, "invalid-pstack", (dir) => {
		writeFileSync(join(dir, "README.md"), "# Not pstack\n", "utf8");
	});
	t.after(() => invalidRepo.close());

	const templates = await loadRoleTemplatesFromDir(resolve(process.cwd(), "roles"));
	const db = openPersonalAgentDatabase(join(dataDir, "personal-agent.db"));
	t.after(() => db.close());
	const store = new PersonalAgentStore(db);
	const adminUser = store.setupInitialAdmin({
		email: "admin@pstack.test",
		password: "password-123",
		displayName: "Admin",
	});
	const memberUser = store.createUser({
		email: "member@pstack.test",
		password: "password-123",
		displayName: "Member",
		status: "active",
	});
	const { rawToken: adminToken } = store.createSession(adminUser.id);
	const { rawToken: memberToken } = store.createSession(memberUser.id);

	const orchestrator = new TeamOrchestrator({
		store,
		templates,
		defaultCwd: tempDir,
		noSession: true,
	});
	const { server } = createPersonalAgentServer({
		store,
		orchestrator,
		templates,
		previewManager: new PreviewManager(),
		dialogBroker: new DialogBroker(),
		requireAuth: true,
		dataDir,
		probePiCli: async () => ({ available: true, executable: "pi", version: "1.5.2", error: null }),
	});
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
	t.after(() => new Promise<void>((resolveClose) => server.close(() => resolveClose())));
	const addr = server.address();
	assert.ok(addr && typeof addr !== "string");
	const baseUrl = `http://127.0.0.1:${addr.port}`;

	// Default clone URL points to upstream backnotprop/pstack and resolves under .data/extensions/repo/pstack
	assert.equal(DEFAULT_PSTACK_CLONE_URL, "https://github.com/backnotprop/pstack.git");
	assert.equal(resolveDefaultPstackRepoDir(dataDir), join(repoContainerDir, "pstack"));

	// Non-admin user is forbidden from enabling/disabling pstack
	const memberEnableRes = await fetch(`${baseUrl}/api/admin/runtime/pstack/enable`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${memberToken}` },
		body: JSON.stringify({ cloneUrl: validRepo.cloneUrl }),
	});
	assert.equal(memberEnableRes.status, 403);

	// Unsafe file:// URL blocked
	const unsafeRes = await fetch(`${baseUrl}/api/admin/runtime/pstack/enable`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
		body: JSON.stringify({ cloneUrl: "file:///tmp/evil-pstack" }),
	});
	assert.equal(unsafeRes.status, 400);

	// Cloning an incomplete repo fails cleanly without leaving invalid files under `.data/extensions/repo/<name>`
	const invalidRes = await fetch(`${baseUrl}/api/admin/runtime/pstack/enable`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
		body: JSON.stringify({ cloneUrl: invalidRepo.cloneUrl }),
	});
	assert.equal(invalidRes.status, 400);
	assert.equal(existsSync(join(repoContainerDir, "invalid-pstack")), false);
	assert.equal(store.getPlatformSettings().pstackDir, null);
	assert.equal(orchestrator.getRuntimeConfig().pstackDir, null);

	// Valid repo clones into `.data/extensions/repo/valid-pstack`, verifies, persists settings, and activates immediately
	const enableRes = await fetch(`${baseUrl}/api/admin/runtime/pstack/enable`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
		body: JSON.stringify({ cloneUrl: validRepo.cloneUrl }),
	});
	assert.equal(enableRes.status, 200);
	const enableJson = (await enableRes.json()) as {
		source: string;
		repoPath: string;
		settings: { pstackDir: string | null };
		overview: RuntimeOverviewPayload;
	};
	assert.equal(enableJson.source, "cloned");
	assert.ok(enableJson.repoPath.endsWith("/extensions/repo/valid-pstack"));
	assert.ok(existsSync(join(expectedValidDir, "plugin.json")));
	assert.ok(existsSync(join(expectedValidDir, "skills", "poteto-mode", "SKILL.md")));
	assert.equal(enableJson.settings.pstackDir, enableJson.repoPath);
	assert.equal(enableJson.overview.base.pstack.configured, true);
	assert.equal(enableJson.overview.base.pstack.available, true);
	assert.equal(enableJson.overview.base.pstack.version, "0.15.42");
	assert.equal(enableJson.overview.base.pstack.skillCount, 2);
	assert.equal(enableJson.overview.extensions.find((ext) => ext.id === "builtin-pstack-extension")?.status, "active");
	assert.equal(
		enableJson.overview.configSections.find((s) => s.id === "env")?.items.find((i) => i.key === "PA_PSTACK_DIR")
			?.overridden,
		true,
	);

	const postPstackUpdate = () =>
		fetch(`${baseUrl}/api/admin/runtime/pstack/enable`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
			body: JSON.stringify({ update: true }),
		});
	const activeRevision = () => execFileSync("git", ["rev-parse", "HEAD"], { cwd: expectedValidDir, encoding: "utf8" });
	const originalRevision = activeRevision();
	validRepo.publish((dir) => rmSync(join(dir, "plugin.json")));
	const invalidUpdate = await postPstackUpdate();
	assert.equal(invalidUpdate.status, 502);
	assert.match(await invalidUpdate.text(), /plugin\.json/);
	assert.equal(activeRevision(), originalRevision);
	assert.ok(existsSync(join(expectedValidDir, "plugin.json")));
	assert.equal(orchestrator.getRuntimeConfig().pstackDir, enableJson.repoPath);

	validRepo.publish((dir) => {
		writeFileSync(join(dir, "plugin.json"), JSON.stringify({ name: "pstack", version: "0.15.43" }));
	});
	const validUpdate = await postPstackUpdate();
	assert.equal(validUpdate.status, 200, await validUpdate.clone().text());
	const updateJson = (await validUpdate.json()) as {
		source: string;
		repoPath: string;
		overview: RuntimeOverviewPayload;
	};
	assert.equal(updateJson.source, "updated");
	assert.equal(updateJson.repoPath, enableJson.repoPath);
	assert.equal(updateJson.overview.base.pstack.version, "0.15.43");
	assert.notEqual(activeRevision(), originalRevision);

	process.env.PA_PSTACK_DIR = expectedValidDir;
	assert.equal((await postPstackUpdate()).status, 409);
	delete process.env.PA_PSTACK_DIR;

	// Simulated server restart reads persisted pstackDir from DB without PA_PSTACK_DIR env
	const reopenedSettings = store.getPlatformSettings();
	assert.equal(reopenedSettings.pstackDir, enableJson.repoPath);
	const restartedOrchestrator = new TeamOrchestrator({
		store,
		templates,
		defaultCwd: tempDir,
		noSession: true,
		pstackDir: reopenedSettings.pstackDir ?? undefined,
	});
	assert.equal(restartedOrchestrator.getRuntimeConfig().pstackDir, enableJson.repoPath);

	// Disable clears persisted pstackDir while preserving local cloned directory for instant re-enable
	const disableRes = await fetch(`${baseUrl}/api/admin/runtime/pstack/disable`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
		body: "{}",
	});
	assert.equal(disableRes.status, 200);
	const disableJson = (await disableRes.json()) as {
		settings: { pstackDir: string | null };
		overview: RuntimeOverviewPayload;
	};
	assert.equal(disableJson.settings.pstackDir, null);
	assert.equal(disableJson.overview.base.pstack.configured, false);
	assert.equal(
		disableJson.overview.extensions.find((ext) => ext.id === "builtin-pstack-extension")?.status,
		"inactive",
	);
	assert.ok(existsSync(join(expectedValidDir, "plugin.json")));

	// Re-enable with same cloneUrl reuses existing `.data/extensions/repo/valid-pstack` without recloning
	const reenableRes = await fetch(`${baseUrl}/api/admin/runtime/pstack/enable`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
		body: JSON.stringify({ cloneUrl: validRepo.cloneUrl }),
	});
	assert.equal(reenableRes.status, 200);
	const reenableJson = (await reenableRes.json()) as { source: string; repoPath: string };
	assert.equal(reenableJson.source, "existing");
	assert.equal(reenableJson.repoPath, enableJson.repoPath);
});
