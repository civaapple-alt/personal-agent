import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TeamOrchestrator } from "../orchestrator/team-orchestrator.ts";
import { loadRoleTemplatesFromDir } from "../roles/template-loader.ts";
import { openPersonalAgentDatabase } from "../storage/database.ts";
import { PersonalAgentStore } from "../storage/repositories.ts";

const directory = mkdtempSync(join(tmpdir(), "pa-rsi-smoke-"));
const workspaceDir = join(directory, "workspace");
const sessionDir = join(directory, "sessions");
const dbPath = join(directory, "personal-agent.db");
const db = openPersonalAgentDatabase(dbPath);
const store = new PersonalAgentStore(db, { spacesDir: join(directory, "spaces") });
const templates = await loadRoleTemplatesFromDir(resolve("roles"));
const orchestrator = new TeamOrchestrator({ store, templates, defaultCwd: workspaceDir, sessionDir });

try {
	await import("node:fs/promises").then(({ mkdir }) => mkdir(workspaceDir, { recursive: true }));
	const workspace = store.upsertWorkspace({ name: "rsi-smoke-repo", repoPath: workspaceDir });
	store.spaces.ensureAllDefaultSpaces();
	const turn = await orchestrator.dispatchMatter({
		workspaceId: workspace.id,
		preferredMemberId: "product-manager",
		timeoutMs: 120_000,
		prompt:
			"这是隔离的 Personal Agent 运行测试，不是业务需求确认。请实际调用 propose_skill，提议一个 personal 作用域的 Skill（name='handoff-brief'），内容是：向同事咨询时提供目标、限制和期望结果，避免只发模糊追问。然后请实际调用 save_space_page 发布一个正式测试记录 document，标题为「RSI 运行验证稿」，写明刚才的协作方法与测试边界，changeNote 说明这是明确要求发布的阶段测试版本。最后简短答复。不写文件，不编码，不调用同事。",
	});
	assert.ok(turn.runResult.toolExecutions.some((tool) => tool.toolName === "propose_skill" && !tool.isError));
	assert.ok(turn.runResult.toolExecutions.some((tool) => tool.toolName === "save_space_page" && !tool.isError));
	const document = store.spaces
		.listDocuments({ matterId: turn.matter.id })
		.find((item) => item.title === "RSI 运行验证稿");
	assert.ok(document);
	const replyMessage = store
		.listMessages(turn.matter.id, "user")
		.filter((message) => message.senderType === "member")
		.at(-1);
	assert.ok(Array.isArray(replyMessage?.metadata?.skillProposals) && replyMessage.metadata.skillProposals.length > 0);
	await store.spaces.saveDocumentFeedback({
		documentId: document.id,
		commitHash: document.headCommit,
		actorId: "owner",
		actorName: "Smoke Owner",
		rating: "positive",
		feedback: "已确认正式测试稿与 Skill 提案。",
	});
	const evidence = {
		matterId: turn.matter.id,
		documentId: document.id,
		skillProposals: replyMessage?.metadata?.skillProposals ?? [],
		toolExecutions: turn.runResult.toolExecutions.map((t) => ({ toolName: t.toolName, isError: t.isError })),
	};
	await writeFile(join(directory, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
	console.log(`RSI smoke passed. Evidence saved at ${join(directory, "evidence.json")}`);
} finally {
	await orchestrator.shutdown();
	db.close();
	if (process.env.PA_KEEP_DEMO_DIR !== "1") rmSync(directory, { recursive: true, force: true });
}
