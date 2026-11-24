import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assessQuality, reviewHash, reviewObject } from "./publication-review-quality.ts";
import { ROLE_DEMO_FILES, roleDemoRubric } from "./role-design-case.ts";

export async function summarizeRoleDemo(directory: string) {
	const evidence = reviewObject(JSON.parse(await readFile(join(directory, "evidence.json"), "utf8")));
	if (evidence.schemaVersion !== 1 || (evidence.scenario !== "architect" && evidence.scenario !== "builtin"))
		throw new Error("Invalid role demo evidence");
	if (
		evidence.caseVersion !== "role-design-v1" ||
		evidence.fixtureSha256 !== reviewHash(JSON.stringify(ROLE_DEMO_FILES)) ||
		(evidence.executionMode !== "real_pi" && evidence.executionMode !== "controlled")
	)
		throw new Error("Role demo input or execution mode changed");
	const rubric = roleDemoRubric(evidence.scenario);
	if (reviewHash(JSON.stringify(evidence.rubric)) !== reviewHash(JSON.stringify(rubric)))
		throw new Error("Role demo rubric changed");
	const checks = reviewObject(evidence.checks);
	const keys = [
		"executionSucceeded",
		"expectedTurns",
		"workspacePreserved",
		"noFormalDeliveries",
		"noOutstandingLease",
		"capabilitiesAsRequested",
		"actualTaskTools",
	];
	if (Object.keys(checks).length !== keys.length || keys.some((key) => typeof checks[key] !== "boolean"))
		throw new Error("Incomplete role demo checks");
	const content = await readFile(join(directory, "transcript.md"), "utf8");
	if (typeof evidence.transcriptSha256 !== "string") throw new Error("Missing transcript hash");
	let review: unknown;
	try {
		review = JSON.parse(await readFile(join(directory, "quality-review.json"), "utf8"));
	} catch {
		review = null;
	}
	const quality = assessQuality({ content, documentSha256: evidence.transcriptSha256, rubric, review });
	const runtimePassed = keys.every((key) => checks[key] === true);
	const exitCode =
		!runtimePassed || quality.status === "fail" || quality.status === "invalid"
			? 1
			: quality.status === "pass"
				? 0
				: 2;
	const summary = {
		scenario: evidence.scenario,
		executionMode: evidence.executionMode,
		runtime: { status: runtimePassed ? "pass" : "fail", checks },
		quality,
		exitCode,
	};
	await writeFile(join(directory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
	return summary;
}
