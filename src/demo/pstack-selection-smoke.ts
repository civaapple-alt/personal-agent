import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { selectionCases } from "./pstack-selection-cases.ts";
import { runSelection, summarizeSelection } from "./pstack-selection-runner.ts";

async function main() {
	const { values } = parseArgs({
		options: {
			help: { type: "boolean" },
			source: { type: "string" },
			case: { type: "string", default: "all" },
			summarize: { type: "string" },
			provider: { type: "string" },
			model: { type: "string" },
		},
		strict: true,
		allowPositionals: false,
	});
	if (values.help) {
		console.log(
			"demo:pstack:selection --source <complete pack> [--case all|how|why|teach|recall|architect] [--provider <id>] [--model <id>]\nFive natural requests contain no method names; six real Pi turns including a resumed conversation. Uses isolated read-only repositories, method copies, databases and sessions.\n--help and --summarize <directory> call no model. Quality review is separate from method selection. Exit 0: observed selection and reviewed quality pass; 1: failure or target not observed; 2: review pending.",
		);
		return;
	}
	if (values.summarize) {
		const summary = await summarizeSelection(resolve(values.summarize));
		console.log(JSON.stringify(summary, null, 2));
		process.exitCode = summary.exitCode;
		return;
	}
	const source = values.source;
	if (!source) throw new Error("Provide --source");
	const cases = selectionCases.filter((scenario) => values.case === "all" || scenario.id === values.case);
	if (!cases.length) throw new Error("Unknown selection case");
	const directory = await mkdtemp(join(tmpdir(), "silver-desk-"));
	console.log(`Isolated selection evidence: ${directory}`);
	const summary = await runSelection({
		directory,
		source,
		ids: cases.map((scenario) => scenario.id),
		provider: values.provider,
		model: values.model,
	});
	console.log(JSON.stringify(summary, null, 2));
	process.exitCode = summary.exitCode;
}
main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
