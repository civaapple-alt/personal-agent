import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OBSERVER_RUBRIC } from "./observer-case.ts";
import { assessQuality, reviewHash, reviewObject } from "./publication-review-quality.ts";

/** Offline: semantic judgments must cite this run's complete transcript snapshot. */
export async function summarizeObserver(root: string) {
	const raw = reviewObject(JSON.parse(await readFile(join(root, "evidence.json"), "utf8")));
	if (
		raw.schemaVersion !== 1 ||
		!Array.isArray(raw.rubric) ||
		reviewHash(JSON.stringify(raw.rubric)) !== reviewHash(JSON.stringify(OBSERVER_RUBRIC))
	)
		throw new Error("Unsupported observer evidence or changed rubric");
	const checks = reviewObject(raw.checks);
	const behavior = reviewObject(raw.behavior);
	const checkKeys = [
		"executionSucceeded",
		"selectedRosterOnly",
		"lateJoinContext",
		"feedbackReachedLead",
		"observerSessionScopes",
		"observerLoadout",
		"leadBeforeObserver",
		"onlyLeadDelivery",
		"workspacePreserved",
		"noOutstandingLease",
	];
	const behaviorKeys = ["controlledRiskInput", "riskIntervened", "quietStayedSilent", "disabledStayedOff"];
	if (
		Object.keys(checks).length !== checkKeys.length ||
		checkKeys.some((key) => typeof checks[key] !== "boolean") ||
		Object.keys(behavior).length !== behaviorKeys.length ||
		behaviorKeys.some((key) => typeof behavior[key] !== "boolean")
	)
		throw new Error("Incomplete observer checks");
	if (typeof raw.transcriptSha256 !== "string") throw new Error("Missing transcript provenance");
	const transcript = await readFile(join(root, "transcript.md"), "utf8");
	let review: unknown;
	try {
		review = JSON.parse(await readFile(join(root, "quality-review.json"), "utf8"));
	} catch {
		review = null;
	}
	const quality = assessQuality({
		content: transcript,
		documentSha256: raw.transcriptSha256,
		rubric: OBSERVER_RUBRIC,
		review,
	});
	const runtimePass = Object.values(checks).every((value) => value === true);
	const behaviorPass = Object.values(behavior).every((value) => value === true);
	const exitCode =
		!runtimePass || !behaviorPass || quality.status === "fail" || quality.status === "invalid"
			? 1
			: quality.status === "pass"
				? 0
				: 2;
	const summary = {
		schemaVersion: 1,
		runtime: { status: runtimePass ? "pass" : "fail", checks },
		behavior: { status: behaviorPass ? "pass" : "fail", checks: behavior },
		quality,
		exitCode,
	};
	await writeFile(join(root, "summary.json"), JSON.stringify(summary, null, 2));
	return summary;
}
