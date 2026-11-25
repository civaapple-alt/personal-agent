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
		assert.ok(truncated.length < 7200);

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

test("pstack poteto-mode and downstream skills (how, why, principles) remain discoverable and loadable under compact catalog", async () => {
	const root = await mkdtemp(join(tmpdir(), "pa-pstack-poteto-"));
	try {
		const skillsRoot = root;
		const skillSpecs = [
			{
				name: "poteto-mode",
				description: "poteto's agent style for concise, detailed responses, unslopped prose, and verified work.",
				body: "---\nname: poteto-mode\ndisable-model-invocation: true\n---\n# Poteto mode\nRead leaf skills like how, why, and principle-prove-it-works.",
			},
			{
				name: "how",
				description: 'Use for "how does X work", code walkthroughs, and layering questions.',
				body: "---\nname: how\n---\n# How\nTrace the real code path with file and line citations.",
			},
			{
				name: "why",
				description: 'Use for "why does X work this way", design rationale, regressions, and history.',
				body: "---\nname: why\n---\n# Why\nCheck git history and recorded decisions; separate facts from inference.",
			},
			{
				name: "principle-prove-it-works",
				description: "After a task, verify against the real artifact, not a proxy.",
				body: "---\nname: principle-prove-it-works\n---\n# Prove It Works\nRun the real check and report observed output.",
			},
			...Array.from({ length: 45 }, (_, i) => ({
				name: `alpha-filler-${String(i).padStart(2, "0")}`,
				description: `Synthetic pstack filler skill ${i} to force compact catalog truncation before tail skills.`,
				body: `# Filler ${i}`,
			})),
		];
		const commands: Array<{
			name: string;
			description: string;
			source: string;
			sourceInfo: { path: string; source: string; scope: string };
		}> = [];
		for (const spec of skillSpecs) {
			const filePath = join(skillsRoot, `${spec.name}.md`);
			await writeFile(filePath, spec.body);
			commands.push({
				name: `skill:${spec.name}`,
				description: spec.description,
				source: "skill",
				sourceInfo: { path: filePath, source: "git:github.com/backnotprop/pstack", scope: "user" },
			});
		}
		// Sort alphabetically like Pi does so tail skills (`poteto-mode`, `why`) sit past the 3600-char inline cap.
		commands.sort((a, b) => a.name.localeCompare(b.name));

		type Tool = Parameters<Parameters<typeof registerSkillCatalog>[0]["registerTool"]>[0];
		const tools = new Map<string, Tool>();
		registerSkillCatalog({
			on: () => {},
			getCommands: () => commands,
			registerTool: (tool) => {
				tools.set(tool.name, tool);
			},
		});

		// Inline compact catalog fits all ~50 pstack skills (including poteto-mode, how, why) without truncation!
		const inlineCatalog = renderAvailableResources(commands);
		assert.match(inlineCatalog, /- poteto-mode:/);
		assert.match(inlineCatalog, /- how:/);
		assert.match(inlineCatalog, /- why:/);
		assert.doesNotMatch(inlineCatalog, /Catalogue truncated/);
		assert.ok(inlineCatalog.length < 6800);

		const list = tools.get("list_available_skills")!;
		const load = tools.get("load_available_skill")!;

		// 1. Discover & load poteto-mode even when truncated from inline catalog.
		const potetoSearch = JSON.parse((await list.execute("s1", { query: "poteto" })).content[0]!.text) as {
			total: number;
			skills: Array<{ name: string }>;
		};
		assert.equal(potetoSearch.total, 1);
		assert.equal(potetoSearch.skills[0]!.name, "poteto-mode");
		const potetoLoaded = (await load.execute("l1", { name: "poteto-mode" })).content[0]!.text;
		assert.match(potetoLoaded, /# Poteto mode/);
		assert.match(potetoLoaded, /SHA256:/);

		// 2. Discover & load downstream `how`, `why`, and `principle-prove-it-works` skills via query & direct name.
		for (const [query, expectedName, expectedHeading] of [
			["walkthroughs", "how", /# How/],
			["rationale", "why", /# Why/],
			["prove it works", "principle-prove-it-works", /# Prove It Works/],
		] as const) {
			const res = JSON.parse((await list.execute(`q-${expectedName}`, { query })).content[0]!.text) as {
				skills: Array<{ name: string; path?: string }>;
			};
			assert.ok(
				res.skills.some((s) => s.name === expectedName),
				`Expected query "${query}" to find ${expectedName}`,
			);
			const content = (await load.execute(`l-${expectedName}`, { name: expectedName })).content[0]!.text;
			assert.match(content, expectedHeading);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
