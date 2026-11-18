import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { type RpcWorkerLike, TeamOrchestrator } from "../src/orchestrator/team-orchestrator.ts";
import { loadRoleTemplatesFromDir } from "../src/roles/template-loader.ts";
import type { PiRpcWorkerOptions, PromptRunResult, RunPromptOptions } from "../src/rpc/pi-rpc-worker.ts";
import teamExtension, { type PiExtensionApi } from "../src/rpc/team-extension.ts";
import { openPersonalAgentDatabase } from "../src/storage/database.ts";
import { PersonalAgentStore } from "../src/storage/repositories.ts";
import { invokeTool } from "./worker-helpers.ts";

type Tool = Parameters<PiExtensionApi["registerTool"]>[0];
type Responder = (worker: SessionWorker, prompt: string, options: RunPromptOptions) => Promise<string>;

/** Model fixture, but uses the shipped Pi extension, authenticated HTTP bridge and real session files. */
class SessionWorker implements RpcWorkerLike {
	readonly options: PiRpcWorkerOptions;
	readonly tools = new Map<string, Tool>();
	readonly sessionId: string;
	readonly sessionFile: string;
	priorTranscript = "";
	stopped = false;
	prompt = "";
	idleSuspendActive = false;
	idleSuspendCount = 0;
	private readonly respond: Responder;
	private readonly eventListeners = new Set<(event: { type: string; [key: string]: unknown }) => void>();
	constructor(options: PiRpcWorkerOptions, respond: Responder) {
		this.options = options;
		this.respond = respond;
		this.sessionId = options.sessionFile?.split("/").at(-1)?.replace(".jsonl", "") ?? randomUUID();
		this.sessionFile = options.sessionFile ?? join(options.sessionDir!, `${this.sessionId}.jsonl`);
	}
	async start(): Promise<void> {
		await mkdir(this.options.sessionDir!, { recursive: true });
		if (this.options.sessionFile) this.priorTranscript = await readFile(this.sessionFile, "utf8");
		else
			await writeFile(
				this.sessionFile,
				`${JSON.stringify({ type: "session", id: this.sessionId, cwd: this.options.cwd })}\n`,
			);
		let onStart: (() => Promise<void>) | undefined;
		const envBefore = { ...process.env };
		Object.assign(process.env, this.options.env);
		process.env.PA_REQUIRED_TOOLS = "[]";
		try {
			teamExtension({
				registerTool: (tool) => {
					this.tools.set(tool.name, tool);
				},
				on: (event, handler) => {
					if (event === "session_start") onStart = handler as () => Promise<void>;
				},
				getActiveTools: () => ["read", "bash", "edit", "write", ...this.tools.keys()],
				getAllTools: () => ["read", "bash", "edit", "write", ...this.tools.keys()].map((name) => ({ name })),
				setActiveTools: () => {},
			});
		} finally {
			for (const key of Object.keys(this.options.env ?? {})) {
				if (envBefore[key] === undefined) delete process.env[key];
				else process.env[key] = envBefore[key];
			}
		}
		await onStart?.();
	}
	async getState() {
		return { sessionId: this.sessionId, sessionFile: this.sessionFile };
	}
	async stop() {
		this.stopped = true;
	}
	async abort() {}
	suspendIdleTimeout(): () => void {
		this.idleSuspendCount += 1;
		this.idleSuspendActive = true;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.idleSuspendActive = false;
		};
	}
	onEvent(listener: (event: { type: string; [key: string]: unknown }) => void): () => void {
		this.eventListeners.add(listener);
		return () => {
			this.eventListeners.delete(listener);
		};
	}
	emitEvent(event: { type: string; [key: string]: unknown }) {
		for (const listener of this.eventListeners) listener(event);
	}
	onNotice() {
		return () => {};
	}
	private dialogHandler: Parameters<RpcWorkerLike["setDialogHandler"]>[0];
	setDialogHandler(handler: Parameters<RpcWorkerLike["setDialogHandler"]>[0]) {
		this.dialogHandler = handler;
	}
	async askDialog() {
		return await this.dialogHandler?.({
			type: "extension_ui_request",
			id: "waiting",
			method: "input",
			title: "缺失信息",
		});
	}
	async call(name: string, args: unknown, callId: string = randomUUID(), signal?: AbortSignal) {
		const tool = this.tools.get(name);
		assert.ok(tool, `Missing shipped extension tool: ${name}`);
		return await tool.execute(callId, args, signal);
	}
	async runPromptAndWait(prompt: string, options: RunPromptOptions = {}): Promise<PromptRunResult> {
		this.prompt = prompt;
		await writeFile(
			this.sessionFile,
			`${this.priorTranscript || (await readFile(this.sessionFile, "utf8"))}${JSON.stringify({ role: "user", content: prompt })}\n`,
		);
		const text = await this.respond(this, prompt, options);
		const transcript = await readFile(this.sessionFile, "utf8");
		await writeFile(this.sessionFile, `${transcript}${JSON.stringify({ role: "assistant", content: text })}\n`);
		return {
			disposition: "started",
			aborted: false,
			assistantText: text,
			assistantMessages: [],
			toolExecutions: [],
			notices: [],
			dialogs: [],
			events: [],
		};
	}
}

async function fixture(t: test.TestContext, respond: Responder) {
	const root = await mkdtemp(join(tmpdir(), "pa-continuity-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const db = openPersonalAgentDatabase(join(root, "data.db"));
	t.after(() => db.close());
	const store = new PersonalAgentStore(db);
	const templates = await loadRoleTemplatesFromDir(resolve("roles"));
	const workers: SessionWorker[] = [];
	const options = {
		store,
		templates,
		defaultCwd: root,
		sessionDir: join(root, "sessions"),
		workerFactory: (options: PiRpcWorkerOptions) => {
			const worker = new SessionWorker(options, respond);
			workers.push(worker);
			return worker;
		},
	};
	const orchestrator = new TeamOrchestrator(options);
	const workspace = store.upsertWorkspace({ name: "A", repoPath: root });
	return { root, db, store, templates, workers, options, orchestrator, workspace };
}

test("reopens exact scoped sessions after orchestrator restart, keeps lead/cwd, and separates workspaces and matters", async (t) => {
	const f = await fixture(t, async () => "讨论回复");
	const first = await f.orchestrator.dispatchMatter({
		prompt: "FIRST_PRIVATE_A",
		workspaceId: f.workspace.id,
		preferredMemberId: "product-manager",
	});
	assert.equal(first.matter.status, "open");
	assert.equal(first.deliverable, null);
	f.store.setPrimaryContact("qa-manager");
	const restarted = new TeamOrchestrator(f.options);
	assert.equal(f.store.getPrimaryContact()?.id, "qa-manager");
	const next = await restarted.dispatchMatter({ matterId: first.matter.id, prompt: "架构代码关键词也不改变负责人" });
	assert.equal(next.assignedMember.id, "product-manager");
	assert.equal(next.workspace?.id, f.workspace.id);
	assert.equal(f.workers[1]?.options.sessionFile, f.workers[0]?.sessionFile);
	assert.match(f.workers[1]?.priorTranscript ?? "", /FIRST_PRIVATE_A/);
	assert.doesNotMatch(f.workers[1]?.prompt ?? "", /FIRST_PRIVATE_A/);
	const otherPath = join(f.root, "B");
	await mkdir(otherPath);
	const other = f.store.upsertWorkspace({ name: "B", repoPath: otherPath });
	f.store.addMemory({
		memberId: "product-manager",
		scope: "company_private",
		workspaceId: f.workspace.id,
		content: "PRIVATE_COMPANY_A",
	});
	f.store.addMemory({ memberId: "product-manager", scope: "company_private", content: "UNSCOPED_COMPANY" });
	f.store.updateMatterWorkspace(first.matter.id, other.id);
	await restarted.dispatchMatter({ matterId: first.matter.id, prompt: "SECOND_PRIVATE_B" });
	assert.equal(f.workers[2]?.options.sessionFile, undefined);
	assert.doesNotMatch(f.workers[2]?.prompt ?? "", /FIRST_PRIVATE_A/);
	assert.doesNotMatch(f.workers[2]?.options.env?.PA_MEMBER_CONTEXT ?? "", /PRIVATE_COMPANY_A|UNSCOPED_COMPANY/);
	f.store.updateMatterWorkspace(first.matter.id, f.workspace.id);
	await restarted.dispatchMatter({ matterId: first.matter.id, prompt: "返回 A" });
	assert.equal(f.workers[3]?.options.sessionFile, f.workers[0]?.sessionFile);
	assert.doesNotMatch(f.workers[3]?.prompt ?? "", /SECOND_PRIVATE_B/);
	assert.match(f.workers[3]?.options.env?.PA_MEMBER_CONTEXT ?? "", /PRIVATE_COMPANY_A/);
	await restarted.dispatchMatter({
		prompt: "独立事项",
		workspaceId: f.workspace.id,
		preferredMemberId: "product-manager",
	});
	assert.equal(f.workers[4]?.options.sessionFile, undefined);
	assert.doesNotMatch(f.workers[4]?.prompt ?? "", /FIRST_PRIVATE_A|SECOND_PRIVATE_B/);
	assert.equal(f.store.listDeliverables().length, 0);
	assert.ok(f.workers.every((worker) => worker.stopped));
	assert.ok(
		f.db
			.prepare("SELECT status FROM worker_sessions")
			.all()
			.every((row) => row.status === "idle"),
	);
});

test("shipped tool delegates to a real colleague execution and returns internal results, with idempotency and cycle boundaries", async (t) => {
	let engineerCalls = 0;
	const f = await fixture(t, async (worker) => {
		if (worker.options.env?.PA_MEMBER_ID === "engineering-manager") {
			engineerCalls++;
			assert.match(worker.prompt, /用户目标/);
			await assert.rejects(
				worker.call("delegate_to_member", { memberId: "product-manager", task: "call ancestor" }),
				/cycle/,
			);
			return "技术依据：采用持久会话";
		}
		const args = { memberId: "engineering-manager", task: "请针对用户目标提供技术意见" };
		const answer = await worker.call("delegate_to_member", args, "same-call");
		assert.match(JSON.stringify(answer), /技术依据/);
		assert.deepEqual(await worker.call("delegate_to_member", args, "same-call"), answer);
		await worker.call("delegate_to_member", args, "different-call-same-question");
		await assert.rejects(
			worker.call("delegate_to_member", { memberId: "missing", task: "unknown" }),
			/existing team members/,
		);
		await assert.rejects(worker.call("delegate_to_member", { memberId: "product-manager", task: "self" }), /cycle/);
		return "产品方案已结合研发意见，仍需确认一个产品取舍。";
	});
	const result = await f.orchestrator.dispatchMatter({
		prompt: "用户目标：完善方案，先请研发提供意见",
		workspaceId: f.workspace.id,
		preferredMemberId: "product-manager",
	});
	assert.equal(engineerCalls, 1);
	assert.equal(result.deliverable, null);
	assert.equal(f.store.listMessages(result.matter.id, "user").length, 2);
	const internal = f.store.listMessages(result.matter.id, "internal_collab");
	assert.equal(internal.length, 2);
	assert.match(internal[1]?.content ?? "", /技术依据/);
	assert.ok(f.workers[0]?.options.args?.some((arg) => arg.endsWith("requirement-clarification/SKILL.md")));
	assert.match(f.workers[0]?.options.env?.PA_MEMBER_CONTEXT ?? "", /Collaboration and communication/);
});

test("archives explicit verified deliverables and versions them, rejects missing/outside files, discards drafts on failure", async (t) => {
	let shouldFail = false;
	const f = await fixture(t, async (worker) => {
		await assert.rejects(
			worker.call("publish_deliverable", {
				type: "artifact",
				changeNote: "经验证的阶段文件",
				title: "missing",
				content: "missing.txt",
			}),
			/ENOENT/,
		);
		await assert.rejects(
			worker.call("publish_deliverable", {
				type: "artifact",
				changeNote: "经验证的阶段文件",
				title: "outside",
				content: `../${f.root.split("/").at(-1)}-outside.txt`,
			}),
			/workspace/,
		);
		await assert.rejects(
			worker.call("publish_deliverable", {
				type: "service_url",
				changeNote: "正式预览链接",
				title: "bad",
				content: "file:///etc/passwd",
			}),
			/http/,
		);
		await worker.call(
			"publish_deliverable",
			{
				type: "document",
				changeNote: "完成本轮设计与验证，形成阶段版本",
				title: "设计说明",
				content: "正式设计文档，含验收条件。",
			},
			"document",
		);
		await worker.call("publish_deliverable", {
			type: "artifact",
			changeNote: "经验证的阶段文件",
			title: "示例文件",
			content: "result.txt",
		});
		if (shouldFail) throw new Error("provider failed after staging");
		return "已整理设计与实际文件。";
	});
	// Sibling file exists but is never a valid artifact for this workspace.
	await writeFile(join(f.root, "result.txt"), "actual artifact");
	await writeFile(join(f.root, "..", `${f.root.split("/").at(-1)}-outside.txt`), "outside");
	t.after(() => rm(join(f.root, "..", `${f.root.split("/").at(-1)}-outside.txt`), { force: true }));
	const first = await f.orchestrator.dispatchMatter({ prompt: "交付正式设计", workspaceId: f.workspace.id });
	assert.equal(first.matter.status, "delivered");
	assert.equal(f.store.listDeliverables(first.matter.id).length, 2);
	await f.orchestrator.dispatchMatter({ matterId: first.matter.id, prompt: "再次交付" });
	assert.equal(f.store.listDeliverables(first.matter.id).length, 4);
	assert.ok(f.store.listDeliverables(first.matter.id).filter((d) => d.version === 2).length === 2);
	shouldFail = true;
	await assert.rejects(
		f.orchestrator.dispatchMatter({ matterId: first.matter.id, prompt: "失败" }),
		/provider failed/,
	);
	assert.equal(f.store.listDeliverables(first.matter.id).length, 4);
	assert.equal(f.store.getMatter(first.matter.id)?.status, "open");
	shouldFail = false;
	await f.orchestrator.dispatchMatter({ matterId: first.matter.id, prompt: "失败后接续" });
	assert.equal(f.workers[3]?.options.sessionFile, f.workers[2]?.sessionFile);
	assert.match(f.workers[3]?.priorTranscript ?? "", /失败/);
});

test("cancellation propagates into delegated worker, rejects concurrent turns, cleans up and resumes", async (t) => {
	let notifyStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		notifyStarted = resolve;
	});
	let cancelledChild = false;
	let continueNormally = false;
	const f = await fixture(t, async (worker, _prompt, options) => {
		if (continueNormally) return "继续处理完成";
		if (worker.options.env?.PA_MEMBER_ID === "engineering-manager") {
			notifyStarted();
			await new Promise<void>((_resolve, reject) =>
				options.signal?.addEventListener(
					"abort",
					() => {
						cancelledChild = true;
						reject(new Error("child aborted"));
					},
					{ once: true },
				),
			);
		}
		await worker.call(
			"delegate_to_member",
			{ memberId: "engineering-manager", task: "耗时设计" },
			"slow",
			options.signal,
		);
		return "不会到达";
	});
	const matter = f.store.createMatter({ title: "取消", leadMemberId: "product-manager", workspaceId: f.workspace.id });
	const running = f.orchestrator.dispatchMatter({ matterId: matter.id, prompt: "协作执行" });
	await started;
	const competing = new TeamOrchestrator(f.options);
	await assert.rejects(competing.dispatchMatter({ matterId: matter.id, prompt: "第二个宿主" }), /active turn/);
	await assert.rejects(f.orchestrator.dispatchMatter({ matterId: matter.id, prompt: "并发请求" }), /active turn/);
	assert.equal(await f.orchestrator.abortMatter(matter.id), true);
	const result = await running;
	assert.equal(result.runResult.aborted, true);
	assert.equal(cancelledChild, true);
	assert.ok(f.workers.every((worker) => worker.stopped));
	assert.equal(f.store.listDeliverables(matter.id).length, 0);
	const abortedMessages = f.store.listMessages(matter.id, "user");
	assert.equal(abortedMessages.length, 2);
	const abortedSnap = abortedMessages[1]?.metadata?.progressSnapshot as
		| {
				outcome?: string;
				stage?: string;
				activeDelegations?: Array<{ memberId: string; memberName: string }>;
				recentLogs?: Array<{ memberName: string; summary: string }>;
		  }
		| undefined;
	assert.equal(abortedSnap?.outcome, "aborted");
	assert.ok(abortedSnap?.activeDelegations?.some((entry) => entry.memberId === "engineering-manager"));
	assert.ok(abortedSnap?.recentLogs?.some((entry) => /耗时设计|委托/.test(entry.summary)));
	assert.equal(await f.orchestrator.abortMatter(matter.id), false);
	continueNormally = true;
	await f.orchestrator.dispatchMatter({ matterId: matter.id, prompt: "停止后继续" });
	assert.equal(f.workers[2]?.options.sessionFile, f.workers[0]?.sessionFile);
	assert.match(f.workers[2]?.prompt ?? "", /## Previous interruption and resume brief/);
	assert.match(f.workers[2]?.prompt ?? "", /Stopped by the user/);
	assert.match(f.workers[2]?.prompt ?? "", /Engineering Manager/);
	assert.match(f.workers[2]?.prompt ?? "", /耗时设计/);
	await f.orchestrator.dispatchMatter({ matterId: matter.id, prompt: "正常完成后的下一问" });
	assert.doesNotMatch(f.workers[3]?.prompt ?? "", /## Previous interruption and resume brief/);
});

test("fails clearly for missing sessions, skills or required runtime tools and cleans up startup failures", async (t) => {
	const f = await fixture(t, async () => "ok");
	const first = await f.orchestrator.dispatchMatter({
		prompt: "会话",
		workspaceId: f.workspace.id,
		preferredMemberId: "product-manager",
	});
	await rm(f.workers[0]!.sessionFile);
	await assert.rejects(f.orchestrator.dispatchMatter({ matterId: first.matter.id, prompt: "继续" }), /ENOENT/);
	assert.equal(f.workers.length, 1, "missing saved session must not silently start a new one");
	const missingSkill = new TeamOrchestrator({
		...f.options,
		templates: f.templates.map((template) => ({ ...template, skills: ["not-installed"] })),
	});
	await assert.rejects(missingSkill.dispatchMatter({ prompt: "能力" }), /not installed/);
	const missingTool = new TeamOrchestrator({
		...f.options,
		templates: f.templates.map((template) => ({ ...template, tools: ["web_search"] })),
	});
	await assert.rejects(
		missingTool.dispatchMatter({ prompt: "能力" }),
		/Required capabilities unavailable: web_search/,
	);
	assert.ok(f.workers.every((worker) => worker.stopped));
	let stopped = false;
	const startupFailure = new TeamOrchestrator({
		...f.options,
		workerFactory: (options) => {
			const worker = new SessionWorker(options, async () => "");
			worker.start = async () => {
				throw new Error("spawn failure");
			};
			worker.stop = async () => {
				stopped = true;
			};
			return worker;
		},
	});
	await assert.rejects(startupFailure.dispatchMatter({ prompt: "启动" }), /spawn failure/);
	assert.equal(stopped, true);
});

test("internal specialists cannot publish user deliverables and the lead receives their failure", async (t) => {
	const f = await fixture(t, async (worker) => {
		if (worker.options.env?.PA_MEMBER_ID === "engineering-manager") {
			const draft = { type: "document", changeNote: "内部讨论不应归档", title: "不完整草稿", content: "尚未验证" };
			assert.equal(worker.tools.has("publish_deliverable"), false);
			await assert.rejects(worker.call("publish_deliverable", draft), /Missing shipped extension tool/);
			// Even a forged transport request must be rejected by the host, beyond model tool filtering.
			await assert.rejects(invokeTool(worker.options, "publish_deliverable", draft), /only the lead publishes/);
			throw new Error("colleague provider failure");
		}
		await assert.rejects(
			worker.call("delegate_to_member", { memberId: "engineering-manager", task: "技术意见" }),
			/colleague provider failure/,
		);
		return "研发暂时未能完成，现有信息不足以确认技术方案。";
	});
	const result = await f.orchestrator.dispatchMatter({
		prompt: "设计咨询",
		preferredMemberId: "product-manager",
		workspaceId: f.workspace.id,
	});
	assert.equal(result.deliverable, null);
	assert.equal(result.matter.status, "open");
	assert.ok(f.store.listMessages(result.matter.id, "internal_collab").some((message) => message.metadata?.failed));
});

test("delegations enforce depth and turn budget without preventing professional handoffs", async (t) => {
	const f = await fixture(t, async (worker) => {
		if (worker.options.env?.PA_MEMBER_ID === "engineering-manager") {
			await worker.call("delegate_to_member", { memberId: "qa-manager", task: "复核风险" });
			return "技术建议";
		}
		if (worker.options.env?.PA_MEMBER_ID === "qa-manager") {
			if (!worker.prompt.includes("Internal delegation from Engineering Manager")) return "测试意见";
			await assert.rejects(
				worker.call("delegate_to_member", { memberId: "marketing-lead", task: "第四层委托" }),
				/depth limit/,
			);
			return "测试意见";
		}
		await worker.call("delegate_to_member", { memberId: "engineering-manager", task: "建议" });
		for (let i = 0; i < 6; i++)
			await worker.call("delegate_to_member", { memberId: "qa-manager", task: `独立问题 ${i}` });
		await assert.rejects(
			worker.call("delegate_to_member", { memberId: "qa-manager", task: "第九次" }),
			/limit reached/,
		);
		return "已整合专业意见";
	});
	await f.orchestrator.dispatchMatter({
		prompt: "协作边界",
		preferredMemberId: "product-manager",
		workspaceId: f.workspace.id,
	});
	assert.equal(f.workers.length, 9);
});

test("a changed saved session header is rejected, and the session directory alone never chooses a conversation", async (t) => {
	const f = await fixture(t, async () => "ok");
	const result = await f.orchestrator.dispatchMatter({ prompt: "私有内容", workspaceId: f.workspace.id });
	await writeFile(f.workers[0]!.sessionFile, `${JSON.stringify({ type: "session", id: "foreign", cwd: f.root })}\n`);
	await assert.rejects(
		f.orchestrator.dispatchMatter({ matterId: result.matter.id, prompt: "继续" }),
		/identity or workspace/,
	);
	const another = await f.orchestrator.dispatchMatter({ prompt: "另一事项", workspaceId: f.workspace.id });
	assert.notEqual(result.matter.id, another.matter.id);
	assert.equal(f.workers[1]?.options.sessionFile, undefined);
});

test("turn deadline cancels the entire collaboration without treating it as successful completion", async (t) => {
	const f = await fixture(t, async (_worker, _prompt, options) => {
		await new Promise<void>((_resolve, reject) =>
			options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true }),
		);
		return "unreachable";
	});
	const matter = f.store.createMatter({
		title: "deadline",
		leadMemberId: "product-manager",
		workspaceId: f.workspace.id,
	});
	await assert.rejects(
		f.orchestrator.dispatchMatter({ matterId: matter.id, prompt: "执行", timeoutMs: 100 }),
		/timed out/,
	);
	assert.ok(f.workers.every((worker) => worker.stopped));
	assert.equal(f.store.getMatter(matter.id)?.status, "open");
	assert.equal(f.store.listDeliverables(matter.id).length, 0);
});

test("shutdown cancels a host dialog wait and waits for cleanup before releasing the database", async (t) => {
	let dialogOpened!: () => void;
	const opened = new Promise<void>((resolve) => {
		dialogOpened = resolve;
	});
	const f = await fixture(t, async (worker) => {
		await worker.askDialog();
		return "not reached";
	});
	f.orchestrator.setDialogHandler(() => {
		dialogOpened();
		return new Promise(() => {});
	});
	const running = f.orchestrator.dispatchMatter({ prompt: "提问", workspaceId: f.workspace.id });
	await opened;
	await f.orchestrator.shutdown();
	const res = await running;
	assert.equal(res.runResult.aborted, true);
	assert.match(res.replyText, /服务正在关闭或重启/);
	assert.ok(f.workers.every((worker) => worker.stopped));
	assert.equal(f.db.prepare("SELECT * FROM matter_execution_leases").all().length, 0);
});

test("abortMatter waits for execution cleanup and releases the lease before reporting completion", async (t) => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const f = await fixture(t, async (_worker, _prompt, options) => {
		entered.resolve();
		await new Promise<void>((done) => options.signal?.addEventListener("abort", () => done(), { once: true }));
		await release.promise;
		return "已停止";
	});
	const matter = f.store.createMatter({ title: "stop then change context", workspaceId: f.workspace.id });
	const pending = f.orchestrator.dispatchMatter({ matterId: matter.id, prompt: "work" });
	await entered.promise;
	let stopped = false;
	const stopping = f.orchestrator.abortMatter(matter.id).then(() => {
		stopped = true;
	});
	try {
		await new Promise<void>((done) => setImmediate(done));
		assert.equal(stopped, false);
	} finally {
		release.resolve();
		await pending;
		await stopping;
	}
	assert.equal(f.orchestrator.isMatterRunning(matter.id), false);
	assert.equal(f.db.prepare("SELECT count(*) AS n FROM matter_execution_leases").get()?.n, 0);
});

test("legacy sessions without proven organization scope remain archived while a fresh scoped session starts", async (t) => {
	const f = await fixture(t, async () => "ok");
	const first = await f.orchestrator.dispatchMatter({ prompt: "old", workspaceId: f.workspace.id });
	f.db.exec("UPDATE worker_sessions SET context_key = NULL, message_cursor = NULL");
	f.store.appendMessage({
		matterId: first.matter.id,
		channel: "user",
		senderType: "member",
		senderId: first.assignedMember.id,
		content: "LEGACY_UNSCOPED_BACKGROUND",
	});
	await f.orchestrator.dispatchMatter({ matterId: first.matter.id, prompt: "continue" });
	assert.equal(f.workers[1]?.options.sessionFile, undefined);
	assert.notEqual(f.workers[1]?.sessionFile, f.workers[0]?.sessionFile);
	assert.match(await readFile(f.workers[0]!.sessionFile, "utf8"), /old/);
	assert.doesNotMatch(f.workers[1]?.prompt ?? "", /LEGACY_UNSCOPED_BACKGROUND/);
	assert.ok(f.store.listMessages(first.matter.id).some((message) => message.content === "LEGACY_UNSCOPED_BACKGROUND"));
});

test("multiple process conversations stay in chat; explicit substantial milestone publishes one version with its change basis", async (t) => {
	const f = await fixture(t, async (worker, prompt) => {
		if (prompt.includes("发布阶段设计版本")) {
			await worker.call("publish_deliverable", {
				type: "document",
				title: "便笺设计",
				content: "已整合单人、本地文本范围，定义保存与恢复的验收条件。",
				changeNote: "根据前面三轮范围澄清，形成可审阅的阶段设计版本。",
				summary: "便笺阶段设计",
			});
		}
		return "已记下本次讨论。";
	});
	const first = await f.orchestrator.dispatchMatter({
		prompt: "先讨论目标",
		preferredMemberId: "product-manager",
		workspaceId: f.workspace.id,
	});
	for (const prompt of ["澄清一个限制", "修改「便笺设计」的一个术语，先讨论不发布"]) {
		const result = await f.orchestrator.dispatchMatter({ matterId: first.matter.id, prompt });
		assert.equal(result.deliverable, null);
		assert.equal(f.store.listDeliverables(first.matter.id).length, 0);
	}
	const released = await f.orchestrator.dispatchMatter({ matterId: first.matter.id, prompt: "发布阶段设计版本" });
	assert.equal(released.deliverable?.version, 1);
	assert.match(released.deliverable?.summary ?? "", /前面三轮范围澄清/);
	const reply = f.store.listMessages(first.matter.id, "user").at(-1);
	assert.deepEqual(reply?.metadata?.deliverableIds, [released.deliverable?.id]);
	assert.ok(reply?.metadata?.sourceUserMessageId);
	await f.orchestrator.dispatchMatter({ matterId: first.matter.id, prompt: "随后继续讨论一个小问题" });
	assert.equal(f.store.listDeliverables(first.matter.id).length, 1);
});

test("delegation suspends parent idle watchdog and forwards colleague progress and collab updates", async (t) => {
	const f = await fixture(t, async (worker) => {
		if (worker.options.env?.PA_MEMBER_ID === "engineering-manager") {
			assert.equal(f.workers[0]?.idleSuspendActive, true);
			worker.emitEvent({
				type: "tool_execution_start",
				toolName: "read",
				toolCallId: "eng-read",
				args: { path: "docs/prd.md" },
			});
			worker.emitEvent({ type: "tool_execution_end", toolName: "read", toolCallId: "eng-read" });
			return "技术方案已完成读取分析。";
		}
		assert.equal(worker.idleSuspendActive, false);
		await worker.call("delegate_to_member", {
			memberId: "engineering-manager",
			task: "分析架构与读取关键文件",
		});
		assert.equal(worker.idleSuspendActive, false);
		assert.ok(worker.idleSuspendCount >= 1);
		return "已汇总研发分析结论。";
	});
	const events: Array<{
		stage: string;
		label: string;
		collabUpdated?: boolean;
		activeNames: string[];
		recentSummaries: string[];
	}> = [];
	const result = await f.orchestrator.dispatchMatter({
		prompt: "用户目标：启动并行技术评估",
		workspaceId: f.workspace.id,
		preferredMemberId: "product-manager",
		onProgress: (evt) => {
			events.push({
				stage: evt.stage,
				label: evt.label,
				collabUpdated: evt.collabUpdated,
				activeNames: (evt.activeDelegations ?? []).map((entry) => entry.memberName),
				recentSummaries: (evt.recentLogs ?? []).map((item) => `${item.memberName}:${item.summary}`),
			});
		},
	});
	assert.match(result.replyText, /已汇总研发分析结论/);
	assert.ok(events.some((evt) => evt.collabUpdated === true && evt.activeNames.includes("Engineering Manager")));
	assert.ok(
		events.some((evt) => evt.stage === "tool" && /Engineering Manager/.test(evt.label) && /读取文件/.test(evt.label)),
	);
	assert.ok(
		events.some((evt) =>
			evt.recentSummaries.some((line) => /Engineering Manager:读取文件：docs\/prd\.md/.test(line)),
		),
	);
	assert.ok(events.some((evt) => evt.collabUpdated === true && evt.activeNames.length === 0));
});

test("failed delegation is not permanently cached so same-task retry runs a fresh worker", async (t) => {
	let engineerAttempts = 0;
	const f = await fixture(t, async (worker) => {
		if (worker.options.env?.PA_MEMBER_ID === "engineering-manager") {
			engineerAttempts += 1;
			if (engineerAttempts === 1) throw new Error("temporary network interruption");
			return "重试后已完成评估。";
		}
		const args = { memberId: "engineering-manager", task: "核查可行性与工作量" };
		await assert.rejects(worker.call("delegate_to_member", args, "attempt-1"), /temporary network interruption/);
		const retryResult = await worker.call("delegate_to_member", args, "attempt-2");
		assert.match(JSON.stringify(retryResult), /重试后已完成评估/);
		return "已通过重试拿到研发经理评估。";
	});
	const result = await f.orchestrator.dispatchMatter({
		prompt: "请让研发经理核查评估",
		workspaceId: f.workspace.id,
		preferredMemberId: "product-manager",
	});
	assert.equal(engineerAttempts, 2);
	assert.match(result.replyText, /已通过重试拿到研发经理评估/);
});

test("proactive observer chimes in with independent user bubble while silent observer writes nothing", async (t) => {
	let pmPromptCount = 0;
	let emPromptCount = 0;
	let qaPromptCount = 0;
	const f = await fixture(t, async (worker, prompt) => {
		const ctx = worker.options.env?.PA_MEMBER_CONTEXT ?? "";
		if (worker.options.env?.PA_MEMBER_ID === "engineering-manager") {
			emPromptCount += 1;
			assert.equal(worker.options.env?.PA_CAN_PUBLISH, "false");
			assert.equal(worker.options.env?.PA_CAN_DELEGATE, "false");
			assert.equal(worker.tools.has("publish_deliverable"), false);
			assert.equal(worker.tools.has("delegate_to_member"), false);
			assert.match(ctx, /## Observer participation/);
			assert.match(prompt, /方案将直接同步拉取全库 10 万条记录/);
			return "技术提醒：首屏直接同步拉取 10 万条会阻塞主线程，建议改为分页+IndexedDB 增量缓存。";
		}
		if (worker.options.env?.PA_MEMBER_ID === "qa-manager") {
			qaPromptCount += 1;
			assert.equal(worker.options.env?.PA_CAN_PUBLISH, "false");
			return "[SILENT]";
		}
		pmPromptCount += 1;
		return "好的，我们方案将直接同步拉取全库 10 万条记录，先推进需求定义。";
	});
	const result = await f.orchestrator.dispatchMatter({
		prompt: "请评估书架首屏加载方案",
		workspaceId: f.workspace.id,
		preferredMemberId: "product-manager",
		observerMemberIds: ["engineering-manager", "qa-manager"],
	});
	assert.equal(pmPromptCount, 1);
	assert.equal(emPromptCount, 1);
	assert.equal(qaPromptCount, 1);
	assert.equal(result.observerMessages?.length, 1);
	const userMessages = f.store.listMessages(result.matter.id, "user");
	assert.equal(userMessages.length, 3);
	assert.equal(userMessages[1]?.senderId, "product-manager");
	assert.equal(userMessages[2]?.senderId, "engineering-manager");
	assert.equal(userMessages[2]?.metadata?.observerIntervention, true);
	assert.equal(userMessages[2]?.metadata?.leadMemberId, "product-manager");
	assert.match(userMessages[2]?.content ?? "", /分页\+IndexedDB 增量缓存/);
	assert.equal(
		userMessages.some((msg) => msg.senderId === "qa-manager"),
		false,
	);
	assert.equal(f.store.listDeliverables(result.matter.id).length, 0);
	assert.deepEqual(f.store.getMatter(result.matter.id)?.observerMemberIds, ["engineering-manager", "qa-manager"]);
});

test("late-joining observer receives summarized background digest rather than full historical session logs", async (t) => {
	const observerPrompts: string[] = [];
	const f = await fixture(t, async (worker, prompt) => {
		if (worker.options.env?.PA_MEMBER_ID === "engineering-manager") {
			observerPrompts.push(prompt);
			return "[SILENT]";
		}
		if (prompt.includes("第1轮")) {
			f.store.appendMessage({
				matterId: f.store.listMatters()[0]!.id,
				channel: "internal_collab",
				senderType: "member",
				senderId: "product-manager",
				content: "INTERNAL_SECRET_TRACE_SHOULD_NOT_LEAK",
			});
			return `第1轮长篇细节：${"A".repeat(1200)}_TAIL_MARKER_IGNORED`;
		}
		return "第2轮讨论：先定边界再开发。";
	});
	const turn1 = await f.orchestrator.dispatchMatter({
		prompt: "第1轮先讨论历史方案",
		workspaceId: f.workspace.id,
		preferredMemberId: "product-manager",
	});
	await f.orchestrator.dispatchMatter({
		matterId: turn1.matter.id,
		prompt: "第2轮把研发拉进旁听",
		workspaceId: f.workspace.id,
		preferredMemberId: "product-manager",
		observerMemberIds: ["engineering-manager"],
	});
	assert.equal(observerPrompts.length, 1);
	const seen = observerPrompts[0]!;
	assert.match(seen, /Brief background for the observer/);
	assert.doesNotMatch(seen, /INTERNAL_SECRET_TRACE_SHOULD_NOT_LEAK/);
	assert.doesNotMatch(seen, /TAIL_MARKER_IGNORED/);
	assert.match(seen, /第2轮讨论：先定边界再开发/);
});

test("aborted turn skips observer evaluation", async (t) => {
	let workerCount = 0;
	let markStarted!: () => void;
	const started = new Promise<void>((resolveStarted) => {
		markStarted = resolveStarted;
	});
	const f = await fixture(t, async (_worker, _prompt, options) => {
		workerCount += 1;
		markStarted();
		await new Promise((_resolve, reject) => {
			options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
		});
		return "unreachable";
	});
	const matter = f.store.createMatter({
		title: "Abort observer check",
		leadMemberId: "product-manager",
		workspaceId: f.workspace.id,
		observerMemberIds: ["engineering-manager"],
	});
	const pending = f.orchestrator.dispatchMatter({
		matterId: matter.id,
		prompt: "开始一个将被取消的任务",
		workspaceId: f.workspace.id,
		preferredMemberId: "product-manager",
	});
	await started;
	await f.orchestrator.abortMatter(matter.id);
	const res = await pending;
	assert.equal(res.runResult.aborted, true);
	assert.equal(workerCount, 1);
	assert.equal(res.observerMessages?.length ?? 0, 0);
});

test("dispatchMatter forwards attached images to lead and observer workers without bloating DB metadata", async (t) => {
	const receivedImagesByMember = new Map<string, Array<{ type: string; data: string; mimeType: string }>>();
	const lateObserverPrompts: string[] = [];
	const pngBase64 = Buffer.from("fake-png-bytes").toString("base64");

	const f = await fixture(t, async (worker, prompt, options) => {
		if (worker.options.env?.PA_MEMBER_ID === "qa-manager") {
			lateObserverPrompts.push(prompt);
			return "[SILENT]";
		}
		const memberKey =
			worker.options.env?.PA_MEMBER_ID === "engineering-manager" ? "engineering-manager" : "product-manager";
		if (options.images) {
			receivedImagesByMember.set(memberKey, options.images);
		}
		if (memberKey === "engineering-manager") {
			return "[SILENT]";
		}
		return "已查看你上传的界面截图。";
	});

	const firstTurn = await f.orchestrator.dispatchMatter({
		prompt: "",
		images: [
			{
				type: "image",
				data: pngBase64,
				mimeType: "image/png",
				name: "wireframe.png",
				url: "/api/uploads/test-wireframe.png",
			},
		],
		workspaceId: f.workspace.id,
		preferredMemberId: "product-manager",
		observerMemberIds: ["engineering-manager"],
	});

	assert.equal(firstTurn.matter.title, "图片：wireframe.png");
	assert.deepEqual(receivedImagesByMember.get("product-manager"), [
		{ type: "image", data: pngBase64, mimeType: "image/png" },
	]);
	assert.deepEqual(receivedImagesByMember.get("engineering-manager"), [
		{ type: "image", data: pngBase64, mimeType: "image/png" },
	]);

	const storedMessages = f.store.listMessages(firstTurn.matter.id, "user");
	const userMsg = storedMessages.find((msg) => msg.senderType === "user");
	assert.ok(userMsg);
	assert.equal(userMsg.content, "");
	assert.deepEqual(userMsg.metadata?.images, [
		{ url: "/api/uploads/test-wireframe.png", mimeType: "image/png", name: "wireframe.png" },
	]);
	assert.equal(JSON.stringify(userMsg.metadata).includes(pngBase64), false);

	await f.orchestrator.dispatchMatter({
		matterId: firstTurn.matter.id,
		prompt: "请结合刚才那张图补充说明",
		workspaceId: f.workspace.id,
		preferredMemberId: "product-manager",
		observerMemberIds: ["engineering-manager", "qa-manager"],
	});
	assert.equal(lateObserverPrompts.length, 1);
	assert.match(lateObserverPrompts[0]!, /\[Image attachments: 1\]/);
});
