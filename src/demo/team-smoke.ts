/** Opt-in real Pi proof. Two separate host processes, disposable database/workspace, no business repository access. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TeamOrchestrator } from "../orchestrator/team-orchestrator.ts";
import { loadRoleTemplatesFromDir } from "../roles/template-loader.ts";
import { openPersonalAgentDatabase } from "../storage/database.ts";
import { PersonalAgentStore } from "../storage/repositories.ts";
import { selectDemoModel } from "./model-selection.ts";

const phase = process.argv[2];
const root = process.argv[3];
if (!phase || !root) {
	const directory = await mkdtemp(join(tmpdir(), "personal-agent-team-smoke-"));
	await writeFile(
		join(directory, "evidence.txt"),
		"TECHNICAL_EVIDENCE_4827: 个人文字便笺，单人、本地存储、纯文本；最小技术选择为浏览器 IndexedDB。仅设计，不编码。\n",
	);
	console.log(`Isolated evidence directory: ${directory}`);
	for (const step of ["first", "restart"]) {
		await new Promise<void>((resolveRun, reject) => {
			const child = spawn(process.execPath, [process.argv[1]!, step, directory], { stdio: "inherit" });
			child.once("error", reject);
			child.once("exit", (code) =>
				code === 0 ? resolveRun() : reject(new Error(`Smoke phase ${step} exited ${code}`)),
			);
		});
	}
	console.log(
		"PASS: real tool delegation, internal evidence, host-process restart, session recall and explicit document archival",
	);
} else {
	const db = openPersonalAgentDatabase(join(root, "proof.db"));
	try {
		const store = new PersonalAgentStore(db);
		store.updatePlatformSettings({ defaultModelSelection: await selectDemoModel(root, { thinkingLevel: "off" }) });
		const templates = (await loadRoleTemplatesFromDir(resolve("roles"))).map((template) => ({
			...template,
			tools: ["read"],
		}));
		const orchestrator = new TeamOrchestrator({
			store,
			templates,
			defaultCwd: root,
			sessionDir: join(root, "sessions"),
		});
		const workspace = store.upsertWorkspace({ name: "隔离协作验证", repoPath: root });
		if (phase === "first") {
			const result = await orchestrator.dispatchMatter({
				preferredMemberId: "product-manager",
				workspaceId: workspace.id,
				timeoutMs: 120_000,
				prompt:
					"这是 Personal Agent 的隔离协作测试：为「个人文字便笺小工具」讨论简短产品方案。单人、本地存储、纯文本，仅做设计。以下是假设，不是用户确认的产品需求。请记住本事项口令 CONTEXT_9361。现在处于需求澄清阶段，无需正式成果。请务必用 delegate_to_member 向 engineering-manager 咨询：只读 evidence.txt，给出便笺工具的最小技术建议，返回其中的技术证据标识、存储选择与阶段限制。收到同事结果后用一句话整合答复，包含口令和技术证据标识。不要写文件，不登记成果，不开展业务编码。",
			});
			assert.match(result.replyText, /TECHNICAL_EVIDENCE_4827/);
			assert.equal(store.spaces.listDocuments({ matterId: result.matter.id }).length, 0);
			const internal = store.listMessages(result.matter.id, "internal_collab");
			assert.ok(
				internal.some(
					(message) =>
						message.senderId === "engineering-manager" && message.content.includes("TECHNICAL_EVIDENCE_4827"),
				),
			);
			assert.ok(
				result.runResult.toolExecutions.some((tool) => tool.toolName === "delegate_to_member" && !tool.isError),
			);
			const discussion = await orchestrator.dispatchMatter({
				matterId: result.matter.id,
				timeoutMs: 120_000,
				prompt:
					"继续澄清：仍只讨论单人、本地纯文本便笺，先不用对方案做正式发布。请简短确认前面的阶段限制即可，不调用同事，不登记成果。",
			});
			assert.equal(store.spaces.listDocuments({ matterId: result.matter.id }).length, 0);

			await writeFile(join(root, "matter-id.txt"), result.matter.id);
			await writeFile(
				join(root, "first.json"),
				JSON.stringify(
					{
						matterId: result.matter.id,
						reply: result.replyText,
						internal,
						discussionReply: discussion.replyText,
						tools: result.runResult.toolExecutions,
					},
					null,
					2,
				),
			);
			console.log(
				"PASS first host: PM called engineering via real Pi tool, integrated read evidence, no false deliverable",
			);
		} else {
			const matterId = (await readFile(join(root, "matter-id.txt"), "utf8")).trim();
			const before = db
				.prepare(
					"SELECT pi_session_id FROM worker_sessions WHERE matter_id = ? AND member_id = 'product-manager' ORDER BY rowid DESC LIMIT 1",
				)
				.get(matterId);
			const result = await orchestrator.dispatchMatter({
				matterId,
				timeoutMs: 120_000,
				prompt:
					"请回忆刚才本事项的口令，以及研发同事从文件读取的技术证据标识。请不要读取文件，不调用同事，也不要猜测。把记得的这两个标识、之前的存储选择和仅设计不编码的限制整合为简短便笺设计测试稿，用 save_space_page 登记 document，标题固定为「隔离协作测试记录」。请在 changeNote 中说明这是为验证本次重启接续而明确要求发布的设计测试版本。这是测试记录，不能视为产品确认。最后简短答复。",
			});
			const meta = store.spaces.listDocuments({ matterId }).find((doc) => doc.title === "隔离协作测试记录");
			assert.ok(meta);
			const document = await store.spaces.getDocument(meta.id);
			assert.ok(document);
			assert.match(document.content, /CONTEXT_9361/);
			assert.match(document.content, /TECHNICAL_EVIDENCE_4827/);
			assert.match(document.content, /IndexedDB/i);
			assert.equal(result.matter.status, "open");
			assert.equal(document.revision, 1);
			assert.ok(
				result.runResult.toolExecutions.some((tool) => tool.toolName === "save_space_page" && !tool.isError),
			);
			const sessions = db
				.prepare(
					"SELECT pi_session_id, status FROM worker_sessions WHERE matter_id = ? AND member_id = 'product-manager' ORDER BY rowid",
				)
				.all(matterId);
			assert.equal(sessions.length, 3);
			assert.equal(sessions[2]?.pi_session_id, before?.pi_session_id);
			assert.equal(sessions[2]?.status, "idle");
			await writeFile(
				join(root, "restart.json"),
				JSON.stringify(
					{ reply: result.replyText, document, sessions, tools: result.runResult.toolExecutions },
					null,
					2,
				),
			);
			console.log("PASS second host: same Pi session ID, recalled both markers, archived actual document");
		}
	} finally {
		db.close();
	}
}
