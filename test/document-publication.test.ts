import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { TeamOrchestrator } from "../src/orchestrator/team-orchestrator.ts";
import { loadRoleTemplatesFromDir } from "../src/roles/template-loader.ts";
import type { PiRpcWorkerOptions, PromptRunResult } from "../src/rpc/pi-rpc-worker.ts";
import { openPersonalAgentDatabase } from "../src/storage/database.ts";
import { PersonalAgentStore } from "../src/storage/repositories.ts";
import { invokeTool, reportReady } from "./worker-helpers.ts";

async function fixture(t: test.TestContext, respond: (options: PiRpcWorkerOptions) => Promise<void>) {
	const root = await mkdtemp(join(tmpdir(), "pa-document-publication-"));
	const workspace = join(root, "workspace");
	await mkdir(workspace);
	const db = openPersonalAgentDatabase(join(root, "proof.db"));
	const store = new PersonalAgentStore(db);
	const orchestrator = new TeamOrchestrator({
		store,
		templates: await loadRoleTemplatesFromDir(resolve("roles")),
		defaultCwd: workspace,
		noSession: true,
		workerFactory: (options) => ({
			async start() {
				await reportReady(options);
			},
			async stop() {},
			async getState() {
				return { sessionId: randomUUID() };
			},
			onNotice: () => () => {},
			setDialogHandler() {},
			async runPromptAndWait(): Promise<PromptRunResult> {
				await respond(options);
				return {
					disposition: "started",
					aborted: false,
					assistantText: "阶段文档已登记",
					assistantMessages: [],
					toolExecutions: [],
					notices: [],
					dialogs: [],
					events: [],
				};
			},
		}),
	});
	t.after(async () => {
		await orchestrator.shutdown();
		db.close();
		await rm(root, { recursive: true, force: true });
	});
	const link = store.upsertWorkspace({ name: "隔离文件交付", repoPath: workspace });
	const dispatch = (matterId?: string) =>
		orchestrator.dispatchMatter({
			matterId,
			workspaceId: link.id,
			preferredMemberId: "product-manager",
			prompt: "阶段交付",
		});
	return { root, workspace, db, store, dispatch };
}

const publication = { type: "document", title: "设计说明", changeNote: "根据已保存的最终文件发布" };

test("sourcePath publication archives exact file text and retains earlier version snapshots", async (t) => {
	let version = 1;
	const f = await fixture(t, async (options) => {
		await invokeTool(options, "save_space_page", { ...publication, sourcePath: `v${version}.md` });
	});
	const firstText = "\uFEFF\n# 文档一\r\n正文含中文与 emoji ✅。\r\n\n";
	await writeFile(join(f.workspace, "v1.md"), firstText);
	const first = await f.dispatch();
	assert.equal(first.deliverable?.contentOrPath, firstText);
	version = 2;
	await writeFile(join(f.workspace, "v2.md"), "# 第二版\nAC9 引用第 4.5 节。\n");
	const second = await f.dispatch(first.matter.id);
	assert.equal(second.deliverable?.version, 2);
	assert.equal(second.deliverable?.contentOrPath, await readFile(join(f.workspace, "v2.md"), "utf8"));
	await writeFile(join(f.workspace, "v1.md"), "后续编辑不改变归档历史");
	assert.equal(f.store.getDeliverable(first.deliverable!.id)?.contentOrPath, firstText);
});

test("document sources reject ambiguity, missing/outside/non-text files and non-document sourcePath", async (t) => {
	const f = await fixture(t, async (options) => {
		for (const [args, expected] of [
			[{ sourcePath: "valid.md", content: "另写的正文" }, /exactly one|both/i],
			[{ sourcePath: "missing.md" }, /ENOENT/],
			[{ sourcePath: "." }, /file/],
			[{ sourcePath: "../outside.md" }, /workspace/],
			[{ sourcePath: "escape.md" }, /workspace/],
			[{ sourcePath: "empty.md" }, /nonempty/],
			[{ sourcePath: "invalid.md" }, /UTF-8/],
			[{ sourcePath: "large.md" }, /large|size|bytes/],
			[{ type: "artifact", sourcePath: "valid.md" }, /document/],
		] as const) {
			await assert.rejects(invokeTool(options, "save_space_page", { ...publication, ...args }), expected);
		}
		await invokeTool(options, "save_space_page", { ...publication, sourcePath: "valid.md" });
	});
	await writeFile(join(f.workspace, "valid.md"), "# 正式文档\n");
	await writeFile(join(f.root, "outside.md"), "外部私有文件");
	await symlink(join(f.root, "outside.md"), join(f.workspace, "escape.md"));
	await writeFile(join(f.workspace, "empty.md"), " \n");
	await writeFile(join(f.workspace, "invalid.md"), Buffer.from([0xff, 0xfe]));
	await writeFile(join(f.workspace, "large.md"), Buffer.alloc(1_048_577, 65));
	await f.dispatch();
	assert.equal(f.store.listDeliverables().length, 1);
});

test("changing a document after staging rejects the turn atomically instead of archiving stale text", async (t) => {
	const f = await fixture(t, async (options) => {
		await invokeTool(options, "save_space_page", { ...publication, sourcePath: "final.md" });
		await invokeTool(options, "propose_experience", {
			scope: "role_general",
			content: "发布应复用最终文档来源。",
			rationale: "文件一致性验证",
		});
		await writeFile(join(f.workspace, "final.md"), "# 后改的正文\n");
	});
	await writeFile(join(f.workspace, "final.md"), "# 已登记快照\n");
	await assert.rejects(f.dispatch(), /changed.*save.*latest/i);
	assert.equal(f.store.listDeliverables().length, 0);
	assert.equal(f.store.listMemberMemories("product-manager").length, 0);
	assert.equal(f.db.prepare("SELECT count(*) AS n FROM matter_execution_leases").get()?.n, 0);
});

test("republishing a revised same-title document replaces its staged draft without adding extra versions", async (t) => {
	const f = await fixture(t, async (options) => {
		await invokeTool(options, "save_space_page", { ...publication, sourcePath: "final.md" });
		await writeFile(join(f.workspace, "final.md"), "# 修订后的最终稿\n");
		await invokeTool(options, "save_space_page", { ...publication, sourcePath: "final.md" });
	});
	await writeFile(join(f.workspace, "final.md"), "# 初稿\n");
	const result = await f.dispatch();
	assert.equal(result.deliverable?.contentOrPath, "# 修订后的最终稿\n");
	assert.equal(result.deliverable?.version, 1);
	assert.equal(f.store.listDeliverables().length, 1);
});

test("a source symlink cannot be redirected between staging and final commit", async (t) => {
	const f = await fixture(t, async (options) => {
		await invokeTool(options, "save_space_page", { ...publication, sourcePath: "alias.md" });
		await rm(join(f.workspace, "alias.md"));
		await symlink(join(f.workspace, "other.md"), join(f.workspace, "alias.md"));
	});
	await writeFile(join(f.workspace, "first.md"), "# 相同正文\n");
	await writeFile(join(f.workspace, "other.md"), "# 相同正文\n");
	await symlink(join(f.workspace, "first.md"), join(f.workspace, "alias.md"));
	await assert.rejects(f.dispatch(), /changed.*save.*latest/i);
	assert.equal(f.store.listDeliverables().length, 0);
});

test("a source deleted after staging cannot leave an archived document or an execution lease", async (t) => {
	const f = await fixture(t, async (options) => {
		await invokeTool(options, "save_space_page", { ...publication, sourcePath: "final.md" });
		await rm(join(f.workspace, "final.md"));
	});
	await writeFile(join(f.workspace, "final.md"), "# 最终稿\n");
	await assert.rejects(f.dispatch(), /ENOENT/);
	assert.equal(f.store.listDeliverables().length, 0);
	assert.equal(f.db.prepare("SELECT count(*) AS n FROM matter_execution_leases").get()?.n, 0);
});
