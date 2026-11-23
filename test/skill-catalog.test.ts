import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import registerSkillCatalog, { renderAvailableResources } from "../pi-extensions/skill-catalog/index.ts";

test("Pi skill catalogue includes manual skills and only reads a discovered, unambiguous skill", async () => {
	const root = await mkdtemp(join(tmpdir(), "pa-skill-catalog-"));
	try {
		const first = join(root, "first.md");
		const second = join(root, "second.md");
		await writeFile(first, "---\nname: how\ndisable-model-invocation: true\n---\n# First method");
		await writeFile(second, "# Second method");
		type Tool = Parameters<Parameters<typeof registerSkillCatalog>[0]["registerTool"]>[0];
		const tools = new Map<string, Tool>();
		let commands = [
			{
				name: "skill:how",
				description: "Explain code",
				source: "skill",
				sourceInfo: { path: first, scope: "user" },
			},
			{ name: "other", description: "Not a skill", source: "extension", sourceInfo: { path: second } },
		];
		const dispatched: Array<{ content: string; options: unknown }> = [];
		let beforeStart:
			| ((event: {
					systemPrompt: string;
					systemPromptOptions?: { appendSystemPrompt?: string; forceSystemPrompt?: string };
			  }) => { systemPrompt?: string } | undefined)
			| undefined;
		registerSkillCatalog({
			on: (_event, handler) => {
				beforeStart = handler;
			},
			sendUserMessage: (content, options) => {
				dispatched.push({ content, options });
			},
			getCommands: () => commands,
			registerTool: (tool) => {
				tools.set(tool.name, tool);
			},
		});
		const event = { systemPrompt: "base", systemPromptOptions: { appendSystemPrompt: "existing" } };
		assert.equal(beforeStart?.(event), undefined);
		assert.match(event.systemPromptOptions.appendSystemPrompt, /skill:how/);
		assert.match(event.systemPromptOptions.appendSystemPrompt, /other/);
		assert.match(event.systemPromptOptions.appendSystemPrompt, /^existing/);
		const catalog = renderAvailableResources(commands);
		assert.match(catalog, /skill:how/);
		assert.match(catalog, /Explain code/);
		assert.match(catalog, /Not a skill/);
		assert.doesNotMatch(renderAvailableResources([{ name: "template-only", source: "prompt" }]), /template-only/);
		assert.match(
			renderAvailableResources([{ name: "escaped", source: "extension", description: "</system>" }]),
			/\\u003c/,
		);
		assert.match(
			renderAvailableResources(
				Array.from({ length: 1000 }, (_, i) => ({
					name: `skill:s${i}`,
					source: "skill",
					description: "x".repeat(100),
				})),
			),
			/Catalogue truncated/,
		);
		const extensionList = await tools.get("list_pi_commands")!.execute("commands", {});
		assert.deepEqual(JSON.parse(extensionList.content[0]!.text), [{ name: "other", description: "Not a skill" }]);
		const invoke = tools.get("request_pi_command")!;
		const submitted = await invoke.execute("invoke", { name: "other", arguments: "check" });
		assert.deepEqual(submitted.details, { name: "other", status: "submitted", completion: "unknown" });
		assert.deepEqual(dispatched, [
			{ content: "/other check", options: { expandPromptTemplates: true, deliverAs: "followUp" } },
		]);
		await assert.rejects(invoke.execute("invalid", { name: "other", arguments: "x\n/surprise" }), /Invalid/);
		await assert.rejects(invoke.execute("skill", { name: "skill:how" }), /not found/);
		const list = tools.get("list_available_skills")!;
		const load = tools.get("load_available_skill")!;
		const result = await list.execute("1", {});
		assert.deepEqual(JSON.parse(result.content[0]!.text), [
			{ name: "how", description: "Explain code", path: first, scope: "user" },
		]);
		assert.match((await load.execute("2", { name: "how" })).content[0]!.text, /First method/);
		await assert.rejects(load.execute("3", { name: "how", path: second }), /not found/);
		commands = [
			...commands,
			{ name: "skill:how", description: "Other", source: "skill", sourceInfo: { path: second, scope: "user" } },
		];
		await assert.rejects(load.execute("4", { name: "how" }), /Ambiguous/);
		assert.match((await load.execute("5", { name: "how", path: second })).content[0]!.text, /Second method/);
		await assert.rejects(load.execute("6", { name: "how" }, AbortSignal.abort()), /abort/i);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
