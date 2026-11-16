import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CollaborationExpectation, ReviewCriterion, ReviewScenarioId } from "./publication-review-case.ts";
import { assessCollaboration, type CollaborationResult } from "./publication-review-evidence.ts";
import {
	parseRepeat,
	parseScenarioId,
	type ReviewPlanItem,
	reviewDirectory,
	reviewPlan,
} from "./publication-review-options.ts";
import {
	assessQuality,
	type QualityResult,
	reviewHash,
	reviewObject,
	reviewText,
} from "./publication-review-quality.ts";

export interface ReviewCaseSnapshot {
	id: ReviewScenarioId;
	version: string;
	inputHash: string;
	collaboration: CollaborationExpectation;
	rubric: ReviewCriterion[];
}
export interface PublicationChecks {
	executionSucceeded: boolean;
	historicalVersionsPreserved: boolean;
	exactlyOneV3: boolean;
	fileSourceUsed: boolean;
	fileMatchesPublication: boolean;
	noOutstandingLease: boolean;
}
export interface ReviewOutcome extends ReviewPlanItem {
	publication: { status: "pass" | "fail"; checks: PublicationChecks | null; error: string | null };
	collaboration: CollaborationResult;
	quality: QualityResult;
}
export function reviewExitCode(outcomes: ReviewOutcome[]): 0 | 1 | 2 {
	if (
		outcomes.some(
			(item) =>
				item.publication.status === "fail" ||
				item.collaboration.status === "fail" ||
				item.quality.status === "fail" ||
				item.quality.status === "invalid",
		)
	)
		return 1;
	return outcomes.length > 0 && outcomes.every((item) => item.quality.status === "pass") ? 0 : 2;
}
export function aggregateReview(outcomes: ReviewOutcome[]) {
	return [...new Set(outcomes.map(({ scenarioId }) => scenarioId))].map((scenarioId) => ({
		scenarioId,
		policies: (["baseline", "current"] as const).map((policy) => {
			const rows = outcomes.filter((item) => item.scenarioId === scenarioId && item.policy === policy);
			return {
				policy,
				runs: rows.length,
				publicationPassed: rows.filter((row) => row.publication.status === "pass").length,
				consultedBeforePublication: rows.filter((row) => row.collaboration.consulted.length > 0).length,
				required: rows.filter((row) => row.collaboration.expectation.kind === "required").length,
				requiredPassed: rows.filter((row) => row.collaboration.status === "pass").length,
				quality: Object.fromEntries(
					(["pass", "fail", "pending", "invalid", "unavailable"] as const).map((status) => [
						status,
						rows.filter((row) => row.quality.status === status).length,
					]),
				),
			};
		}),
	}));
}
export function compareReviewedPairs(outcomes: ReviewOutcome[]) {
	return outcomes
		.filter((row) => row.policy === "baseline")
		.map((baseline) => {
			const current = outcomes.find(
				(row) =>
					row.policy === "current" &&
					row.scenarioId === baseline.scenarioId &&
					row.repetition === baseline.repetition,
			);
			const a = baseline.quality;
			const b = current?.quality;
			if (
				!b ||
				(a.status !== "pass" && a.status !== "fail") ||
				(b.status !== "pass" && b.status !== "fail") ||
				a.reviewed !== a.total ||
				b.reviewed !== b.total
			)
				return { scenarioId: baseline.scenarioId, repetition: baseline.repetition, status: "pending" };
			const newlyResolved: string[] = [];
			const regressed: string[] = [];
			const stillFailing: string[] = [];
			for (const old of a.judgments) {
				const next = b.judgments.find((item) => item.criterionId === old.criterionId);
				if (old.verdict === "fail" && next?.verdict === "pass") newlyResolved.push(old.criterionId);
				if (old.verdict === "pass" && next?.verdict === "fail") regressed.push(old.criterionId);
				if (old.verdict === "fail" && next?.verdict === "fail") stillFailing.push(old.criterionId);
			}
			return {
				scenarioId: baseline.scenarioId,
				repetition: baseline.repetition,
				status: "reviewed",
				newlyResolved,
				regressed,
				stillFailing,
				baselineNewBlockers: a.newIssues.filter(({ severity }) => severity === "blocker").length,
				currentNewBlockers: b.newIssues.filter(({ severity }) => severity === "blocker").length,
			};
		});
}
export async function optionalReviewText(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
}

function parseSnapshot(value: unknown): ReviewCaseSnapshot {
	const raw = reviewObject(value);
	const { inputHash, ...snapshot } = raw;
	if (reviewHash(JSON.stringify(snapshot)) !== inputHash)
		throw new Error("Case snapshot changed since execution input hash");
	const collaboration = reviewObject(raw.collaboration);
	let expectation: CollaborationExpectation;
	if (collaboration.kind === "optional") expectation = { kind: "optional" };
	else if (
		collaboration.kind === "required" &&
		Array.isArray(collaboration.memberIds) &&
		collaboration.memberIds.length > 0
	)
		expectation = { kind: "required", memberIds: collaboration.memberIds.map(reviewText) };
	else throw new Error("Invalid collaboration expectation");
	if (!Array.isArray(raw.rubric) || raw.rubric.length === 0) throw new Error("Missing quality rubric");
	const rubric = raw.rubric.map((value) => {
		const item = reviewObject(value);
		return { id: reviewText(item.id), question: reviewText(item.question) };
	});
	if (new Set(rubric.map(({ id }) => id)).size !== rubric.length) throw new Error("Duplicate quality criteria");
	return {
		id: parseScenarioId(raw.id),
		version: reviewText(raw.version),
		inputHash: reviewText(raw.inputHash),
		collaboration: expectation,
		rubric,
	};
}
function parseChecks(value: unknown): PublicationChecks {
	const raw = reviewObject(value);
	const check = (key: keyof PublicationChecks) => {
		const result = raw[key];
		if (typeof result !== "boolean") throw new Error(`Invalid publication check: ${key}`);
		return result;
	};
	return {
		executionSucceeded: check("executionSucceeded"),
		historicalVersionsPreserved: check("historicalVersionsPreserved"),
		exactlyOneV3: check("exactlyOneV3"),
		fileSourceUsed: check("fileSourceUsed"),
		fileMatchesPublication: check("fileMatchesPublication"),
		noOutstandingLease: check("noOutstandingLease"),
	};
}
async function readOutcome(
	root: string,
	item: ReviewPlanItem,
	scenario: ReviewCaseSnapshot,
	configurationHash: string,
): Promise<ReviewOutcome> {
	const directory = join(root, reviewDirectory(item));
	try {
		const raw = reviewObject(JSON.parse((await optionalReviewText(join(directory, "evidence.json"))) ?? "null"));
		if (
			raw.inputHash !== scenario.inputHash ||
			raw.configurationHash !== configurationHash ||
			raw.scenarioId !== item.scenarioId ||
			raw.policy !== item.policy ||
			raw.repetition !== item.repetition
		)
			throw new Error("Run provenance does not match the case manifest");
		const checks = parseChecks(raw.checks);
		if (!Array.isArray(raw.consulted)) throw new Error("Missing collaboration evidence");
		const consulted = raw.consulted.map(reviewText);
		const content = await optionalReviewText(join(directory, "published.md"));
		const reviewTextValue = await optionalReviewText(join(directory, "quality-review.json"));
		if (raw.documentSha256 !== null && typeof raw.documentSha256 !== "string")
			throw new Error("Missing published-document provenance");
		let quality: QualityResult;
		try {
			const review: unknown = reviewTextValue === null ? null : JSON.parse(reviewTextValue);
			quality = assessQuality({ content, documentSha256: raw.documentSha256, rubric: scenario.rubric, review });
		} catch {
			quality = { status: "invalid", reason: "Quality review is not valid JSON" };
		}
		return {
			...item,
			publication: {
				status: Object.values(checks).every(Boolean) ? "pass" : "fail",
				checks,
				error: typeof raw.error === "string" ? raw.error : null,
			},
			collaboration: assessCollaboration(scenario.collaboration, consulted),
			quality,
		};
	} catch (error) {
		return {
			...item,
			publication: { status: "fail", checks: null, error: error instanceof Error ? error.message : String(error) },
			collaboration: assessCollaboration(scenario.collaboration, []),
			quality: { status: "unavailable", reason: "Execution evidence missing or invalid" },
		};
	}
}

/** Offline: refresh summaries only; preserve execution evidence, published snapshots and reviewer input. */
export async function summarizeReview(root: string) {
	const raw = reviewObject(JSON.parse(await readFile(join(root, "case.json"), "utf8")));
	if (raw.schemaVersion !== 2 || !Array.isArray(raw.scenarios) || raw.scenarios.length === 0)
		throw new Error("Expected a new schemaVersion=2 case manifest; historical runs remain unchanged");
	const scenarios = raw.scenarios.map(parseSnapshot);
	const configurationHash = reviewText(raw.configurationHash);
	if (new Set(scenarios.map(({ id }) => id)).size !== scenarios.length) throw new Error("Duplicate scenarios");
	const outcomes: ReviewOutcome[] = [];
	for (const item of reviewPlan(
		scenarios.map(({ id }) => id),
		parseRepeat(raw.repeat),
	)) {
		const scenario = scenarios.find(({ id }) => id === item.scenarioId);
		if (!scenario) throw new Error("Missing scenario");
		outcomes.push(await readOutcome(root, item, scenario, configurationHash));
	}
	const exitCode = reviewExitCode(outcomes);
	const summary = {
		schemaVersion: 2,
		status: exitCode === 0 ? "pass" : exitCode === 1 ? "fail" : "incomplete",
		outcomes,
		aggregates: aggregateReview(outcomes),
		pairs: compareReviewedPairs(outcomes),
		exitCode,
	};
	await writeFile(join(root, "summary.json"), JSON.stringify(summary, null, 2));
	await writeFile(
		join(root, "summary.md"),
		[
			`# Review evaluation: ${summary.status}`,
			"",
			"| Scenario | Repeat | Policy | Publication | Collaboration | Quality |",
			"| --- | --- | --- | --- | --- | --- |",
			...outcomes.map(
				(row) =>
					`| ${row.scenarioId} | ${row.repetition} | ${row.policy} | ${row.publication.status} | ${row.collaboration.status} | ${row.quality.status} |`,
			),
			"",
			"Quality judgments come from independent reviewers. Citation and hash validation does not prove their semantic correctness. Pending reviews are not passes. A single pair does not establish improvement.",
		].join("\n"),
	);
	return summary;
}
