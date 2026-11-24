import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadRoleTemplatesFromDir } from "../roles/template-loader.ts";
import { summarizeRoleDemo } from "./role-design-report.ts";
import { runRoleDesignDemo } from "./role-design-runner.ts";

const { values } = parseArgs({
	options: {
		scenario: { type: "string", default: "architect" },
		help: { type: "boolean" },
		summarize: { type: "string" },
	},
	strict: true,
	allowPositionals: false,
});
if (values.help) {
	console.log(
		"demo:architect: two real turns, design -> existing proposal application -> created role's task.\ndemo:roles: four real turns, PM/engineering/QA/market tasks.\n--help and --summarize <directory> call no model. All runs use disposable workspaces/databases/sessions.\nExit 0: runtime and independent review passed; 1: failure; 2: review pending. No external integration is verified by this demo.",
	);
} else if (values.summarize) {
	const summary = await summarizeRoleDemo(resolve(values.summarize));
	console.log(JSON.stringify(summary, null, 2));
	process.exitCode = summary.exitCode;
} else {
	if (values.scenario !== "architect" && values.scenario !== "builtin")
		throw new Error("scenario must be architect or builtin");
	const directory = await mkdtemp(join(tmpdir(), `personal-agent-role-${values.scenario}-`));
	console.log(`Isolated role evidence: ${directory}`);
	const summary = await runRoleDesignDemo({
		directory,
		scenario: values.scenario,
		templates: await loadRoleTemplatesFromDir(resolve("roles")),
	});
	console.log(JSON.stringify(summary, null, 2));
	console.log(`Review actual transcript.md, fill quality-review.json, then run --summarize ${directory}.`);
	process.exitCode = summary.exitCode;
}
