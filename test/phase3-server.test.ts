import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
	createPersonalAgentServer,
	DialogBroker,
	loadRoleTemplatesFromDir,
	openPersonalAgentDatabase,
	PersonalAgentStore,
	type PiRpcWorkerOptions,
	PreviewManager,
	type PromptRunResult,
	type RpcExtensionUIDialogRequest,
	type RpcExtensionUIResponsePayload,
	type RpcSessionEvent,
	type RpcWorkerLike,
	TeamOrchestrator,
} from "../src/index.ts";
import { formatHashRoute, parseHashRoute } from "../web/src/hashRouter.ts";
import {
	collectMatterMemories,
	collectMatterParticipantIds,
	countMemberMemoriesByScope,
	formatElapsedDuration,
	formatMemberGitIdentity,
	formatNoticeEventLine,
	getMemberThemeById,
	inferDelegationMood,
	isKeyNoticeEvent,
	MEMORY_CATEGORY_LABELS,
	MEMORY_SCOPE_LABELS,
	MEMORY_SCOPE_SHORT_LABELS,
	mapDelegationsToMessages,
	parseDeliverableSummary,
	parseMessageImages,
	parseProgressSnapshot,
	pickDefaultWorkspaceId,
} from "../web/src/utils.ts";
import { invokeTool, reportReady } from "./worker-helpers.ts";

class InteractiveTestWorker implements RpcWorkerLike {
	readonly options: PiRpcWorkerOptions;
	constructor(options: PiRpcWorkerOptions) {
		this.options = options;
	}
	private dialogHandler:
		| ((req: RpcExtensionUIDialogRequest) => Promise<RpcExtensionUIResponsePayload> | RpcExtensionUIResponsePayload)
		| undefined;
	private noticeListeners: Array<(notice: { method: string; [key: string]: unknown }) => void> = [];

	async start(): Promise<void> {
		await reportReady(this.options);
	}
	async stop(): Promise<void> {}
	async getState(): Promise<{ sessionId: string; sessionFile?: string }> {
		return { sessionId: "test-web-session" };
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

	async runPromptAndWait(_message: string): Promise<PromptRunResult> {
		for (const listener of this.noticeListeners) {
			listener({ method: "notify", message: "正在核对原型内容", notifyType: "info" });
		}

		const reply = this.dialogHandler
			? await this.dialogHandler({
					type: "extension_ui_request",
					id: "dlg-preview-1",
					method: "confirm",
					title: "启动独立预览",
					message: "是否发布交付原型？",
				})
			: { cancelled: true as const };

		const confirmed = "confirmed" in reply ? reply.confirmed : false;
		return {
			disposition: "started",
			aborted: false,
			assistantText: confirmed ? "交付原型已准备就绪" : "已取消发布",
			assistantMessages: [],
			toolExecutions: [],
			notices: [],
			dialogs: [],
			events: [],
		};
	}
}

test("PreviewManager starts an independent local HTTP service and stops it cleanly", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pa-preview-"));
	const scriptPath = join(tempDir, "preview.mjs");
	writeFileSync(
		scriptPath,
		`import http from "node:http";
const port = Number(process.env.PORT);
const server = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("preview-ok");
});
server.listen(port, "127.0.0.1");
`,
	);

	const manager = new PreviewManager();
	try {
		const info = await manager.startCommandPreview({
			title: "原型独立服务",
			command: process.execPath,
			args: [scriptPath],
			cwd: tempDir,
		});
		assert.equal(info.status, "running");
		assert.match(info.url, /^http:\/\/127\.0\.0\.1:\d+$/);

		const res = await fetch(info.url);
		assert.equal(res.status, 200);
		assert.equal(await res.text(), "preview-ok");

		const stopped = await manager.stopPreview(info.id);
		assert.equal(stopped?.status, "stopped");
	} finally {
		await manager.stopAll();
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("Personal Agent HTTP server handles bootstrap, async dispatch, dialog approval, feedback, and preview routes", async () => {
	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db);
	const templates = await loadRoleTemplatesFromDir(resolve(process.cwd(), "roles"));
	const dialogBroker = new DialogBroker();
	const previewManager = new PreviewManager();

	const orchestrator = new TeamOrchestrator({
		store,
		templates,
		onDialog: (ctx) => dialogBroker.requestApproval(ctx),
		workerFactory: (options) => new InteractiveTestWorker(options),
	});

	const { server } = createPersonalAgentServer({
		store,
		orchestrator,
		templates,
		previewManager,
		dialogBroker,
		webDistDir: resolve(process.cwd(), "web/dist"),
	});

	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const baseUrl = `http://127.0.0.1:${address.port}`;

	try {
		// 1. Register workspace & check bootstrap
		const wsRes = await fetch(`${baseUrl}/api/workspaces`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "personal-agent", repoPath: "/tmp/pa-repo" }),
		});
		assert.equal(wsRes.status, 201);

		const bootRes = await fetch(`${baseUrl}/api/bootstrap`);
		assert.equal(bootRes.status, 200);
		const boot = (await bootRes.json()) as { members: unknown[]; workspaces: unknown[] };
		assert.equal(boot.members.length, 4);
		assert.equal(boot.workspaces.length, 1);

		// 2. Dispatch matter -> pauses at confirm dialog -> answer dialog -> matter delivered
		const createRes = await fetch(`${baseUrl}/api/matters`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: "帮我准备 V4 交互原型交付", deliverableTitle: "交付说明" }),
		});
		assert.equal(createRes.status, 202);
		const created = (await createRes.json()) as { matter: { id: string } };

		// Wait until dialog is registered
		let pendingDialogId: string | null = null;
		for (let i = 0; i < 40; i++) {
			const b = (await (await fetch(`${baseUrl}/api/bootstrap`)).json()) as {
				pendingDialogs: Array<{ id: string; matterId: string }>;
			};
			const match = b.pendingDialogs.find((d) => d.matterId === created.matter.id);
			if (match) {
				pendingDialogId = match.id;
				break;
			}
			await new Promise((r) => setTimeout(r, 20));
		}
		assert.ok(pendingDialogId, "Expected pending dialog for matter");

		const answerRes = await fetch(`${baseUrl}/api/dialogs/${pendingDialogId}/respond`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ confirmed: true }),
		});
		assert.equal(answerRes.status, 200);

		// Wait until matter reaches delivered
		let deliverableId: string | null = null;
		for (let i = 0; i < 40; i++) {
			const detail = (await (await fetch(`${baseUrl}/api/matters/${created.matter.id}`)).json()) as {
				matter: { status: string };
				deliverables: Array<{ id: string; contentOrPath: string }>;
				noticeMessages: unknown[];
			};
			if (detail.matter.status === "delivered" && detail.deliverables[0]) {
				assert.equal(detail.deliverables[0].contentOrPath, "交付原型已准备就绪");
				assert.equal(detail.noticeMessages.length, 2);
				deliverableId = detail.deliverables[0].id;
				break;
			}
			await new Promise((r) => setTimeout(r, 20));
		}
		assert.ok(deliverableId, "Expected delivered deliverable");

		// 3. Submit deliverable feedback & register external preview URL
		const fbRes = await fetch(`${baseUrl}/api/deliverables/${deliverableId}/feedback`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ feedback: "按钮文案清晰" }),
		});
		assert.equal(fbRes.status, 200);

		const prevRes = await fetch(`${baseUrl}/api/previews`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "V4 体验服务", url: "http://127.0.0.1:4999", deliverableId }),
		});
		assert.equal(prevRes.status, 201);

		// 4. Built V4 web UI is served at /
		const htmlRes = await fetch(`${baseUrl}/`);
		assert.equal(htmlRes.status, 200);
		assert.match(await htmlRes.text(), /Personal Agent/);
	} finally {
		await previewManager.stopAll();
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		db.close();
	}
});

class ProgressTestWorker implements RpcWorkerLike {
	readonly options: PiRpcWorkerOptions;
	constructor(options: PiRpcWorkerOptions) {
		this.options = options;
	}
	private eventListeners: Array<(event: RpcSessionEvent) => void> = [];

	async start(): Promise<void> {
		await reportReady(this.options);
	}
	async stop(): Promise<void> {}
	async getState(): Promise<{ sessionId: string; sessionFile?: string }> {
		return { sessionId: "test-progress-session" };
	}

	onNotice(): () => void {
		return () => {};
	}

	setDialogHandler(): void {}

	onEvent(listener: (event: RpcSessionEvent) => void): () => void {
		this.eventListeners.push(listener);
		return () => {
			this.eventListeners = this.eventListeners.filter((l) => l !== listener);
		};
	}

	async runPromptAndWait(_message: string): Promise<PromptRunResult> {
		for (const listener of this.eventListeners) {
			listener({ type: "agent_start" });
			listener({ type: "tool_execution_start", toolCallId: "tc-1", toolName: "read", args: {} });
			listener({ type: "tool_execution_end", toolCallId: "tc-1", toolName: "read", result: {}, isError: false });
		}
		return {
			disposition: "started",
			aborted: false,
			assistantText: "# 交付结果\n\n- 已完成结构梳理",
			assistantMessages: [],
			toolExecutions: [],
			notices: [],
			dialogs: [],
			events: [],
		};
	}
}

test("Server emits matter_progress via SSE and supports team build, export/import, primary switch, and memory save", async () => {
	const tempRolesDir = mkdtempSync(join(tmpdir(), "pa-roles-"));
	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db);
	const templates = await loadRoleTemplatesFromDir(resolve(process.cwd(), "roles"));
	const dialogBroker = new DialogBroker();
	const previewManager = new PreviewManager();

	const orchestrator = new TeamOrchestrator({
		store,
		templates,
		onDialog: (ctx) => dialogBroker.requestApproval(ctx),
		workerFactory: (options) => new ProgressTestWorker(options),
	});

	const { server } = createPersonalAgentServer({
		store,
		orchestrator,
		templates,
		previewManager,
		dialogBroker,
		rolesDir: tempRolesDir,
		webDistDir: resolve(process.cwd(), "web/dist"),
	});

	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const baseUrl = `http://127.0.0.1:${address.port}`;

	const sseController = new AbortController();
	const sseChunks: string[] = [];

	try {
		// Connect SSE listener before dispatching matter
		const ssePromise = (async () => {
			const res = await fetch(`${baseUrl}/api/events`, { signal: sseController.signal });
			assert.equal(res.status, 200);
			const reader = res.body?.getReader();
			if (!reader) return;
			const decoder = new TextDecoder();
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				sseChunks.push(decoder.decode(value, { stream: true }));
			}
		})().catch(() => {});

		await new Promise((r) => setTimeout(r, 40));

		// 1. Bootstrap includes templates with responsibilities and keywords
		const bootRes = await fetch(`${baseUrl}/api/bootstrap`);
		assert.equal(bootRes.status, 200);
		const boot = (await bootRes.json()) as {
			templates: Array<{ id: string; responsibilities: string; keywords: string[] }>;
		};
		assert.equal(boot.templates.length, 4);
		assert.ok(boot.templates.some((t) => t.id === "engineering-manager" && t.responsibilities.length > 0));

		// 2. Dispatch matter and verify matter_progress SSE events
		const matterRes = await fetch(`${baseUrl}/api/matters`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: "帮我梳理工程结构" }),
		});
		assert.equal(matterRes.status, 202);
		const created = (await matterRes.json()) as { matter: { id: string } };

		for (let i = 0; i < 40; i++) {
			const detail = (await (await fetch(`${baseUrl}/api/matters/${created.matter.id}`)).json()) as {
				matter: { status: string };
			};
			if (detail.matter.status === "open" && sseChunks.join("").includes("matter_settled")) break;
			await new Promise((r) => setTimeout(r, 20));
		}

		const sseJoined = sseChunks.join("");
		assert.match(sseJoined, /event: matter_progress/);
		assert.match(sseJoined, /"stage":"tool"/);
		assert.match(sseJoined, /"stage":"finalizing"/);

		// 3. Create custom member (writes only inside tempRolesDir)
		const createMemberRes = await fetch(`${baseUrl}/api/members`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				name: "架构师",
				title: "System Architect",
				responsibilities: "负责系统架构设计与技术评审",
				keywords: ["架构", "重构"],
				skills: ["architecture-review"],
			}),
		});
		assert.equal(createMemberRes.status, 201);
		const newMemberPayload = (await createMemberRes.json()) as { member: { id: string; templateId: string } };
		assert.equal(newMemberPayload.member.templateId, "system-architect");

		// 4. Switch primary contact
		const primaryRes = await fetch(`${baseUrl}/api/members/${newMemberPayload.member.id}/primary`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		});
		assert.equal(primaryRes.status, 200);
		const primaryJson = (await primaryRes.json()) as { member: { isPrimaryContact: boolean } };
		assert.equal(primaryJson.member.isPrimaryContact, true);

		// 5. Save private & general memories, then export package -> private memories stay excluded
		const memRes = await fetch(`${baseUrl}/api/memories`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				memberId: newMemberPayload.member.id,
				scope: "company_private",
				content: "内部秘密代号 PROJECT_OMEGA",
			}),
		});
		assert.equal(memRes.status, 201);

		const exportRes = await fetch(`${baseUrl}/api/members/${newMemberPayload.member.id}/export`);
		assert.equal(exportRes.status, 200);
		const exported = (await exportRes.json()) as { filename: string; markdown: string };
		assert.match(exported.filename, /\.md$/);
		assert.match(exported.markdown, /架构师/);
		assert.doesNotMatch(exported.markdown, /PROJECT_OMEGA/);

		// 6. Import role package as a separate role template
		const importMarkdown = exported.markdown
			.replace("id: system-architect", "id: imported-architect")
			.replace("name: 架构师", "name: 资深架构师");
		const importRes = await fetch(`${baseUrl}/api/members/import`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ markdown: importMarkdown }),
		});
		assert.equal(importRes.status, 201);
		const importedJson = (await importRes.json()) as { member: { displayName: string } };
		assert.equal(importedJson.member.displayName, "资深架构师");

		sseController.abort();
		await ssePromise;
	} finally {
		sseController.abort();
		await previewManager.stopAll();
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		db.close();
		rmSync(tempRolesDir, { recursive: true, force: true });
	}
});

test("hashRouter parses and formats deliverable, chat, team, and materials hash routes", () => {
	assert.deepEqual(parseHashRoute(""), { tab: "chats" });
	assert.deepEqual(parseHashRoute("#/unknown"), { tab: "chats" });
	assert.deepEqual(parseHashRoute("#/deliverables/deliv-1"), {
		tab: "deliverables",
		deliverableId: "deliv-1",
	});
	assert.deepEqual(parseHashRoute("#/chats/matter%2042"), {
		tab: "chats",
		matterId: "matter 42",
	});
	assert.deepEqual(parseHashRoute("#/chats/new"), {
		tab: "chats",
		isNewMatter: true,
	});
	assert.deepEqual(parseHashRoute("#/team"), { tab: "team" });
	assert.deepEqual(parseHashRoute("#/materials"), { tab: "materials" });

	assert.equal(formatHashRoute({ tab: "deliverables" }), "#/deliverables");
	assert.equal(formatHashRoute({ tab: "deliverables", deliverableId: "d1" }), "#/deliverables/d1");
	assert.equal(formatHashRoute({ tab: "chats", matterId: "m1" }), "#/chats/m1");
	assert.equal(formatHashRoute({ tab: "chats", isNewMatter: true }), "#/chats/new");
	assert.equal(formatHashRoute({ tab: "team" }), "#/team");
	assert.equal(formatHashRoute({ tab: "materials" }), "#/materials");
});

class AbortableTestWorker implements RpcWorkerLike {
	readonly options: PiRpcWorkerOptions;
	constructor(options: PiRpcWorkerOptions) {
		this.options = options;
	}
	private resolveRun: ((res: PromptRunResult) => void) | null = null;
	private settled = false;

	async start(): Promise<void> {
		await reportReady(this.options);
	}
	async stop(): Promise<void> {
		this.finish(true);
	}
	async abort(): Promise<void> {
		this.finish(true);
	}
	async getState(): Promise<{ sessionId: string; sessionFile?: string }> {
		return { sessionId: "test-abort-session" };
	}
	onNotice(): () => void {
		return () => {};
	}
	setDialogHandler(): void {}

	private finish(aborted: boolean) {
		if (this.settled) return;
		this.settled = true;
		this.resolveRun?.({
			disposition: "started",
			aborted,
			assistantText: "",
			assistantMessages: [],
			toolExecutions: [],
			notices: [],
			dialogs: [],
			events: [],
		});
	}

	runPromptAndWait(): Promise<PromptRunResult> {
		return new Promise<PromptRunResult>((resolvePromise) => {
			this.resolveRun = resolvePromise;
		});
	}
}

test("Server supports aborting a running matter and updating its bound workspace", async () => {
	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db);
	const templates = await loadRoleTemplatesFromDir(resolve(process.cwd(), "roles"));
	const dialogBroker = new DialogBroker();
	const previewManager = new PreviewManager();

	const orchestrator = new TeamOrchestrator({
		store,
		templates,
		onDialog: (ctx) => dialogBroker.requestApproval(ctx),
		workerFactory: (options) => new AbortableTestWorker(options),
	});

	const { server } = createPersonalAgentServer({
		store,
		orchestrator,
		templates,
		previewManager,
		dialogBroker,
		webDistDir: resolve(process.cwd(), "web/dist"),
	});

	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const baseUrl = `http://127.0.0.1:${address.port}`;

	try {
		const ws1 = await (
			await fetch(`${baseUrl}/api/workspaces`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "repo-a", repoPath: "/tmp/repo-a" }),
			})
		).json();
		const ws2 = await (
			await fetch(`${baseUrl}/api/workspaces`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "repo-b", repoPath: "/tmp/repo-b" }),
			})
		).json();

		const created = (await (
			await fetch(`${baseUrl}/api/matters`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					prompt: "帮我检查 repo-a 的结构",
					workspaceId: (ws1 as { workspace: { id: string } }).workspace.id,
				}),
			})
		).json()) as { matter: { id: string } };

		// Allow worker to start
		await new Promise((r) => setTimeout(r, 40));

		// Bootstrap & detail endpoints expose live run progress so browser refresh restores status.
		const bootWhileRunning = (await (await fetch(`${baseUrl}/api/bootstrap`)).json()) as {
			activeRuns?: Record<string, { matterId: string; stage: string; startedAt: number }>;
		};
		assert.ok(bootWhileRunning.activeRuns?.[created.matter.id]?.startedAt);
		const detailWhileRunning = (await (await fetch(`${baseUrl}/api/matters/${created.matter.id}`)).json()) as {
			activeRun?: { matterId: string; stage: string; startedAt: number } | null;
		};
		assert.equal(detailWhileRunning.activeRun?.matterId, created.matter.id);

		// Reject workspace switches and overlapping messages while a turn owns this matter.
		for (const [method, path, body] of [
			["PATCH", "", { workspaceId: (ws2 as { workspace: { id: string } }).workspace.id }],
			["POST", "/messages", { prompt: "overlap" }],
		] as const) {
			const busy = await fetch(`${baseUrl}/api/matters/${created.matter.id}${path}`, {
				method,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			assert.equal(busy.status, 409);
		}

		// Updating observer seats while a turn is running is non-destructive and succeeds immediately.
		const observerUpdateWhileRunning = await fetch(`${baseUrl}/api/matters/${created.matter.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ observerMemberIds: ["engineering-manager"] }),
		});
		assert.equal(observerUpdateWhileRunning.status, 200);
		const updatedObs = (await observerUpdateWhileRunning.json()) as { matter: { observerMemberIds: string[] } };
		assert.deepEqual(updatedObs.matter.observerMemberIds, ["engineering-manager"]);

		// Abort running matter
		const abortRes = await fetch(`${baseUrl}/api/matters/${created.matter.id}/abort`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		});
		assert.equal(abortRes.status, 200);
		const abortJson = (await abortRes.json()) as { ok: boolean; aborted: boolean };
		assert.equal(abortJson.ok, true);
		assert.equal(abortJson.aborted, true);

		// Wait for orchestrator cleanup and confirm no bogus deliverable was recorded
		for (let i = 0; i < 30; i++) {
			const detail = (await (await fetch(`${baseUrl}/api/matters/${created.matter.id}`)).json()) as {
				matter: { status: string };
				userMessages: Array<{ content: string }>;
				deliverables: unknown[];
				activeRun?: unknown | null;
			};
			if (detail.userMessages.length >= 2) {
				assert.equal(detail.matter.status, "open");
				assert.equal(detail.deliverables.length, 0);
				assert.equal(detail.activeRun ?? null, null);
				assert.match(detail.userMessages[1]?.content ?? "", /停止本次执行/);
				break;
			}
			await new Promise((r) => setTimeout(r, 20));
		}

		// Switch matter workspace from repo-a to repo-b
		const targetWsId = (ws2 as { workspace: { id: string } }).workspace.id;
		const patchRes = await fetch(`${baseUrl}/api/matters/${created.matter.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ workspaceId: targetWsId }),
		});
		assert.equal(patchRes.status, 200);
		const patched = (await patchRes.json()) as { matter: { workspaceId: string | null } };
		assert.equal(patched.matter.workspaceId, targetWsId);
	} finally {
		await previewManager.stopAll();
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		db.close();
	}
});

test("Server persists partial streamed text and readable failure message in userMessages on error", async () => {
	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db);
	const templates = await loadRoleTemplatesFromDir(resolve(process.cwd(), "roles"));
	const dialogBroker = new DialogBroker();
	const previewManager = new PreviewManager();

	let attempt = 0;
	const seenPrompts: string[] = [];
	const orchestrator = new TeamOrchestrator({
		store,
		templates,
		onDialog: (ctx) => dialogBroker.requestApproval(ctx),
		workerFactory: (options) => {
			let eventListener: ((evt: RpcSessionEvent) => void) | null = null;
			return {
				async start() {
					await reportReady(options);
				},
				async getState() {
					return { sessionId: "fail-session", isStreaming: false };
				},
				onEvent(listener) {
					eventListener = listener;
					return () => {
						eventListener = null;
					};
				},
				onNotice() {
					return () => {};
				},
				setDialogHandler() {},
				async runPromptAndWait(message, runOptions) {
					attempt += 1;
					seenPrompts.push(message);
					if (attempt === 1) {
						eventListener?.({
							type: "tool_execution_start",
							toolCallId: "t-bash-1",
							toolName: "bash",
							args: { command: "npm test" },
						});
						runOptions?.onTextDelta?.("已分析部分上下文");
						throw new Error("Timed out after 180000ms waiting for agent_settled");
					}
					return {
						assistantText: "已基于上次断点完成验证",
						assistantMessages: [],
						disposition: "started",
						aborted: false,
						toolExecutions: [],
						notices: [],
						dialogs: [],
						events: [],
					};
				},
				async stop() {},
			};
		},
	});

	const { server } = createPersonalAgentServer({
		store,
		orchestrator,
		templates,
		previewManager,
		dialogBroker,
	});
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const baseUrl = `http://127.0.0.1:${address.port}`;

	try {
		const created = (await (
			await fetch(`${baseUrl}/api/matters`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ prompt: "分析超长任务" }),
			})
		).json()) as { matter: { id: string } };

		let userMessages: Array<{ senderType: string; content: string; metadata?: Record<string, unknown> | null }> = [];
		for (let i = 0; i < 30; i++) {
			const detail = (await (await fetch(`${baseUrl}/api/matters/${created.matter.id}`)).json()) as {
				userMessages: Array<{ senderType: string; content: string; metadata?: Record<string, unknown> | null }>;
			};
			userMessages = detail.userMessages;
			if (userMessages.length >= 2) break;
			await new Promise((r) => setTimeout(r, 20));
		}

		assert.equal(userMessages.length, 2);
		assert.equal(userMessages[1]?.senderType, "system");
		assert.match(userMessages[1]?.content ?? "", /已分析部分上下文/);
		assert.match(userMessages[1]?.content ?? "", /本次执行未完成/);
		assert.match(userMessages[1]?.content ?? "", /Timed out after 180000ms/);
		const snapshot = parseProgressSnapshot(userMessages[1]?.metadata);
		assert.ok(snapshot);
		assert.equal(snapshot.outcome, "failed");
		assert.equal(snapshot.stage, "tool");
		assert.equal(snapshot.toolName, "bash");
		assert.match(snapshot.label, /执行命令.*npm test/);
		assert.ok(snapshot.elapsedSeconds >= 0);
		assert.ok(snapshot.recentLogs?.some((entry) => /npm test/.test(entry.summary)));

		const resumeRes = await fetch(`${baseUrl}/api/matters/${created.matter.id}/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: "继续完成" }),
		});
		assert.equal(resumeRes.status, 202);
		for (let i = 0; i < 30; i++) {
			const detail = (await (await fetch(`${baseUrl}/api/matters/${created.matter.id}`)).json()) as {
				userMessages: Array<{ senderType: string; content: string }>;
			};
			if (detail.userMessages.length >= 4) break;
			await new Promise((r) => setTimeout(r, 20));
		}
		assert.equal(seenPrompts.length, 2);
		assert.match(seenPrompts[1] ?? "", /## 上次中断状态简报/);
		assert.match(seenPrompts[1] ?? "", /Timed out after 180000ms/);
		assert.match(seenPrompts[1] ?? "", /执行命令：npm test/);
		assert.match(seenPrompts[1] ?? "", /已分析部分上下文/);
		assert.match(seenPrompts[1] ?? "", /继续完成/);
	} finally {
		await previewManager.stopAll();
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		db.close();
	}
});

test("mapDelegationsToMessages pairs turn delegations for running, completed, and failed outcomes", () => {
	const userMessages = [
		{
			id: "u1",
			matterId: "m1",
			channel: "user" as const,
			senderType: "user" as const,
			senderId: "user",
			content: "开始技术评估",
			createdAt: "2026-11-15T01:00:00.000Z",
		},
		{
			id: "s1",
			matterId: "m1",
			channel: "user" as const,
			senderType: "system" as const,
			senderId: "orchestrator",
			content: "执行异常",
			createdAt: "2026-11-15T01:05:00.000Z",
		},
		{
			id: "u2",
			matterId: "m1",
			channel: "user" as const,
			senderType: "user" as const,
			senderId: "user",
			content: "继续追问",
			createdAt: "2026-11-15T01:06:00.000Z",
		},
	];
	const internalCollab = [
		{
			id: "c-req-1",
			matterId: "m1",
			channel: "internal_collab" as const,
			senderType: "member" as const,
			senderId: "product-manager",
			content: "@研发经理: 评估工作量",
			metadata: { toMemberId: "engineering-manager" },
			createdAt: "2026-11-15T01:00:30.000Z",
		},
		{
			id: "c-res-1",
			matterId: "m1",
			channel: "internal_collab" as const,
			senderType: "member" as const,
			senderId: "engineering-manager",
			content: "需要 3 人日。",
			metadata: { replyToMemberId: "product-manager", requestMessageId: "c-req-1" },
			createdAt: "2026-11-15T01:01:30.000Z",
		},
		{
			id: "c-req-2",
			matterId: "m1",
			channel: "internal_collab" as const,
			senderType: "member" as const,
			senderId: "product-manager",
			content: "@测试经理: 核对验收标准",
			metadata: { toMemberId: "qa-manager" },
			createdAt: "2026-11-15T01:00:35.000Z",
		},
		{
			id: "c-res-2",
			matterId: "m1",
			channel: "internal_collab" as const,
			senderType: "system" as const,
			senderId: "qa-manager",
			content: "内部委托未完成：Prompt cancelled",
			metadata: { requestMessageId: "c-req-2", failed: true },
			createdAt: "2026-11-15T01:04:50.000Z",
		},
		{
			id: "c-req-3",
			matterId: "m1",
			channel: "internal_collab" as const,
			senderType: "member" as const,
			senderId: "product-manager",
			content: "@研发经理: 二次复核",
			metadata: { toMemberId: "engineering-manager" },
			createdAt: "2026-11-15T01:06:10.000Z",
		},
	];

	const placedRunning = mapDelegationsToMessages(userMessages, internalCollab, true);
	assert.equal(placedRunning.byMessageId.get("s1")?.length, 2);
	assert.equal(placedRunning.byMessageId.get("s1")?.[0]?.status, "completed");
	assert.equal(placedRunning.byMessageId.get("s1")?.[0]?.answer, "需要 3 人日。");
	assert.equal(placedRunning.byMessageId.get("s1")?.[1]?.status, "failed");
	assert.equal(placedRunning.byMessageId.get("u2")?.[0]?.status, "running");

	const placedStopped = mapDelegationsToMessages(userMessages, internalCollab, false);
	assert.equal(placedStopped.byMessageId.get("u2")?.[0]?.status, "failed");

	assert.equal(
		formatNoticeEventLine(
			JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "docs/prd.md" } }),
		),
		"开始工具 read (docs/prd.md)",
	);
	assert.equal(inferDelegationMood("读取文件 docs/prd.md"), "tool");
	assert.equal(inferDelegationMood("撰写结论：已完成评估"), "finalizing");
	assert.equal(inferDelegationMood("待你确认方案取舍"), "waiting_user");
	assert.equal(inferDelegationMood("已接入任务"), "starting");
	assert.equal(inferDelegationMood("思考分析"), "thinking");
	assert.equal(getMemberThemeById([{ id: "pm" } as never, { id: "eng" } as never], "eng").bg, "#4e6df5");
});

test("HTTP API persists observerMemberIds and broadcasts proactive observer messages", async () => {
	const tempRoot = mkdtempSync(join(tmpdir(), "pa-phase3-observers-"));
	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db);
	const templates = await loadRoleTemplatesFromDir(resolve("roles"));
	const previewManager = new PreviewManager();
	const dialogBroker = new DialogBroker();

	const orchestrator = new TeamOrchestrator({
		store,
		templates,
		defaultCwd: process.cwd(),
		noSession: true,
		workerFactory: (workerOptions) => ({
			async start() {
				await reportReady(workerOptions);
			},
			async getState() {
				return { sessionId: `obs_${Math.random().toString(36).slice(2)}` };
			},
			onNotice() {
				return () => {};
			},
			setDialogHandler() {},
			async runPromptAndWait() {
				const ctx = workerOptions.env?.PA_MEMBER_CONTEXT ?? "";
				const assistantText = ctx.includes("(Engineering Manager)")
					? "技术补充：需要核查 SQLite 锁与连接复用。"
					: ctx.includes("(QA Manager)")
						? "[SILENT]"
						: "我先整理产品需求范围。";
				return {
					disposition: "started",
					aborted: false,
					assistantText,
					assistantMessages: [],
					toolExecutions: [],
					notices: [],
					dialogs: [],
					events: [],
				};
			},
			async stop() {},
		}),
	});

	const workspace = store.upsertWorkspace({ name: "obs-repo", repoPath: tempRoot });
	const { server } = createPersonalAgentServer({
		store,
		orchestrator,
		templates,
		previewManager,
		dialogBroker,
	});
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const baseUrl = `http://127.0.0.1:${address.port}`;

	try {
		const created = (await (
			await fetch(`${baseUrl}/api/matters`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					prompt: "设计技术评审会议",
					workspaceId: workspace.id,
					observerMemberIds: ["engineering-manager", "qa-manager"],
				}),
			})
		).json()) as { matter: { id: string; observerMemberIds: string[] } };
		assert.deepEqual(created.matter.observerMemberIds, ["engineering-manager", "qa-manager"]);

		let userMessages: Array<{ senderId: string; content: string; metadata?: Record<string, unknown> | null }> = [];
		for (let i = 0; i < 40; i++) {
			const detail = (await (await fetch(`${baseUrl}/api/matters/${created.matter.id}`)).json()) as {
				userMessages: Array<{ senderId: string; content: string; metadata?: Record<string, unknown> | null }>;
			};
			userMessages = detail.userMessages;
			if (userMessages.length >= 3) break;
			await new Promise((r) => setTimeout(r, 20));
		}

		assert.equal(userMessages.length, 3);
		assert.equal(userMessages[1]?.senderId, "product-manager");
		assert.equal(userMessages[2]?.senderId, "engineering-manager");
		assert.equal(userMessages[2]?.metadata?.observerIntervention, true);

		const patchedRes = await fetch(`${baseUrl}/api/matters/${created.matter.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ observerMemberIds: ["qa-manager"] }),
		});
		assert.equal(patchedRes.status, 200);
		const patched = (await patchedRes.json()) as {
			matter: { workspaceId: string | null; observerMemberIds: string[] };
		};
		assert.equal(patched.matter.workspaceId, workspace.id);
		assert.deepEqual(patched.matter.observerMemberIds, ["qa-manager"]);
	} finally {
		await previewManager.stopAll();
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		db.close();
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

test("Server supports Phase 4 RSI feedback evaluation, AI distillation, and memory lifecycle API", async () => {
	const tempRoot = mkdtempSync(join(tmpdir(), "pa-server-rsi-"));
	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db);
	const templates = await loadRoleTemplatesFromDir(resolve("roles"));
	const previewManager = new PreviewManager();
	const dialogBroker = new DialogBroker();
	const workspace = store.upsertWorkspace({ name: "rsi-repo", repoPath: tempRoot });

	const orchestrator = new TeamOrchestrator({
		store,
		templates,
		sessionDir: join(tempRoot, "sessions"),
		workerFactory: (options) => ({
			async start() {
				if (options.env?.PA_TEAM_BRIDGE_URL) {
					await reportReady(options);
				}
			},
			async getState() {
				return { sessionId: "rsi-http-session", sessionFile: options.sessionFile };
			},
			onNotice() {
				return () => {};
			},
			setDialogHandler() {},
			async runPromptAndWait() {
				if (!options.env?.PA_TEAM_BRIDGE_URL) {
					return {
						disposition: "started",
						aborted: false,
						assistantText: JSON.stringify({
							summary: "总结了一条新的工程发布规范",
							candidates: [
								{
									scope: "role_general",
									content: "接口变更需同时说明兼容与回滚方案",
									rationale: "线上验收关注可回滚性",
								},
							],
						}),
						assistantMessages: [],
						toolExecutions: [],
						notices: [],
						dialogs: [],
						events: [],
					};
				}

				await invokeTool(options, "publish_deliverable", {
					type: "document",
					title: "服务重构方案",
					summary: "包含启动验证命令",
					content: "# 重构方案\n\n`npm test` 通过。",
					changeNote: "初稿",
				});
				return {
					disposition: "started",
					aborted: false,
					assistantText: "已交付重构方案。",
					assistantMessages: [],
					toolExecutions: [],
					notices: [],
					dialogs: [],
					events: [],
				};
			},
			async stop() {},
		}),
	});

	const seedMemory = store.addMemory({
		memberId: "engineering-manager",
		scope: "project_private",
		workspaceId: workspace.id,
		content: "交付工程设计前必须附上可运行验证命令",
		verified: true,
		status: "verified",
	});

	const { server } = createPersonalAgentServer({
		store,
		orchestrator,
		templates,
		previewManager,
		dialogBroker,
	});
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const baseUrl = `http://127.0.0.1:${address.port}`;

	try {
		const created = (await (
			await fetch(`${baseUrl}/api/matters`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					prompt: "输出服务重构方案",
					preferredMemberId: "engineering-manager",
					workspaceId: workspace.id,
				}),
			})
		).json()) as { matter: { id: string } };

		let deliverableId = "";
		for (let i = 0; i < 40; i++) {
			const detail = (await (await fetch(`${baseUrl}/api/matters/${created.matter.id}`)).json()) as {
				deliverables: Array<{ id: string }>;
			};
			if (detail.deliverables.length > 0) {
				deliverableId = detail.deliverables[0]!.id;
				break;
			}
			await new Promise((r) => setTimeout(r, 20));
		}
		assert.ok(deliverableId);

		// Submit positive acceptance rating -> links to applied seedMemory
		const fbRes = await fetch(`${baseUrl}/api/deliverables/${deliverableId}/feedback`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				feedback: "验证命令很实用",
				rating: "positive",
			}),
		});
		assert.equal(fbRes.status, 200);
		const fbJson = (await fbRes.json()) as {
			ok: boolean;
			rating: string;
			evaluatedMemoryIds: string[];
		};
		assert.equal(fbJson.ok, true);
		assert.equal(fbJson.rating, "positive");
		assert.deepEqual(fbJson.evaluatedMemoryIds, [seedMemory.id]);

		// Check memory applications telemetry
		const appsRes = await fetch(`${baseUrl}/api/memories/${seedMemory.id}/applications`);
		assert.equal(appsRes.status, 200);
		const appsJson = (await appsRes.json()) as {
			memory: { appliedCount: number; positiveCount: number };
			applications: Array<{ outcome: string }>;
		};
		assert.equal(appsJson.memory.appliedCount, 1);
		assert.equal(appsJson.memory.positiveCount, 1);
		assert.ok(appsJson.applications.some((a) => a.outcome === "applied"));
		assert.ok(appsJson.applications.some((a) => a.outcome === "feedback_positive"));

		// A rating is one current vote for this version; neutral retracts it.
		for (const rating of ["negative", "positive", "neutral", "positive"]) {
			const vote = await fetch(`${baseUrl}/api/deliverables/${deliverableId}/feedback`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ rating }),
			});
			assert.equal(vote.status, 200);
			assert.equal(store.getMemory(seedMemory.id)?.positiveCount, rating === "positive" ? 1 : 0);
			assert.equal(store.getMemory(seedMemory.id)?.negativeCount, rating === "negative" ? 1 : 0);
		}
		const badReplacement = await fetch(`${baseUrl}/api/memories`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				memberId: "qa-manager",
				scope: "role_general",
				content: "foreign replacement",
				supersedesMemoryId: seedMemory.id,
				status: "verified",
			}),
		});
		assert.equal(badReplacement.status, 400);
		assert.equal(store.getMemory(seedMemory.id)?.status, "verified");

		const legacy = store.recordDeliverable({
			matterId: created.matter.id,
			memberId: "engineering-manager",
			type: "document",
			title: "old unscoped result",
			contentOrPath: "legacy",
		});
		const partial = await fetch(`${baseUrl}/api/deliverables/${legacy.id}/feedback`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				feedback: "saved despite reflection scope rejection",
				rating: "positive",
				autoDistill: true,
			}),
		});
		assert.equal(partial.status, 200);
		const partialJson = (await partial.json()) as { ok: boolean; distillationError?: string };
		assert.equal(partialJson.ok, true);
		assert.match(partialJson.distillationError ?? "", /current workspace/);
		assert.equal(store.getDeliverable(legacy.id)?.feedbackRating, "positive");

		// Trigger AI experience distillation via HTTP API
		const distillRes = await fetch(`${baseUrl}/api/rsi/distill`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				matterId: created.matter.id,
				deliverableId,
				feedback: "需要同时考虑回滚",
				rating: "positive",
			}),
		});
		assert.equal(distillRes.status, 200);
		const distillJson = (await distillRes.json()) as {
			ok: boolean;
			createdMemories: Array<{ id: string; status: string; verified: boolean }>;
		};
		assert.equal(distillJson.ok, true);
		assert.equal(distillJson.createdMemories.length, 1);
		const candidateId = distillJson.createdMemories[0]!.id;
		assert.equal(distillJson.createdMemories[0]!.status, "candidate");
		assert.equal(distillJson.createdMemories[0]!.verified, false);

		// Verify candidate -> verified, and evaluate manually
		const patchRes = await fetch(`${baseUrl}/api/memories/${candidateId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "verified" }),
		});
		assert.equal(patchRes.status, 200);
		const patchJson = (await patchRes.json()) as { memory: { status: string; verified: boolean } };
		assert.equal(patchJson.memory.status, "verified");
		assert.equal(patchJson.memory.verified, true);

		const evalRes = await fetch(`${baseUrl}/api/memories/${candidateId}/evaluate`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ outcome: "negative", note: "补充更多案例" }),
		});
		assert.equal(evalRes.status, 200);
		const evalJson = (await evalRes.json()) as { memory: { negativeCount: number } };
		assert.equal(evalJson.memory.negativeCount, 1);

		// Create categorized memory + reassign memberId via PATCH + validate rejection of bad category/memberId
		const manualCatRes = await fetch(`${baseUrl}/api/memories`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				memberId: "engineering-manager",
				scope: "role_general",
				category: "troubleshooting",
				content: "先 check 日志 tail 再重跑",
				rationale: "定位问题更快",
				sourceMatterId: created.matter.id,
				status: "candidate",
			}),
		});
		assert.equal(manualCatRes.status, 201);
		const manualCatJson = (await manualCatRes.json()) as {
			memory: { id: string; memberId: string; category: string };
		};
		assert.equal(manualCatJson.memory.category, "troubleshooting");

		const reassignRes = await fetch(`${baseUrl}/api/memories/${manualCatJson.memory.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				memberId: "qa-manager",
				category: "efficiency",
				status: "verified",
			}),
		});
		assert.equal(reassignRes.status, 200);
		const reassignJson = (await reassignRes.json()) as {
			memory: { memberId: string; category: string; verified: boolean };
		};
		assert.equal(reassignJson.memory.memberId, "qa-manager");
		assert.equal(reassignJson.memory.category, "efficiency");
		assert.equal(reassignJson.memory.verified, true);

		const badCatRes = await fetch(`${baseUrl}/api/memories/${manualCatJson.memory.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ category: "invalid_category" }),
		});
		assert.equal(badCatRes.status, 400);

		const missingMemberRes = await fetch(`${baseUrl}/api/memories/${manualCatJson.memory.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ memberId: "non-existent-role" }),
		});
		assert.equal(missingMemberRes.status, 404);

		// Abort distillation endpoint returns aborted: false when idle and validates matterId
		const idleAbortRes = await fetch(`${baseUrl}/api/rsi/distill/abort`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ matterId: created.matter.id }),
		});
		assert.equal(idleAbortRes.status, 200);
		assert.deepEqual(await idleAbortRes.json(), { ok: true, aborted: false });

		const badAbortRes = await fetch(`${baseUrl}/api/rsi/distill/abort`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		assert.equal(badAbortRes.status, 400);
	} finally {
		await previewManager.stopAll();
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		db.close();
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

test("formatElapsedDuration and parseProgressSnapshot safely handle snapshot metadata", () => {
	assert.equal(formatElapsedDuration(0), "0s");
	assert.equal(formatElapsedDuration(31), "31s");
	assert.equal(formatElapsedDuration(179), "2m 59s");
	assert.equal(formatElapsedDuration(1800), "30m 0s");
	assert.equal(formatElapsedDuration(3720), "1h 2m");

	assert.equal(parseProgressSnapshot(null), null);
	assert.equal(parseProgressSnapshot({}), null);
	assert.equal(parseProgressSnapshot({ progressSnapshot: { stage: "unknown", outcome: "failed", label: "x" } }), null);

	const parsed = parseProgressSnapshot({
		progressSnapshot: {
			outcome: "aborted",
			stage: "tool",
			label: "已委托研发经理",
			elapsedSeconds: 45,
			activeDelegations: [
				{ memberId: "engineering-manager", memberName: "研发经理", stageLabel: "思考分析" },
				{ broken: true },
			],
			recentLogs: [{ memberName: "研发经理", summary: "执行命令：npm test", at: "2026-11-15T03:10:00.000Z" }],
		},
	});
	assert.ok(parsed);
	assert.equal(parsed.outcome, "aborted");
	assert.equal(parsed.stage, "tool");
	assert.equal(parsed.elapsedSeconds, 45);
	assert.equal(parsed.activeDelegations?.length, 1);
	assert.equal(parsed.recentLogs?.length, 1);
});

test("collectMatterMemories and collectMatterParticipantIds aggregate multi-role experiences", () => {
	assert.equal(MEMORY_CATEGORY_LABELS.efficiency, "提效方法");
	assert.equal(MEMORY_CATEGORY_LABELS.troubleshooting, "问题排障");

	const sorted = collectMatterMemories(
		{
			"product-manager": [
				{
					id: "m1",
					memberId: "product-manager",
					scope: "role_general",
					category: "collaboration",
					orgId: null,
					workspaceId: null,
					content: "verified pm rule",
					sourceMatterId: "mat-1",
					sourceDeliverableId: null,
					status: "verified",
					verified: true,
					appliedCount: 0,
					positiveCount: 0,
					negativeCount: 0,
					createdAt: "2026-11-15T10:00:00.000Z",
				},
			],
			"engineering-manager": [
				{
					id: "m2",
					memberId: "engineering-manager",
					scope: "role_general",
					category: "troubleshooting",
					orgId: null,
					workspaceId: null,
					content: "candidate eng rule",
					sourceMatterId: "mat-1",
					sourceDeliverableId: "deliv-1",
					status: "candidate",
					verified: false,
					appliedCount: 0,
					positiveCount: 0,
					negativeCount: 0,
					createdAt: "2026-11-15T09:00:00.000Z",
				},
				{
					id: "m3",
					memberId: "engineering-manager",
					scope: "role_general",
					category: "general",
					orgId: null,
					workspaceId: null,
					content: "other matter rule",
					sourceMatterId: "mat-other",
					sourceDeliverableId: null,
					status: "candidate",
					verified: false,
					appliedCount: 0,
					positiveCount: 0,
					negativeCount: 0,
					createdAt: "2026-11-15T11:00:00.000Z",
				},
			],
		},
		"mat-1",
		"deliv-1",
	);
	assert.deepEqual(
		sorted.map((m) => m.id),
		["m2", "m1"],
	);

	const participants = collectMatterParticipantIds({
		matter: {
			id: "mat-1",
			title: "Test",
			summary: "",
			workspaceId: null,
			leadMemberId: "product-manager",
			observerMemberIds: ["qa-manager"],
			status: "open",
			createdAt: "2026-11-15T09:00:00.000Z",
			updatedAt: "2026-11-15T09:00:00.000Z",
		},
		internalCollabMessages: [
			{
				id: "msg-1",
				matterId: "mat-1",
				channel: "internal_collab",
				senderType: "member",
				senderId: "product-manager",
				content: "请研发跟进",
				metadata: { toMemberId: "engineering-manager" },
				createdAt: "2026-11-15T09:05:00.000Z",
			},
		],
	});
	assert.deepEqual(new Set(participants), new Set(["product-manager", "qa-manager", "engineering-manager"]));
});

test("formatNoticeEventLine and isKeyNoticeEvent handle truncated tool JSON notices safely", () => {
	const truncatedRead =
		'{"type":"tool_execution_end","toolCallId":"tool_1","toolName":"read","result":{"content":[{"type":"text","text":"# Huge PRD doc without closing brace...';
	assert.equal(formatNoticeEventLine(truncatedRead), "结束工具 read");
	assert.equal(isKeyNoticeEvent(truncatedRead), false);

	const truncatedFailedBash =
		'{"type":"tool_execution_end","toolCallId":"tool_2","toolName":"bash","isError":true,"result":"long...';
	assert.equal(formatNoticeEventLine(truncatedFailedBash), "结束工具 bash（失败）");
	assert.equal(isKeyNoticeEvent(truncatedFailedBash), true);

	assert.equal(isKeyNoticeEvent('{"method":"error","message":"Timed out"}'), true);
});

test("pickDefaultWorkspaceId prefers memory workspace, then active matter workspace, then first workspace", () => {
	const workspaces = [{ id: "personal-agent" }, { id: "bookshelf" }];
	assert.equal(pickDefaultWorkspaceId(workspaces, null, "bookshelf"), "bookshelf");
	assert.equal(pickDefaultWorkspaceId(workspaces, "personal-agent", "bookshelf"), "personal-agent");
	assert.equal(pickDefaultWorkspaceId(workspaces, "missing-ws", null), "personal-agent");
	assert.equal(pickDefaultWorkspaceId([], null, "bookshelf"), "");
});

test("parseDeliverableSummary extracts lead takeaway and scannable process/evidence bullets", () => {
	const raw =
		"M1 收口：QA 验收通过（10/10），默认档 T1。\n交付依据：v1.6 收口并按用户指示收尾。QA 验收报告已归档。\n固化结论：recall 89.9%（62/69）。p95 T1 达标，待补 S1 实拍。";
	const parsed = parseDeliverableSummary(raw);
	assert.equal(parsed.lead, "M1 收口：QA 验收通过（10/10），默认档 T1。");
	assert.deepEqual(parsed.details, [
		"交付依据：v1.6 收口并按用户指示收尾。QA 验收报告已归档。",
		"固化结论：recall 89.9%（62/69）。p95 T1 达标，待补 S1 实拍。",
	]);

	const inlineLabeled =
		"第一句核心结论。交付依据：补充检查完成。固化结论：所有门禁全部通过，其余指标保持不变，下周继续推进下一阶段内容！";
	const inlineParsed = parseDeliverableSummary(inlineLabeled, 40);
	assert.equal(inlineParsed.lead, "第一句核心结论。");
	assert.ok(inlineParsed.details.length >= 2);
	assert.equal(parseDeliverableSummary("   ").lead, "");
});

test("parseMessageImages extracts valid lightweight image refs from message metadata", () => {
	assert.deepEqual(parseMessageImages(null), []);
	assert.deepEqual(
		parseMessageImages({
			images: [
				{ url: "/api/uploads/a.png", mimeType: "image/png", name: "a.png" },
				{ mimeType: "image/webp" },
				null,
				{},
			],
		}),
		[{ url: "/api/uploads/a.png", mimeType: "image/png", name: "a.png" }, { mimeType: "image/webp" }],
	);
});

test("HTTP server persists uploaded chat images to uploadsDir, forwards them to worker, and serves GET /api/uploads/:file", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pa-uploads-"));
	const dbPath = join(tempDir, "test.sqlite");
	const uploadsDir = join(tempDir, "uploads");
	const receivedImages: Array<Array<{ type: string; data: string; mimeType: string }>> = [];
	const pngPayload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
	const pngBase64 = pngPayload.toString("base64");

	class ImageCaptureWorker implements RpcWorkerLike {
		readonly options: PiRpcWorkerOptions;
		constructor(options: PiRpcWorkerOptions) {
			this.options = options;
		}
		async start() {
			await reportReady(this.options);
		}
		async getState() {
			return { sessionId: "sess-img", sessionFile: undefined };
		}
		async stop() {}
		async abort() {}
		onEvent() {
			return () => {};
		}
		onNotice() {
			return () => {};
		}
		setDialogHandler() {}
		async runPromptAndWait(
			_prompt: string,
			options: { images?: Array<{ type: string; data: string; mimeType: string }> } = {},
		): Promise<PromptRunResult> {
			if (options.images) receivedImages.push(options.images);
			return {
				disposition: "started",
				aborted: false,
				assistantText: "已识别截图内容",
				assistantMessages: [],
				toolExecutions: [],
				notices: [],
				dialogs: [],
				events: [],
			};
		}
	}

	const db = openPersonalAgentDatabase(dbPath);
	const store = new PersonalAgentStore(db);
	const templates = await loadRoleTemplatesFromDir(resolve(process.cwd(), "roles"));
	const orchestrator = new TeamOrchestrator({
		store,
		templates,
		defaultCwd: tempDir,
		workerFactory: (opts) => new ImageCaptureWorker(opts),
	});
	const { server } = createPersonalAgentServer({
		store,
		orchestrator,
		templates,
		previewManager: new PreviewManager(),
		dialogBroker: new DialogBroker(),
		uploadsDir,
	});

	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const baseUrl = `http://127.0.0.1:${address.port}`;

	try {
		// Reject empty request without prompt or images
		const emptyRes = await fetch(`${baseUrl}/api/matters`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: "   " }),
		});
		assert.equal(emptyRes.status, 400);

		// Reject unsupported MIME type
		const badMimeRes = await fetch(`${baseUrl}/api/matters`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				prompt: "check file",
				images: [{ mimeType: "application/pdf", data: pngBase64, name: "bad.pdf" }],
			}),
		});
		assert.equal(badMimeRes.status, 400);

		// Accept image-only matter creation
		const createRes = await fetch(`${baseUrl}/api/matters`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				prompt: "",
				images: [{ mimeType: "image/png", data: pngBase64, name: "screen.png" }],
			}),
		});
		assert.equal(createRes.status, 202);
		const createdBody = (await createRes.json()) as { matter: { id: string; title: string } };
		assert.equal(createdBody.matter.title, "图片：screen.png");

		// Wait briefly for background dispatch to persist user/assistant messages
		type DetailResult = {
			userMessages: Array<{ senderType: string; metadata?: Record<string, unknown> | null }>;
			activeRun?: unknown;
		};
		let detail: DetailResult | null = null;
		for (let i = 0; i < 30; i += 1) {
			const res = await fetch(`${baseUrl}/api/matters/${createdBody.matter.id}`);
			const data = (await res.json()) as DetailResult;
			if (data.userMessages.length >= 2 && !data.activeRun) {
				detail = data;
				break;
			}
			await new Promise((r) => setTimeout(r, 25));
		}
		assert.ok(detail);
		assert.equal(receivedImages.length, 1);
		assert.deepEqual(receivedImages[0], [{ type: "image", data: pngBase64, mimeType: "image/png" }]);

		const userMsg = detail.userMessages.find((m) => m.senderType === "user");
		assert.ok(userMsg);
		const storedImages = parseMessageImages(userMsg.metadata);
		assert.equal(storedImages.length, 1);
		assert.match(storedImages[0]!.url ?? "", /^\/api\/uploads\/.+\.png$/);
		assert.equal(storedImages[0]!.name, "screen.png");
		assert.equal(readdirSync(uploadsDir).length, 1);

		const uploadGetRes = await fetch(`${baseUrl}${storedImages[0]!.url!}`);
		assert.equal(uploadGetRes.status, 200);
		assert.equal(uploadGetRes.headers.get("content-type"), "image/png");
		const fetchedBytes = Buffer.from(await uploadGetRes.arrayBuffer());
		assert.deepEqual(fetchedBytes, pngPayload);

		// Follow-up message with text + image
		const followupRes = await fetch(`${baseUrl}/api/matters/${createdBody.matter.id}/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				prompt: "再看一下这第二张",
				images: [{ mimeType: "image/jpeg", data: pngBase64, name: "second.jpg" }],
			}),
		});
		assert.equal(followupRes.status, 202);
		for (let i = 0; i < 30; i += 1) {
			if (receivedImages.length >= 2 && !orchestrator.isMatterRunning(createdBody.matter.id)) break;
			await new Promise((r) => setTimeout(r, 25));
		}
		assert.equal(receivedImages.length, 2);
		assert.deepEqual(receivedImages[1], [{ type: "image", data: pngBase64, mimeType: "image/jpeg" }]);

		// Path traversal / unknown upload should return 404
		const missingUpload = await fetch(`${baseUrl}/api/uploads/does-not-exist.png`);
		assert.equal(missingUpload.status, 404);
	} finally {
		await orchestrator.shutdown();
		server.closeAllConnections();
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		db.close();
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("organization CRUD, workspace binding, member identity updates & sanitized export, and frontend identity helpers", async () => {
	assert.equal(MEMORY_SCOPE_SHORT_LABELS.role_general, "岗位通用");
	assert.equal(MEMORY_SCOPE_SHORT_LABELS.company_private, "组织记忆");
	assert.equal(MEMORY_SCOPE_SHORT_LABELS.project_private, "仓库记忆");
	assert.match(MEMORY_SCOPE_LABELS.company_private ?? "", /组织/);

	const gitDefault = formatMemberGitIdentity(
		{ id: "pm", displayName: "产品经理", roleTitle: "Product Manager", gitName: "", gitEmail: "pm@team.local" },
		{ gitEmailDomain: "@acme.dev" },
	);
	assert.equal(gitDefault.formatted, "Product Manager <pm@acme.dev>");

	const gitCustom = formatMemberGitIdentity(
		{ id: "pm", displayName: "PM", gitName: "Alice", gitEmail: "alice@custom.io" },
		{ gitEmailDomain: "acme.dev" },
	);
	assert.equal(gitCustom.formatted, "Alice <alice@custom.io>");

	const scopeCounts = countMemberMemoriesByScope([
		{
			id: "m1",
			memberId: "pm",
			scope: "role_general",
			category: "general",
			orgId: null,
			workspaceId: null,
			content: "a",
			status: "verified",
			verified: true,
			appliedCount: 0,
			positiveCount: 0,
			negativeCount: 0,
			createdAt: "2026-11-15T00:00:00Z",
		},
		{
			id: "m2",
			memberId: "pm",
			scope: "company_private",
			category: "collaboration",
			orgId: "org1",
			workspaceId: null,
			content: "b",
			status: "candidate",
			verified: false,
			appliedCount: 0,
			positiveCount: 0,
			negativeCount: 0,
			createdAt: "2026-11-15T00:00:00Z",
		},
		{
			id: "m3",
			memberId: "pm",
			scope: "project_private",
			category: "domain_constraint",
			orgId: null,
			workspaceId: "ws1",
			content: "c",
			status: "verified",
			verified: true,
			appliedCount: 0,
			positiveCount: 0,
			negativeCount: 0,
			createdAt: "2026-11-15T00:00:00Z",
		},
		{
			id: "m4",
			memberId: "pm",
			scope: "project_private",
			category: "general",
			orgId: null,
			workspaceId: "ws1",
			content: "ignored",
			status: "rejected",
			verified: false,
			appliedCount: 0,
			positiveCount: 0,
			negativeCount: 0,
			createdAt: "2026-11-15T00:00:00Z",
		},
	]);
	assert.deepEqual(scopeCounts, {
		totalActive: 3,
		roleGeneral: 1,
		companyPrivate: 1,
		projectPrivate: 1,
		pendingReview: 1,
	});

	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db);
	const templates = await loadRoleTemplatesFromDir(resolve(process.cwd(), "roles"));
	const tempDir = mkdtempSync(join(tmpdir(), "pa-server-org-"));
	const dialogBroker = new DialogBroker();
	const previewManager = new PreviewManager();
	const orchestrator = new TeamOrchestrator({
		store,
		templates,
		noSession: true,
		workerFactory: (opts) =>
			({
				options: opts,
				onSessionEvent: () => () => {},
				onNotice: () => () => {},
				setDialogHandler: () => {},
				start: async () => {},
				stop: async () => {},
				getState: async () => ({ sessionId: "s", isStreaming: false }),
				runPromptAndWait: async () => ({
					disposition: "started",
					aborted: false,
					assistantText: "ok",
					assistantMessages: [],
					toolExecutions: [],
					notices: [],
					dialogs: [],
					events: [],
				}),
			}) as unknown as RpcWorkerLike,
	});

	const { server } = createPersonalAgentServer({
		store,
		orchestrator,
		templates,
		dialogBroker,
		previewManager,
		uploadsDir: join(tempDir, "uploads"),
	});
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const baseUrl = `http://127.0.0.1:${address.port}`;

	try {
		const orgCreate = await fetch(`${baseUrl}/api/organizations`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				name: "Acme Corp",
				gitEmailDomain: "@acme.dev",
				description: "Engineering org",
			}),
		});
		assert.equal(orgCreate.status, 201);
		const { organization } = (await orgCreate.json()) as {
			organization: { id: string; name: string; gitEmailDomain: string };
		};
		assert.equal(organization.gitEmailDomain, "acme.dev");

		const orgPatch = await fetch(`${baseUrl}/api/organizations/${organization.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ description: "Updated org description" }),
		});
		assert.equal(orgPatch.status, 200);

		const wsCreate = await fetch(`${baseUrl}/api/workspaces`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				orgId: organization.id,
				name: "app-one",
				repoPath: join(tempDir, "app-one"),
			}),
		});
		assert.equal(wsCreate.status, 201);
		const { workspace } = (await wsCreate.json()) as { workspace: { id: string; orgId: string | null } };
		assert.equal(workspace.orgId, organization.id);

		const badWsPatch = await fetch(`${baseUrl}/api/workspaces/${workspace.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ orgId: "non-existent-org" }),
		});
		assert.equal(badWsPatch.status, 404);

		const memberPatch = await fetch(`${baseUrl}/api/members/product-manager`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				gitName: "PM Secret Name",
				gitEmail: "secret-pm@acme.dev",
				identitySummary: "Private internal company background",
			}),
		});
		assert.equal(memberPatch.status, 200);
		const patchedMember = (await memberPatch.json()) as {
			member: { gitName: string; gitEmail: string; identitySummary: string };
		};
		assert.equal(patchedMember.member.gitName, "PM Secret Name");
		assert.equal(patchedMember.member.gitEmail, "secret-pm@acme.dev");
		assert.equal(patchedMember.member.identitySummary, "Private internal company background");

		// Public role export MUST NOT leak private gitEmail, identitySummary, or org name
		const exportRes = await fetch(`${baseUrl}/api/members/product-manager/export`);
		assert.equal(exportRes.status, 200);
		const exported = (await exportRes.json()) as { markdown: string };
		assert.doesNotMatch(exported.markdown, /secret-pm@acme\.dev/);
		assert.doesNotMatch(exported.markdown, /Private internal company background/);
		assert.doesNotMatch(exported.markdown, /Acme Corp/);

		// Memory CRUD with orgId
		const memRes = await fetch(`${baseUrl}/api/memories`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				memberId: "product-manager",
				scope: "company_private",
				orgId: organization.id,
				content: "All Acme PRs require tests",
			}),
		});
		assert.equal(memRes.status, 201);
		const { memory } = (await memRes.json()) as {
			memory: { id: string; orgId: string | null; workspaceId: string | null };
		};
		assert.equal(memory.orgId, organization.id);
		assert.equal(memory.workspaceId, null);

		const memSwitchRes = await fetch(`${baseUrl}/api/memories/${memory.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				scope: "project_private",
				workspaceId: workspace.id,
			}),
		});
		assert.equal(memSwitchRes.status, 200);
		const switched = (await memSwitchRes.json()) as {
			memory: { scope: string; orgId: string | null; workspaceId: string | null };
		};
		assert.equal(switched.memory.scope, "project_private");
		assert.equal(switched.memory.orgId, null);
		assert.equal(switched.memory.workspaceId, workspace.id);

		const bootstrapRes = await fetch(`${baseUrl}/api/bootstrap`);
		const bootstrapBody = (await bootstrapRes.json()) as {
			organizations: Array<{ id: string; isDefault?: boolean }>;
		};
		assert.equal(bootstrapBody.organizations.length, 1);
		assert.equal(bootstrapBody.organizations[0]?.id, organization.id);
		assert.equal(bootstrapBody.organizations[0]?.isDefault, true);

		// Creating another org & promoting it as default, then auto-assigning a new workspace with omitted orgId
		const secondOrgRes = await fetch(`${baseUrl}/api/organizations`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "Default Org Two" }),
		});
		assert.equal(secondOrgRes.status, 201);
		const { organization: secondOrg } = (await secondOrgRes.json()) as {
			organization: { id: string; isDefault: boolean };
		};
		assert.equal(secondOrg.isDefault, false);

		const setDefaultRes = await fetch(`${baseUrl}/api/organizations/${secondOrg.id}/default`, { method: "POST" });
		assert.equal(setDefaultRes.status, 200);

		const autoWsRes = await fetch(`${baseUrl}/api/workspaces`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "auto-org-ws", repoPath: join(tempDir, "auto-org-ws") }),
		});
		assert.equal(autoWsRes.status, 201);
		const { workspace: autoWs } = (await autoWsRes.json()) as { workspace: { orgId: string | null } };
		assert.equal(autoWs.orgId, secondOrg.id);

		// Explicit orgId: null still creates a standalone workspace
		const standaloneWsRes = await fetch(`${baseUrl}/api/workspaces`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "standalone-ws", repoPath: join(tempDir, "standalone-ws"), orgId: null }),
		});
		assert.equal(standaloneWsRes.status, 201);
		const { workspace: standaloneWs } = (await standaloneWsRes.json()) as { workspace: { orgId: string | null } };
		assert.equal(standaloneWs.orgId, null);

		// Creating & switching organization on a workspace-less matter (e.g., new org with no registered repos yet)
		const createMatterRes = await fetch(`${baseUrl}/api/matters`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: "Plan test-org roadmap", orgId: secondOrg.id }),
		});
		assert.equal(createMatterRes.status, 202);
		const { matter: orgMatter } = (await createMatterRes.json()) as {
			matter: { id: string; orgId: string | null; workspaceId: string | null };
		};
		assert.equal(orgMatter.orgId, secondOrg.id);
		assert.equal(orgMatter.workspaceId, null);

		await orchestrator.abortMatter(orgMatter.id);

		const patchMatterOrgRes = await fetch(`${baseUrl}/api/matters/${orgMatter.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ orgId: organization.id }),
		});
		assert.equal(patchMatterOrgRes.status, 200);
		const patchedOrgMatter = (await patchMatterOrgRes.json()) as {
			matter: { orgId: string | null; workspaceId: string | null };
		};
		assert.equal(patchedOrgMatter.matter.orgId, organization.id);
	} finally {
		await orchestrator.shutdown();
		server.closeAllConnections();
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		db.close();
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("Multi-human restricted collaboration: auth gate, discussion vs ai_request vs dispatch, owner approval, and token redaction", async () => {
	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db);
	const owner = store.ensureOwnerCollaborator("团队所有者");
	const templates = await loadRoleTemplatesFromDir(resolve(process.cwd(), "roles"));
	const tempDir = mkdtempSync(join(tmpdir(), "pa-server-collab-"));
	const dialogBroker = new DialogBroker();
	const previewManager = new PreviewManager();
	const capturedPrompts: string[] = [];

	const orchestrator = new TeamOrchestrator({
		store,
		templates,
		noSession: true,
		defaultCwd: tempDir,
		workerFactory: (opts) =>
			({
				options: opts,
				onSessionEvent: () => () => {},
				onNotice: () => () => {},
				setDialogHandler: () => {},
				start: async () => {
					await reportReady(opts);
				},
				stop: async () => {},
				getState: async () => ({ sessionId: "s", isStreaming: false }),
				runPromptAndWait: async (prompt: string) => {
					capturedPrompts.push(prompt);
					return {
						disposition: "started",
						aborted: false,
						assistantText: "已按所有者确认的提请完成分析。",
						assistantMessages: [],
						toolExecutions: [],
						notices: [],
						dialogs: [],
						events: [],
					};
				},
			}) as unknown as RpcWorkerLike,
	});

	const { server } = createPersonalAgentServer({
		store,
		orchestrator,
		templates,
		dialogBroker,
		previewManager,
		uploadsDir: join(tempDir, "uploads"),
		requireAuth: true,
	});
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const baseUrl = `http://127.0.0.1:${address.port}`;

	try {
		// Unauthenticated LAN session check & API rejection
		const unauthSession = await fetch(`${baseUrl}/api/auth/session`);
		assert.equal(unauthSession.status, 200);
		const unauthSessionJson = (await unauthSession.json()) as { authenticated: boolean; currentUser: unknown };
		assert.equal(unauthSessionJson.authenticated, false);
		assert.equal(unauthSessionJson.currentUser, null);

		const unauthBoot = await fetch(`${baseUrl}/api/bootstrap`);
		assert.equal(unauthBoot.status, 401);

		// Owner login sets cookie & adds collaborator
		const ownerLogin = await fetch(`${baseUrl}/api/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token: owner.token }),
		});
		assert.equal(ownerLogin.status, 200);
		const ownerCookie = ownerLogin.headers.get("set-cookie")?.split(";")[0] ?? "";
		assert.match(ownerCookie, /^pa_session=/);

		const addCollabRes = await fetch(`${baseUrl}/api/collaborators`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: ownerCookie },
			body: JSON.stringify({ name: "李四", roleTitle: "后端研发" }),
		});
		assert.equal(addCollabRes.status, 201);
		const { collaborator: colleague } = (await addCollabRes.json()) as {
			collaborator: { id: string; name: string; roleTitle: string; token: string; permissionRole: string };
		};
		assert.equal(colleague.permissionRole, "collaborator");
		assert.ok(colleague.token.startsWith("inv_"));

		// Collaborator login & token redaction
		const collabLogin = await fetch(`${baseUrl}/api/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token: colleague.token }),
		});
		assert.equal(collabLogin.status, 200);
		const collabCookie = collabLogin.headers.get("set-cookie")?.split(";")[0] ?? "";

		const collabBootRes = await fetch(`${baseUrl}/api/bootstrap`, { headers: { Cookie: collabCookie } });
		assert.equal(collabBootRes.status, 200);
		const collabBoot = (await collabBootRes.json()) as {
			currentUser: { id: string; permissionRole: string; token?: string };
			collaborators: Array<{ id: string; token?: string }>;
		};
		assert.equal(collabBoot.currentUser.id, colleague.id);
		assert.equal(collabBoot.currentUser.permissionRole, "collaborator");
		for (const item of collabBoot.collaborators) {
			assert.equal(item.token, undefined);
		}

		// Collaborator is blocked from admin & direct AI dispatch
		for (const [urlPath, payload] of [
			["/api/matters", { prompt: "直接触发 AI" }],
			["/api/organizations", { name: "Unauthorized Org" }],
			["/api/workspaces", { name: "bad-ws", repoPath: tempDir }],
			["/api/members", { name: "hack", title: "Hack" }],
			["/api/previews", { url: "http://127.0.0.1:9999" }],
		] as const) {
			const res = await fetch(`${baseUrl}${urlPath}`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Cookie: collabCookie },
				body: JSON.stringify(payload),
			});
			assert.equal(res.status, 403, `Expected 403 for collaborator on ${urlPath}`);
		}

		// Collaborator starts a matter in discussion mode & submits follow-up discussion + ai_request
		const startDiscussionRes = await fetch(`${baseUrl}/api/matters`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: collabCookie },
			body: JSON.stringify({ mode: "discussion", prompt: "大家先讨论一下接口协议字段名" }),
		});
		assert.equal(startDiscussionRes.status, 201);
		const { matter } = (await startDiscussionRes.json()) as {
			matter: { id: string; collaboratorIds: string[] };
		};
		assert.ok(matter.collaboratorIds.includes(colleague.id));

		const postAiRequestRes = await fetch(`${baseUrl}/api/matters/${matter.id}/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: collabCookie },
			body: JSON.stringify({ mode: "ai_request", prompt: "请 AI 根据刚才讨论整理 API 文档" }),
		});
		assert.equal(postAiRequestRes.status, 201);
		const { message: requestMsg } = (await postAiRequestRes.json()) as {
			message: { id: string; metadata: Record<string, unknown> };
		};
		assert.equal(requestMsg.metadata.mode, "ai_request");
		assert.equal(requestMsg.metadata.aiRequestStatus, "pending");

		// Collaborator cannot directly dispatch on existing matter
		const forbiddenDispatch = await fetch(`${baseUrl}/api/matters/${matter.id}/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: collabCookie },
			body: JSON.stringify({ prompt: "绕过审核直接派发" }),
		});
		assert.equal(forbiddenDispatch.status, 403);

		// Collaborator cannot approve own ai_request
		const forbiddenApprove = await fetch(`${baseUrl}/api/matters/${matter.id}/messages/${requestMsg.id}/approve-ai`, {
			method: "POST",
			headers: { Cookie: collabCookie },
		});
		assert.equal(forbiddenApprove.status, 403);

		// Owner approves ai_request -> AI worker executes with discussion + request context
		const ownerApprove = await fetch(`${baseUrl}/api/matters/${matter.id}/messages/${requestMsg.id}/approve-ai`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: ownerCookie },
			body: "{}",
		});
		assert.equal(ownerApprove.status, 202);

		await new Promise<void>((resolveWait, rejectWait) => {
			const deadline = Date.now() + 2000;
			const poll = () => {
				if (capturedPrompts.length > 0 && !orchestrator.isMatterRunning(matter.id)) {
					resolveWait();
					return;
				}
				if (Date.now() > deadline) {
					rejectWait(new Error("Timed out waiting for approved AI request dispatch"));
					return;
				}
				setTimeout(poll, 25);
			};
			poll();
		});
		assert.match(capturedPrompts[0] ?? "", /\[团队讨论\] 李四 \(后端研发\): 大家先讨论一下接口协议字段名/);
		assert.match(capturedPrompts[0] ?? "", /Owner 已确认同事 李四 的 AI 提请并安排执行/);

		// Collaborator can rate deliverable without autoDistill, but autoDistill: true returns 403
		const deliv = store.recordDeliverable({
			matterId: matter.id,
			memberId: "product-manager",
			type: "document",
			title: "接口设计方案",
			summary: "Draft",
			contentOrPath: "# API",
		});
		const forbiddenDistill = await fetch(`${baseUrl}/api/deliverables/${deliv.id}/feedback`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: collabCookie },
			body: JSON.stringify({ feedback: "需要补充错误码", rating: "neutral", autoDistill: true }),
		});
		assert.equal(forbiddenDistill.status, 403);

		const allowedFeedback = await fetch(`${baseUrl}/api/deliverables/${deliv.id}/feedback`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: collabCookie },
			body: JSON.stringify({ feedback: "字段定义清晰", rating: "positive" }),
		});
		assert.equal(allowedFeedback.status, 200);
		const fbJson = (await allowedFeedback.json()) as { feedback: string; rating: string };
		assert.equal(fbJson.rating, "positive");
		assert.equal(fbJson.feedback, "[李四 (后端研发)]: 字段定义清晰");

		// Dismiss flow + token regeneration
		const secondReqRes = await fetch(`${baseUrl}/api/matters/${matter.id}/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: collabCookie },
			body: JSON.stringify({ mode: "ai_request", prompt: "顺便重构一下数据库层" }),
		});
		assert.equal(secondReqRes.status, 201);
		const { message: secondReq } = (await secondReqRes.json()) as { message: { id: string } };
		const dismissRes = await fetch(`${baseUrl}/api/matters/${matter.id}/messages/${secondReq.id}/dismiss-ai`, {
			method: "POST",
			headers: { Cookie: ownerCookie },
		});
		assert.equal(dismissRes.status, 200);
		assert.equal(store.getMessage(secondReq.id)?.metadata?.aiRequestStatus, "dismissed");

		const regenRes = await fetch(`${baseUrl}/api/collaborators/${colleague.id}/regenerate-token`, {
			method: "POST",
			headers: { Cookie: ownerCookie },
		});
		assert.equal(regenRes.status, 200);
		const oldLogin = await fetch(`${baseUrl}/api/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token: colleague.token }),
		});
		assert.equal(oldLogin.status, 401);
	} finally {
		await orchestrator.shutdown();
		server.closeAllConnections();
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		db.close();
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("Matter AI roster, lead switching, Matter-wide observer toggle, and delegation scope enforcement", async () => {
	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db);
	const templates = await loadRoleTemplatesFromDir(resolve(process.cwd(), "roles"));
	const tempDir = mkdtempSync(join(tmpdir(), "pa-server-roster-"));
	const dialogBroker = new DialogBroker();
	const previewManager = new PreviewManager();

	const orchestrator = new TeamOrchestrator({
		store,
		templates,
		noSession: true,
		defaultCwd: tempDir,
		workerFactory: (opts) =>
			({
				options: opts,
				onSessionEvent: () => () => {},
				onNotice: () => () => {},
				setDialogHandler: () => {},
				start: async () => {
					await reportReady(opts);
				},
				stop: async () => {},
				getState: async () => ({ sessionId: "s", isStreaming: false }),
				runPromptAndWait: async () => ({
					disposition: "started",
					aborted: false,
					assistantText: "已完成测试处理。",
					assistantMessages: [],
					toolExecutions: [],
					notices: [],
					dialogs: [],
					events: [],
				}),
			}) as unknown as RpcWorkerLike,
	});

	const { server } = createPersonalAgentServer({
		store,
		orchestrator,
		templates,
		dialogBroker,
		previewManager,
		uploadsDir: join(tempDir, "uploads"),
	});
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const baseUrl = `http://127.0.0.1:${address.port}`;

	try {
		const createRes = await fetch(`${baseUrl}/api/matters`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				prompt: "验证默认全员 AI 参与与统一旁听开关",
				preferredMemberId: "product-manager",
			}),
		});
		assert.equal(createRes.status, 202);
		const created = (await createRes.json()) as {
			matter: {
				id: string;
				leadMemberId: string | null;
				aiMemberIds: string[] | null;
				observersEnabled: boolean;
				observerMemberIds: string[];
			};
		};
		const matterId = created.matter.id;
		assert.equal(created.matter.leadMemberId, "product-manager");
		assert.equal(created.matter.aiMemberIds, null);
		assert.equal(created.matter.observersEnabled, false);
		assert.deepEqual(created.matter.observerMemberIds, []);

		// Wait for initial background dispatch turn to settle before patching lead/roster.
		for (let i = 0; i < 40; i++) {
			const detailRes = await fetch(`${baseUrl}/api/matters/${matterId}`);
			assert.equal(detailRes.status, 200);
			const detail = (await detailRes.json()) as { running?: boolean; matter: { status: string } };
			if (!detail.running && detail.matter.status !== "running") break;
			await new Promise((r) => setTimeout(r, 25));
		}

		// Enable Matter-wide observer toggle -> auto-populates all non-lead AI roles.
		const enableObsRes = await fetch(`${baseUrl}/api/matters/${matterId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ observersEnabled: true }),
		});
		assert.equal(enableObsRes.status, 200);
		const enabledObs = (await enableObsRes.json()) as {
			matter: { observersEnabled: boolean; observerMemberIds: string[] };
		};
		assert.equal(enabledObs.matter.observersEnabled, true);
		assert.deepEqual([...enabledObs.matter.observerMemberIds].sort(), [
			"engineering-manager",
			"marketing-lead",
			"qa-manager",
		]);

		// Switch Matter lead -> previous lead joins observers and new lead leaves observers.
		const switchLeadRes = await fetch(`${baseUrl}/api/matters/${matterId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ leadMemberId: "engineering-manager" }),
		});
		assert.equal(switchLeadRes.status, 200);
		const switchedLead = (await switchLeadRes.json()) as {
			matter: { leadMemberId: string | null; observerMemberIds: string[] };
		};
		assert.equal(switchedLead.matter.leadMemberId, "engineering-manager");
		assert.deepEqual([...switchedLead.matter.observerMemberIds].sort(), [
			"marketing-lead",
			"product-manager",
			"qa-manager",
		]);

		// Reject empty AI member roster with 400.
		const emptyRosterRes = await fetch(`${baseUrl}/api/matters/${matterId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ aiMemberIds: [] }),
		});
		assert.equal(emptyRosterRes.status, 400);

		// Narrow AI roster -> removed AI roles are dropped from both aiMemberIds and observerMemberIds.
		const narrowRes = await fetch(`${baseUrl}/api/matters/${matterId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ aiMemberIds: ["engineering-manager", "product-manager"] }),
		});
		assert.equal(narrowRes.status, 200);
		const narrowed = (await narrowRes.json()) as {
			matter: { aiMemberIds: string[] | null; observerMemberIds: string[] };
		};
		assert.deepEqual(narrowed.matter.aiMemberIds, ["engineering-manager", "product-manager"]);
		assert.deepEqual(narrowed.matter.observerMemberIds, ["product-manager"]);

		// Turn off Matter-wide observer toggle -> clears observerMemberIds.
		const disableObsRes = await fetch(`${baseUrl}/api/matters/${matterId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ observersEnabled: false }),
		});
		assert.equal(disableObsRes.status, 200);
		const disabledObs = (await disableObsRes.json()) as {
			matter: { observersEnabled: boolean; observerMemberIds: string[] };
		};
		assert.equal(disabledObs.matter.observersEnabled, false);
		assert.deepEqual(disabledObs.matter.observerMemberIds, []);

		// Delegating to an AI removed from the Matter is rejected.
		await assert.rejects(
			() =>
				orchestrator.delegateToMember({
					matterId,
					fromMemberId: "engineering-manager",
					toMemberId: "qa-manager",
					question: "请补充测试方案",
				}),
			/removed from this matter/,
		);
	} finally {
		await orchestrator.shutdown();
		server.closeAllConnections();
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		db.close();
		rmSync(tempDir, { recursive: true, force: true });
	}
});
