/** Opt-in proof of actual Pi experience proposal/reflection; all data belongs to a disposable workspace. */
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TeamOrchestrator } from "../orchestrator/team-orchestrator.ts";
import { loadRoleTemplatesFromDir } from "../roles/template-loader.ts";
import { PiRpcWorker } from "../rpc/pi-rpc-worker.ts";
import { openPersonalAgentDatabase } from "../storage/database.ts";
import { PersonalAgentStore } from "../storage/repositories.ts";
import { selectDemoModel } from "./model-selection.ts";

const directory = await mkdtemp(join(tmpdir(), "personal-agent-rsi-smoke-"));
console.log(`Isolated RSI evidence directory: ${directory}`);
const db = openPersonalAgentDatabase(join(directory, "proof.db"));
const store = new PersonalAgentStore(db, { spacesDir: join(directory, "spaces") });
store.updatePlatformSettings({ defaultModelSelection: await selectDemoModel(directory, { thinkingLevel: "off" }) });
const templates = (await loadRoleTemplatesFromDir(resolve("roles"))).map((template) => ({
	...template,
	tools: ["read"],
}));
let reflectionTools = 0;
const orchestrator = new TeamOrchestrator({
	store,
	templates,
	defaultCwd: directory,
	sessionDir: join(directory, "sessions"),
	workerFactory: (options) => {
		const worker = new PiRpcWorker(options);
		if (options.noSession)
			worker.onEvent((event) => {
				if (event.type === "tool_execution_start") reflectionTools++;
			});
		return worker;
	},
});
try {
	const workspace = store.upsertWorkspace({ name: "RSI 隔离测试", repoPath: directory });
	const seed = store.addMemory({
		memberId: "product-manager",
		scope: "role_general",
		content: "正式交付先给结论，再说明核查依据。",
		status: "verified",
	});
	const turn = await orchestrator.dispatchMatter({
		workspaceId: workspace.id,
		preferredMemberId: "product-manager",
		timeoutMs: 120_000,
		prompt:
			"这是隔离的 Personal Agent 运行测试，不是业务需求确认。请实际调用 propose_experience，提议一条 role_general、category=collaboration 的候选方法：向同事咨询时提供目标、限制和期望结果，避免只发模糊追问。然后请实际调用 save_space_page 发布一个正式测试记录 document，标题为「RSI 运行验证稿」，写明刚才的协作方法与测试边界，changeNote 说明这是明确要求发布的阶段测试版本。最后简短答复。不写文件，不编码，不调用同事。",
	});
	assert.ok(turn.runResult.toolExecutions.some((tool) => tool.toolName === "propose_experience" && !tool.isError));
	assert.ok(turn.runResult.toolExecutions.some((tool) => tool.toolName === "save_space_page" && !tool.isError));
	const document = store.spaces
		.listDocuments({ matterId: turn.matter.id })
		.find((item) => item.title === "RSI 运行验证稿");
	assert.ok(document);
	assert.ok(
		store
			.listMemberMemories("product-manager")
			.some((memory) => memory.id !== seed.id && memory.status === "candidate"),
	);
	for (const rating of ["negative", "positive"] as const) {
		await store.spaces.saveDocumentFeedback({
			documentId: document.id,
			commitHash: document.headCommit,
			actorId: "demo",
			actorName: "Demo",
			feedback: "测试改票",
			rating,
		});
	}
	assert.equal(store.getMemory(seed.id)?.positiveCount, 1);
	assert.equal(store.getMemory(seed.id)?.negativeCount, 0);
	console.log("PASS real proposal tool, staged candidate commit, formal document and version-specific feedback");
	const reflection = await orchestrator.distillExperiences({
		matterId: turn.matter.id,
		scopeMode: "single",
		timeoutMs: 120_000,
		feedback:
			"本次隔离测试补充一条仅对当前工作区成立的规范：所有验证记录须附带 TEST_RSI_4827 标识，防止与业务记录混淆。请将这条明确纠偏提炼为 project_private、category=domain_constraint 的候选规则，内容保留标识，不要泛化为跨项目通用方法。",
	});
	assert.ok(
		reflection.createdMemories.some(
			(memory) =>
				memory.scope === "project_private" &&
				memory.workspaceId === workspace.id &&
				memory.content.includes("TEST_RSI_4827"),
		),
	);
	assert.equal(reflectionTools, 0);
	await writeFile(
		join(directory, "evidence.json"),
		JSON.stringify(
			{
				matterId: turn.matter.id,
				document,
				tools: turn.runResult.toolExecutions.map((tool) => ({ name: tool.toolName, isError: tool.isError })),
				reflection,
				seed: store.getMemory(seed.id),
				reflectionTools,
			},
			null,
			2,
		),
	);
	console.log("PASS real no-tool reflection, correctly scoped candidate and retained evidence.json");
} finally {
	await orchestrator.shutdown();
	db.close();
}
