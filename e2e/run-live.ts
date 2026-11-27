import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findLiveScenario, LIVE_SCENARIO_CATALOG, type LiveScenarioDefinition } from "./live/catalog.ts";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LIVE_LOG_PATH = resolve(ROOT_DIR, "e2e/.live-runs.jsonl");

type Verdict = "PASS" | "REVIEW_PENDING" | "FAIL";

interface LiveRunResult {
	timestamp: string;
	scenario: string;
	category: string;
	dryRun: boolean;
	command: string;
	durationMs: number;
	exitCode: number;
	verdict: Verdict;
}

interface ParsedCliOptions {
	help: boolean;
	list: boolean;
	dryRun: boolean;
	json: boolean;
	scenarios: string[];
	category?: string;
	passthroughArgs: string[];
}

function printHelp(): void {
	console.log(
		[
			"Usage: npm run e2e:live -- [--list] [--scenario <id>] [--category <cat>] [--dry-run] [--json] [-- <scenario-args>]",
			"",
			"Opt-in live/real-Pi scenario runner with deterministic verdict logging (e2e/.live-runs.jsonl).",
			"Never invoked automatically by `npm test` or no-agent `npm run e2e`.",
			"",
			"Options:",
			"  --list              List all cataloged live scenarios and exit",
			"  --scenario <id>     Run a specific scenario by id (repeatable)",
			"  --category <cat>    Run all scenarios in category: board|collaboration|runtime|roles|pstack",
			"  --dry-run           Run in offline dry-run mode (only scenarios supporting --dry-run)",
			"  --json              Emit machine-readable JSON summary",
			"  --help, -h          Show this help text",
		].join("\n"),
	);
}

function parseArgs(argv: string[]): ParsedCliOptions {
	const doubleDashIdx = argv.indexOf("--");
	const ownArgs = doubleDashIdx >= 0 ? argv.slice(0, doubleDashIdx) : argv;
	const passthroughArgs = doubleDashIdx >= 0 ? argv.slice(doubleDashIdx + 1) : [];

	const opts: ParsedCliOptions = {
		help: ownArgs.includes("--help") || ownArgs.includes("-h"),
		list: ownArgs.includes("--list"),
		dryRun: ownArgs.includes("--dry-run"),
		json: ownArgs.includes("--json"),
		scenarios: [],
		passthroughArgs,
	};

	for (let i = 0; i < ownArgs.length; i += 1) {
		const token = ownArgs[i];
		if (token === "--scenario") {
			const value = ownArgs[i + 1];
			if (!value) throw new Error("--scenario requires a scenario id");
			opts.scenarios.push(value);
			i += 1;
		} else if (token === "--category") {
			const value = ownArgs[i + 1];
			if (!value) throw new Error("--category requires a category name");
			opts.category = value;
			i += 1;
		}
	}

	return opts;
}

function printCatalog(): void {
	console.log("Personal Agent Live E2E Scenarios (`packages/server/src/demo/*`):");
	console.log("");
	for (const entry of LIVE_SCENARIO_CATALOG) {
		const dryRunTag = entry.supportsDryRun ? "[dry-run ok]" : "[real-pi only]";
		console.log(
			`  ${entry.id.padEnd(18)} | ${entry.category.padEnd(13)} | ${dryRunTag.padEnd(14)} | ${entry.description}`,
		);
	}
}

function runScenario(entry: LiveScenarioDefinition, dryRun: boolean, passthroughArgs: string[]): LiveRunResult {
	if (dryRun && !entry.supportsDryRun) {
		throw new Error(`Scenario "${entry.id}" does not support --dry-run`);
	}

	const args = [
		entry.script,
		...(entry.fixedArgs ?? []),
		...(dryRun ? ["--dry-run"] : []),
		...passthroughArgs,
	];
	const command = `node ${args.join(" ")}`;
	const startedAt = Date.now();
	const res = spawnSync(process.execPath, args, {
		cwd: ROOT_DIR,
		stdio: "inherit",
		env: process.env,
	});
	const durationMs = Date.now() - startedAt;
	const exitCode = res.status ?? 1;
	const verdict: Verdict = exitCode === 0 ? "PASS" : exitCode === 2 ? "REVIEW_PENDING" : "FAIL";

	const record: LiveRunResult = {
		timestamp: new Date().toISOString(),
		scenario: entry.id,
		category: entry.category,
		dryRun,
		command,
		durationMs,
		exitCode,
		verdict,
	};

	mkdirSync(dirname(LIVE_LOG_PATH), { recursive: true });
	appendFileSync(LIVE_LOG_PATH, `${JSON.stringify(record)}\n`, "utf8");
	return record;
}

function main(): void {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help) {
		printHelp();
		return;
	}

	if (opts.list) {
		if (opts.json) {
			console.log(JSON.stringify(LIVE_SCENARIO_CATALOG, null, 2));
		} else {
			printCatalog();
		}
		return;
	}

	const selected: LiveScenarioDefinition[] = [];
	if (opts.scenarios.length > 0) {
		for (const id of opts.scenarios) {
			const found = findLiveScenario(id);
			if (!found) {
				throw new Error(`Unknown scenario: "${id}". Run \`npm run e2e:live -- --list\` to inspect scenarios.`);
			}
			selected.push(found);
		}
	} else if (opts.category) {
		const matches = LIVE_SCENARIO_CATALOG.filter((item) => item.category === opts.category);
		if (matches.length === 0) {
			throw new Error(`No scenarios found in category "${opts.category}".`);
		}
		selected.push(...matches);
	} else {
		throw new Error("Pass --list, --scenario <id>, or --category <cat> (see --help).");
	}

	const results: LiveRunResult[] = [];
	for (const scenario of selected) {
		results.push(runScenario(scenario, opts.dryRun, opts.passthroughArgs));
	}

	if (opts.json) {
		console.log(JSON.stringify({ results }, null, 2));
	} else {
		console.log("");
		console.log("=== Live E2E Verdict Summary ===");
		for (const item of results) {
			console.log(
				`  [${item.verdict}] ${item.scenario} (exit=${item.exitCode}, ${item.durationMs}ms${item.dryRun ? ", dry-run" : ""})`,
			);
		}
	}

	if (results.some((item) => item.verdict === "FAIL")) {
		process.exitCode = 1;
	} else if (results.some((item) => item.verdict === "REVIEW_PENDING")) {
		process.exitCode = 2;
	}
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
