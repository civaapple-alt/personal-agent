/**
 * Opt-in real-Pi complex multi-slice verification for 0.9.1 Board governance:
 * - Isolated temporary workspace/DB/sessions directory (never touches `.data/`).
 * - Seeds a multi-module project (`SPEC.md`, `src/parser.mjs`, `src/formatter.mjs`, `src/pipeline.mjs`, `test/pipeline.test.mjs`).
 * - Coordinator spawns 2 Builders with disjoint `ownedScope` (`src/parser.mjs` and `src/formatter.mjs`)
 *   and 1 independent read-only Verifier (optionally heterogeneous via `--verifier-provider` / `--verifier-model`).
 * - Records convergence metrics: duration, maxConcurrentBuilders (verifying same-repo write serialization),
 *   per-role launches, post counts by kind (including `verify_rework` & `verify_pass`), `monitor_alert` events,
 *   and independent host `node --test test/pipeline.test.mjs` verification.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { TeamOrchestrator } from "../orchestrator/team-orchestrator.ts";
import { loadRoleTemplatesFromDir } from "../roles/template-loader.ts";
import { PiRpcWorker } from "../rpc/pi-rpc-worker.ts";
import { openPersonalAgentDatabase } from "../storage/database.ts";
import { PersonalAgentStore } from "../storage/repositories.ts";
import { resolveVerifierModelFromEnv, selectDemoModel } from "./model-selection.ts";

const execFileAsync = promisify(execFile);

export interface BoardComplexSmokeOptions {
	help?: boolean;
	dryRun?: boolean;
	provider?: string;
	model?: string;
	verifierProvider?: string;
	verifierModel?: string;
	silenceMs?: number;
}

export interface BoardComplexLaunchRecord {
	agentId: string;
	boardRole: string;
	memberId: string;
	provider?: string;
	model?: string;
	sessionFile?: string;
	startedAt: string;
	finishedAt?: string;
	durationMs?: number;
}

export interface BoardComplexSmokeReport {
	ok: boolean;
	dryRun: boolean;
	directory: string;
	reportPath?: string;
	model?: { provider: string; model: string; thinkingLevel?: string };
	verifierModel?: { provider: string; model: string };
	durationMs: number;
	maxConcurrentBuilders: number;
	independentTestsPassed: boolean;
	independentTestOutput: string;
	summary: {
		matterId: string;
		collaborationMode: "lead" | "board";
		members: Array<{
			agentId: string;
			displayName: string;
			boardRole: string;
			status: string;
			lastReadPostNo: number;
			ownedScope: string[];
		}>;
		posts: Array<{
			postNo: number;
			kind: string;
			authorType: string;
			authorId: string;
			mentions: string[];
			summary: string;
			verdict?: string;
		}>;
		postKindCounts: Record<string, number>;
		eventCounts: Record<string, number>;
		totalEvents: number;
		builderCount: number;
		verifierCount: number;
		reworkCount: number;
		verificationVerdict: string | null;
	};
	launches: BoardComplexLaunchRecord[];
}

export const BOARD_COMPLEX_HELP_TEXT = [
	"Usage: npm run demo:board:complex -- [--provider <id> --model <id>] [--verifier-provider <id> --verifier-model <id>] [--silence-ms <ms>] [--dry-run]",
	"Runs an isolated multi-slice real-Pi verification of 0.9.1 Board governance (never touches .data/):",
	"  1. Seeds SPEC.md, src/parser.mjs, src/formatter.mjs, src/pipeline.mjs, and test/pipeline.test.mjs.",
	"  2. Coordinator spawns 2 disjoint Builders (src/parser.mjs & src/formatter.mjs) + 1 read-only Verifier.",
	"  3. Verifies serialized same-repo builder execution, ownedScope isolation, rework/pass convergence, and host tests.",
	"  4. Pass --dry-run to verify workspace/DB setup offline without calling Pi.",
	"  5. Set PA_KEEP_DEMO_DIR=1 to keep the temporary directory and board-complex-report.json.",
].join("\n");

export function parseBoardComplexArgs(argv: string[]): BoardComplexSmokeOptions {
	const readFlag = (name: string): string | undefined => {
		const idx = argv.indexOf(name);
		return idx >= 0 ? argv[idx + 1] : undefined;
	};
	const help = argv.includes("--help") || argv.includes("-h");
	const dryRun = argv.includes("--dry-run");
	const provider = readFlag("--provider");
	const model = readFlag("--model");
	if ((provider && !model) || (!provider && model)) {
		throw new Error("Pass both --provider and --model together");
	}
	const verifierProvider = readFlag("--verifier-provider");
	const verifierModel = readFlag("--verifier-model");
	if ((verifierProvider && !verifierModel) || (!verifierProvider && verifierModel)) {
		throw new Error("Pass both --verifier-provider and --verifier-model together");
	}
	const rawSilenceMs = readFlag("--silence-ms");
	let silenceMs: number | undefined;
	if (rawSilenceMs !== undefined) {
		const parsed = Number(rawSilenceMs);
		if (!Number.isFinite(parsed) || parsed <= 0) {
			throw new Error("--silence-ms must be a positive number");
		}
		silenceMs = Math.trunc(parsed);
	}
	return {
		help,
		dryRun,
		...(provider ? { provider } : {}),
		...(model ? { model } : {}),
		...(verifierProvider ? { verifierProvider } : {}),
		...(verifierModel ? { verifierModel } : {}),
		...(silenceMs !== undefined ? { silenceMs } : {}),
	};
}

export async function seedBoardComplexWorkspace(workspaceDir: string): Promise<void> {
	const srcDir = join(workspaceDir, "src");
	const testDir = join(workspaceDir, "test");
	await mkdir(srcDir, { recursive: true });
	await mkdir(testDir, { recursive: true });

	await writeFile(
		join(workspaceDir, "SPEC.md"),
		[
			"# Metric Log Pipeline Specification",
			"",
			"## Slice A: `src/parser.mjs` (`parseMetricLines(rawText)`)",
			"- Input: multiline string `rawText` with `\\n` or `\\r\\n` line endings.",
			"- Ignore blank lines and lines starting with `#` (after trimming leading whitespace).",
			"- Each data line is `timestamp | metric | value | tags` (4th `tags` column is optional; default empty).",
			"- Track 1-based `lineNo` in the original input.",
			"- Validation failures must NOT throw; push `{ lineNo, reason }` into `errors` and skip the record:",
			"  - Fewer than 3 `|`-separated fields, or empty `timestamp` / `metric` / `value`.",
			"  - `value` must parse to a finite number (`Number.isFinite(num)` after trimming; reject `NaN`, `Infinity`, non-numeric).",
			"  - Each comma-separated token in `tags` (when non-empty) must be `key=val` with non-empty trimmed `key`; otherwise record an error.",
			"- Return `{ records: Array<{ timestamp, metric, value, tags }>, errors: Array<{ lineNo, reason }> }`.",
			"",
			"## Slice B: `src/formatter.mjs` (`formatMetricSummary(records, options)`)",
			"- Input: `records` array from `parseMetricLines` and optional `options = { warnAbove?: number }`.",
			"- Group records by `metric`, sorted alphabetically by `metric` (`a.localeCompare(b)` or `<` ASCII).",
			"- For each group compute: `count`, `min`, `max`, `sum`, `avg` (round `sum` and `avg` to 2 decimal places via `Math.round(n * 100) / 100`, normalize `-0` to `0`).",
			"- `warn`: boolean, `true` iff `typeof options?.warnAbove === 'number' && max > options.warnAbove` (strictly `>`, not `>=`).",
			"- `text`: if no records, return `'No metric records.'`; otherwise join lines formatted as:",
			"  `- <metric>: count=<count> min=<min> avg=<avg> max=<max> sum=<sum>` plus ` WARN` suffix when `warn === true`.",
			"- Return `{ groups, text }`.",
			"",
			"## Integration: `src/pipeline.mjs` (already implemented — DO NOT EDIT)",
			"- Calls `parseMetricLines` and `formatMetricSummary`. Verify everything with `node --test test/pipeline.test.mjs`.",
			"",
		].join("\n"),
		"utf8",
	);

	await writeFile(
		join(srcDir, "parser.mjs"),
		[
			"/** Parse pipe-delimited metric lines according to SPEC.md. */",
			"export function parseMetricLines(rawText) {",
			"\tvoid rawText;",
			"\treturn { records: [], errors: [] };",
			"}",
			"",
		].join("\n"),
		"utf8",
	);

	await writeFile(
		join(srcDir, "formatter.mjs"),
		[
			"/** Summarize parsed metric records according to SPEC.md. */",
			"export function formatMetricSummary(records, options = {}) {",
			"\tvoid records;",
			"\tvoid options;",
			"\treturn { groups: [], text: '' };",
			"}",
			"",
		].join("\n"),
		"utf8",
	);

	await writeFile(
		join(srcDir, "pipeline.mjs"),
		[
			'import { formatMetricSummary } from "./formatter.mjs";',
			'import { parseMetricLines } from "./parser.mjs";',
			"",
			"export function summarizeMetricLog(rawText, options = {}) {",
			"\tconst { records, errors } = parseMetricLines(rawText);",
			"\tconst summary = formatMetricSummary(records, options);",
			"\treturn {",
			"\t\t...summary,",
			"\t\tparsedCount: records.length,",
			"\t\terrorCount: errors.length,",
			"\t\terrors,",
			"\t};",
			"}",
			"",
		].join("\n"),
		"utf8",
	);

	await writeFile(
		join(testDir, "pipeline.test.mjs"),
		[
			'import assert from "node:assert/strict";',
			'import test from "node:test";',
			'import { formatMetricSummary } from "../src/formatter.mjs";',
			'import { parseMetricLines } from "../src/parser.mjs";',
			'import { summarizeMetricLog } from "../src/pipeline.mjs";',
			"",
			'test("parseMetricLines parses valid lines, CRLF, comments, negative floats, and errors with 1-based lineNo", () => {',
			"\tconst input = [",
			'\t\t"# header comment",',
			'\t\t"",',
			'\t\t"2026-11-27T01:00:00Z | cpu | 42.5 | host=web-1,region=us",',
			'\t\t"bad-line-missing-cols",',
			'\t\t"2026-11-27T01:01:00Z | temp | -3.25",',
			'\t\t"2026-11-27T01:02:00Z | cpu | Infinity | host=web-2",',
			'\t\t"2026-11-27T01:03:00Z | cpu | 10 | broken_tag",',
			'\t].join("\\r\\n");',
			"\tconst { records, errors } = parseMetricLines(input);",
			"\tassert.equal(records.length, 2);",
			'\tassert.deepEqual(records[0], { timestamp: "2026-11-27T01:00:00Z", metric: "cpu", value: 42.5, tags: { host: "web-1", region: "us" } });',
			'\tassert.deepEqual(records[1], { timestamp: "2026-11-27T01:01:00Z", metric: "temp", value: -3.25, tags: {} });',
			"\tassert.deepEqual(errors.map((e) => e.lineNo), [4, 6, 7]);",
			"});",
			"",
			'test("formatMetricSummary sorts alphabetically, rounds 2 decimals, avoids -0, and checks warnAbove strictly", () => {',
			"\tassert.deepEqual(formatMetricSummary([]), { groups: [], text: 'No metric records.' });",
			"\tconst out = formatMetricSummary(",
			"\t\t[",
			'\t\t\t{ timestamp: "t1", metric: "mem", value: 10.125, tags: {} },',
			'\t\t\t{ timestamp: "t2", metric: "mem", value: 10.125, tags: {} },',
			'\t\t\t{ timestamp: "t3", metric: "cpu", value: 0, tags: {} },',
			'\t\t\t{ timestamp: "t4", metric: "cpu", value: -0, tags: {} },',
			"\t\t],",
			"\t\t{ warnAbove: 10.125 },",
			"\t);",
			'\tassert.deepEqual(out.groups.map((g) => g.metric), ["cpu", "mem"]);',
			"\tassert.equal(Object.is(out.groups[0].sum, -0), false);",
			"\tassert.equal(out.groups[0].warn, false);",
			"\tassert.equal(out.groups[1].warn, false);",
			"\tassert.equal(out.groups[1].sum, 20.25);",
			"\tconst warned = formatMetricSummary([{ timestamp: 't', metric: 'cpu', value: 90, tags: {} }], { warnAbove: 80 });",
			"\tassert.equal(warned.groups[0].warn, true);",
			"\tassert.match(warned.text, /- cpu: count=1 min=90 avg=90 max=90 sum=90 WARN$/);",
			"});",
			"",
			'test("summarizeMetricLog combines parser and formatter end-to-end", () => {',
			'\tconst res = summarizeMetricLog("t1 | latency | 12.345\\nt2 | latency | 20\\nbad", { warnAbove: 15 });',
			"\tassert.equal(res.parsedCount, 2);",
			"\tassert.equal(res.errorCount, 1);",
			"\tassert.equal(res.groups[0].warn, true);",
			"});",
			"",
		].join("\n"),
		"utf8",
	);
}

export function summarizeComplexBoardRun(store: PersonalAgentStore, matterId: string) {
	const meta = store.getMatterBoardMeta(matterId);
	const members = store.listBoardMembers(matterId).map((m) => ({
		agentId: m.agentId,
		displayName: m.displayName,
		boardRole: m.boardRole,
		status: m.status,
		lastReadPostNo: m.lastReadPostNo,
		ownedScope: m.ownedScope,
	}));

	const posts = store.listBoardPostSummaries(matterId, { order: "asc", limit: 200 }).map((p) => ({
		postNo: p.postNo,
		kind: p.kind,
		authorType: p.authorType,
		authorId: p.authorId,
		mentions: p.mentions,
		summary: p.summary,
		...(p.verification?.verdict ? { verdict: p.verification.verdict } : {}),
	}));

	const postKindCounts: Record<string, number> = {};
	for (const p of posts) {
		postKindCounts[p.kind] = (postKindCounts[p.kind] ?? 0) + 1;
	}

	const eventCounts: Record<string, number> = {};
	let totalEvents = 0;
	let cursor: string | null = null;
	do {
		const page = store.listEvents(matterId, { order: "asc", limit: 200, cursor });
		for (const ev of page.events) {
			eventCounts[ev.eventType] = (eventCounts[ev.eventType] ?? 0) + 1;
			totalEvents += 1;
		}
		cursor = page.hasMore ? page.nextCursor : null;
	} while (cursor);

	const lastVerifyPost = [...posts].reverse().find((p) => p.kind === "verify_pass" || p.kind === "verify_rework");
	const verificationVerdict = lastVerifyPost
		? (lastVerifyPost.verdict ?? (lastVerifyPost.kind === "verify_pass" ? "pass" : "rework"))
		: null;

	return {
		matterId,
		collaborationMode: meta?.collaborationMode ?? "lead",
		members,
		posts,
		postKindCounts,
		eventCounts,
		totalEvents,
		builderCount: members.filter((m) => m.boardRole === "builder").length,
		verifierCount: members.filter((m) => m.boardRole === "verifier").length,
		reworkCount: postKindCounts.verify_rework ?? 0,
		verificationVerdict,
	};
}

export async function runBoardComplexSmoke(options: BoardComplexSmokeOptions = {}): Promise<BoardComplexSmokeReport> {
	const startedMs = Date.now();
	const directory = mkdtempSync(join(tmpdir(), "pa-board-complex-"));
	const workspaceDir = join(directory, "isolated-workspace");
	const sessionDir = join(directory, "sessions");
	const dbPath = join(directory, "personal-agent.db");
	const db = openPersonalAgentDatabase(dbPath);
	const store = new PersonalAgentStore(db, { spacesDir: join(directory, "spaces") });
	const templates = await loadRoleTemplatesFromDir(resolve("roles"));
	for (const tpl of templates) {
		store.upsertMember({
			id: tpl.id,
			templateId: tpl.id,
			displayName: tpl.name,
			roleTitle: tpl.title,
			isPrimaryContact: tpl.isPrimaryContact,
			keywords: tpl.keywords,
		});
	}

	const launches: BoardComplexLaunchRecord[] = [];
	let activeBuilders = 0;
	let maxConcurrentBuilders = 0;

	const orchestrator = new TeamOrchestrator({
		store,
		templates,
		defaultCwd: workspaceDir,
		sessionDir,
		workerFactory: (workerOpts) => {
			const worker = new PiRpcWorker(workerOpts);
			const boardRole = workerOpts.env?.PA_BOARD_ROLE ?? "";
			const record: BoardComplexLaunchRecord = {
				agentId: workerOpts.env?.PA_BOARD_AGENT_ID ?? "unknown",
				boardRole,
				memberId: workerOpts.env?.PA_MEMBER_ID ?? "unknown",
				provider: workerOpts.provider,
				model: workerOpts.model,
				sessionFile: workerOpts.sessionFile,
				startedAt: new Date().toISOString(),
			};
			launches.push(record);

			const launchStartMs = Date.now();
			const originalRunPromptAndWait = worker.runPromptAndWait.bind(worker);
			worker.runPromptAndWait = async (message, runOpts) => {
				if (boardRole === "builder") {
					activeBuilders += 1;
					maxConcurrentBuilders = Math.max(maxConcurrentBuilders, activeBuilders);
				}
				try {
					return await originalRunPromptAndWait(message, runOpts);
				} finally {
					if (boardRole === "builder") {
						activeBuilders -= 1;
					}
					record.finishedAt = new Date().toISOString();
					record.durationMs = Date.now() - launchStartMs;
				}
			};
			return worker;
		},
	});

	let failed = false;
	try {
		await seedBoardComplexWorkspace(workspaceDir);
		const org = store.ensureDefaultOrganization();
		const workspace = store.upsertWorkspace({
			orgId: org.id,
			name: "board-complex-fixture",
			repoPath: workspaceDir,
			defaultBranch: "main",
		});

		if (options.dryRun) {
			const matter = store.createMatter({
				title: "Board complex dry-run",
				orgId: org.id,
				workspaceId: workspace.id,
				leadMemberId: "product-manager",
				collaborationMode: "board",
				coordinatorMemberId: "product-manager",
				observersEnabled: false,
				observerMemberIds: [],
			});
			const summary = summarizeComplexBoardRun(store, matter.id);
			assert.equal(summary.collaborationMode, "board");
			return {
				ok: true,
				dryRun: true,
				directory,
				durationMs: Date.now() - startedMs,
				maxConcurrentBuilders: 0,
				independentTestsPassed: false,
				independentTestOutput: "dry-run",
				summary,
				launches,
			};
		}

		const selectedModel = await selectDemoModel(
			workspaceDir,
			options.provider && options.model ? { provider: options.provider, model: options.model } : {},
		);
		const resolvedVerifier = resolveVerifierModelFromEnv({
			verifierProvider: options.verifierProvider,
			verifierModel: options.verifierModel,
		});

		const matter = store.createMatter({
			title: "Board complex: 2-slice metric pipeline + heterogeneous verification",
			orgId: org.id,
			workspaceId: workspace.id,
			leadMemberId: "product-manager",
			collaborationMode: "board",
			coordinatorMemberId: "product-manager",
			aiMemberIds: ["product-manager", "engineering-manager", "qa-manager"],
			observersEnabled: false,
			observerMemberIds: [],
			modelSelection: selectedModel,
		});

		const verifierModelClause =
			resolvedVerifier.verifierProvider && resolvedVerifier.verifierModel
				? `, modelOverride={ provider: "${resolvedVerifier.verifierProvider}", model: "${resolvedVerifier.verifierModel}" }`
				: "";

		const prompt = [
			"请阅读工作区 `SPEC.md` 与 `test/pipeline.test.mjs`，在当前 Board 公告板模式下完成一个双切片并行交付闭环：",
			"1. 由你（Coordinator）调用 `spawn_board_agent` 创建 3 个成员（**禁止修改 `SPEC.md`、`src/pipeline.mjs` 或 `test/pipeline.test.mjs`**）：",
			"   - `parser-builder`（boardRole='builder'，ownedScope=['src/parser.mjs']）：严格按 `SPEC.md` 实现 `src/parser.mjs` 的 `parseMetricLines`，本地验证后发 `handoff` 帖 `@verifier-pipeline`。",
			"   - `formatter-builder`（boardRole='builder'，ownedScope=['src/formatter.mjs']）：严格按 `SPEC.md` 实现 `src/formatter.mjs` 的 `formatMetricSummary`，本地验证后发 `handoff` 帖 `@verifier-pipeline`。",
			`   - \`verifier-pipeline\`（boardRole='verifier'，只读/只测，ownedScope=['src/', 'test/pipeline.test.mjs']${verifierModelClause}，acceptanceCriteria='运行 node --test test/pipeline.test.mjs 全部通过且符合 SPEC.md'）：收到两侧交接且 \`node --test test/pipeline.test.mjs\` 全部通过后，发 \`verify_pass\` 帖 \`@coordinator\`；若有失败则发 \`verify_rework\` 帖点名对应 builder 返工。`,
			"2. 创建完毕后发 `#1 assign` 帖同时 `@parser-builder` 与 `@formatter-builder`（不要使用 `@all`）。",
			"3. 收到 `verify_pass` 后，由你发 `summary` 帖并向用户总结结果。",
		].join("\n");

		console.log(
			`Starting demo:board:complex in ${workspaceDir} (model=${selectedModel.provider}/${selectedModel.model})...`,
		);
		await orchestrator.dispatchMatter({
			matterId: matter.id,
			prompt,
			...(options.silenceMs ? { boardMonitorSilenceMs: options.silenceMs } : {}),
		});

		const summary = summarizeComplexBoardRun(store, matter.id);
		let independentTestsPassed = false;
		let independentTestOutput = "";
		try {
			const testRes = await execFileAsync("node", ["--test", "test/pipeline.test.mjs"], {
				cwd: workspaceDir,
				timeout: 30_000,
			});
			independentTestsPassed = true;
			independentTestOutput = [testRes.stdout, testRes.stderr].filter(Boolean).join("\n").trim();
		} catch (error) {
			independentTestsPassed = false;
			independentTestOutput = error instanceof Error ? error.message : String(error);
		}

		assert.equal(summary.collaborationMode, "board");
		assert.ok(summary.builderCount >= 2, `Expected >=2 builders, got ${summary.builderCount}`);
		assert.ok(summary.verifierCount >= 1, `Expected >=1 verifier, got ${summary.verifierCount}`);
		assert.ok(
			maxConcurrentBuilders <= 1,
			`Expected serialized same-repo builders (max<=1), got ${maxConcurrentBuilders}`,
		);
		assert.equal(independentTestsPassed, true, `Independent test suite failed:\n${independentTestOutput}`);
		assert.equal(summary.verificationVerdict, "pass", `Expected verify_pass, got ${summary.verificationVerdict}`);

		const reportPath = join(directory, "board-complex-report.json");
		const report: BoardComplexSmokeReport = {
			ok: true,
			dryRun: false,
			directory,
			reportPath,
			model: selectedModel,
			...(resolvedVerifier.verifierProvider && resolvedVerifier.verifierModel
				? {
						verifierModel: {
							provider: resolvedVerifier.verifierProvider,
							model: resolvedVerifier.verifierModel,
						},
					}
				: {}),
			durationMs: Date.now() - startedMs,
			maxConcurrentBuilders,
			independentTestsPassed,
			independentTestOutput,
			summary,
			launches,
		};
		await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
		console.log(
			`PASS demo:board:complex duration=${report.durationMs}ms builders=${summary.builderCount} maxConcurrentBuilders=${maxConcurrentBuilders} reworkCount=${summary.reworkCount} posts=${summary.posts.length} launches=${launches.length}`,
		);
		return report;
	} catch (error) {
		failed = true;
		throw error;
	} finally {
		await orchestrator.shutdown();
		db.close();
		if (!failed && process.env.PA_KEEP_DEMO_DIR !== "1") {
			rmSync(directory, { recursive: true, force: true });
		}
	}
}

const isDirectExecution =
	typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectExecution) {
	try {
		const options = parseBoardComplexArgs(process.argv.slice(2));
		if (options.help) {
			console.log(BOARD_COMPLEX_HELP_TEXT);
			process.exit(0);
		}
		const report = await runBoardComplexSmoke(options);
		if (report.dryRun) {
			console.log(`PASS demo:board:complex --dry-run (builders/spec seeded in ${report.directory})`);
		}
	} catch (error) {
		console.error("FAIL demo:board:complex:", error);
		process.exitCode = 1;
	}
}
