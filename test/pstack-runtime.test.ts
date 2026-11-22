import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerPstackExtension } from "../pi-extensions/pstack-methods/index.ts";
import { preparePstackRuntime, readPstackResource } from "../pi-extensions/pstack-methods/methods.js";
import type { PiExtensionApi } from "../pi-extensions/team-extension/index.ts";
import { hasPstackReadEvidence } from "../src/demo/pstack-evidence.ts";
import { TeamOrchestrator } from "../src/orchestrator/team-orchestrator.ts";
import { BUILTIN_ROLE_ARCHITECT_TEMPLATE } from "../src/roles/role-architect.ts";
import { loadRoleTemplatesFromDir } from "../src/roles/template-loader.ts";
import { openPersonalAgentDatabase } from "../src/storage/database.ts";
import { PersonalAgentStore } from "../src/storage/repositories.ts";
import { reportReady } from "./worker-helpers.ts";

async function createPack(root: string) {
	await mkdir(root, { recursive: true });
	await writeFile(join(root, "plugin.json"), JSON.stringify({ name: "pstack", version: "fixture-1" }));
	for (const name of ["poteto-mode", "principle-prove-it-works", "principle-fix-root-causes"]) {
		await mkdir(join(root, "skills", name), { recursive: true });
		await writeFile(
			join(root, "skills", name, "SKILL.md"),
			`---\nname: ${name}\ndescription: Fixture ${name}\ndisable-model-invocation: true\n---\n# ${name}\nSOURCE_${name}\n`,
		);
	}
	await mkdir(join(root, "skills", "poteto-mode", "playbooks"));
	await writeFile(
		join(root, "skills", "poteto-mode", "playbooks", "investigation.md"),
		"Read-only investigation fixture\n",
	);
	await writeFile(join(root, "skills", "poteto-mode", "playbooks", "bug-fix.md"), "Bug fix fixture\n");
}

function extensionApi(tools: Map<string, Parameters<PiExtensionApi["registerTool"]>[0]>): PiExtensionApi {
	return {
		registerTool: (tool) => {
			tools.set(tool.name, tool);
		},
		on: () => {},
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: () => {},
	};
}

test("pstack loader reads actual method resources and rejects escapes, scripts and missing mode", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pa-pstack-loader-"));
	try {
		const root = join(dir, "pack");
		await createPack(root);
		const runtime = await preparePstackRuntime(root);
		assert.equal(runtime.version, "fixture-1");
		assert.equal(runtime.skills.length, 3);
		assert.match(runtime.modeSha256, /^[a-f0-9]{64}$/);
		const method = await readPstackResource(root, "poteto-mode", "playbooks/investigation.md");
		assert.equal(method.text, "Read-only investigation fixture\n");
		await writeFile(join(dir, "outside.md"), "must not be read");
		await symlink(join(dir, "outside.md"), join(root, "skills", "poteto-mode", "outside.md"));
		await assert.rejects(() => readPstackResource(root, "poteto-mode", "outside.md"), /inside/);
		await assert.rejects(() => readPstackResource(root, "poteto-mode", "../../../outside.md"), /inside/);
		await assert.rejects(() => readPstackResource(root, "poteto-mode", "script.sh"), /Markdown/);
		await assert.rejects(() => readPstackResource(root, "../outside"), /Invalid/);
		await writeFile(join(root, "skills", "poteto-mode", "large.md"), "x".repeat(262145));
		await assert.rejects(() => readPstackResource(root, "poteto-mode", "large.md"), /bounded/);
		await rm(join(root, "skills", "poteto-mode"), { recursive: true });
		await assert.rejects(() => preparePstackRuntime(root), /ENOENT/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("Pi method tool supports catalogue, real principles and cancellation without business tools", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pa-pstack-extension-"));
	try {
		await createPack(dir);
		const tools = new Map<string, Parameters<PiExtensionApi["registerTool"]>[0]>();
		await registerPstackExtension(extensionApi(tools), dir);
		assert.deepEqual([...tools.keys()], ["load_pstack_skill"]);
		const tool = tools.get("load_pstack_skill")!;
		const catalog = await tool.execute("catalog", {});
		assert.match(catalog.content[0]!.text, /principle-prove-it-works/);
		const method = await tool.execute("method", { name: "principle-prove-it-works" });
		assert.match(method.content[0]!.text, /SOURCE_principle-prove-it-works/);
		assert.match(method.content[0]!.text, /SHA256: [a-f0-9]{64}/);
		assert.match(method.content[0]!.text, /Successfully loaded in this worker: principle-prove-it-works\/SKILL.md/);
		const bugfix = await tool.execute("bugfix", { name: "poteto-mode", resource: "playbooks/bug-fix.md" });
		assert.match(bugfix.content[0]!.text, /SOURCE_principle-fix-root-causes/);
		assert.match(bugfix.content[0]!.text, /SOURCE_principle-prove-it-works/);
		const expected = await readPstackResource(dir, "principle-fix-root-causes");
		const record = {
			toolName: "load_pstack_skill",
			toolCallId: "bugfix",
			args: { name: "poteto-mode", resource: "playbooks/bug-fix.md" },
			isError: false,
			result: bugfix,
		};
		assert.equal(hasPstackReadEvidence([record], expected), true);
		assert.equal(hasPstackReadEvidence([{ ...record, isError: true }], expected), false);
		assert.equal(hasPstackReadEvidence([{ ...record, result: undefined }], expected), false);
		assert.equal(
			hasPstackReadEvidence([{ ...record, result: { content: [{ text: expected.sha256 }] } }], expected),
			false,
		);
		assert.equal(
			hasPstackReadEvidence(
				[{ ...record, result: { content: [{ text: "I applied principle-fix-root-causes" }] } }],
				expected,
			),
			false,
		);
		await assert.rejects(
			() => tool.execute("wrong-path", { name: "poteto-mode", resource: "principle-experience-first.md" }),
			/sibling/,
		);
		await assert.rejects(() => tool.execute("bad", { name: "not-installed" }), /Unknown/);
		await assert.rejects(() => tool.execute("aborted", { name: "poteto-mode" }, AbortSignal.abort()), /abort/i);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("orchestrator wires pstack into the real loadout without widening the architect's business permissions", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pa-pstack-wiring-"));
	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db);
	await createPack(join(dir, "pack"));
	let promptReached = false;
	let omitMethodTool = false;
	const orchestrator = new TeamOrchestrator({
		store,
		templates: [BUILTIN_ROLE_ARCHITECT_TEMPLATE],
		defaultCwd: dir,
		noSession: true,
		pstackDir: join(dir, "pack"),
		workerFactory: (options) => ({
			onNotice: () => () => {},
			setDialogHandler: () => {},
			stop: async () => {},
			getState: async () => ({ sessionId: "fixture" }),
			start: async () => {
				assert.match(options.env!.PA_MEMBER_CONTEXT!, /## pstack methods/);
				assert.match(options.env!.PA_MEMBER_CONTEXT!, /lead can save plans/);
				const args = options.args!;
				assert.equal(args[args.indexOf("--tools") + 1], "read_pa_help,load_pstack_skill");
				assert.ok(args.some((arg) => arg.endsWith(join("pstack-methods", "index.ts"))));
				assert.equal(options.env!.PA_CAN_SAVE_SPACE, "false");
				assert.equal(options.env!.PA_CAN_DELEGATE, "false");
				await reportReady(options, omitMethodTool ? ["read_pa_help"] : ["read_pa_help", "load_pstack_skill"]);
			},
			runPromptAndWait: async () => {
				promptReached = true;
				return {
					disposition: "started",
					aborted: false,
					assistantText: "只提供岗位建议",
					assistantMessages: [],
					toolExecutions: [],
					notices: [],
					dialogs: [],
					events: [],
				};
			},
		}),
	});
	try {
		const result = await orchestrator.dispatchMatter({
			preferredMemberId: "role-architect",
			prompt: "讨论团队职责，不创建角色",
		});
		assert.equal(promptReached, true);
		assert.equal(store.spaces.listDocuments({ matterId: result.matter.id }).length, 0);
		assert.ok(store.listMessages(result.matter.id, "notice").some((m) => m.content.includes('"modeSha256"')));
		omitMethodTool = true;
		promptReached = false;
		await assert.rejects(
			() => orchestrator.dispatchMatter({ preferredMemberId: "role-architect", prompt: "另一次讨论" }),
			/load_pstack_skill/,
		);
		assert.equal(promptReached, false);
	} finally {
		await orchestrator.shutdown();
		db.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test("pstack-enabled observers retain narrowed tools and can remain silent without loading the full mode", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pa-pstack-observer-"));
	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db);
	await createPack(join(dir, "pack"));
	const templates = (await loadRoleTemplatesFromDir(join(process.cwd(), "roles")))
		.filter((template) => ["product-manager", "qa-manager"].includes(template.id))
		.map((template) => ({ ...template, tools: template.id === "qa-manager" ? ["read", "edit", "write"] : [] }));
	let observerReached = false;
	const orchestrator = new TeamOrchestrator({
		store,
		templates,
		defaultCwd: dir,
		noSession: true,
		pstackDir: join(dir, "pack"),
		workerFactory: (options) => {
			const observer = options.env?.PA_MEMBER_ID === "qa-manager";
			return {
				onNotice: () => () => {},
				setDialogHandler: () => {},
				stop: async () => {},
				getState: async () => ({ sessionId: "observer-fixture" }),
				start: async () => {
					if (observer) {
						const args = options.args!;
						assert.deepEqual(args[args.indexOf("--tools") + 1]!.split(","), [
							"read",
							"read_pa_help",
							"load_pstack_skill",
						]);
						assert.equal(options.env!.PA_CAN_DELEGATE, "false");
						assert.equal(options.env!.PA_CAN_SAVE_SPACE, "false");
						assert.equal(options.env!.PA_CAN_EXPERIENCE, "false");
						assert.match(options.env!.PA_MEMBER_CONTEXT!, /remain silent without loading the full mode/);
					}
					await reportReady(options);
				},
				runPromptAndWait: async () => {
					if (observer) observerReached = true;
					return {
						disposition: "started",
						aborted: false,
						assistantText: observer ? "[SILENT]" : "继续讨论",
						assistantMessages: [],
						toolExecutions: [],
						notices: [],
						dialogs: [],
						events: [],
					};
				},
			};
		},
	});
	try {
		const result = await orchestrator.dispatchMatter({
			preferredMemberId: "product-manager",
			aiMemberIds: ["product-manager", "qa-manager"],
			observersEnabled: true,
			observerMemberIds: ["qa-manager"],
			prompt: "只讨论需求，不编码不发布",
		});
		assert.equal(observerReached, true);
		assert.equal(store.spaces.listDocuments({ matterId: result.matter.id }).length, 0);
		assert.equal(
			store.listMessages(result.matter.id, "user").some((m) => m.senderId === "qa-manager"),
			false,
		);
	} finally {
		await orchestrator.shutdown();
		db.close();
		await rm(dir, { recursive: true, force: true });
	}
});
