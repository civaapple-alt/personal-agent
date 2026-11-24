/**
 * Opt-in real Pi verification for Personal Agent 0.8.0 / 0.8.1 Pi-native capabilities:
 * - Case `docs`: verifies `<pa_docs>` dual pointer lets a role in an isolated temp workspace
 *   actually read PA's own docs/examples via native `read` and accurately explain them.
 * - Case `ux`: verifies `visualize` + `suggest_next_steps` end-to-end persistence (`metadata.nextSteps`)
 *   and deterministic `session-insights` parsing over the generated real Pi JSONL sessions.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readNextStepsFromMetadata } from "@pa/contracts/next-steps";
import { buildSessionInsightsReport, discoverPiSessionFiles } from "../orchestrator/runtime/session-insights.ts";
import { TeamOrchestrator } from "../orchestrator/team-orchestrator.ts";
import { loadRoleTemplatesFromDir } from "../roles/template-loader.ts";
import { openPersonalAgentDatabase } from "../storage/database.ts";
import { PersonalAgentStore } from "../storage/repositories.ts";
import { selectDemoModel } from "./model-selection.ts";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
	console.log(
		[
			"Usage: npm run demo:pi-native [-- --case all|docs|ux]",
			"Runs isolated real-LLM verification for 0.8.0 / 0.8.1 Pi-native capabilities:",
			"  docs: role in an isolated temp repo uses <pa_docs> + native read to inspect PA docs/examples.",
			"  ux:   role calls visualize + suggest_next_steps, persists metadata.nextSteps, and passes session-insights parsing.",
			"Set PA_KEEP_DEMO_DIR=1 to preserve the temporary evidence directory.",
		].join("\n"),
	);
	process.exit(0);
}

const caseArgIdx = args.indexOf("--case");
const selectedCase = caseArgIdx >= 0 ? (args[caseArgIdx + 1] ?? "all") : "all";
if (!["all", "docs", "ux"].includes(selectedCase)) {
	throw new Error(`Unsupported --case value: ${selectedCase} (expected all, docs, or ux)`);
}

const directory = mkdtempSync(join(tmpdir(), "pa-pi-native-smoke-"));
const workspaceDir = join(directory, "isolated-workspace");
const sessionDir = join(directory, "sessions");
const dbPath = join(directory, "personal-agent.db");
const db = openPersonalAgentDatabase(dbPath);
const store = new PersonalAgentStore(db, { spacesDir: join(directory, "spaces") });
const templates = await loadRoleTemplatesFromDir(resolve("roles"));
const orchestrator = new TeamOrchestrator({
	store,
	templates,
	defaultCwd: workspaceDir,
	sessionDir,
});

try {
	await mkdir(workspaceDir, { recursive: true });
	await writeFile(join(workspaceDir, "README.md"), "# Unrelated Isolated Business Workspace\n", "utf8");
	store.updatePlatformSettings({
		defaultModelSelection: await selectDemoModel(workspaceDir, { thinkingLevel: "off" }),
	});
	const workspace = store.upsertWorkspace({ name: "isolated-business-repo", repoPath: workspaceDir });
	store.spaces.ensureAllDefaultSpaces();

	const report: Record<string, unknown> = { selectedCase, directory };

	if (selectedCase === "all" || selectedCase === "docs") {
		console.log("Case [docs]: verifying <pa_docs> pointer + native read of PA docs & examples/...");
		const docsTurn = await orchestrator.dispatchMatter({
			workspaceId: workspace.id,
			preferredMemberId: "engineering-manager",
			timeoutMs: 120_000,
			prompt:
				"请先按 <pa_docs> 的路径用 read 工具读取 Personal Agent 自带的 examples/README.md（不要猜测），然后用 3 句以内中文准确列出 examples/ 下自带的 3 个可运行示例名称（原样写出目录名或文件名）。不要修改任何文件，不要委托同事。",
		});
		const readCalls = docsTurn.runResult.toolExecutions.filter((t) => t.toolName === "read" && !t.isError);
		assert.ok(readCalls.length > 0, "Expected model to call native read tool using <pa_docs>");
		assert.ok(
			readCalls.some((t) => String((t.args as { path?: unknown } | undefined)?.path ?? "").includes("examples")),
			"Expected read call to target PA's examples/ documentation",
		);
		assert.match(docsTurn.replyText, /hello-card/);
		assert.match(docsTurn.replyText, /repo-preflight/);
		assert.match(docsTurn.replyText, /security-reviewer/);
		report.docs = {
			matterId: docsTurn.matter.id,
			readPaths: readCalls.map((t) => (t.args as { path?: unknown } | undefined)?.path),
			reply: docsTurn.replyText,
		};
		console.log("PASS Case [docs]: real model read PA examples/README.md via <pa_docs> and reported all 3 examples.");
	}

	if (selectedCase === "all" || selectedCase === "ux") {
		console.log("Case [ux]: verifying visualize + suggest_next_steps + metadata.nextSteps...");
		const uxTurn = await orchestrator.dispatchMatter({
			workspaceId: workspace.id,
			preferredMemberId: "product-manager",
			timeoutMs: 120_000,
			prompt:
				"这是隔离的 Personal Agent 能力测试：假设我们要为小型内部工具选型本地数据库（SQLite vs JSON 文件）。" +
				"1）请务必调用 visualize 工具（type='comparison'）对比这两种方案。" +
				"2）写一句简短结论，然后务必调用 suggest_next_steps 工具给出 2-3 个下一步建议（例如请研发评估或沉淀规范）。" +
				"不要委托同事，不要保存空间文档。",
		});
		assert.ok(
			uxTurn.runResult.toolExecutions.some((t) => t.toolName === "visualize" && !t.isError),
			"Expected visualize tool to succeed",
		);
		assert.ok(
			uxTurn.runResult.toolExecutions.some((t) => t.toolName === "suggest_next_steps" && !t.isError),
			"Expected suggest_next_steps tool to succeed",
		);
		const replyMsg = store
			.listMessages(uxTurn.matter.id, "user")
			.filter((m) => m.senderType === "member")
			.at(-1);
		const nextSteps = readNextStepsFromMetadata(replyMsg?.metadata);
		assert.ok(
			nextSteps.length >= 2 && nextSteps.length <= 4,
			`Expected 2-4 persisted nextSteps, got ${nextSteps.length}`,
		);
		report.ux = {
			matterId: uxTurn.matter.id,
			toolsUsed: uxTurn.runResult.toolExecutions.map((t) => ({ toolName: t.toolName, isError: t.isError })),
			nextSteps,
			reply: uxTurn.replyText,
		};
		console.log(`PASS Case [ux]: visualize & suggest_next_steps succeeded (${nextSteps.length} chips persisted).`);
	}

	const sessionSources = discoverPiSessionFiles(sessionDir);
	const insights = buildSessionInsightsReport(sessionSources);
	assert.ok(insights.usage.sessions >= 1, "Expected session-insights to analyze generated real Pi sessions");
	report.sessionInsights = {
		sessions: insights.usage.sessions,
		toolCalls: insights.usage.toolCalls,
		findingsCount: insights.findings.length,
	};

	const reportPath = join(directory, "pi-native-report.json");
	await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
	console.log(`PASS pi-native real-LLM smoke. Report: ${reportPath}`);
} finally {
	await orchestrator.shutdown();
	db.close();
	if (process.env.PA_KEEP_DEMO_DIR !== "1") rmSync(directory, { recursive: true, force: true });
}
