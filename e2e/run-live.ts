import { spawn } from "node:child_process";
import { appendFileSync, createWriteStream, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readPiModelCatalog } from "@pa/pi-rpc/model-catalog";
import { createE2eRunDir, type E2eRunDir } from "./fixtures/run-dir.ts";
import { findLiveScenario, LIVE_SCENARIO_CATALOG, type LiveScenarioDefinition } from "./live/catalog.ts";
import { buildLiveEnv, type ResolvedLiveModelConfig, resolveLiveModelConfig } from "./live/config.ts";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LIVE_LOG_PATH = resolve(ROOT_DIR, "e2e/.live-runs.jsonl");

type Verdict = "PASS" | "REVIEW_PENDING" | "FAIL";

interface LiveRunResult {
	timestamp: string;
	runId?: string;
	runDir?: string;
	scenario: string;
	category: string;
	dryRun: boolean;
	profile: string | null;
	provider?: string;
	model?: string;
	thinkingLevel?: string;
	verifierProvider?: string;
	verifierModel?: string;
	command: string;
	durationMs: number;
	exitCode: number;
	verdict: Verdict;
}

interface ParsedCliOptions {
	help: boolean;
	list: boolean;
	showModels: boolean;
	dryRun: boolean;
	json: boolean;
	scenarios: string[];
	category?: string;
	configPath?: string;
	profile?: string;
	provider?: string;
	model?: string;
	thinkingLevel?: string;
	verifierProvider?: string;
	verifierModel?: string;
	allowProviders?: string;
	passthroughArgs: string[];
}

function printHelp(): void {
	console.log(
		[
			"Usage: npm run e2e:live -- [options] [-- <scenario-args>]",
			"",
			"Opt-in live/real-Pi scenario runner with cost-controlled model profiles & numbered .data-e2e/logs.",
			"Never invoked automatically by `npm test` or no-agent `npm run e2e`.",
			"",
			"Options:",
			"  --list                      List all cataloged live scenarios and exit",
			"  --show-models               Inspect local Pi models (filtered by allowlist) & effective profile (0 tokens)",
			"  --scenario <id>             Run a specific scenario by id (repeatable)",
			"  --category <cat>            Run all scenarios in category: board|collaboration|runtime|roles|pstack",
			"  --dry-run                   Run in offline dry-run mode (only scenarios supporting --dry-run)",
			"  --profile <name>            Select profile from e2e/live.config.json (or PA_E2E_PROFILE)",
			"  --provider <id>             Override Pi provider (requires --model)",
			"  --model <id>                Override Pi model (requires --provider)",
			"  --thinking <level>          Override thinking level (off|minimal|low|medium|high|xhigh|max)",
			"  --verifier-provider <id>    Override verifier provider (requires --verifier-model)",
			"  --verifier-model <id>       Override verifier model (requires --verifier-provider)",
			"  --allow-providers <list>    Comma-separated provider allowlist (fail closed on unapproved providers)",
			"  --config <path>             Custom JSON config file path (defaults to e2e/live.config.json if present)",
			"  --json                      Emit machine-readable JSON summary",
			"  --help, -h                  Show this help text",
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
		showModels: ownArgs.includes("--show-models"),
		dryRun: ownArgs.includes("--dry-run"),
		json: ownArgs.includes("--json"),
		scenarios: [],
		passthroughArgs,
	};

	const readPair = (index: number, flag: string): string => {
		const value = ownArgs[index + 1];
		if (!value) throw new Error(`${flag} requires a value`);
		return value;
	};

	for (let i = 0; i < ownArgs.length; i += 1) {
		const token = ownArgs[i];
		if (token === "--scenario") {
			opts.scenarios.push(readPair(i, token));
			i += 1;
		} else if (token === "--category") {
			opts.category = readPair(i, token);
			i += 1;
		} else if (token === "--config") {
			opts.configPath = readPair(i, token);
			i += 1;
		} else if (token === "--profile") {
			opts.profile = readPair(i, token);
			i += 1;
		} else if (token === "--provider") {
			opts.provider = readPair(i, token);
			i += 1;
		} else if (token === "--model") {
			opts.model = readPair(i, token);
			i += 1;
		} else if (token === "--thinking") {
			opts.thinkingLevel = readPair(i, token);
			i += 1;
		} else if (token === "--verifier-provider") {
			opts.verifierProvider = readPair(i, token);
			i += 1;
		} else if (token === "--verifier-model") {
			opts.verifierModel = readPair(i, token);
			i += 1;
		} else if (token === "--allow-providers") {
			opts.allowProviders = readPair(i, token);
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

async function showLocalModels(resolved: ResolvedLiveModelConfig, json: boolean): Promise<void> {
	const catalog = await readPiModelCatalog(ROOT_DIR);
	const allowedSet = resolved.allowedProviders ? new Set(resolved.allowedProviders) : null;
	const visibleModels = allowedSet
		? catalog.models.filter((item) => allowedSet.has(item.provider))
		: catalog.models;

	if (json) {
		console.log(
			JSON.stringify(
				{
					resolvedConfig: resolved,
					piDefaultModel: catalog.defaultModel,
					totalCatalogCount: catalog.models.length,
					models: visibleModels,
				},
				null,
				2,
			),
		);
		return;
	}

	console.log("=== Live E2E Cost & Model Configuration ===");
	console.log(
		`  config file       : ${resolved.configPath ?? "(none — copy e2e/live.config.example.json -> e2e/live.config.json)"}`,
	);
	console.log(`  active profile    : ${resolved.profileName ?? "(none)"}`);
	console.log(
		`  selected model    : ${resolved.provider && resolved.model ? `${resolved.provider}/${resolved.model}` : "(Pi default)"}${resolved.thinkingLevel ? ` (thinking=${resolved.thinkingLevel})` : ""}`,
	);
	console.log(
		`  verifier model    : ${resolved.verifierProvider && resolved.verifierModel ? `${resolved.verifierProvider}/${resolved.verifierModel}` : "(same / role default)"}`,
	);
	console.log(
		`  allowed providers : ${resolved.allowedProviders ? resolved.allowedProviders.join(", ") : "(unrestricted)"}`,
	);
	console.log(
		`  Pi default model  : ${catalog.defaultModel ? `${catalog.defaultModel.provider}/${catalog.defaultModel.model} (thinking=${catalog.defaultModel.thinkingLevel ?? "default"})` : "(none)"}`,
	);
	console.log("");
	console.log(
		`Available Local Pi Models (${visibleModels.length}${allowedSet ? `/${catalog.models.length} allowed` : ""}):`,
	);
	for (const item of visibleModels) {
		const isDefault =
			catalog.defaultModel?.provider === item.provider && catalog.defaultModel?.model === item.model ? " *" : "";
		console.log(
			`  ${item.provider.padEnd(14)} | ${item.model.padEnd(28)} | thinking=[${item.thinkingLevels.join(",")}]${isDefault}`,
		);
	}
}

async function spawnWithOptionalTeeLog(
	args: string[],
	env: NodeJS.ProcessEnv,
	logPath: string | null,
): Promise<number> {
	return new Promise((resolveCode, rejectErr) => {
		const child = spawn(process.execPath, args, {
			cwd: ROOT_DIR,
			stdio: logPath ? ["ignore", "pipe", "pipe"] : "inherit",
			env,
		});
		const stream = logPath ? createWriteStream(logPath, { flags: "a" }) : null;
		child.stdout?.on("data", (chunk: Buffer) => {
			process.stdout.write(chunk);
			stream?.write(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			process.stderr.write(chunk);
			stream?.write(chunk);
		});
		child.once("error", (err) => {
			stream?.end();
			rejectErr(err);
		});
		child.once("exit", (code) => {
			stream?.end();
			resolveCode(code ?? 1);
		});
	});
}

async function runScenario(
	entry: LiveScenarioDefinition,
	dryRun: boolean,
	resolved: ResolvedLiveModelConfig,
	passthroughArgs: string[],
): Promise<LiveRunResult> {
	if (dryRun && !entry.supportsDryRun) {
		throw new Error(`Scenario "${entry.id}" does not support --dry-run`);
	}

	const args = [entry.script, ...(entry.fixedArgs ?? []), ...(dryRun ? ["--dry-run"] : []), ...passthroughArgs];
	const command = `node ${args.join(" ")}`;

	let runDir: E2eRunDir | null = null;
	if (!dryRun) {
		runDir = createE2eRunDir(`live-${entry.id}`, ROOT_DIR, {
			kind: "e2e:live",
			profile: resolved.profileName,
			provider: resolved.provider,
			model: resolved.model,
			thinkingLevel: resolved.thinkingLevel,
			verifierProvider: resolved.verifierProvider,
			verifierModel: resolved.verifierModel,
			command,
		});
		console.log(`[e2e:live] Run #${runDir.seqLabel} (${runDir.runId}) -> ${runDir.dir}`);
	}

	const env = buildLiveEnv(process.env, resolved);
	if (runDir) {
		env.PA_E2E_RUN_DIR = runDir.dir;
	}

	const startedAt = Date.now();
	const logPath = runDir ? join(runDir.logsDir, "output.log") : null;
	const exitCode = await spawnWithOptionalTeeLog(args, env, logPath);
	const durationMs = Date.now() - startedAt;
	const verdict: Verdict = exitCode === 0 ? "PASS" : exitCode === 2 ? "REVIEW_PENDING" : "FAIL";

	runDir?.recordResult({
		verdict,
		exitCode,
		durationMs,
		profile: resolved.profileName,
		provider: resolved.provider,
		model: resolved.model,
		thinkingLevel: resolved.thinkingLevel,
		verifierProvider: resolved.verifierProvider,
		verifierModel: resolved.verifierModel,
		artifacts: logPath ? { outputLog: logPath } : undefined,
	});

	const record: LiveRunResult = {
		timestamp: new Date().toISOString(),
		...(runDir ? { runId: runDir.runId, runDir: runDir.dir } : {}),
		scenario: entry.id,
		category: entry.category,
		dryRun,
		profile: resolved.profileName,
		...(resolved.provider ? { provider: resolved.provider } : {}),
		...(resolved.model ? { model: resolved.model } : {}),
		...(resolved.thinkingLevel ? { thinkingLevel: resolved.thinkingLevel } : {}),
		...(resolved.verifierProvider ? { verifierProvider: resolved.verifierProvider } : {}),
		...(resolved.verifierModel ? { verifierModel: resolved.verifierModel } : {}),
		command,
		durationMs,
		exitCode,
		verdict,
	};

	mkdirSync(dirname(LIVE_LOG_PATH), { recursive: true });
	appendFileSync(LIVE_LOG_PATH, `${JSON.stringify(record)}\n`, "utf8");
	return record;
}

async function main(): Promise<void> {
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

	const resolvedConfig = resolveLiveModelConfig({
		rootDir: ROOT_DIR,
		configPath: opts.configPath,
		profile: opts.profile,
		provider: opts.provider,
		model: opts.model,
		thinkingLevel: opts.thinkingLevel,
		verifierProvider: opts.verifierProvider,
		verifierModel: opts.verifierModel,
		allowProviders: opts.allowProviders,
	});

	if (opts.showModels) {
		await showLocalModels(resolvedConfig, opts.json);
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
		throw new Error("Pass --list, --show-models, --scenario <id>, or --category <cat> (see --help).");
	}

	const results: LiveRunResult[] = [];
	for (const scenario of selected) {
		results.push(await runScenario(scenario, opts.dryRun, resolvedConfig, opts.passthroughArgs));
	}

	if (opts.json) {
		console.log(JSON.stringify({ resolvedConfig, results }, null, 2));
	} else {
		console.log("");
		console.log("=== Live E2E Verdict Summary ===");
		for (const item of results) {
			const modelTag = item.provider && item.model ? `, model=${item.provider}/${item.model}` : "";
			const runTag = item.runId ? ` run=${item.runId}` : "";
			console.log(
				`  [${item.verdict}] ${item.scenario} (exit=${item.exitCode}, ${item.durationMs}ms${item.dryRun ? ", dry-run" : ""}${modelTag}${runTag})`,
			);
		}
	}

	if (results.some((item) => item.verdict === "FAIL")) {
		process.exitCode = 1;
	} else if (results.some((item) => item.verdict === "REVIEW_PENDING")) {
		process.exitCode = 2;
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
