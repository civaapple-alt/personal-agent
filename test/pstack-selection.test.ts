import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fixtureReadAllowed } from "../src/demo/fixture-read-guard.ts";
import { selectionCases } from "../src/demo/pstack-selection-cases.ts";
import { selectionMethodLoaded, selectionTree, summarizeSelection } from "../src/demo/pstack-selection-runner.ts";
import { qualityReviewTemplate, reviewHash } from "../src/demo/publication-review-quality.ts";

test("natural selection cases do not tell candidates method names or expose the rubric", () => {
	assert.deepEqual(
		selectionCases.map((entry) => entry.id),
		["how", "why", "teach", "recall", "architect"],
	);
	for (const scenario of selectionCases) {
		assert.doesNotMatch(
			`${scenario.prompt}\n${scenario.priorMessage ?? ""}`,
			/\b(?:pstack|poteto-mode|how|why|teach|recall|architect|load_pstack_skill)\b/i,
		);
		assert.equal(scenario.rubric.length, 3);
		assert.match(scenario.prompt, /不改文件/);
	}
});

test("fixture read boundaries exclude private sessions, sibling projects and escaping symlinks", async () => {
	const root = await mkdtemp(join(tmpdir(), "pa-selection-read-"));
	try {
		const project = join(root, "project");
		await mkdir(project);
		await writeFile(join(project, "README.md"), "Fixture");
		await writeFile(join(root, "private.md"), "Outside current project");
		await symlink(join(root, "private.md"), join(project, "escape.md"));
		assert.equal(await fixtureReadAllowed("README.md", project, [project]), true);
		assert.equal(await fixtureReadAllowed("missing.md", project, [project]), true);
		assert.equal(await fixtureReadAllowed("../missing.md", project, [project]), false);
		assert.equal(await fixtureReadAllowed("../private.md", project, [project]), false);
		assert.equal(await fixtureReadAllowed("escape.md", project, [project]), false);
		assert.equal(await fixtureReadAllowed(join(root, "private.md"), project, [join(project, "README.md")]), false);
		assert.equal(await fixtureReadAllowed(join(project, "README.md"), project, [join(project, "README.md")]), true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("selection evidence accepts full direct file reads but rejects excerpts, failed reads and wrong paths", async () => {
	const root = await mkdtemp(join(tmpdir(), "pa-selection-body-"));
	try {
		const path = join(root, "SKILL.md");
		const text = "# Example method\nComplete body\n";
		await writeFile(path, text);
		const expected = { name: "how", resource: "SKILL.md", path, text, sha256: reviewHash(text) };
		const record = {
			toolName: "read",
			toolCallId: "read-1",
			args: { path: "SKILL.md" },
			isError: false,
			result: { content: [{ type: "text", text }] },
		};
		assert.equal(await selectionMethodLoaded([record], expected, root), true);
		assert.equal(await selectionMethodLoaded([{ ...record, isError: true }], expected, root), false);
		assert.equal(
			await selectionMethodLoaded(
				[{ ...record, result: { content: [{ type: "text", text: "I used how" }] } }],
				expected,
				root,
			),
			false,
		);
		assert.equal(await selectionMethodLoaded([{ ...record, args: { path: "missing.md" } }], expected, root), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("offline summaries keep missing method selection separate from reviewed semantic quality", async () => {
	const root = await mkdtemp(join(tmpdir(), "pa-selection-summary-"));
	try {
		const dir = join(root, "evidence", "how");
		await mkdir(dir, { recursive: true });
		await writeFile(join(root, "run.json"), JSON.stringify({ ids: ["how"] }));
		const transcript = "An actual fixture explanation.\n";
		await writeFile(join(dir, "transcript.md"), transcript);
		await writeFile(
			join(dir, "execution.json"),
			JSON.stringify({
				executionSucceeded: true,
				workspaceUnchanged: true,
				methodsUnchanged: true,
				noDeliverables: true,
				sessionResumed: true,
				targetMethodObserved: false,
				transcriptSha256: reviewHash(transcript),
			}),
		);
		const scenario = selectionCases.find((entry) => entry.id === "how")!;
		const pending = qualityReviewTemplate(transcript, scenario.rubric);
		await writeFile(join(dir, "quality-review.json"), JSON.stringify(pending));
		let summary = await summarizeSelection(root);
		assert.equal(summary.results[0]?.runtimePassed, true);
		assert.equal(summary.results[0]?.targetMethodObserved, false);
		assert.equal(summary.results[0]?.quality.status, "pending");
		await writeFile(
			join(dir, "quality-review.json"),
			JSON.stringify({
				...pending,
				reviewer: "fixture-independent-reviewer",
				judgments: scenario.rubric.map(({ id }) => ({
					criterionId: id,
					verdict: "pass",
					explanation: "Fixture-only validation of review binding",
					evidence: [{ line: 1, text: "An actual fixture explanation." }],
				})),
			}),
		);
		summary = await summarizeSelection(root);
		assert.equal(summary.exitCode, 1);
		assert.equal(summary.results[0]?.quality.status, "pass");
		await writeFile(join(dir, "transcript.md"), "Changed after review\n");
		summary = await summarizeSelection(root);
		assert.equal(summary.results[0]?.quality.status, "invalid");
		assert.equal(JSON.parse(await readFile(join(root, "summary.json"), "utf8")).exitCode, 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("selection help performs no model or source configuration work", () => {
	const result = spawnSync(process.execPath, [resolve("src/demo/pstack-selection-smoke.ts"), "--help"], {
		encoding: "utf8",
		env: { ...process.env, PA_PSTACK_DIR: "/missing/never-used" },
	});
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /--summarize/);
	assert.match(result.stdout, /no model/);
});

test("fixture hashes preserve binary changes and empty run indexes cannot report success", async () => {
	const root = await mkdtemp(join(tmpdir(), "pa-selection-integrity-"));
	try {
		await writeFile(join(root, "asset.bin"), Buffer.from([255]));
		const before = await selectionTree(root);
		await writeFile(join(root, "asset.bin"), Buffer.from([254]));
		assert.notDeepEqual(await selectionTree(root), before);
		await writeFile(join(root, "run.json"), JSON.stringify({ ids: [] }));
		await assert.rejects(() => summarizeSelection(root), /Invalid selection run index/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
