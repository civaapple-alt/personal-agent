import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import humanQuestionExtension from "../pi-extensions/human-question/index.ts";
import teamExtension, { type PiExtensionApi } from "../pi-extensions/team-extension/index.ts";
import type { DecisionClassifier } from "../src/orchestrator/system-one.ts";
import {
	type DispatchProgressEvent,
	type RpcWorkerLike,
	TeamOrchestrator,
} from "../src/orchestrator/team-orchestrator.ts";
import { resolveBuiltinExtensionPath } from "../src/pa-extensions/builtin-paths.ts";
import {
	isGuideTopic,
	isWorkbenchTopic,
	readWorkbenchGuide,
	WORKBENCH_TOPICS,
} from "../src/pa-extensions/workbench-help/catalog.ts";
import { BUILTIN_ROLE_ARCHITECT_TEMPLATE } from "../src/roles/role-architect.ts";
import { loadRoleTemplatesFromDir } from "../src/roles/template-loader.ts";
import type { PiRpcWorkerOptions, PromptRunResult, RunPromptOptions } from "../src/rpc/pi-rpc-worker.ts";
import { createPersonalAgentServer } from "../src/server/app.ts";
import { DialogBroker } from "../src/server/dialog-broker.ts";
import { PreviewManager } from "../src/server/preview-manager.ts";
import { openPersonalAgentDatabase } from "../src/storage/database.ts";
import { PersonalAgentStore } from "../src/storage/repositories.ts";
import type { Matter, MatterMessage } from "../src/storage/types.ts";
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
		this.sessionFile = options.sessionFile ?? join(options.sessionDir ?? options.cwd!, `${this.sessionId}.jsonl`);
	}
	async start(): Promise<void> {
		await mkdir(this.options.sessionDir ?? this.options.cwd!, { recursive: true });
		if (this.options.sessionFile) this.priorTranscript = await readFile(this.sessionFile, "utf8");
		else
			await writeFile(
				this.sessionFile,
				`${JSON.stringify({ type: "session", id: this.sessionId, cwd: this.options.cwd })}\n`,
			);
		if (this.options.env?.PA_DECISION_NAME) return;
		let onStart: (() => Promise<void>) | undefined;
		const envBefore = { ...process.env };
		Object.assign(process.env, this.options.env);
		process.env.PA_REQUIRED_TOOLS = "[]";
		try {
			const registerTool: PiExtensionApi["registerTool"] = (tool) => {
				this.tools.set(tool.name, tool);
			};
			teamExtension({
				registerTool,
				on: (event, handler) => {
					if (event === "session_start") onStart = handler as () => Promise<void>;
				},
				getActiveTools: () => ["read", "bash", "edit", "write", ...this.tools.keys()],
				getAllTools: () => ["read", "bash", "edit", "write", ...this.tools.keys()].map((name) => ({ name })),
				setActiveTools: () => {},
			});
			if (this.options.args?.includes(resolveBuiltinExtensionPath("human-question"))) {
				humanQuestionExtension({ registerTool });
			}
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

async function fixture(t: test.TestContext, respond: Responder, classifier?: DecisionClassifier) {
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
		classifier,
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

test("team discussion is opt-in, preserves the roster and deliverables, and uses separate Pi sessions", async (t) => {
	const failingPrompt = "@engineering-manager @qa-manager Confirm the second discussion reply";
	const f = await fixture(t, async (worker, prompt) => {
		const memberId = worker.options.env?.PA_MEMBER_ID;
		if (memberId === "qa-manager" && prompt.endsWith(failingPrompt)) throw new Error("Discussion worker failed");
		return `Reply from ${memberId}`;
	});
	const { server } = createPersonalAgentServer({
		store: f.store,
		orchestrator: f.orchestrator,
		templates: f.templates,
		uploadsDir: join(f.root, "uploads"),
		dialogBroker: new DialogBroker(),
		previewManager: new PreviewManager(),
	});
	await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
	t.after(() => {
		server.closeAllConnections();
		server.close();
	});
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const url = `http://127.0.0.1:${address.port}`;
	const request = async (path: string, method: "POST" | "PATCH", input: object) => {
		const response = await fetch(url + path, {
			method,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		});
		const body = await response.json();
		assert.ok(response.ok, JSON.stringify(body));
		return body as {
			aiDiscussionTriggered?: boolean;
			aiDiscussionSkippedReason?: string;
			message: MatterMessage;
			matter: Matter;
		};
	};
	const waitForTurn = async (matterId: string) => {
		const deadline = Date.now() + 5_000;
		while (f.orchestrator.isMatterRunning(matterId) && Date.now() < deadline) {
			await new Promise((wait) => setTimeout(wait, 10));
		}
		assert.equal(f.orchestrator.isMatterRunning(matterId), false);
	};

	const first = await f.orchestrator.dispatchMatter({
		prompt: "Publish the initial design",
		preferredMemberId: "engineering-manager",
		workspaceId: f.workspace.id,
		aiMemberIds: ["engineering-manager", "qa-manager", "product-manager"],
		consultMemberIds: ["qa-manager"],
		observerMemberIds: ["qa-manager"],
		deliverableTitle: "Initial design",
	});
	const matterPath = `/api/matters/${first.matter.id}`;
	const initialWorkerCount = f.workers.length;
	const off = await request(`${matterPath}/messages`, "POST", {
		mode: "discussion",
		discussionAi: true,
		prompt: "@qa-manager Review the initial design",
	});
	assert.equal(off.aiDiscussionSkippedReason, "disabled");
	assert.equal(f.workers.length, initialWorkerCount);

	await request(matterPath, "PATCH", { consultMemberIds: [] });
	assert.deepEqual(f.store.getMatter(first.matter.id)?.observerMemberIds, ["qa-manager"]);
	assert.deepEqual(f.store.getMatter(first.matter.id)?.aiMemberIds, [
		"engineering-manager",
		"qa-manager",
		"product-manager",
	]);
	await request(matterPath, "PATCH", { discussionAiEnabled: true });
	const on = await request(`${matterPath}/messages`, "POST", {
		mode: "discussion",
		prompt: "@qa-manager @engineering-manager What should we verify?",
	});
	assert.equal(on.aiDiscussionTriggered, true);
	await waitForTurn(first.matter.id);
	const discussionWorkers = f.workers.slice(initialWorkerCount);
	assert.deepEqual(
		discussionWorkers.map((worker) => worker.options.env?.PA_MEMBER_ID),
		["qa-manager", "engineering-manager"],
	);
	assert.equal(
		discussionWorkers.every((worker) => !worker.tools.has("publish_deliverable")),
		true,
	);
	assert.equal(
		discussionWorkers.every((worker) => !worker.tools.has("propose_experience")),
		true,
	);
	assert.equal(discussionWorkers[1]?.options.sessionFile, undefined);
	const engineeringArgs = discussionWorkers[1]?.options.args ?? [];
	assert.ok(engineeringArgs[engineeringArgs.indexOf("--tools") + 1]?.split(",").includes("bash"));
	assert.match(discussionWorkers[1]?.options.env?.PA_MEMBER_CONTEXT ?? "", /Discussion chat mode/);
	assert.equal(f.store.getMatter(first.matter.id)?.leadMemberId, "engineering-manager");
	assert.equal(f.store.getMatter(first.matter.id)?.status, "delivered");
	assert.equal(f.store.listDeliverables(first.matter.id).length, 1);
	const messages = f.store.listMessages(first.matter.id, "user");
	assert.equal(messages.filter(({ content }) => content === on.message.content).length, 1);
	assert.deepEqual(
		messages
			.filter(({ metadata }) => metadata?.sourceUserMessageId === on.message.id)
			.map(({ senderId }) => senderId),
		["qa-manager", "engineering-manager"],
	);
	await f.orchestrator.dispatchMatter({ matterId: first.matter.id, prompt: "Continue with the verified findings" });
	const resumed = f.workers
		.slice(initialWorkerCount + 2)
		.find((worker) => worker.options.env?.PA_MEMBER_ID === "engineering-manager");
	assert.equal(resumed?.options.sessionFile, f.workers[0]?.sessionFile);
	assert.match(resumed?.prompt ?? "", /\[Discussion reply\].*Reply from qa-manager/);

	const created = await request("/api/matters", "POST", {
		mode: "discussion",
		prompt: "@qa-manager Initial discussion",
		discussionAiEnabled: true,
		preferredMemberId: "engineering-manager",
		aiMemberIds: ["engineering-manager", "qa-manager"],
	});
	assert.equal(created.aiDiscussionTriggered, true);
	await waitForTurn(created.matter.id);
	assert.deepEqual(
		f.store
			.listMessages(created.matter.id, "user")
			.map(({ senderType, senderId }) => [senderType, senderType === "member" ? senderId : "human"]),
		[
			["user", "human"],
			["member", "qa-manager"],
		],
	);

	f.store.updateMatterStatus(first.matter.id, "delivered", "Published summary");
	const failingDiscussion = await request(`${matterPath}/messages`, "POST", {
		mode: "discussion",
		prompt: failingPrompt,
	});
	assert.equal(failingDiscussion.aiDiscussionTriggered, true);
	await waitForTurn(first.matter.id);
	assert.equal(f.store.getMatter(first.matter.id)?.status, "delivered");
	assert.equal(f.store.getMatter(first.matter.id)?.summary, "Published summary");
	const replies = f.store
		.listMessages(first.matter.id, "user")
		.filter(({ metadata }) => metadata?.sourceUserMessageId === failingDiscussion.message.id);
	assert.equal(replies[0]?.senderId, "engineering-manager");
	assert.equal(replies[1]?.metadata?.failed, true);
	assert.match(replies[1]?.content ?? "", /AI 讨论未完成/);
	assert.match(JSON.stringify(replies[1]?.metadata?.progressSnapshot), /"leadMemberId":"qa-manager"/);
	assert.equal(f.store.getMatter(first.matter.id)?.leadMemberId, "engineering-manager");

	const specialist = f.templates.find(({ id }) => id === "qa-manager")!;
	f.orchestrator.registerRoleTemplate({
		...specialist,
		id: "ux-designer",
		name: "UX & Visual Designer",
		title: "UX & Visual Designer",
		isPrimaryContact: false,
	});
	await request(matterPath, "PATCH", {
		aiMemberIds: ["engineering-manager", "qa-manager", "ux-designer"],
		consultMemberIds: ["ux-designer"],
	});
	const workerCountBeforeLookup = f.workers.length;
	const lookup = await request(`${matterPath}/messages`, "POST", { mode: "discussion", prompt: "现在成员呢" });
	const roster = f.store
		.listMessages(first.matter.id, "user")
		.find((msg) => msg.metadata?.sourceUserMessageId === lookup.message.id);
	assert.equal(lookup.aiDiscussionTriggered, false);
	assert.equal(f.workers.length, workerCountBeforeLookup);
	assert.equal(roster?.senderType, "system");
	assert.match(roster?.content ?? "", /Engineering Manager · 负责人/);
	assert.match(roster?.content ?? "", /UX & Visual Designer · 可请教/);
	assert.doesNotMatch(roster?.content ?? "", /Product Manager/);

	const assignment = await request(`${matterPath}/messages`, "POST", {
		mode: "discussion",
		prompt: "现在有哪些成员需要调整分工？",
	});
	assert.equal(assignment.aiDiscussionTriggered, true);
	await waitForTurn(first.matter.id);
	const context = f.workers.at(-1)?.options.env?.PA_TURN_CONTEXT ?? "";
	assert.match(context, /ux-designer: UX & Visual Designer/);
	assert.match(context, /Treat earlier replies, plans, and saved proposals as historical/);
});

test("one conversation entry point saves chat, routes questions and work, and confirms uncertain execution", async (t) => {
	const incomplete = "这一段可能也要改";
	const direct = "跑一下登录回归并记录结果";
	const impersonation = "不要执行，只讨论「删除登录模块」";
	const softQuestion = "我想看一下 现在「待你决定」的使用方式";
	const observerStarted = Promise.withResolvers<void>();
	let observerInterrupted = false;
	const f = await fixture(t, async (worker, prompt, options) => {
		if (worker.options.env?.PA_DECISION_NAME) {
			assert.equal(worker.options.noSession, true);
			assert.equal(worker.options.args?.at(-1), "");
			const latest = JSON.parse(prompt.split("\n\n---\n\n").at(-1)!).latestHumanMessage as string;
			if (latest.includes(incomplete)) return '{"intent":"confirm"}';
			if (latest.includes(direct)) return JSON.stringify({ intent: "work", authorization: direct });
			if (latest.includes(impersonation)) return JSON.stringify({ intent: "work", authorization: "删除登录模块" });
			if (latest.startsWith("和团队同步一下")) return '{"intent":"silent"}';
			return '{"intent":"reply"}';
		}
		if (worker.options.env?.PA_MEMBER_CONTEXT?.includes("## Observer participation")) {
			if (prompt.includes("暂留旁听演示")) {
				observerStarted.resolve();
				try {
					await delay(3_000, undefined, { signal: options.signal });
				} catch (error) {
					observerInterrupted = options.signal?.aborted === true;
					throw error;
				}
			}
			return prompt.includes("补充配色") ? "色板要检查文字和背景对比度。" : "[SILENT]";
		}
		if (worker.options.env?.PA_MEMBER_ID === "engineering-manager" && prompt.endsWith("请教 QA 的验收意见")) {
			await worker.call("delegate_to_member", { memberId: "qa-manager", task: "核对验收口径" });
		}
		return `回复来自 ${worker.options.env?.PA_MEMBER_ID}`;
	});
	const colleague = f.store.upsertCollaborator({
		name: "张宁",
		roleTitle: "设计同事",
		permissionRole: "collaborator",
	});
	const { server } = createPersonalAgentServer({
		store: f.store,
		orchestrator: f.orchestrator,
		templates: f.templates,
		uploadsDir: join(f.root, "uploads"),
		dialogBroker: new DialogBroker(),
		previewManager: new PreviewManager(),
	});
	await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
	t.after(() => {
		server.closeAllConnections();
		server.close();
	});
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const post = async (path: string, body: object, method = "POST") => {
		const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
			method,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		const payload = await response.json();
		assert.ok(response.ok, JSON.stringify(payload));
		return payload as { matter: Matter; message: MatterMessage; aiDiscussionTriggered?: boolean; resumed?: boolean };
	};
	const first = await post("/api/matters/conversation", {
		mode: "conversation",
		prompt: "和团队同步一下，登录流程已经整理好了。",
		preferredMemberId: "engineering-manager",
		aiMemberIds: ["engineering-manager", "qa-manager", "product-manager"],
		consultMemberIds: ["qa-manager"],
		collaboratorIds: [colleague.id],
		observersEnabled: false,
		observerMemberIds: ["product-manager"],
		discussionAiEnabled: false,
		workspaceId: f.workspace.id,
	});
	assert.equal(first.aiDiscussionTriggered, true);
	while (f.orchestrator.isMatterRunning(first.matter.id)) await new Promise((wait) => setTimeout(wait, 10));
	assert.equal(f.workers.length, 2);
	assert.equal(f.store.listMessages(first.matter.id, "user").at(-1)?.senderId, "engineering-manager");
	assert.equal(f.store.listMessages(first.matter.id, "user").at(-1)?.metadata?.matterLeadReply, true);
	assert.equal(first.matter.observersEnabled, false);
	assert.deepEqual(first.matter.observerMemberIds, ["product-manager"]);
	f.workers.length = 0;
	const messages = `/api/matters/${first.matter.id}/messages`;
	const send = (prompt: string) => post(`${messages}/conversation`, { prompt });
	const reply = async (message: MatterMessage) => {
		const deadline = Date.now() + 5_000;
		while (f.orchestrator.isMatterRunning(first.matter.id) && Date.now() < deadline) {
			await new Promise((wait) => setTimeout(wait, 10));
		}
		const found = f.store
			.listMessages(first.matter.id, "user")
			.find((entry) => entry.senderType === "member" && entry.metadata?.sourceUserMessageId === message.id);
		assert.ok(found, `Missing reply to ${message.content}`);
		return found;
	};

	const question = await send("@QA Manager 这条验收标准清楚吗？");
	assert.equal(question.aiDiscussionTriggered, true);
	const directedReply = await reply(question.message);
	assert.equal(directedReply.senderId, "qa-manager");
	assert.equal(directedReply.metadata?.matterLeadReply, undefined);
	assert.ok(f.workers[1]?.options.env?.PA_REQUIRED_TOOLS);
	assert.doesNotMatch(f.workers[1]?.options.env?.PA_REQUIRED_TOOLS ?? "", /bash|edit|write|publish_deliverable/);
	assert.equal(f.workers.length, 2);

	await post(`/api/matters/${first.matter.id}`, { observersEnabled: true }, "PATCH");
	const execute = await send(`@QA Manager ${direct}`);
	assert.equal((await reply(execute.message)).senderId, "qa-manager");
	assert.equal(f.store.getMessage(execute.message.id)?.metadata?.mode, "dispatch");
	assert.match(f.workers[3]?.options.env?.PA_REQUIRED_TOOLS ?? "", /bash|publish_deliverable/);
	assert.equal(f.workers[4]?.options.env?.PA_MEMBER_ID, "product-manager");
	assert.match(f.workers[4]?.options.env?.PA_MEMBER_CONTEXT ?? "", /Observer participation/);
	assert.equal(f.store.getMatter(first.matter.id)?.leadMemberId, "engineering-manager");
	await post(`/api/matters/${first.matter.id}`, { observersEnabled: false }, "PATCH");

	const uncertain = await send(`@QA Manager ${incomplete}`);
	const decision = await reply(uncertain.message);
	assert.match(JSON.stringify(decision.metadata?.humanDecision), /execution_confirmation/);
	assert.equal(f.workers.length, 6);
	const accepted = await post(`${messages}/${decision.id}/human-decision`, {
		action: "answer",
		revision: 1,
		answer: "先讨论",
	});
	assert.equal(accepted.resumed, true);
	while (f.orchestrator.isMatterRunning(first.matter.id)) await new Promise((wait) => setTimeout(wait, 10));
	assert.equal(f.workers[6]?.options.env?.PA_MEMBER_ID, "qa-manager");
	assert.doesNotMatch(f.workers[6]?.options.env?.PA_REQUIRED_TOOLS ?? "", /bash|edit|write|publish_deliverable/);
	assert.equal(f.store.getMatter(first.matter.id)?.leadMemberId, "engineering-manager");

	const denied = await send(`@QA Manager ${impersonation}`);
	assert.equal((await reply(denied.message)).metadata?.humanDecision, undefined);
	assert.equal(f.workers.length, 9);
	assert.doesNotMatch(f.workers[8]?.options.env?.PA_REQUIRED_TOOLS ?? "", /bash|edit|write|publish_deliverable/);

	const unknown = await send("@missing-role 跑一下登录回归");
	assert.equal(unknown.aiDiscussionTriggered, false);
	assert.equal(f.workers.length, 9);

	const implicitQuestion = await send(softQuestion);
	assert.equal(implicitQuestion.aiDiscussionTriggered, true);
	assert.equal((await reply(implicitQuestion.message)).senderId, "engineering-manager");
	assert.equal(f.workers.length, 11);
	assert.doesNotMatch(f.workers[10]?.options.env?.PA_REQUIRED_TOOLS ?? "", /bash|edit|write|publish_deliverable/);

	const human = await send("这个配色想请 @张宁 看一下");
	assert.equal(human.aiDiscussionTriggered, false);
	assert.equal(human.message.metadata?.mode, "conversation");
	assert.equal(f.workers.length, 11);
	const together = await send("@张宁 和 @QA Manager 一起看看");
	assert.equal((await reply(together.message)).senderId, "qa-manager");
	assert.equal(f.store.getMatter(first.matter.id)?.leadMemberId, "engineering-manager");

	const delegate = async (observersEnabled: boolean) => {
		const updated = await post(`/api/matters/${first.matter.id}`, { observersEnabled }, "PATCH");
		assert.equal(updated.matter.observersEnabled, observersEnabled);
		assert.deepEqual(updated.matter.consultMemberIds, ["qa-manager"]);
		assert.deepEqual(updated.matter.observerMemberIds, ["product-manager"]);
		const before = f.workers.length;
		const request = await send("需要补充配色和可读性，请教 QA 的验收意见");
		const mainReply = await reply(request.message);
		assert.equal(mainReply.senderId, "engineering-manager");
		const roles = f.workers
			.slice(before)
			.map(({ options }) => options.env?.PA_MEMBER_ID)
			.filter(Boolean);
		assert.deepEqual(
			roles,
			observersEnabled
				? ["engineering-manager", "qa-manager", "product-manager"]
				: ["engineering-manager", "qa-manager"],
		);
		const replies = f.store
			.listMessages(first.matter.id, "user")
			.filter(
				(message) =>
					message.senderType === "member" &&
					(message.metadata?.sourceUserMessageId === request.message.id ||
						message.metadata?.inReplyToUserMessageId === request.message.id),
			);
		assert.deepEqual(
			replies.map(({ senderId }) => senderId),
			observersEnabled ? ["engineering-manager", "product-manager"] : ["engineering-manager"],
		);
		assert.equal(Boolean(replies[1]?.metadata?.observerIntervention), observersEnabled);
	};
	await delegate(true);
	const directed = await send("@Product Manager 补充配色意见");
	assert.equal((await reply(directed.message)).senderId, "product-manager");
	assert.equal(
		f.store
			.listMessages(first.matter.id, "user")
			.filter(
				(message) =>
					message.metadata?.inReplyToUserMessageId === directed.message.id &&
					message.metadata?.observerIntervention,
			).length,
		0,
	);
	const beforeHuman = f.workers.length;
	const humanWithObservers = await send("@张宁 补充配色意见");
	assert.equal(humanWithObservers.aiDiscussionTriggered, false);
	assert.equal(f.workers.length, beforeHuman);
	await delegate(false);

	await post(`/api/matters/${first.matter.id}`, { observersEnabled: true }, "PATCH");
	const parkedTurn = await send("暂留旁听演示");
	await Promise.race([
		observerStarted.promise,
		delay(3_000, undefined, { ref: false }).then(() => {
			throw new Error("Observer pass did not start");
		}),
	]);
	assert.equal(f.orchestrator.isMatterRunning(first.matter.id), true);
	const humanDuringObservation = await send("@张宁 这条只请你看一下");
	assert.equal(humanDuringObservation.aiDiscussionTriggered, false);
	assert.equal(observerInterrupted, false);
	const nextTurn = await send("请继续讨论刚才的配色");
	assert.equal(nextTurn.aiDiscussionTriggered, true);
	assert.equal((await reply(nextTurn.message)).senderId, "engineering-manager");
	const parkedLeadReply = await reply(parkedTurn.message);
	assert.equal(parkedLeadReply.senderId, "engineering-manager");
	assert.equal(parkedLeadReply.metadata?.aborted, false);
	assert.equal(observerInterrupted, true);
});

test("System One drives saved conversations, workbench help, roster data and lead matching with safe fallback", async (t) => {
	const lookedUp = "这件事目前有哪些队友呀";
	const activeWork = "我想看一下日志，顺手把自动重试改成三次";
	const featureQuestion = "我想看一下 现在 由用户待定 的使用";
	const featureDemo = "请演示一下「待你决定」现在怎么用";
	const interactiveDemo = "给我一个 pa 的 待你决定 的交互演示";
	const followupDemo = "给我一个 实例 演示 有我待定的使用";
	const runtimeQuestion = "你应该能使用 的工具和扩展有哪些，包含 human question  和 request_clarification 吗";
	const howToRun = "怎么进入 正式执行轮";
	const paAndPi = "你知道 当前 agent workbench 的 pa 和 pi 吗";
	const runtimeReply = "这轮是讨论。要让主责用 Human Question 发起真实决定，需要进入正式执行。";
	const howToRunReply = "在这里明确交办一件具体工作。如果出现开始执行卡片，就点开始执行。";
	const paAndPiReply = "PA 管理事项和成员，Pi 通过 RPC 运行岗位的模型会话与工具。";
	const helpReplies = new Map([
		[runtimeQuestion, runtimeReply],
		[howToRun, howToRunReply],
		[paAndPi, paAndPiReply],
	]);
	const defaultHelpReply = "主责根据问题给出的答复";
	const helpQuestions = new Map([
		[featureQuestion, { topic: "decisions", match: /提交答案/ }],
		[interactiveDemo, { topic: "decisions", match: /提交答案/ }],
		[followupDemo, { topic: "decisions", match: /找回密码/ }],
		["怎么安排旁听", { topic: "collaboration", match: /查看交接/ }],
		["PA 支持自己做插件吗", { topic: "capabilities", match: /维护者开发及发布/ }],
		[runtimeQuestion, { topic: "runtime_tools", match: /本轮启动时的工具.*read_pa_help/ }],
		[howToRun, { topic: "starting_work", match: /同一个输入框发一条具体的交办消息/ }],
		[paAndPi, { topic: "pa_and_pi", match: /Pi 是岗位的执行底座/ }],
		["怎么看成果版本", { topic: "deliverables", match: /成果库/ }],
		["当前事项还有什么等我决定", { topic: "pending_decisions", match: /共 0 条/ }],
	]);
	const quoted = "「删除登录模块」";
	const review = "我们现有岗位之间有没有做了同一件事的";
	const piFallback = "本事项的处理进度如何";
	const rulesFallback = "跑一下测试";
	const classifier: DecisionClassifier = {
		async evaluate(request) {
			const state = request.state as { latestHumanMessage: string };
			const text = state.latestHumanMessage;
			if (text === piFallback || text === rulesFallback) throw new Error("Classifier unavailable");
			const help = helpQuestions.get(text);
			const isInformationOnly = Boolean(help) || text === featureDemo;
			const intent =
				text === lookedUp
					? "roster"
					: text === featureDemo
						? "confirm"
						: text === activeWork ||
								text === quoted ||
								text === featureQuestion ||
								text === followupDemo ||
								text === interactiveDemo
							? "work"
							: "reply";
			// This fixture deliberately reports full certainty for an instruction inside quotes.
			return {
				intent: { type: "choice", choice: intent },
				target: { type: "choice", choice: text === review ? "role_architect_review" : "qa-manager" },
				authorized: { type: "noul", noul: text === interactiveDemo ? 0.8 : isInformationOnly ? 0.55 : 0.95 },
				informationOnly: { type: "noul", noul: text === interactiveDemo ? 0.64 : isInformationOnly ? 0.89 : 0.05 },
				workbenchHelp: {
					type: "noul",
					noul: text === interactiveDemo ? 0.55 : text === featureQuestion ? 0.74 : help ? 0.97 : 0.12,
				},
				decisionPreview: { type: "noul", noul: text === interactiveDemo ? 0.95 : 0.04 },
				workbenchTopic: { type: "choice", choice: help?.topic ?? "none", confidence: 0.95 },
			} as never;
		},
	};
	const f = await fixture(
		t,
		async (worker, prompt) => {
			if (worker.options.env?.PA_DECISION_NAME) {
				const state = JSON.parse(prompt.split("\n\n---\n\n").at(-1)!) as { latestHumanMessage: string };
				return state.latestHumanMessage === piFallback ? '{"intent":"reply"}' : "Malformed decision response";
			}
			if (worker.options.env?.PA_MEMBER_ID === "role-architect") {
				return JSON.stringify({
					reply: "发现角色职责重叠",
					healthFindings: [{ severity: "warning", title: "职责重叠", description: "两个岗位需要对齐验收职责。" }],
					recommendedFormation: {
						mode: "solo",
						existingMemberIds: ["qa-manager"],
						rationale: "应保留的不是这条建议",
					},
				});
			}
			const help = [...helpQuestions].find(([question]) => prompt.endsWith(question));
			if (help) {
				const [question, { match }] = help;
				const reference = prompt
					.split("[PA workbench reference for this turn]")[1]
					?.split("[/PA workbench reference]")[0];
				assert.match(reference ?? "", match);
				assert.doesNotMatch(reference ?? "", /other_workspace_tool/);
				if (question === howToRun) {
					assert.ok(worker.priorTranscript.includes(runtimeReply));
				}
				return helpReplies.get(question) ?? defaultHelpReply;
			}
			return `Reply from ${worker.options.env?.PA_MEMBER_ID}`;
		},
		classifier,
	);
	const templates = [...f.templates, BUILTIN_ROLE_ARCHITECT_TEMPLATE];
	const orchestrator = new TeamOrchestrator({ ...f.options, templates });
	const { server } = createPersonalAgentServer({
		store: f.store,
		orchestrator,
		templates,
		uploadsDir: join(f.root, "uploads"),
		dialogBroker: new DialogBroker(),
		previewManager: new PreviewManager(),
	});
	await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
	t.after(() => {
		server.closeAllConnections();
		server.close();
	});
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const send = async (path: string, body: object) => {
		const result = await fetch(`http://127.0.0.1:${address.port}${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		assert.equal(result.status, 201);
		const { matter, message } = (await result.json()) as { matter: Matter; message: MatterMessage };
		const deadline = Date.now() + 3_000;
		while (orchestrator.isMatterRunning(matter.id) && Date.now() < deadline) {
			await new Promise((ready) => setTimeout(ready, 10));
		}
		assert.equal(orchestrator.isMatterRunning(matter.id), false);
		return {
			matter: f.store.getMatter(matter.id)!,
			message: f.store.getMessage(message.id)!,
			reply: f.store
				.listMessages(matter.id, "user")
				.find((entry) => entry.metadata?.sourceUserMessageId === message.id),
		};
	};
	const created = await send("/api/matters/conversation", {
		prompt: "可以讲讲这套方案如何验收吗",
		workspaceId: f.workspace.id,
		aiMemberIds: ["product-manager", "qa-manager"],
		observerMemberIds: ["product-manager"],
		observersEnabled: false,
		discussionAiEnabled: false,
	});
	assert.equal(created.matter.leadMemberId, "qa-manager");
	assert.deepEqual(created.matter.observerMemberIds, ["product-manager"]);
	assert.equal(created.message.metadata?.conversationDecisionSource, "system_one");
	assert.equal(created.reply?.senderId, "qa-manager");
	assert.equal(f.workers.length, 1);
	const path = `/api/matters/${created.matter.id}/messages/conversation`;
	const roster = await send(path, { prompt: lookedUp });
	assert.equal(roster.reply?.metadata?.matterRosterSnapshot, true);
	assert.match(roster.reply?.content ?? "", /QA Manager.*负责人/);
	assert.equal(f.workers.length, 1);
	const mentioned = await send(path, { prompt: "@Product Manager 可以讲讲现状吗" });
	assert.equal(mentioned.reply?.senderId, "product-manager");
	assert.equal(mentioned.matter.leadMemberId, "qa-manager");
	const response = await send(path, { prompt: featureDemo });
	assert.equal(response.message.metadata?.conversationDecisionSource, "system_one");
	assert.equal(response.message.metadata?.mode, "conversation");
	assert.equal(response.reply?.senderId, "qa-manager");
	assert.equal(response.reply?.metadata?.humanDecision, undefined);
	assert.doesNotMatch(f.workers.at(-1)?.options.env?.PA_REQUIRED_TOOLS ?? "", /bash|edit|write|publish_deliverable/);
	f.store.appendMessage({
		matterId: created.matter.id,
		channel: "notice",
		senderType: "system",
		senderId: "qa-manager",
		content: JSON.stringify({ method: "runtime_ready", tools: ["other_workspace_tool"] }),
		metadata: { workspaceId: "other_workspace", repoPath: join(f.root, "other"), orgId: f.workspace.orgId },
	});
	const workerCount = f.workers.length;
	for (const [prompt, { topic }] of helpQuestions) {
		const example = await send(path, { prompt });
		assert.equal(example.message.metadata?.conversationDecisionSource, "system_one");
		assert.equal(example.message.metadata?.mode, "conversation");
		assert.equal(example.reply?.senderType, "member");
		assert.equal(example.reply?.senderId, "qa-manager");
		assert.equal(example.reply?.metadata?.matterLeadReply, true);
		assert.equal(example.reply?.metadata?.workbenchHelpTopic, topic);
		assert.equal(example.reply?.metadata?.humanDecision, undefined);
		assert.equal(example.reply?.content, helpReplies.get(prompt) ?? defaultHelpReply);
	}
	assert.equal(f.workers.length, workerCount + helpQuestions.size);
	const work = await send(path, { prompt: activeWork });
	assert.equal(work.message.metadata?.mode, "dispatch");
	assert.equal(work.message.metadata?.targetMemberId, "qa-manager");
	const scopedQuestion = await send(path, { prompt: review });
	assert.equal(scopedQuestion.reply?.senderId, "qa-manager");
	assert.equal(scopedQuestion.matter.leadMemberId, "qa-manager");
	const audit = await send("/api/matters/conversation", { prompt: review, workspaceId: f.workspace.id });
	assert.equal(audit.reply?.senderId, "role-architect");
	assert.equal(audit.matter.leadMemberId, null);
	const proposal = audit.reply?.metadata?.roleProposals as {
		healthFindings?: unknown[];
		recommendedFormation?: unknown;
	};
	assert.ok(proposal.healthFindings?.length);
	assert.equal(proposal.recommendedFormation, undefined);
	const quotation = await send(path, { prompt: quoted });
	assert.equal(quotation.message.metadata?.mode, "conversation");
	assert.match(JSON.stringify(quotation.reply?.metadata?.humanDecision), /execution_confirmation/);
	const fallback = await send(path, { prompt: piFallback });
	assert.equal(fallback.message.metadata?.conversationDecisionSource, "pi");
	assert.equal(fallback.reply?.senderId, "qa-manager");
	const offline = await send(path, { prompt: rulesFallback });
	assert.equal(offline.message.metadata?.conversationDecisionSource, "rules");
	assert.equal(offline.message.metadata?.mode, "conversation");
	assert.match(JSON.stringify(offline.reply?.metadata?.humanDecision), /execution_confirmation/);
});

test("workbench help reads packaged guides and active matter facts through the shipped extension", async (t) => {
	for (const topic of Object.keys(WORKBENCH_TOPICS)) {
		if (!isWorkbenchTopic(topic) || !isGuideTopic(topic)) continue;
		assert.ok((await readWorkbenchGuide(topic, true)).content);
		assert.ok((await readWorkbenchGuide(topic, false)).content);
	}
	const f = await fixture(t, async (worker) => {
		assert.match(worker.options.env?.PA_MEMBER_CONTEXT ?? "", /read_pa_help/);
		const details = async (topics: string[]) =>
			JSON.stringify((await worker.call("read_pa_help", { topics, language: "zh" })).details);
		const guide = await details(["roles", "capabilities", "deliverables"]);
		assert.match(guide, /角色架构师.*网页检索.*成果库/);
		const state = await details(["current_matter", "pending_decisions", "published_deliverables"]);
		assert.match(state, /QA Manager.*持续跟进的审批.*新工作区验收/);
		assert.doesNotMatch(state, /旧工作区|其他组织|被替代|仅存在于数据库/);
		assert.match(await details(["runtime_tools"]), /本轮启动时的工具.*request_clarification/);
		await assert.rejects(
			worker.call("read_pa_help", { topics: ["current_matter"], matterId: "another_matter" }),
			/PA help accepts only topics and language/,
		);
		await assert.rejects(
			worker.call("read_pa_help", { topics: ["../../SECURITY.md"] }),
			/Select one to three topics/,
		);
		return "已查阅工作台";
	});
	const oldWorkspace = f.workspace;
	const repoPath = join(f.root, "B");
	await mkdir(repoPath);
	const workspace = f.store.upsertWorkspace({ name: "B", repoPath });
	const matter = f.store.createMatter({
		title: "交付与审批",
		workspaceId: oldWorkspace.id,
		leadMemberId: "qa-manager",
	});
	const append = (title: string, scope: { workspaceId: string; repoPath: string; orgId: string | null }) => {
		f.store.appendMessage({
			matterId: matter.id,
			channel: "user",
			senderType: "member",
			senderId: "qa-manager",
			content: title,
			metadata: {
				...scope,
				humanDecision: {
					kind: "execution_confirmation",
					status: "pending",
					revision: 1,
					assignedUserId: null,
					requests: [{ question: title }],
				},
			},
		});
	};
	const publish = (title: string, scope?: { workspaceId: string; repoPath: string; orgId: string | null }) => {
		const deliverable = f.store.recordDeliverable({
			matterId: matter.id,
			memberId: "qa-manager",
			type: "document",
			title,
			contentOrPath: "evidence",
		});
		if (scope)
			f.store.appendMessage({
				matterId: matter.id,
				channel: "user",
				senderType: "member",
				senderId: "qa-manager",
				content: title,
				metadata: { ...scope, deliverableIds: [deliverable.id] },
			});
	};
	const oldScope = { workspaceId: oldWorkspace.id, repoPath: oldWorkspace.repoPath, orgId: oldWorkspace.orgId };
	append("旧工作区审批", oldScope);
	publish("旧工作区验收", oldScope);
	f.store.updateMatterWorkspace(matter.id, workspace.id);
	const currentScope = { workspaceId: workspace.id, repoPath, orgId: workspace.orgId };
	append("被替代的审批", currentScope);
	append("持续跟进的审批", currentScope);
	append("其他组织审批", { ...currentScope, orgId: "org_elsewhere" });
	publish("新工作区验收", currentScope);
	publish("仅存在于数据库");
	const response = await f.orchestrator.dispatchMatter({
		matterId: matter.id,
		prompt: "读一下工作台帮助和当前事项",
	});
	assert.equal(response.replyText, "已查阅工作台");
	assert.equal(f.store.listDeliverables(matter.id).length, 3);
});

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
	assert.doesNotMatch(f.workers[2]?.options.env?.PA_TURN_CONTEXT ?? "", /PRIVATE_COMPANY_A|UNSCOPED_COMPANY/);
	f.store.updateMatterWorkspace(first.matter.id, f.workspace.id);
	await restarted.dispatchMatter({ matterId: first.matter.id, prompt: "返回 A" });
	assert.equal(f.workers[3]?.options.sessionFile, f.workers[0]?.sessionFile);
	assert.doesNotMatch(f.workers[3]?.prompt ?? "", /SECOND_PRIVATE_B/);
	assert.match(f.workers[3]?.options.env?.PA_TURN_CONTEXT ?? "", /PRIVATE_COMPANY_A/);
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

test("resumed turns append current roster, memories, and files without changing role instructions", async (t) => {
	const f = await fixture(t, async () => "Done");
	const first = await f.orchestrator.dispatchMatter({
		prompt: "Plan the next step",
		workspaceId: f.workspace.id,
		preferredMemberId: "product-manager",
		aiMemberIds: ["product-manager", "engineering-manager"],
		consultMemberIds: ["engineering-manager"],
		observersEnabled: false,
	});
	assert.match(f.workers[0]?.options.env?.PA_TURN_CONTEXT ?? "", /No scoped memories/);
	assert.doesNotMatch(f.workers[0]?.options.env?.PA_TURN_CONTEXT ?? "", /ux-designer|design\.md/);

	const specialist = f.templates.find(({ id }) => id === "qa-manager")!;
	f.orchestrator.registerRoleTemplate({
		...specialist,
		id: "ux-designer",
		name: "UX & Visual Designer",
		title: "UX & Visual Designer",
		isPrimaryContact: false,
	});

	f.store.updateMatterAiMembers(first.matter.id, ["product-manager", "engineering-manager", "ux-designer"]);
	f.store.updateMatterConsultMembers(first.matter.id, ["engineering-manager", "ux-designer"]);
	f.store.addMemory({
		memberId: "product-manager",
		workspaceId: f.workspace.id,
		scope: "project_private",
		content: "UX_REVIEW_REQUIRED",
	});
	await writeFile(join(f.root, "design.md"), "# Design\n");
	await f.orchestrator.dispatchMatter({ matterId: first.matter.id, prompt: "Review the updated plan" });

	const resumed = f.workers[1];
	assert.equal(resumed?.options.sessionFile, f.workers[0]?.sessionFile);
	assert.equal(resumed?.options.env?.PA_MEMBER_CONTEXT, f.workers[0]?.options.env?.PA_MEMBER_CONTEXT);
	assert.deepEqual(resumed?.options.args, f.workers[0]?.options.args);
	const snapshot = resumed?.options.env?.PA_TURN_CONTEXT ?? "";
	assert.match(snapshot, /ux-designer: UX & Visual Designer.*\[consultable\]/);
	assert.match(snapshot, /UX_REVIEW_REQUIRED/);
	assert.match(snapshot, /Top-level entries: .*design\.md/);
	assert.doesNotMatch(resumed?.options.env?.PA_MEMBER_CONTEXT ?? "", /ux-designer|UX_REVIEW_REQUIRED|design\.md/);
});

test("resumed workers keep personal role snapshots scoped to the triggering user", async (t) => {
	const f = await fixture(t, async () => "Done");
	const owner = f.store.createUser({ email: "owner@example.test", displayName: "Owner", password: "fixture-pass" });
	const guest = f.store.createUser({ email: "guest@example.test", displayName: "Guest", password: "fixture-pass" });
	const specialist = f.templates.find(({ id }) => id === "qa-manager")!;
	const personal = f.orchestrator.registerRoleTemplate({
		...specialist,
		id: "owner-private-specialist",
		roleScope: "personal",
		ownerUserId: owner.id,
	});
	const first = await f.orchestrator.dispatchMatter({
		prompt: "Owner's turn",
		workspaceId: f.workspace.id,
		preferredMemberId: "product-manager",
		aiMemberIds: ["product-manager", "engineering-manager", personal.id],
		observersEnabled: false,
		actorUserId: owner.id,
	});
	assert.match(f.workers[0]?.options.env?.PA_TURN_CONTEXT ?? "", /owner-private-specialist/);

	await f.orchestrator.dispatchMatter({ matterId: first.matter.id, prompt: "Guest's turn", actorUserId: guest.id });
	assert.equal(f.workers[1]?.options.sessionFile, undefined);
	assert.doesNotMatch(f.workers[1]?.options.env?.PA_TURN_CONTEXT ?? "", /owner-private-specialist/);

	await f.orchestrator.dispatchMatter({ matterId: first.matter.id, prompt: "Owner resumes", actorUserId: owner.id });
	assert.equal(f.workers[2]?.options.sessionFile, f.workers[0]?.sessionFile);
	assert.match(f.workers[2]?.options.env?.PA_TURN_CONTEXT ?? "", /owner-private-specialist/);
});

test("shipped tool delegates to a real colleague execution and returns internal results, with idempotency and cycle boundaries", async (t) => {
	let engineerCalls = 0;
	const f = await fixture(t, async (worker) => {
		if (worker.options.env?.PA_MEMBER_ID === "engineering-manager") {
			engineerCalls++;
			assert.match(worker.prompt, /用户目标/);
			assert.match(worker.prompt, /Assignment #1/);
			await assert.rejects(
				worker.call("delegate_to_member", { memberId: "product-manager", task: "call ancestor" }),
				/cycle/,
			);
			return "技术依据：采用持久会话";
		}
		const args = { memberId: "engineering-manager", task: "请针对用户目标提供技术意见" };
		const answer = await worker.call("delegate_to_member", args, "same-call");
		assert.match(JSON.stringify(answer), /技术依据/);
		assert.match(JSON.stringify(answer), /delegationNumber/);
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
		templates: f.templates.map((template) => ({ ...template, tools: ["custom_research"] })),
	});
	await assert.rejects(
		missingTool.dispatchMatter({ prompt: "能力" }),
		/Required capabilities unavailable: custom_research/,
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
	const progress: DispatchProgressEvent[] = [];
	const result = await f.orchestrator.dispatchMatter({
		prompt: "协作边界",
		preferredMemberId: "product-manager",
		workspaceId: f.workspace.id,
		onProgress: (event) => progress.push(event),
	});
	assert.equal(f.workers.length, 9);
	const [turn] = f.store.listMessages(result.matter.id, "user");
	const records = f.store.listMessages(result.matter.id, "internal_collab");
	assert.equal(records.length, 16);
	assert.ok(records.every((message) => message.metadata?.sourceUserMessageId === turn?.id));
	const [first, nested] = records.filter((message) => message.metadata?.toMemberId);
	assert.ok(first && nested);
	assert.equal(first.metadata?.delegationNumber, 1);
	assert.equal(nested.metadata?.delegationNumber, 2);
	assert.equal(nested.metadata?.parentRequestMessageId, first.id);
	assert.ok(progress.every((event) => event.sourceUserMessageId === turn?.id));
	const handoffIndex = progress.findIndex((event) => event.collabUpdated && event.activeDelegations?.length === 2);
	assert.notEqual(handoffIndex, -1);
	const handoff = progress[handoffIndex];
	assert.deepEqual(
		handoff?.activeDelegations?.map((edge) => [
			edge.kind === "delegation" && edge.requestMessageId,
			edge.fromMemberId,
			edge.memberId,
		]),
		[
			[first.id, "product-manager", "engineering-manager"],
			[nested.id, "engineering-manager", "qa-manager"],
		],
	);
	assert.equal(handoff?.activeDelegations?.[0]?.stageLabel, "等待下游回报");
	assert.ok(
		progress
			.slice(handoffIndex + 1)
			.some(
				(event) =>
					event.collabUpdated &&
					event.activeDelegations?.length === 1 &&
					event.activeDelegations[0]?.kind === "delegation" &&
					event.activeDelegations[0]?.requestMessageId === first.id,
			),
	);
});

test("independent review links to a completed assignment and gates the exact final document", async (t) => {
	const title = "Implementation report";
	const evidence = "Checked the exact supplied version and acceptance criteria";
	const f = await fixture(t, async (worker, prompt) => {
		const member = worker.options.env?.PA_MEMBER_ID;
		if (member === "engineering-manager") return "First version of report completed";
		if (member === "qa-manager") {
			assert.match(prompt, /\[Acceptance criteria\]/);
			assert.match(prompt, /\[Document snapshot\]/);
			const manifest = JSON.parse(worker.options.env?.PA_REQUIRED_TOOLS ?? "[]");
			assert.ok(manifest.every((name: string) => ["read", "bash", "read_pa_help"].includes(name)));
			assert.equal(worker.tools.has("delegate_to_member"), false);
			assert.equal(worker.tools.has("publish_deliverable"), false);
			assert.equal(worker.tools.has("propose_experience"), false);
			const revised = prompt.includes("Reviewed content with checks");
			return JSON.stringify({
				verdict: revised ? "passed" : "changes_requested",
				summary: revised ? "OK" : "Missing checks",
				evidence: [evidence],
			});
		}
		await worker.call("delegate_to_member", { memberId: "engineering-manager", task: "Write the report" });
		const stage = (content: string) =>
			worker.call("publish_deliverable", {
				type: "document",
				title,
				content,
				changeNote: "Include check evidence",
			});
		const verify = (memberId: string) =>
			worker.call("delegate_to_member", {
				memberId,
				task: "Verify the report",
				verification: {
					assignmentNumber: 1,
					target: { kind: "draft", reference: title },
					criteria: "Include check results",
				},
			});
		await stage("First version without checks");
		await assert.rejects(verify("engineering-manager"), /cannot verify their own work/);
		assert.match(JSON.stringify(await verify("qa-manager")), /changes_requested/);
		await stage("Reviewed content with checks");
		assert.match(JSON.stringify(await verify("qa-manager")), /"verdict"\s*:\s*"passed"/);
		if (prompt.endsWith("Change after inspection")) await stage("Unreviewed different version");
		return "Report ready";
	});
	const result = await f.orchestrator.dispatchMatter({
		prompt: "Review and publish the exact report",
		preferredMemberId: "product-manager",
		workspaceId: f.workspace.id,
	});
	assert.equal(result.deliverable?.contentOrPath, "Reviewed content with checks");
	const records = f.store.listMessages(result.matter.id, "internal_collab");
	const [work] = records;
	const reviews = records.filter(
		(entry) => entry.metadata?.verification && typeof entry.metadata?.toMemberId === "string",
	);
	assert.equal(reviews.length, 2);
	for (const entry of reviews)
		assert.match(JSON.stringify(entry.metadata?.verification), new RegExp(work?.id ?? "missing"));
	assert.notDeepEqual(reviews[0]?.metadata?.verification, reviews[1]?.metadata?.verification);
	assert.ok(
		records.some((entry) => entry.metadata?.requestMessageId === reviews[1]?.id && entry.content.includes(evidence)),
	);
	await assert.rejects(
		f.orchestrator.dispatchMatter({ matterId: result.matter.id, prompt: "Change after inspection" }),
		/Independent verification has not passed for the final draft/,
	);
	assert.equal(f.store.listDeliverables(result.matter.id).length, 1);
});

test("file reviews detect changed snapshots and commit reviews require observed workspace checks", async (t) => {
	let revision = "";
	const f = await fixture(t, async (worker, prompt) => {
		if (worker.options.env?.PA_MEMBER_ID === "qa-manager") {
			if (prompt.includes("[File snapshot]")) {
				assert.match(prompt, /Original fixture source/);
				await writeFile(join(f.root, "notes.md"), "Changed during the review");
			} else assert.ok(prompt.includes(revision));
			return JSON.stringify({ verdict: "passed", summary: "Checked", evidence: ["Reported result"] });
		}
		const review = (kind: "file" | "commit", reference: string) =>
			worker.call("delegate_to_member", {
				memberId: "qa-manager",
				task: "Review the pinned source",
				verification: { target: { kind, reference }, criteria: "Check contents" },
			});
		await assert.rejects(review("commit", "HEAD"), /full Git commit hash/);
		const fileReview = JSON.stringify(await review("file", "notes.md"));
		assert.match(fileReview, /inconclusive.*验收对象已变更/);
		const commitReview = JSON.stringify(await review("commit", revision));
		assert.match(commitReview, /inconclusive.*未观察到成功完成的仓库读取/);
		return "Review records saved";
	});
	const git = (...args: string[]) => execFileSync("git", args, { cwd: f.root, encoding: "utf8" });
	await writeFile(join(f.root, "notes.md"), "Original fixture source");
	git("init", "-q");
	git("add", "notes.md");
	git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Initial fixture");
	revision = git("rev-parse", "HEAD").trim();
	const result = await f.orchestrator.dispatchMatter({
		prompt: "Review the exact inputs",
		workspaceId: f.workspace.id,
		preferredMemberId: "product-manager",
	});
	const board = f.store.listMessages(result.matter.id, "internal_collab");
	assert.equal(board.length, 4);
	assert.ok(board.some((post) => JSON.stringify(post.metadata?.verification).includes(revision)));
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
