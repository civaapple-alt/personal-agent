/** Opt-in real Pi check for team capability evidence in a disposable workspace. */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TeamOrchestrator } from "../orchestrator/team-orchestrator.ts";
import { loadRoleTemplatesFromDir } from "../roles/template-loader.ts";
import { openPersonalAgentDatabase } from "../storage/database.ts";
import { PersonalAgentStore } from "../storage/repositories.ts";
import { selectDemoModel } from "./model-selection.ts";

const root = await mkdtemp(join(tmpdir(), "pa-team-capability-check-"));
await writeFile(join(root, "README.md"), "# Isolated team capability check\n");
const db = openPersonalAgentDatabase(join(root, "proof.db"));
try {
	const store = new PersonalAgentStore(db, { spacesDir: join(root, "spaces") });
	store.updatePlatformSettings({ defaultModelSelection: await selectDemoModel(root, { thinkingLevel: "off" }) });
	const templates = await loadRoleTemplatesFromDir(resolve("roles"));
	const orchestrator = new TeamOrchestrator({
		store,
		templates,
		defaultCwd: root,
		sessionDir: join(root, "sessions"),
	});
	const workspace = store.upsertWorkspace({ name: "隔离测试", repoPath: root });
	const matter = store.createMatter({
		title: "团队能力检查",
		workspaceId: workspace.id,
		leadMemberId: "product-manager",
	});
	store.appendMessage({
		matterId: matter.id,
		channel: "notice",
		senderType: "system",
		senderId: "engineering-manager",
		metadata: {
			workspaceId: workspace.id,
			repoPath: root,
			orgId: workspace.orgId,
			sourceUserMessageId: "synthetic-previous-turn",
		},
		content: JSON.stringify({
			method: "runtime_ready",
			sessionMode: "internal",
			discussionMode: false,
			tools: ["read", "bash", "edit"],
		}),
	});
	const result = await orchestrator.dispatchMatter({
		matterId: matter.id,
		timeoutMs: 120_000,
		prompt:
			"你是当前事项负责人。介绍本团队可请教成员各自适合做什么、有哪些边界；你能否确认他们这次运行时有哪些工具，以及网页搜索和 pstack 是否已经成功调用？根据目前已知证据回答。",
	});
	const events = store.listMessages(matter.id, "notice");
	const internal = store.listMessages(matter.id, "internal_collab");
	await writeFile(join(root, "result.json"), JSON.stringify({ reply: result.replyText, events, internal }, null, 2));
	console.log(`Evidence: ${root}`);
	console.log(result.replyText);
	console.log(
		`Internal messages: ${internal.length}. Review result.json against the actual runtime notices; completion alone is not a quality pass.`,
	);
} finally {
	db.close();
}
