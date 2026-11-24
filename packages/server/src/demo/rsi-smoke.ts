/**
 * Opt-in real Pi verification for the Four-Step Trust progression:
 * Step 1 (probe) -> Step 2 (propose_skill with SKILL.md + scripts/* -> confirm & save to disk)
 * -> Step 3 (Pi native --skill discovery + tool_call confirm dialog -> promote to autonomous)
 * -> Step 4 (autonomous script execution without re-prompting + session-insights analysis).
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SkillProposalItem } from "@pa/contracts/skill-proposal";
import { buildSessionInsightsReport, discoverPiSessionFiles } from "../orchestrator/runtime/session-insights.ts";
import { TeamOrchestrator } from "../orchestrator/team-orchestrator.ts";
import { saveSkillProposalToDisk } from "../roles/role-package-store.ts";
import { loadRoleTemplatesFromDir } from "../roles/template-loader.ts";
import { openPersonalAgentDatabase } from "../storage/database.ts";
import { PersonalAgentStore } from "../storage/repositories.ts";
import { selectDemoModel } from "./model-selection.ts";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
	console.log(
		[
			"Usage: npm run demo:rsi (or npm run demo:trust)",
			"Runs an isolated real-LLM Four-Step Trust verification in a disposable workspace/DB:",
			"  1. Turn 1: role calls propose_skill (workspace scope, SKILL.md + executable scripts/check.mjs) and save_space_page.",
			"  2. Host saves the confirmed proposal to <workspace>/.agents/skills/demo-preflight/.",
			"  3. Turn 2: role runs scripts/check.mjs via bash -> triggers Step 3 tool_call confirm dialog -> promotes to Step 4 autonomous.",
			"  4. Turn 3: role runs scripts/check.mjs again -> executes autonomously with 0 dialogs, plus deterministic session-insights check.",
			"Set PA_KEEP_DEMO_DIR=1 to preserve the temporary evidence directory.",
		].join("\n"),
	);
	process.exit(0);
}

const directory = mkdtempSync(join(tmpdir(), "pa-trust-smoke-"));
const workspaceDir = join(directory, "workspace");
const sessionDir = join(directory, "sessions");
const skillsDir = join(directory, "skills");
const dbPath = join(directory, "personal-agent.db");
const db = openPersonalAgentDatabase(dbPath);
const store = new PersonalAgentStore(db, { spacesDir: join(directory, "spaces") });
const templates = await loadRoleTemplatesFromDir(resolve("roles"));

const dialogLog: Array<{ method: string; title: string; choice?: string }> = [];
const orchestrator = new TeamOrchestrator({
	store,
	templates,
	defaultCwd: workspaceDir,
	sessionDir,
	skillsDir,
	onDialog: async ({ request }) => {
		if (request.method === "select") {
			const promoteOption = request.options.find((opt) => opt.includes("自主执行")) ?? request.options[0];
			dialogLog.push({ method: request.method, title: request.title, choice: promoteOption });
			if (promoteOption) return { value: promoteOption };
		}
		dialogLog.push({ method: request.method, title: request.title });
		return { cancelled: true };
	},
});

try {
	await mkdir(workspaceDir, { recursive: true });
	await writeFile(join(workspaceDir, "README.md"), "# Isolated Four-Step Trust Demo Repo\n", "utf8");
	store.updatePlatformSettings({
		defaultModelSelection: await selectDemoModel(workspaceDir, { thinkingLevel: "off" }),
	});
	const workspace = store.upsertWorkspace({ name: "trust-smoke-repo", repoPath: workspaceDir });
	store.spaces.ensureAllDefaultSpaces();

	console.log("Turn 1 (Step 1 -> Step 2): proposing workspace Skill + executable script & saving space record...");
	const turn1 = await orchestrator.dispatchMatter({
		workspaceId: workspace.id,
		preferredMemberId: "engineering-manager",
		timeoutMs: 120_000,
		prompt:
			"这是隔离的 Personal Agent 信任四步实机验证，不是业务需求。请按要求完成两件事：" +
			"1）调用 propose_skill，提议一个 workspace 作用域的 Skill：name 固定为 'demo-preflight'，description 为 'Run repo preflight check'，body 写明运行 `node .agents/skills/demo-preflight/scripts/check.mjs`，并附带一个可执行脚本 scripts（path 为 'scripts/check.mjs'，executable: true，content 为 `#!/usr/bin/env node\\nconsole.log('PREFLIGHT_OK_7419');\\n`）。" +
			"2）调用 save_space_page 发布一个 document，标题固定为「信任四步验证稿」，简述该 Skill 提案与脚本作用，changeNote 说明这是实机验证记录。" +
			"不要直接运行 bash，不要委托同事，完成后简短回复。",
	});

	assert.ok(
		turn1.runResult.toolExecutions.some((tool) => tool.toolName === "propose_skill" && !tool.isError),
		"Expected propose_skill to succeed in Turn 1",
	);
	assert.ok(
		turn1.runResult.toolExecutions.some((tool) => tool.toolName === "save_space_page" && !tool.isError),
		"Expected save_space_page to succeed in Turn 1",
	);
	const document = store.spaces
		.listDocuments({ matterId: turn1.matter.id })
		.find((item) => item.title === "信任四步验证稿");
	assert.ok(document, "Expected space document '信任四步验证稿' to be created");

	const reply1 = store
		.listMessages(turn1.matter.id, "user")
		.filter((message) => message.senderType === "member")
		.at(-1);
	const proposals = (reply1?.metadata?.skillProposals ?? []) as SkillProposalItem[];
	const skillProposal = proposals.find((item) => item.name === "demo-preflight");
	assert.ok(skillProposal, "Expected staged skillProposal 'demo-preflight'");
	assert.ok(
		skillProposal.scripts?.some((s) => s.path === "scripts/check.mjs"),
		"Expected staged proposal to include scripts/check.mjs",
	);
	assert.equal(
		existsSync(join(workspaceDir, ".agents/skills/demo-preflight/SKILL.md")),
		false,
		"propose_skill must not write to disk before human approval",
	);

	// Human approves the proposal -> writes SKILL.md + scripts/check.mjs to disk
	const saved = await saveSkillProposalToDisk({
		proposal: skillProposal,
		storageScope: "workspace",
		workspaceRepoPath: workspaceDir,
	});
	assert.ok(existsSync(join(workspaceDir, ".agents/skills/demo-preflight/scripts/check.mjs")));

	await store.spaces.saveDocumentFeedback({
		documentId: document.id,
		commitHash: document.headCommit,
		actorId: "owner",
		actorName: "Smoke Owner",
		rating: "positive",
		feedback: "已确认 Skill 提案并批准落盘。",
	});

	console.log(
		"Turn 2 (Step 3 -> Step 4): running vetted Skill script via bash (expecting confirm dialog & promotion)...",
	);
	const turn2 = await orchestrator.dispatchMatter({
		matterId: turn1.matter.id,
		timeoutMs: 120_000,
		prompt:
			"刚才提议的 Skill `demo-preflight` 已批准并写入仓库。请现在使用 bash 工具执行 `node .agents/skills/demo-preflight/scripts/check.mjs`，并把输出的关键标记原样汇报给我。不要修改脚本，不要委托同事。",
	});

	assert.ok(
		turn2.runResult.toolExecutions.some((tool) => tool.toolName === "bash" && !tool.isError),
		"Expected bash execution of vetted script to succeed in Turn 2",
	);
	assert.match(turn2.replyText, /PREFLIGHT_OK_7419/);
	assert.equal(
		dialogLog.length,
		1,
		`Expected exactly 1 Step-3 confirmation dialog in Turn 2, got ${dialogLog.length}`,
	);
	assert.match(dialogLog[0]?.title ?? "", /demo-preflight/);
	const policyAfterTurn2 = store.skillTrust.getPolicy("workspace", workspace.id, "demo-preflight");
	assert.equal(policyAfterTurn2?.trustLevel, "autonomous", "Expected Skill trust to promote to autonomous");

	console.log("Turn 3 (Step 4): re-running vetted Skill script autonomously (expecting 0 dialogs)...");
	const turn3 = await orchestrator.dispatchMatter({
		matterId: turn1.matter.id,
		timeoutMs: 120_000,
		prompt: "请再次使用 bash 运行 `node .agents/skills/demo-preflight/scripts/check.mjs` 并简短回报输出标记。",
	});
	assert.ok(
		turn3.runResult.toolExecutions.some((tool) => tool.toolName === "bash" && !tool.isError),
		"Expected autonomous bash execution to succeed in Turn 3",
	);
	assert.match(turn3.replyText, /PREFLIGHT_OK_7419/);
	assert.equal(dialogLog.length, 1, "Expected 0 additional dialogs after promotion to autonomous");
	const policyAfterTurn3 = store.skillTrust.getPolicy("workspace", workspace.id, "demo-preflight");
	assert.ok((policyAfterTurn3?.runCount ?? 0) >= 2, `Expected runCount >= 2, got ${policyAfterTurn3?.runCount}`);

	const sessionSources = discoverPiSessionFiles(sessionDir);
	const insights = buildSessionInsightsReport(sessionSources);
	assert.ok(insights.usage.sessions >= 1, "Expected session-insights to parse at least 1 real Pi session");

	const evidence = {
		matterId: turn1.matter.id,
		documentId: document.id,
		savedPaths: saved.writtenPaths,
		dialogLog,
		policyAfterTurn3,
		insightsSummary: {
			sessions: insights.usage.sessions,
			totalToolCalls: insights.usage.toolCalls,
			findingsCount: insights.findings.length,
		},
		turns: [
			{ turn: 1, tools: turn1.runResult.toolExecutions.map((t) => ({ toolName: t.toolName, isError: t.isError })) },
			{ turn: 2, tools: turn2.runResult.toolExecutions.map((t) => ({ toolName: t.toolName, isError: t.isError })) },
			{ turn: 3, tools: turn3.runResult.toolExecutions.map((t) => ({ toolName: t.toolName, isError: t.isError })) },
		],
	};
	await writeFile(join(directory, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
	console.log(`PASS Four-Step Trust real-LLM smoke. Evidence: ${join(directory, "evidence.json")}`);
	console.log(JSON.stringify(evidence.insightsSummary));
} finally {
	await orchestrator.shutdown();
	db.close();
	if (process.env.PA_KEEP_DEMO_DIR !== "1") rmSync(directory, { recursive: true, force: true });
}
