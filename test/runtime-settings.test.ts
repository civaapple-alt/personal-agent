import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { findInstalledPiWebAccess } from "../packages/server/src/extensions/web-access/package.ts";
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
} from "../packages/server/src/index.ts";

test("pi-web-access discovery uses the user package manifest and confines its entry to the package", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pa-web-access-package-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const root = join(dir, "npm", "pi-web-access");
	const manifest = join(root, "package.json");
	mkdirSync(join(root, "dist"), { recursive: true });
	writeFileSync(join(root, "dist", "index.js"), "export default () => {};");
	const writeManifest = (entry: string) =>
		writeFileSync(
			manifest,
			JSON.stringify({ name: "pi-web-access", version: "0.48.0", pi: { extensions: [entry] } }),
		);
	const printPackage = (scope: "User" | "Project") => async () =>
		`${scope} packages:\n  npm:pi-web-access@0.48.0\n    ${root}\n`;

	writeManifest("./dist");
	assert.deepEqual(await findInstalledPiWebAccess("pi", printPackage("User")), {
		entry: realpathSync(join(root, "dist", "index.js")),
		version: "0.48.0",
	});
	assert.equal(await findInstalledPiWebAccess("pi", printPackage("Project")), null);
	writeManifest("../../");
	assert.equal(await findInstalledPiWebAccess("pi", printPackage("User")), null);
});

test("GET /api/runtime reports Pi base, built-in and operator extensions, MCP dependencies, and collaborator redaction", async (t) => {
	const tempDir = mkdtempSync(join(tmpdir(), "pa-runtime-settings-"));
	t.after(() => rmSync(tempDir, { recursive: true, force: true }));

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
	const owner = store.setupInitialAdmin({
		email: "owner@runtime.test",
		password: "TestPass123!",
		displayName: "Owner",
	});
	const collaborator = store.createUser({
		email: "reviewer@runtime.test",
		password: "TestPass123!",
		displayName: "Alice",
		status: "active",
	});
	const ownerToken = store.createSession(owner.id).rawToken;
	const collaboratorToken = store.createSession(collaborator.id).rawToken;

	const sessionDir = join(tempDir, "pi-sessions");
	mkdirSync(sessionDir, { recursive: true });

	const orchestrator = new TeamOrchestrator({
		store,
		templates: allTemplates,
		defaultCwd: tempDir,
		sessionDir,
		noSession: false,
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

	const ownerRes = await fetch(`${baseUrl}/api/runtime`, {
		headers: { Authorization: `Bearer ${ownerToken}` },
	});
	assert.equal(ownerRes.status, 200);
	const removedPstackRoute = await fetch(`${baseUrl}/api/admin/runtime/pstack/enable`, {
		method: "POST",
		headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
		body: JSON.stringify({ path: "/obsolete" }),
	});
	assert.equal(removedPstackRoute.status, 404);
	const ownerPayload = (await ownerRes.json()) as RuntimeOverviewPayload;

	assert.equal(ownerPayload.base.name, "Pi CLI");
	assert.equal(ownerPayload.base.available, true);
	assert.equal(ownerPayload.base.version, "1.5.2");
	assert.equal(ownerPayload.base.pathsRedacted, false);
	assert.equal(ownerPayload.base.sessionMode, "persisted");
	assert.equal(ownerPayload.base.sessionDir, sessionDir);
	assert.equal(ownerPayload.base.defaultCwd, tempDir);
	assert.equal(ownerPayload.base.isolationModes.length, 5);
	assert.ok(
		ownerPayload.base.isolationModes.some(
			(mode) => mode.id === "architect-matter" && mode.sessionStrategy.includes("事项"),
		),
	);
	assert.ok(
		ownerPayload.base.isolationModes.some(
			(mode) =>
				mode.id === "architect-aux" &&
				mode.extensionsPolicy.includes("Skill") &&
				mode.usage.includes("团队协作体检"),
		),
	);

	const workerRuntimeExt = ownerPayload.extensions.find((ext) => ext.id === "builtin-worker-runtime");
	assert.ok(workerRuntimeExt);
	assert.equal(workerRuntimeExt.status, "active");
	assert.equal(workerRuntimeExt.fileStatus, "present");
	assert.deepEqual(workerRuntimeExt.registeredTools, []);

	const spaceExt = ownerPayload.extensions.find((ext) => ext.id === "builtin-space");
	assert.ok(spaceExt);
	assert.equal(spaceExt.status, "conditional");
	assert.deepEqual(spaceExt.registeredTools, ["read_space", "save_space_page"]);

	const delegationExt = ownerPayload.extensions.find((ext) => ext.id === "builtin-delegation");
	assert.ok(delegationExt);
	assert.equal(delegationExt.status, "conditional");
	assert.deepEqual(delegationExt.registeredTools, ["delegate_to_member"]);

	const skillCaptureExt = ownerPayload.extensions.find((ext) => ext.id === "builtin-skill-capture");
	assert.ok(skillCaptureExt);
	assert.equal(skillCaptureExt.status, "conditional");
	assert.deepEqual(skillCaptureExt.registeredTools, ["propose_skill"]);
	const questionExt = ownerPayload.extensions.find((ext) => ext.id === "builtin-human-question");
	assert.equal(questionExt?.status, "conditional");
	assert.deepEqual(questionExt.registeredTools, ["request_clarification"]);

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

	const roleSkillsPkg = ownerPayload.extensions.find((ext) => ext.name === "role-skills");
	assert.ok(roleSkillsPkg);
	assert.equal(roleSkillsPkg.status, "active");
	assert.equal(roleSkillsPkg.fileStatus, "present");

	assert.equal(ownerPayload.summary.activeCount, 5);
	assert.equal(
		ownerPayload.summary.conditionalCount,
		ownerPayload.extensions.filter((ext) => ext.status === "conditional").length,
	);
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

	// Collaborator view redacts host filesystem paths while keeping capability info intact.
	const collabRes = await fetch(`${baseUrl}/api/runtime`, {
		headers: { Authorization: `Bearer ${collaboratorToken}` },
	});
	assert.equal(collabRes.status, 200);
	const collabPayload = (await collabRes.json()) as RuntimeOverviewPayload;
	assert.equal(collabPayload.base.pathsRedacted, true);
	assert.equal(collabPayload.base.sessionDir, "pi-sessions");
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

test("buildRuntimeOverview reports missing Pi CLI and reports MCP configuration cleanly", async (t) => {
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
	assert.equal(payload.base.isolationModes.find((mode) => mode.id === "worker")?.sessionStrategy, "无持久 Pi 会话");
	assert.equal(
		payload.base.isolationModes.find((mode) => mode.id === "architect-matter")?.sessionStrategy,
		"无持久 Pi 会话",
	);
	assert.equal(payload.base.envFlags.turnTimeoutMs, 0);
	assert.equal(payload.base.envFlags.idleTimeoutMs, 900_000);
	assert.match(
		payload.base.isolationModes.find((mode) => mode.id === "worker")?.extensionsPolicy ?? "",
		/Skill 由 Pi 发现/,
	);
	const localResources = await buildRuntimeOverview({
		config: orchestrator.getRuntimeConfig(),
		serverConfig: { inheritLocalPiResources: true },
		activeMembers: store.listMembers(),
		isOwner: true,
		probePiCli: async () => ({ available: false, executable: "pi", version: null, error: "not installed" }),
	});
	assert.match(
		localResources.base.isolationModes.find((mode) => mode.id === "worker")?.extensionsPolicy ?? "",
		/可继承 Pi 资源/,
	);

	const mcpExt = payload.extensions.find((ext) => ext.id === "pi-builtin-mcp");
	assert.equal(mcpExt?.status, "conditional");
	assert.deepEqual(mcpExt?.declaredByRoles, []);

	assert.ok(statSync(resolveBuiltinExtensionPath("worker-runtime")).isFile());
	assert.ok(statSync(resolveBuiltinExtensionPath("space")).isFile());
	assert.ok(statSync(resolveBuiltinExtensionPath("delegation")).isFile());
	assert.ok(statSync(resolveBuiltinExtensionPath("skill-capture")).isFile());
	assert.ok(statSync(resolveBuiltinExtensionPath("human-question")).isFile());
});
