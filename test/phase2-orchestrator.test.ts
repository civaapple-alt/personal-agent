import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
	loadRoleTemplatesFromDir,
	openPersonalAgentDatabase,
	PersonalAgentStore,
	type PiRpcWorkerOptions,
	type PromptRunResult,
	type RpcExtensionUIDialogRequest,
	type RpcExtensionUIResponsePayload,
	type RpcWorkerLike,
	serializeRoleTemplateMarkdown,
	TeamOrchestrator,
} from "../src/index.ts";

class FakeRpcWorker implements RpcWorkerLike {
	readonly options: PiRpcWorkerOptions;
	readonly receivedPrompts: string[] = [];
	private noticeListeners: Array<(notice: { method: string; [key: string]: unknown }) => void> = [];
	private dialogHandler:
		| ((req: RpcExtensionUIDialogRequest) => Promise<RpcExtensionUIResponsePayload> | RpcExtensionUIResponsePayload)
		| undefined;
	private readonly responder: (
		prompt: string,
		helpers: {
			emitNotice: (notice: { method: string; [key: string]: unknown }) => void;
			askDialog: (req: RpcExtensionUIDialogRequest) => Promise<RpcExtensionUIResponsePayload>;
		},
	) => Promise<string>;

	constructor(
		options: PiRpcWorkerOptions,
		responder: (
			prompt: string,
			helpers: {
				emitNotice: (notice: { method: string; [key: string]: unknown }) => void;
				askDialog: (req: RpcExtensionUIDialogRequest) => Promise<RpcExtensionUIResponsePayload>;
			},
		) => Promise<string>,
	) {
		this.options = options;
		this.responder = responder;
	}

	async start(): Promise<void> {}
	async stop(): Promise<void> {}
	async getState(): Promise<{ sessionId: string; sessionFile?: string }> {
		return { sessionId: `fake-session-${this.options.model ?? "default"}` };
	}

	onNotice(listener: (notice: { method: string; [key: string]: unknown }) => void): () => void {
		this.noticeListeners.push(listener);
		return () => {
			this.noticeListeners = this.noticeListeners.filter((l) => l !== listener);
		};
	}

	setDialogHandler(
		handler:
			| ((
					req: RpcExtensionUIDialogRequest,
			  ) => Promise<RpcExtensionUIResponsePayload> | RpcExtensionUIResponsePayload)
			| undefined,
	): void {
		this.dialogHandler = handler;
	}

	async runPromptAndWait(message: string): Promise<PromptRunResult> {
		this.receivedPrompts.push(message);
		const text = await this.responder(message, {
			emitNotice: (notice) => {
				for (const listener of this.noticeListeners) {
					listener(notice);
				}
			},
			askDialog: async (req) => {
				if (!this.dialogHandler) {
					return { cancelled: true };
				}
				return await this.dialogHandler(req);
			},
		});

		return {
			disposition: "started",
			aborted: false,
			assistantText: text,
			assistantMessages: [],
			toolExecutions: [{ toolCallId: "t-1", toolName: "read", args: {}, isError: false }],
			notices: [],
			dialogs: [],
			events: [],
		};
	}
}

test("loads 4 shareable Markdown role templates and serializes cleanly without private state", async () => {
	const rolesDir = resolve(process.cwd(), "roles");
	const templates = await loadRoleTemplatesFromDir(rolesDir);
	const ids = templates.map((t) => t.id).sort();

	assert.deepEqual(ids, ["engineering-manager", "marketing-lead", "product-manager", "qa-manager"]);
	const pm = templates.find((t) => t.id === "product-manager")!;
	assert.equal(pm.isPrimaryContact, true);
	assert.equal(pm.shareable, true);
	assert.ok(pm.sections.responsibilitiesAndBoundaries.length > 0);
	assert.ok(pm.sections.deliveryAndVerification.length > 0);

	const roundTripped = serializeRoleTemplateMarkdown(pm);
	assert.match(roundTripped, /id: product-manager/);
	assert.match(roundTripped, /## 职责与边界/);
});

test("isolates project-private memories across workspaces while preserving shared role/company memories", async () => {
	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db);
	const templates = await loadRoleTemplatesFromDir(resolve(process.cwd(), "roles"));
	new TeamOrchestrator({ store, templates });

	const wsA = store.upsertWorkspace({ name: "订单系统", repoPath: "/tmp/repo-orders" });
	const wsB = store.upsertWorkspace({ name: "客户管理", repoPath: "/tmp/repo-crm" });

	store.addMemory({
		memberId: "engineering-manager",
		scope: "role_general",
		content: "改动前先跑 typecheck",
		verified: true,
	});
	store.addMemory({
		memberId: "engineering-manager",
		scope: "company_private",
		content: "公司默认采用 Node 22+",
		verified: true,
	});
	store.addMemory({
		memberId: "engineering-manager",
		scope: "project_private",
		workspaceId: wsA.id,
		content: "订单表金额字段为分",
	});
	store.addMemory({
		memberId: "engineering-manager",
		scope: "project_private",
		workspaceId: wsB.id,
		content: "CRM 导出有字段脱敏",
	});

	const forA = store.listRelevantMemories("engineering-manager", wsA.id).map((m) => m.content);
	assert.deepEqual(forA, ["改动前先跑 typecheck", "公司默认采用 Node 22+", "订单表金额字段为分"]);

	const forB = store.listRelevantMemories("engineering-manager", wsB.id).map((m) => m.content);
	assert.deepEqual(forB, ["改动前先跑 typecheck", "公司默认采用 Node 22+", "CRM 导出有字段脱敏"]);
	db.close();
});

test("routes tasks by role, keeps internal_collab & notices separate, handles waiting_user, and versions deliverables", async () => {
	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db);
	const templates = await loadRoleTemplatesFromDir(resolve(process.cwd(), "roles"));
	const ws = store.upsertWorkspace({ name: "personal-agent", repoPath: "/tmp/personal-agent" });

	const spawnedWorkers: FakeRpcWorker[] = [];
	const seenStatusesDuringDialog: string[] = [];

	const orchestrator = new TeamOrchestrator({
		store,
		templates,
		onDialog: async (ctx) => {
			const during = store.getMatter(ctx.matterId);
			if (during) {
				seenStatusesDuringDialog.push(during.status);
			}
			return { confirmed: true };
		},
		workerFactory: (opts) => {
			const worker = new FakeRpcWorker(opts, async (prompt, helpers) => {
				helpers.emitNotice({ method: "setStatus", statusKey: "phase", statusText: "running" });
				if (prompt.includes("评估") && prompt.includes("架构")) {
					const reply = await helpers.askDialog({
						type: "extension_ui_request",
						id: "dlg-arch",
						method: "confirm",
						title: "确认执行",
						message: "允许读取仓库依赖？",
					});
					return `研发评估完成（confirmed=${"confirmed" in reply ? reply.confirmed : false}）`;
				}
				return "已按内部协作结论整理出 PRD 交付稿";
			});
			spawnedWorkers.push(worker);
			return worker;
		},
	});

	// 1. Route an engineering architecture task to engineering-manager with workspace cwd
	const engResult = await orchestrator.dispatchMatter({
		title: "评估架构依赖",
		prompt: "帮我评估一下仓库的架构和 SQLite 接口依赖",
		workspaceId: ws.id,
		deliverableTitle: "架构评估报告",
	});

	assert.equal(engResult.assignedMember.id, "engineering-manager");
	assert.equal(spawnedWorkers[0]?.options.cwd, "/tmp/personal-agent");
	assert.deepEqual(seenStatusesDuringDialog, ["waiting_user"]);
	assert.equal(engResult.matter.status, "delivered");
	assert.ok(engResult.deliverable);
	assert.equal(engResult.deliverable.version, 1);

	// 2. Internal delegation from PM to QA stays in internal_collab channel, not user channel
	const collab = await orchestrator.delegateToMember({
		matterId: engResult.matter.id,
		fromMemberId: "product-manager",
		toMemberId: "qa-manager",
		question: "请补充该改动对应的验收风险",
	});
	assert.equal(collab.toMember.id, "qa-manager");

	const userMsgs = store.listMessages(engResult.matter.id, "user");
	const collabMsgs = store.listMessages(engResult.matter.id, "internal_collab");
	const noticeMsgs = store.listMessages(engResult.matter.id, "notice");
	assert.equal(userMsgs.length, 2);
	assert.equal(collabMsgs.length, 2);
	assert.equal(noticeMsgs.length, 2);

	// 3. Dispatching a follow-up deliverable with the same title increments version to 2
	const v2Result = await orchestrator.dispatchMatter({
		matterId: engResult.matter.id,
		prompt: "请基于最新需求补充功能范围和验收条件",
		deliverableTitle: "架构评估报告",
	});
	assert.equal(v2Result.assignedMember.id, "product-manager");
	assert.ok(v2Result.deliverable);
	assert.equal(v2Result.deliverable.version, 2);

	db.close();
});
