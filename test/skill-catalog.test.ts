import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import registerSkillCatalog from "../pi-extensions/skill-catalog/index.ts";

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
		registerSkillCatalog({
			getCommands: () => commands,
			registerTool: (tool) => {
				tools.set(tool.name, tool);
			},
		});
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
