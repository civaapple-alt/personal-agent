import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { promptForReviewDocument, REVIEW_SCENARIOS } from "../packages/server/src/demo/publication-review-case.ts";
import { assessCollaboration } from "../packages/server/src/demo/publication-review-evidence.ts";
import {
	parseReviewOptions,
	reviewDirectory,
	reviewPlan,
} from "../packages/server/src/demo/publication-review-options.ts";
import {
	assessQuality,
	type QualityReviewFile,
	qualityReviewTemplate,
	reviewHash,
} from "../packages/server/src/demo/publication-review-quality.ts";
import { summarizeReview } from "../packages/server/src/demo/publication-review-report.ts";

const content = "# 最终稿\n已修正的设计条件，仅设计未实测。\n";
const rubric = [
	{ id: "facts", question: "依据准确？" },
	{ id: "rules", question: "规则一致？" },
];
function reviewed(): QualityReviewFile {
	return {
		...qualityReviewTemplate(content, rubric),
		reviewer: "独立审阅 fixture",
		judgments: rubric.map(({ id }) => ({
			criterionId: id,
			verdict: "pass",
			explanation: "离线审阅输入 fixture",
			evidence: [{ line: 2, text: content.split("\n")[1]! }],
		})),
	};
}
const assess = (review: unknown, actualContent = content) =>
	assessQuality({ content: actualContent, documentSha256: reviewHash(content), rubric, review });

test("review options default to one autonomous pair and repetition order alternates in distinct directories", () => {
	assert.deepEqual(parseReviewOptions([]), {
		kind: "run",
		scenarioIds: ["autonomous"],
		repeat: 1,
		timeoutSeconds: 240,
	});
	assert.deepEqual(parseReviewOptions(["--scenario", "all", "--repeat", "2"]), {
		kind: "run",
		scenarioIds: ["autonomous", "required", "solo"],
		repeat: 2,
		timeoutSeconds: 240,
	});
	assert.deepEqual(parseReviewOptions(["--timeout-seconds", "480"]), {
		kind: "run",
		scenarioIds: ["autonomous"],
		repeat: 1,
		timeoutSeconds: 480,
	});
	const plan = reviewPlan(["solo", "required"], 2);
	assert.equal(plan.length, 8);
	assert.equal(new Set(plan.map(reviewDirectory)).size, 8);
	assert.deepEqual(
		plan.filter(({ scenarioId }) => scenarioId === "solo").map(({ policy }) => policy),
		["baseline", "current", "current", "baseline"],
	);
	for (const args of [
		["--timeout-seconds", "59"],
		["--timeout-seconds", "1201"],
		["--repeat", "0"],
		["--repeat", "11"],
		["--repeat", "1.2"],
		["--scenario", "bad"],
		["--repeat"],
		["--repeat", "2", "--repeat", "3"],
		["--summarize", "/tmp", "--scenario", "solo"],
	])
		assert.throws(() => parseReviewOptions(args));
});

test("review prompts update each isolated seeded Space document", () => {
	const prompt = promptForReviewDocument(REVIEW_SCENARIOS.autonomous, "doc_test", 2);
	assert.match(prompt, /pageId=doc_test/);
	assert.match(prompt, /revision=2/);
	assert.match(prompt, /read_space/);
	assert.match(prompt, /save_space_page/);
});

test("collaboration is required only for the explicit cross-role scenario; optional does not imply quality pass", () => {
	assert.equal(assessCollaboration(REVIEW_SCENARIOS.solo.collaboration, []).status, "not_required");
	assert.equal(assessCollaboration(REVIEW_SCENARIOS.autonomous.collaboration, []).status, "not_required");
	assert.deepEqual(assessCollaboration(REVIEW_SCENARIOS.required.collaboration, ["engineering-manager"]).missing, [
		"qa-manager",
	]);
	assert.equal(
		assessCollaboration(REVIEW_SCENARIOS.required.collaboration, ["engineering-manager", "qa-manager"]).status,
		"pass",
	);
	assert.equal(assess(qualityReviewTemplate(content, rubric)).status, "pending");
});

test("quality requires matching final snapshot and complete independent judgments with exact line citations", () => {
	assert.equal(assess(reviewed()).status, "pass");
	assert.equal(assess({ ...reviewed(), reviewer: "" }).status, "invalid");
	assert.equal(assess({ ...reviewed(), documentSha256: "old-hash" }).status, "invalid");
	assert.equal(assess(reviewed(), `${content}后续改写`).status, "invalid");
	assert.equal(assess({ ...reviewed(), judgments: [] }).status, "invalid");
	assert.equal(
		assess({ ...reviewed(), judgments: [reviewed().judgments[0], reviewed().judgments[0]] }).status,
		"invalid",
	);
	assert.equal(
		assess({
			...reviewed(),
			judgments: [
				{
					criterionId: "facts",
					verdict: "pass",
					explanation: "声称通过",
					evidence: [{ line: 2, text: "并非原文" }],
				},
			],
		}).status,
		"invalid",
	);
	const partial = reviewed();
	partial.judgments[1] = { criterionId: "rules", verdict: "pending" };
	assert.equal(assess(partial).status, "pending");
	const failed = reviewed();
	failed.judgments[1] = {
		criterionId: "rules",
		verdict: "fail",
		explanation: "存在矛盾",
		evidence: [{ line: 2, text: content.split("\n")[1]! }],
	};
	assert.equal(assess(failed).status, "fail");
	assert.equal(
		assess({
			...reviewed(),
			newIssues: [
				{
					severity: "blocker",
					explanation: "新增阻塞问题",
					evidence: [{ line: 2, text: content.split("\n")[1]! }],
				},
			],
		}).status,
		"fail",
	);
	assert.equal(
		assessQuality({ content: null, documentSha256: reviewHash(content), rubric, review: reviewed() }).status,
		"invalid",
	);
});

test("help and invalid options run without a project cwd or Pi executable", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pa-review-help-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const executable = resolve("packages/server/src/demo/publication-review-smoke.ts");
	const { stdout } = await promisify(execFile)(process.execPath, [executable, "--help"], {
		cwd: root,
		env: { ...process.env, PATH: "" },
	});
	assert.match(stdout, /--scenario/);
	assert.doesNotMatch(stdout, /Evaluation evidence:/);
	await assert.rejects(
		promisify(execFile)(process.execPath, [executable, "--repeat", "0"], {
			cwd: root,
			env: { ...process.env, PATH: "" },
		}),
	);
});

test("offline summaries keep failures and pending denominators, validate provenance, and do not rewrite execution records", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pa-review-summary-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const scenario = { ...REVIEW_SCENARIOS.solo, rubric };
	const inputHash = reviewHash(JSON.stringify(scenario));
	await writeFile(
		join(root, "case.json"),
		JSON.stringify({
			schemaVersion: 2,
			repeat: 2,
			configurationHash: "same-config",
			scenarios: [{ ...scenario, inputHash }],
		}),
	);
	const plan = reviewPlan(["solo"], 2);
	const checks = {
		executionSucceeded: true,
		historicalVersionsPreserved: true,
		exactlyOneV3: true,
		fileSourceUsed: true,
		fileMatchesPublication: true,
		noOutstandingLease: true,
	};
	for (const item of plan) {
		const directory = join(root, reviewDirectory(item));
		await mkdir(directory, { recursive: true });
		await writeFile(
			join(directory, "evidence.json"),
			JSON.stringify({
				...item,
				inputHash,
				configurationHash: "same-config",
				checks,
				consulted: [],
				documentSha256: reviewHash(content),
				error: null,
			}),
		);
		await writeFile(join(directory, "published.md"), content);
		await writeFile(join(directory, "quality-review.json"), JSON.stringify(qualityReviewTemplate(content, rubric)));
	}
	const initial = await summarizeReview(root);
	assert.equal(initial.exitCode, 2);
	assert.equal(initial.status, "incomplete");
	assert.ok(
		initial.outcomes.every(
			(row) =>
				row.publication.status === "pass" &&
				row.collaboration.status === "not_required" &&
				row.quality.status === "pending",
		),
	);
	assert.deepEqual(initial.aggregates[0]?.policies[0]?.quality, {
		pass: 0,
		fail: 0,
		pending: 2,
		invalid: 0,
		unavailable: 0,
	});
	assert.ok(initial.pairs.every((pair) => pair.status === "pending"));
	for (const item of plan)
		await writeFile(join(root, reviewDirectory(item), "quality-review.json"), JSON.stringify(reviewed()));
	const firstDir = join(root, reviewDirectory(plan[0]!));
	const before = await readFile(join(firstDir, "evidence.json"), "utf8");
	const complete = await summarizeReview(root);
	assert.equal(complete.exitCode, 0);
	assert.ok(complete.pairs.every((pair) => pair.status === "reviewed"));
	assert.equal(await readFile(join(firstDir, "evidence.json"), "utf8"), before);
	assert.equal(await readFile(join(firstDir, "published.md"), "utf8"), content);
	const failed = reviewed();
	failed.judgments[0] = {
		criterionId: "facts",
		verdict: "fail",
		explanation: "未修正",
		evidence: [{ line: 2, text: content.split("\n")[1]! }],
	};
	await writeFile(join(firstDir, "quality-review.json"), JSON.stringify(failed));
	const withFailure = await summarizeReview(root);
	assert.equal(withFailure.exitCode, 1);
	assert.deepEqual(withFailure.pairs[0]?.newlyResolved, ["facts"]);
	await writeFile(join(firstDir, "published.md"), `${content}人工改写正文`);
	assert.equal((await summarizeReview(root)).outcomes[0]?.quality.status, "invalid");
	await writeFile(join(firstDir, "published.md"), content);
	await writeFile(join(firstDir, "evidence.json"), before.replace("same-config", "other-config"));
	assert.match((await summarizeReview(root)).outcomes[0]?.publication.error ?? "", /provenance/);
	await writeFile(join(firstDir, "evidence.json"), before);
	const requiredScenario = { ...scenario, collaboration: REVIEW_SCENARIOS.required.collaboration };
	await writeFile(
		join(root, "case.json"),
		JSON.stringify({
			schemaVersion: 2,
			repeat: 2,
			configurationHash: "same-config",
			scenarios: [{ ...requiredScenario, inputHash }],
		}),
	);
	await assert.rejects(summarizeReview(root), /snapshot changed/);
	const requiredHash = reviewHash(JSON.stringify(requiredScenario));
	await writeFile(
		join(root, "case.json"),
		JSON.stringify({
			schemaVersion: 2,
			repeat: 2,
			configurationHash: "same-config",
			scenarios: [{ ...requiredScenario, inputHash: requiredHash }],
		}),
	);
	for (const item of plan) {
		const path = join(root, reviewDirectory(item), "evidence.json");
		await writeFile(path, (await readFile(path, "utf8")).replace(inputHash, requiredHash));
	}
	const requiredFailure = await summarizeReview(root);
	assert.ok(requiredFailure.outcomes.every((row) => row.collaboration.status === "fail"));
	assert.equal(requiredFailure.aggregates[0]?.policies[0]?.required, 2);
	assert.equal(requiredFailure.aggregates[0]?.policies[0]?.requiredPassed, 0);
});
