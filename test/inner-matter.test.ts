import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { INNER_MATTER_GUIDE } from "../src/demo/inner-matter-definition.ts";
import { TeamOrchestrator } from "../src/orchestrator/team-orchestrator.ts";
import { loadRoleTemplatesFromDir } from "../src/roles/template-loader.ts";
import type { PromptRunResult } from "../src/rpc/pi-rpc-worker.ts";
import { createPersonalAgentServer } from "../src/server/app.ts";
import { DialogBroker } from "../src/server/dialog-broker.ts";
import { InnerMatterDemo } from "../src/server/inner-matter.ts";
import { PreviewManager } from "../src/server/preview-manager.ts";
import { openPersonalAgentDatabase } from "../src/storage/database.ts";
import { PersonalAgentStore } from "../src/storage/repositories.ts";
import type { MatterDetailPayload } from "../web/src/api.ts";
import { innerDemoProgress } from "../web/src/innerDemo.ts";
import { invokeTool, reportReady } from "./worker-helpers.ts";

const result = (text: string): PromptRunResult => ({
	disposition: "started",
	aborted: false,
	assistantText: text,
	assistantMessages: [],
	toolExecutions: [],
	notices: [],
	dialogs: [],
	events: [],
});

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
async function jsonObject(response: Response): Promise<Record<string, unknown>> {
	const value: unknown = await response.json();
	assert.ok(isObject(value));
	return value;
}
async function responseMatter(response: Response): Promise<{ id: string }> {
	const body = await jsonObject(response);
	assert.ok(isObject(body.matter) && typeof body.matter.id === "string");
	return { id: body.matter.id };
}

async function fixture(t: test.TestContext) {
	const root = await mkdtemp(join(tmpdir(), "pa-inner-demo-"));
	const directory = join(root, "inner-matter");
	const db = openPersonalAgentDatabase(join(root, "data.db"));
	const store = new PersonalAgentStore(db);
	const templates = await loadRoleTemplatesFromDir(resolve("roles"));
	let workers = 0;
	const orchestrator = new TeamOrchestrator({
		store,
		templates,
		noSession: true,
		defaultCwd: root,
		workerFactory: (options) => ({
			async start() {
				workers++;
				await reportReady(options);
			},
			async stop() {},
			async getState() {
				return { sessionId: "demo-fixture" };
			},
			onNotice() {
				return () => {};
			},
			setDialogHandler() {},
			async runPromptAndWait(prompt) {
				if (options.env?.PA_CAN_PUBLISH === "false") return result("专业建议与验收风险");
				if (prompt.includes("actual-collaboration") || prompt.includes("actual-revision")) {
					for (const memberId of INNER_MATTER_GUIDE.collaborationMemberIds)
						await invokeTool(options, "delegate_to_member", { memberId, task: "核查设计" });
				}
				if (prompt.includes("actual-delivery") || prompt.includes("actual-revision")) {
					const version = prompt.includes("actual-revision") ? 2 : 1;
					const content = `# 产品方案 V${version}\n范围、专业建议与验收依据`;
					await writeFile(join(directory, "deliverables", `feedback-box-v${version}.md`), content);
					await invokeTool(options, "publish_deliverable", {
						title: INNER_MATTER_GUIDE.deliverableTitle,
						type: "document",
						content,
						changeNote: version === 1 ? "明确的首版阶段交付" : "根据 V1 反馈修订",
					});
				}
				return result("回复与待确认问题");
			},
		}),
	});
	const owner = store.ensureOwnerCollaborator();
	const colleague = store.upsertCollaborator({ name: "同事" });
	const { server } = createPersonalAgentServer({
		store,
		orchestrator,
		templates,
		previewManager: new PreviewManager(),
		dialogBroker: new DialogBroker(),
		innerMatterDir: directory,
		requireAuth: true,
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const request = (path: string, token = owner.token, method = "GET", body?: unknown) =>
		fetch(`http://127.0.0.1:${address.port}${path}`, {
			method,
			headers: { "x-pa-token": token, "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	t.after(async () => {
		await orchestrator.shutdown();
		server.closeAllConnections();
		await new Promise<void>((done) => server.close(() => done()));
		db.close();
		await rm(root, { recursive: true, force: true });
	});
	return { root, directory, store, db, orchestrator, request, owner, colleague, workers: () => workers };
}

test("owner opt-in prepares one real Git workspace and one matter, without model calls or fabricated outcomes", async (t) => {
	const f = await fixture(t);
	assert.equal((await jsonObject(await f.request("/api/bootstrap"))).innerDemoAvailable, true);
	assert.equal((await f.request("/api/demos/inner-matter", f.colleague.token, "POST")).status, 403);
	assert.equal(f.store.listMatters().length, 0);
	const responses = await Promise.all([
		f.request("/api/demos/inner-matter", undefined, "POST"),
		f.request("/api/demos/inner-matter", undefined, "POST"),
	]);
	assert.ok(responses.every((response) => response.status === 200));
	const matter = await responseMatter(responses[0]!);
	assert.equal(f.store.listMatters().length, 1);
	assert.equal(f.store.listWorkspaces().length, 1);
	assert.equal(f.workers(), 0);
	assert.equal(f.store.listDeliverables().length, 0);
	assert.equal(f.store.listMessages(matter.id, "internal_collab").length, 0);
	assert.equal(f.store.listMessages(matter.id, "user")[0]?.senderType, "system");
	assert.match(await readFile(join(f.directory, "docs/brief.md"), "utf8"), /尚需讨论/);
	const { stdout } = await promisify(execFile)("git", ["rev-parse", "--show-toplevel"], { cwd: f.directory });
	assert.equal(stdout.trim(), await realpath(f.directory));
	await writeFile(join(f.directory, "docs/brief.md"), "用户已修改的演示背景");
	const demo = new InnerMatterDemo(f.store, f.directory);
	assert.equal((await demo.prepare()).id, matter.id);
	assert.equal(await readFile(join(f.directory, "docs/brief.md"), "utf8"), "用户已修改的演示背景");
	assert.equal(f.store.listMessages(matter.id, "user").length, 1);
});

test("guided demo uses normal dispatch, real tool bridge, formal versions and feedback; progress follows persisted evidence", async (t) => {
	const f = await fixture(t);
	const matter = await responseMatter(await f.request("/api/demos/inner-matter", undefined, "POST"));
	const getDetail = async (): Promise<MatterDetailPayload> => {
		const body = await jsonObject(await f.request(`/api/matters/${matter.id}`));
		assert.ok(isObject(body.demoGuide) && Array.isArray(body.demoGuide.steps) && body.demoGuide.steps.length === 4);
		return {
			matter: f.store.getMatter(matter.id)!,
			demoGuide: INNER_MATTER_GUIDE,
			userMessages: f.store.listMessages(matter.id, "user"),
			internalCollabMessages: f.store.listMessages(matter.id, "internal_collab"),
			noticeMessages: f.store.listMessages(matter.id, "notice"),
			deliverables: f.store.listDeliverables(matter.id),
			pendingDialogs: [],
		};
	};
	const progress = async () => innerDemoProgress(INNER_MATTER_GUIDE, await getDetail());
	assert.deepEqual(await progress(), [false, false, false, false]);
	await f.orchestrator.dispatchMatter({ matterId: matter.id, prompt: "actual-discussion" });
	assert.deepEqual(await progress(), [true, false, false, false]);
	await f.orchestrator.dispatchMatter({ matterId: matter.id, prompt: "actual-collaboration" });
	assert.deepEqual(await progress(), [true, true, false, false]);
	assert.equal(f.store.listDeliverables().length, 0);
	const first = await f.orchestrator.dispatchMatter({ matterId: matter.id, prompt: "actual-delivery" });
	assert.ok(first.deliverable);
	assert.deepEqual(await progress(), [true, true, true, false]);
	const feedback = INNER_MATTER_GUIDE.steps.find((step) => step.id === "revise");
	assert.ok(feedback?.id === "revise");
	assert.equal(
		(
			await f.request(`/api/deliverables/${first.deliverable.id}/feedback`, undefined, "POST", {
				feedback: feedback.feedback,
			})
		).status,
		200,
	);
	const second = await f.orchestrator.dispatchMatter({ matterId: matter.id, prompt: "actual-revision" });
	assert.equal(second.deliverable?.version, 2);
	assert.deepEqual(await progress(), [true, true, true, true]);
	await f.request("/api/demos/inner-matter", undefined, "POST");
	assert.equal(f.store.listDeliverables().length, 2);
	assert.match(await readFile(join(f.directory, "deliverables/feedback-box-v1.md"), "utf8"), /V1/);
	assert.match(await readFile(join(f.directory, "deliverables/feedback-box-v2.md"), "utf8"), /V2/);
	assert.equal(f.db.prepare("SELECT count(*) AS n FROM matter_execution_leases").get()?.n, 0);
});

test("reopening a modified demo never overwrites an unrelated workspace or organization binding", async (t) => {
	const f = await fixture(t);
	const matter = await responseMatter(await f.request("/api/demos/inner-matter", undefined, "POST"));
	const other = f.store.upsertWorkspace({ name: "business", repoPath: join(f.root, "business") });
	f.store.updateMatterWorkspace(matter.id, other.id);
	assert.equal((await f.request("/api/demos/inner-matter", undefined, "POST")).status, 409);
	assert.equal(f.store.getMatter(matter.id)?.workspaceId, other.id);
	assert.equal((await jsonObject(await f.request(`/api/matters/${matter.id}`))).demoGuide, undefined);
});
