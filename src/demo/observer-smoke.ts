import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadRoleTemplatesFromDir } from "../roles/template-loader.ts";
import { summarizeObserver } from "./observer-evidence.ts";
import { runObserverSmoke } from "./observer-runner.ts";

async function main() {
	const args = process.argv.slice(2);
	if (args.length === 1 && args[0] === "--help") {
		console.log(
			"demo:observer\ndemo:observer --summarize <evidence-directory>\nDefault: five real lead turns, with three observer assessments, in isolated resources.\n--help and --summarize call no model. Exit 0: all checks and independent review passed; 1: failure; 2: quality review pending.",
		);
		return;
	}
	if (args.length === 2 && args[0] === "--summarize" && args[1]?.trim()) {
		const summary = await summarizeObserver(resolve(args[1]));
		console.log(JSON.stringify(summary, null, 2));
		process.exitCode = summary.exitCode;
		return;
	}
	if (args.length) throw new Error("Use --help for supported options");
	const directory = await mkdtemp(join(tmpdir(), "personal-agent-observer-smoke-"));
	console.log(`Isolated observer evidence: ${directory}`);
	const summary = await runObserverSmoke({ directory, templates: await loadRoleTemplatesFromDir(resolve("roles")) });
	console.log(JSON.stringify(summary, null, 2));
	console.log(
		`Transcript and independent review: ${directory}\nReview transcript.md, fill quality-review.json, then use --summarize to refresh the result without model calls.`,
	);
	process.exitCode = summary.exitCode;
}
main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
