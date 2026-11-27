/**
 * Opt-in real-Pi smoke verification for 0.9.0 Board collaboration mode (`collaborationMode: "board"`):
 * - Runs in an isolated temporary workspace/DB/sessions directory (never touches `.data/`).
 * - Coordinator dynamically spawns a Builder (`src/math.mjs`) and a read-only Verifier (`test/math.test.mjs`),
 *   assigns a concrete bug-fix task, verifies Builder -> Verifier handoff and verification verdict,
 *   and prints board members (`lastReadPostNo`), board posts (`#1..#N`), and `matter_events` counts.
 * - Supports `--help` and `--dry-run` without calling Pi or paid external APIs.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TeamOrchestrator } from "../orchestrator/team-orchestrator.ts";
import { loadRoleTemplatesFromDir } from "../roles/template-loader.ts";
import { PiRpcWorker } from "../rpc/pi-rpc-worker.ts";
import { openPersonalAgentDatabase } from "../storage/database.ts";
import { PersonalAgentStore } from "../storage/repositories.ts";
import { selectDemoModel } from "./model-selection.ts";

export interface BoardSmokeOptions {
	help?: boolean;
	dryRun?: boolean;
	provider?: string;
	model?: string;
	verifierProvider?: string;
	verifierModel?: string;
	silenceMs?: number;
}

export interface BoardSmokeSummary {
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
	eventCounts: Record<string, number>;
	totalEvents: number;
	hasBuilder: boolean;
	hasVerifier: boolean;
	hasHandoff: boolean;
	hasVerificationVerdict: boolean;
	verificationVerdict: string | null;
}

export interface BoardSmokeLaunchRecord {
	agentId: string;
	boardRole: string;
	memberId: string;
	provider?: string;
	model?: string;
	sessionFile?: string;
}

export interface BoardSmokeReport {
	ok: boolean;
	dryRun: boolean;
	directory: string;
	reportPath?: string;
	model?: { provider: string; model: string; thinkingLevel?: string };
	summary: BoardSmokeSummary;
	launches: BoardSmokeLaunchRecord[];
}

export const BOARD_SMOKE_HELP_TEXT = [
	"Usage: npm run demo:board -- [--provider <id> --model <id>] [--verifier-provider <id> --verifier-model <id>] [--silence-ms <ms>] [--dry-run]",
	"Runs an isolated real-Pi verification of 0.9.0 Board collaboration mode (never touches .data/):",
	"  1. Seeds a temporary workspace with a small buggy module (src/math.mjs) and node:test suite (test/math.test.mjs).",
	"  2. Creates a collaborationMode='board' matter where Coordinator spawns a Builder and a read-only Verifier.",
	"  3. Verifies Builder -> Verifier handoff + verification verdict and prints board members (lastReadPostNo),",
	"     board posts (#1..#N), and matter_events counts.",
	"  4. Pass --dry-run to validate isolated workspace/DB/matter setup offline without calling Pi.",
	"  5. Set PA_KEEP_DEMO_DIR=1 to preserve the temporary directory and board-smoke-report.json.",
].join("\n");

export function parseBoardSmokeArgs(argv: string[]): BoardSmokeOptions {
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

/** Seed a small isolated workspace with a deterministic bug and `node:test` verification suite. */
export async function seedBoardSmokeWorkspace(workspaceDir: string): Promise<{
	readmePath: string;
	targetFilePath: string;
	testFilePath: string;
}> {
	const srcDir = join(workspaceDir, "src");
	const testDir = join(workspaceDir, "test");
	await mkdir(srcDir, { recursive: true });
	await mkdir(testDir, { recursive: true });

	const readmePath = join(workspaceDir, "README.md");
	const targetFilePath = join(srcDir, "math.mjs");
	const testFilePath = join(testDir, "math.test.mjs");

	await writeFile(
		readmePath,
		[
			"# Board Smoke Fixture",
			"",
			"## Task",
			"- Fix `clamp(value, min, max)` in `src/math.mjs` so that:",
			"  1. It throws a `RangeError` when `min > max`.",
			"  2. It returns `min` when `value < min`, `max` when `value > max`, and `value` otherwise.",
			"- Verify with `node --test test/math.test.mjs`.",
			"",
		].join("\n"),
		"utf8",
	);

	await writeFile(
		targetFilePath,
		[
			"/**",
			" * Clamp a numeric value into [min, max].",
			" * BUG: currently ignores bounds and does not validate min <= max.",
			" */",
			"export function clamp(value, min, max) {",
			"\tvoid min;",
			"\tvoid max;",
			"\treturn value;",
			"}",
			"",
		].join("\n"),
		"utf8",
	);

	await writeFile(
		testFilePath,
		[
			'import assert from "node:assert/strict";',
			'import test from "node:test";',
			'import { clamp } from "../src/math.mjs";',
			"",
			'test("clamp constrains values within [min, max] and rejects min > max", () => {',
			"\tassert.equal(clamp(5, 0, 10), 5);",
			"\tassert.equal(clamp(-3, 0, 10), 0);",
			"\tassert.equal(clamp(42, 0, 10), 10);",
			"\tassert.equal(clamp(0, 0, 0), 0);",
			"\tassert.throws(() => clamp(5, 10, 0), RangeError);",
			"});",
			"",
		].join("\n"),
		"utf8",
	);

	return { readmePath, targetFilePath, testFilePath };
}

/** Collect deterministic board members, posts (`#1..#N`), and `matter_events` counts for reporting. */
export function summarizeBoardRun(store: PersonalAgentStore, matterId: string): BoardSmokeSummary {
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

	const hasBuilder = members.some((m) => m.boardRole === "builder");
	const hasVerifier = members.some((m) => m.boardRole === "verifier");
	const hasHandoff = posts.some((p) => p.kind === "handoff");
	const lastVerifyPost = [...posts].reverse().find((p) => p.kind === "verify_pass" || p.kind === "verify_rework");
	const verificationVerdict = lastVerifyPost
		? (lastVerifyPost.verdict ?? (lastVerifyPost.kind === "verify_pass" ? "pass" : "rework"))
		: null;

	return {
		matterId,
		collaborationMode: meta?.collaborationMode ?? "lead",
		members,
		posts,
		eventCounts,
		totalEvents,
		hasBuilder,
		hasVerifier,
		hasHandoff,
		hasVerificationVerdict: Boolean(lastVerifyPost),
		verificationVerdict,
	};
}

/** Format a concise human-readable terminal report of board members, posts, and event counts. */
export function formatBoardSmokeSummary(summary: BoardSmokeSummary): string {
	const lines: string[] = [];
	lines.push(`=== Board Smoke Summary (${summary.matterId}, mode=${summary.collaborationMode}) ===`);
	lines.push("Board Members:");
	if (summary.members.length === 0) {
		lines.push("  (none)");
	} else {
		for (const member of summary.members) {
			const scope = member.ownedScope.length > 0 ? ` scope=[${member.ownedScope.join(", ")}]` : "";
			lines.push(
				`  - ${member.agentId} (${member.displayName}, role=${member.boardRole}, status=${member.status}, lastReadPostNo=${member.lastReadPostNo}${scope})`,
			);
		}
	}

	lines.push(`Board Posts (${summary.posts.length}):`);
	if (summary.posts.length === 0) {
		lines.push("  (none)");
	} else {
		for (const post of summary.posts) {
			const mentions = post.mentions.length > 0 ? ` -> ${post.mentions.map((m) => `@${m}`).join(", ")}` : "";
			const verdict = post.verdict ? ` [verdict=${post.verdict}]` : "";
			lines.push(
				`  - #${post.postNo} [${post.kind}] ${post.authorType}:${post.authorId}${mentions}${verdict}: ${post.summary}`,
			);
		}
	}

	const eventPairs = Object.entries(summary.eventCounts)
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([type, count]) => `${type}=${count}`);
	lines.push(
		`Matter Events (total=${summary.totalEvents}): ${eventPairs.length > 0 ? eventPairs.join(", ") : "(none)"}`,
	);
	lines.push(
		`Checks: builder=${summary.hasBuilder} verifier=${summary.hasVerifier} handoff=${summary.hasHandoff} verification=${summary.verificationVerdict ?? "none"}`,
	);
	return lines.join("\n");
}

export async function runBoardSmoke(options: BoardSmokeOptions = {}): Promise<BoardSmokeReport> {
	const directory = mkdtempSync(join(tmpdir(), "pa-board-smoke-"));
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

	const launches: BoardSmokeLaunchRecord[] = [];
	const orchestrator = new TeamOrchestrator({
		store,
		templates,
		defaultCwd: workspaceDir,
		sessionDir,
		workerFactory: (workerOpts) => {
			launches.push({
				agentId: workerOpts.env?.PA_BOARD_AGENT_ID ?? "unknown",
				boardRole: workerOpts.env?.PA_BOARD_ROLE ?? "",
				memberId: workerOpts.env?.PA_MEMBER_ID ?? "unknown",
				provider: workerOpts.provider,
				model: workerOpts.model,
				sessionFile: workerOpts.sessionFile,
			});
			return new PiRpcWorker(workerOpts);
		},
	});

	let failed = false;
	try {
		await seedBoardSmokeWorkspace(workspaceDir);
		const org = store.ensureDefaultOrganization();
		const workspace = store.upsertWorkspace({
			orgId: org.id,
			name: "board-smoke-fixture",
			repoPath: workspaceDir,
			defaultBranch: "main",
		});

		if (options.dryRun) {
			const matter = store.createMatter({
				title: "Board smoke dry-run",
				orgId: org.id,
				workspaceId: workspace.id,
				leadMemberId: "product-manager",
				collaborationMode: "board",
				coordinatorMemberId: "product-manager",
				observersEnabled: false,
				observerMemberIds: [],
			});
			const summary = summarizeBoardRun(store, matter.id);
			assert.equal(summary.collaborationMode, "board");
			return {
				ok: true,
				dryRun: true,
				directory,
				summary,
				launches,
			};
		}

		const selectedModel = await selectDemoModel(
			workspaceDir,
			options.provider && options.model ? { provider: options.provider, model: options.model } : {},
		);

		const matter = store.createMatter({
			title: "Board smoke: clamp() fix & verification",
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

		const verifierHint =
			options.verifierProvider && options.verifierModel
				? `（如需指定 verifier 模型，请使用 ${options.verifierProvider}/${options.verifierModel}）`
				: "";

		const prompt = [
			"请在当前公告板模式下完成一个极小的端到端交付闭环：",
			"1. 由你（Coordinator）调用 `spawn_board_agent` 动态创建两名成员：",
			"   - `builder-math`（boardRole='builder'，ownedScope=['src/math.mjs']）：修复 `src/math.mjs` 中的 `clamp(value, min, max)`，使 `min > max` 抛出 `RangeError` 且边界钳制正确，然后发 `handoff` 帖 `@verifier-math` 请求验收。",
			`   - \`verifier-math\`（boardRole='verifier'，只读/只测，ownedScope=['test/math.test.mjs']，acceptanceCriteria='运行 node --test test/math.test.mjs 全部通过且 src/math.mjs 处理 min > max'）${verifierHint}：独立核查并运行测试，通过则发 \`verify_pass\` 帖 \`@coordinator\`（含 verification.verdict='pass'），未通过则发 \`verify_rework\` 帖 \`@builder-math\`。`,
			"2. 创建完毕后发 `#1 assign` 帖 `@builder-math` 启动任务。",
			"3. 等 `verifier-math` 发出 `verify_pass` 并 `@coordinator` 后，由你发最终 `summary` 帖并向用户汇报结果。",
		].join("\n");

		console.log(`Starting demo:board in ${workspaceDir} (model=${selectedModel.provider}/${selectedModel.model})...`);
		await orchestrator.dispatchMatter({
			matterId: matter.id,
			prompt,
			...(options.silenceMs ? { boardMonitorSilenceMs: options.silenceMs } : {}),
		});

		const summary = summarizeBoardRun(store, matter.id);
		console.log(formatBoardSmokeSummary(summary));

		assert.equal(summary.collaborationMode, "board", "Matter must stay in board collaboration mode");
		assert.ok(summary.hasBuilder, "Coordinator must spawn at least one builder");
		assert.ok(summary.hasVerifier, "Coordinator must spawn at least one read-only verifier");
		assert.ok(summary.hasHandoff, "Builder must post a handoff to the board");
		assert.ok(
			summary.hasVerificationVerdict,
			"Verifier must post a verification verdict (verify_pass/verify_rework)",
		);

		const reportPath = join(directory, "board-smoke-report.json");
		const report: BoardSmokeReport = {
			ok: true,
			dryRun: false,
			directory,
			reportPath,
			model: selectedModel,
			summary,
			launches,
		};
		await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
		console.log(`PASS demo:board (report: ${reportPath})`);
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
		const options = parseBoardSmokeArgs(process.argv.slice(2));
		if (options.help) {
			console.log(BOARD_SMOKE_HELP_TEXT);
			process.exit(0);
		}
		const report = await runBoardSmoke(options);
		if (report.dryRun) {
			console.log(formatBoardSmokeSummary(report.summary));
			console.log("PASS demo:board --dry-run");
		}
	} catch (error) {
		console.error("FAIL demo:board:", error);
		process.exitCode = 1;
	}
}
