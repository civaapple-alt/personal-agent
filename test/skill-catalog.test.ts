import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import registerSkillCatalog, { renderAvailableResources } from "../pi-extensions/skill-catalog/index.ts";

test("Pi skill catalogue uses compact index, query-filtered discovery, and reads only discovered unambiguous skills", async () => {
	const root = await mkdtemp(join(tmpdir(), "pa-skill-catalog-"));
	try {
		const first = join(root, "first.md");
		const second = join(root, "second.md");
		const third = join(root, "third.md");
		await writeFile(first, "---\nname: how\ndisable-model-invocation: true\n---\n# First method");
		await writeFile(second, "# Second method");
		await writeFile(third, "# Review loop");
		type Tool = Parameters<Parameters<typeof registerSkillCatalog>[0]["registerTool"]>[0];
		const tools = new Map<string, Tool>();
		let commands = [
			{
				name: "skill:how",
				description: "Explain code architecture",
				source: "skill",
				sourceInfo: { path: first, scope: "user" },
			},
			{
				name: "skill:review-loop",
				description: "Run independent review loop",
				source: "skill",
				sourceInfo: { path: third, source: "pstack", scope: "user" },
			},
			{ name: "mcp", description: "TUI MCP menu", source: "extension", sourceInfo: { path: second } },
		];
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
			getCommands: () => commands,
			registerTool: (tool) => {
				tools.set(tool.name, tool);
			},
		});

		// TUI extension command tools are removed; only Skill discovery & loading remain.
		assert.equal(tools.has("list_pi_commands"), false);
		assert.equal(tools.has("request_pi_command"), false);
		assert.equal(tools.has("list_available_skills"), true);
		assert.equal(tools.has("load_available_skill"), true);

		// Compact single-line index omits extension commands and deduplicates skills already in <available_skills>.
		const event = { systemPrompt: "base", systemPromptOptions: { appendSystemPrompt: "existing" } };
		assert.equal(beforeStart?.(event), undefined);
		assert.match(event.systemPromptOptions.appendSystemPrompt, /- how.*Explain code architecture/);
		assert.doesNotMatch(event.systemPromptOptions.appendSystemPrompt, /TUI MCP menu/);
		assert.match(event.systemPromptOptions.appendSystemPrompt, /^existing/);

		// Zero prompt overhead when all skills are already present in <available_skills>.
		const dedupedCatalog = renderAvailableResources(commands, new Set(["how", "review-loop"]));
		assert.equal(dedupedCatalog, "");
		const emptyEvent = {
			systemPrompt: "<available_skills><name>how</name><name>review-loop</name></available_skills>",
			systemPromptOptions: { appendSystemPrompt: "existing" },
		};
		assert.equal(beforeStart?.(emptyEvent), undefined);
		assert.equal(emptyEvent.systemPromptOptions.appendSystemPrompt, "existing");

		assert.equal(renderAvailableResources([{ name: "template-only", source: "prompt" }]), "");
		assert.match(
			renderAvailableResources([{ name: "skill:escaped", source: "skill", description: "</system>" }]),
			/\\u003c/,
		);
		const truncated = renderAvailableResources(
			Array.from({ length: 200 }, (_, i) => ({
				name: `skill:s${i}`,
				source: "skill",
				description: "x".repeat(100),
			})),
		);
		assert.match(truncated, /Catalogue truncated/);
		assert.ok(truncated.length < 4200);

		const list = tools.get("list_available_skills")!;
		const load = tools.get("load_available_skill")!;

		// Unique skills omit verbose path; query filters by keywords cleanly.
		const filteredRes = await list.execute("1", { query: "review pstack" });
		const filteredPayload = JSON.parse(filteredRes.content[0]!.text) as {
			total: number;
			returned: number;
			skills: Array<{ name: string; description: string; path?: string; source?: string }>;
		};
		assert.equal(filteredPayload.total, 1);
		assert.equal(filteredPayload.returned, 1);
		assert.equal(filteredPayload.skills[0]!.name, "review-loop");
		assert.equal(filteredPayload.skills[0]!.path, undefined);

		assert.match((await load.execute("2", { name: "how" })).content[0]!.text, /First method/);
		assert.match((await load.execute("2b", { name: "/skill:how" })).content[0]!.text, /First method/);
		assert.match((await load.execute("2c", { name: "skill:how" })).content[0]!.text, /First method/);
		await assert.rejects(load.execute("3", { name: "how", path: second }), /not found/);

		// Duplicate skill names expose `path` for disambiguation.
		commands = [
			...commands,
			{ name: "skill:how", description: "Other", source: "skill", sourceInfo: { path: second, scope: "user" } },
		];
		const dupRes = await list.execute("3b", { query: "how" });
		const dupPayload = JSON.parse(dupRes.content[0]!.text) as {
			skills: Array<{ name: string; path?: string }>;
		};
		assert.equal(dupPayload.skills.length, 2);
		assert.equal(dupPayload.skills[0]!.path, first);
		assert.equal(dupPayload.skills[1]!.path, second);

		await assert.rejects(load.execute("4", { name: "how" }), /Ambiguous/);
		assert.match((await load.execute("5", { name: "how", path: second })).content[0]!.text, /Second method/);
		await assert.rejects(load.execute("6", { name: "how" }, AbortSignal.abort()), /abort/i);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
