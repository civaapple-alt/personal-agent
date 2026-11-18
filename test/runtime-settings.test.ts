import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
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
