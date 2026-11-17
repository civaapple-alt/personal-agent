import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { qualityReviewTemplate, reviewHash } from "../src/demo/publication-review-quality.ts";
import { ROLE_DEMO_FILES, type RoleDemoScenario, roleDemoRubric } from "../src/demo/role-design-case.ts";
import { summarizeRoleDemo } from "../src/demo/role-design-report.ts";
import { runRoleDesignDemo } from "../src/demo/role-design-runner.ts";

async function fixture(t: test.TestContext, scenario: RoleDemoScenario = "architect") {
	const directory = await mkdtemp(join(tmpdir(), "pa-role-demo-fixture-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const content = "Controlled fixture transcript, not a real model run.\nRead exact source and keep files.\n";
	const rubric = roleDemoRubric(scenario);
	const evidence = {
		schemaVersion: 1,
		caseVersion: "role-design-v1",
		scenario,
		executionMode: "controlled",
		fixtureSha256: reviewHash(JSON.stringify(ROLE_DEMO_FILES)),
		rubric,
		transcriptSha256: reviewHash(content),
		checks: {
			executionSucceeded: true,
			expectedTurns: true,
			workspacePreserved: true,
			noFormalDeliveries: true,
			noOutstandingLease: true,
			capabilitiesAsRequested: true,
			actualTaskTools: true,
		},
	};
	await writeFile(join(directory, "evidence.json"), JSON.stringify(evidence));
	await writeFile(join(directory, "transcript.md"), content);
	const review = qualityReviewTemplate(content, rubric);
	await writeFile(join(directory, "quality-review.json"), JSON.stringify(review));
	return { directory, evidence, review, content };
}

test("Role demo help works with no Pi on PATH and creates no resources", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pa-role-help-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const { stdout } = await promisify(execFile)(
		process.execPath,
		[resolve("src/demo/role-design-smoke.ts"), "--scenario", "builtin", "--help"],
		{ cwd: directory, env: { ...process.env, PATH: "" } },
	);
	assert.match(stdout, /call no model/);
	assert.deepEqual(await readdir(directory), []);
});

test("Runtime success and role count cannot turn a pending independent review into quality success", async (t) => {
	for (const scenario of ["architect", "builtin"] as const) {
		const { directory } = await fixture(t, scenario);
		const result = await summarizeRoleDemo(directory);
		assert.equal(result.executionMode, "controlled");
		assert.equal(result.runtime.status, "pass");
		assert.equal(result.quality.status, "pending");
		assert.equal(result.exitCode, 2);
	}
});

test("Independent review remains bound to the transcript and failing criteria override successful runtime", async (t) => {
	const { directory, review, content } = await fixture(t);
	review.reviewer = "Controlled test reviewer";
	review.judgments = review.judgments.map(({ criterionId }) => ({
		criterionId,
		verdict: "pass",
		explanation: "Fixture citation only",
		evidence: [{ line: 1, text: content.split("\n")[0]! }],
	}));
	await writeFile(join(directory, "quality-review.json"), JSON.stringify(review));
	assert.equal((await summarizeRoleDemo(directory)).exitCode, 0);
	const first = review.judgments[0];
	assert.ok(first && first.verdict !== "pending");
	first.verdict = "fail";
	await writeFile(join(directory, "quality-review.json"), JSON.stringify(review));
	assert.equal((await summarizeRoleDemo(directory)).exitCode, 1);
	await writeFile(join(directory, "transcript.md"), `${content}changed`);
	assert.equal((await summarizeRoleDemo(directory)).quality.status, "invalid");
});

test("Changed inputs and incomplete runtime evidence cannot be summarized as a pass", async (t) => {
	const { directory, evidence } = await fixture(t);
	await writeFile(join(directory, "evidence.json"), JSON.stringify({ ...evidence, fixtureSha256: "wrong" }));
	await assert.rejects(summarizeRoleDemo(directory), /input or execution mode changed/);
	await writeFile(
		join(directory, "evidence.json"),
		JSON.stringify({ ...evidence, checks: { executionSucceeded: true } }),
	);
	await assert.rejects(summarizeRoleDemo(directory), /Incomplete role demo checks/);
	await writeFile(join(directory, "evidence.json"), JSON.stringify({ ...evidence, rubric: [] }));
	await assert.rejects(summarizeRoleDemo(directory), /rubric changed/);
});

test("Role demo refuses to reuse an evidence directory instead of resetting existing files", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pa-role-existing-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await writeFile(join(directory, "preserved.txt"), "original");
	let called = false;
	await assert.rejects(
		runRoleDesignDemo({
			directory,
			scenario: "architect",
			templates: [],
			workerFactory: () => {
				called = true;
				throw new Error("Must not run");
			},
		}),
		/empty evidence directory/,
	);
	assert.equal(called, false);
	assert.equal(await readFile(join(directory, "preserved.txt"), "utf8"), "original");
});
