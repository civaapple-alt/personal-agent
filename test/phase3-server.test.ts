import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { parseProgressSnapshot } from "../web/src/utils.ts";
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
		if (confirmed) {
			await invokeTool(this.options, "save_space_page", { title: "交付说明", content: "交付原型已准备就绪" });
		}
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

		// 2. Dispatch matter -> pauses at confirm dialog -> saves a space document
		const createRes = await fetch(`${baseUrl}/api/matters`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: "帮我准备 V4 交互原型交付" }),
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

		// Wait until the document is saved and the turn settles.
		let document: { id: string; headCommit: string } | undefined;
		for (let i = 0; i < 40; i++) {
			const detail = (await (await fetch(`${baseUrl}/api/matters/${created.matter.id}`)).json()) as {
				matter: { status: string };
				spaceDocuments: Array<{ id: string; headCommit: string }>;
				activeRun?: unknown;
				noticeMessages: unknown[];
			};
			if (detail.spaceDocuments[0] && !detail.activeRun) {
				assert.equal(detail.noticeMessages.length, 2);
				document = detail.spaceDocuments[0];
				break;
			}
			await new Promise((r) => setTimeout(r, 20));
		}
		assert.ok(document, "Expected a saved space document");
		assert.equal((await store.spaces.getDocument(document.id))?.content, "交付原型已准备就绪");

		// 3. Submit document feedback & register external preview URL
		const fbRes = await fetch(`${baseUrl}/api/spaces/documents/${document.id}/feedback`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ commitHash: document.headCommit, feedback: "按钮文案清晰" }),
		});
		assert.equal(fbRes.status, 200);
		const oldFeedback = await fetch(`${baseUrl}/api/deliverables/obsolete/feedback`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ feedback: "obsolete" }),
		});
		assert.equal(oldFeedback.status, 404);

		const prevRes = await fetch(`${baseUrl}/api/previews`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: "V4 体验服务", url: "http://127.0.0.1:4999" }),
		});
		assert.equal(prevRes.status, 201);

		// 4. Built V4 web UI is served at / and hash routing covers admin tab
		const htmlRes = await fetch(`${baseUrl}/`);
		assert.equal(htmlRes.status, 200);
		assert.match(await htmlRes.text(), /Personal Agent/);
		assert.deepEqual(parseHashRoute("#/admin"), { tab: "admin" });
		assert.equal(formatHashRoute({ tab: "admin" }), "#/admin");
	} finally {
		await previewManager.stopAll();
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		db.close();
	}
});

test("Space static preview is served in a sandbox", async () => {
	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db);
	const templates = await loadRoleTemplatesFromDir(resolve(process.cwd(), "roles"));
	const dialogBroker = new DialogBroker();
	const previewManager = new PreviewManager();
	const orchestrator = new TeamOrchestrator({ store, templates });
	const { server } = createPersonalAgentServer({
		store,
		orchestrator,
		templates,
		previewManager,
		dialogBroker,
		webDistDir: resolve(process.cwd(), "web/dist"),
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const baseUrl = `http://127.0.0.1:${address.port}`;
	try {
		store.ensureDefaultOrganization();
		store.spaces.ensureAllDefaultSpaces();
		const orgSpace = store.spaces.listSpaces().find((space) => space.kind === "org");
		assert.ok(orgSpace);
		const previewDoc = await store.spaces.createDocument({
			spaceId: orgSpace.id,
			title: "Preview",
			entryKind: "folder",
			content: "Preview",
			extraFiles: [{ subPath: "index.html", content: "<script>document.body.textContent='preview'</script>" }],
			actorId: "owner",
		});
		const staticPreview = await fetch(`${baseUrl}/api/spaces/documents/${previewDoc.id}/preview/index.html`);
		assert.equal(staticPreview.status, 200);
		assert.match(staticPreview.headers.get("content-security-policy") ?? "", /sandbox allow-scripts/);
		assert.match(staticPreview.headers.get("content-security-policy") ?? "", /connect-src 'none'/);
		assert.match(await staticPreview.text(), /document\.body/);
	} finally {
		await previewManager.stopAll();
		await new Promise<void>((done) => server.close(() => done()));
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

test("hashRouter parses and formats deliverable, chat, team, materials, and settings hash routes", () => {
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
	assert.deepEqual(parseHashRoute("#/settings"), { tab: "settings" });
	assert.deepEqual(parseHashRoute("#/settings/base"), { tab: "settings", settingsSection: "base" });
	assert.deepEqual(parseHashRoute("#/settings/extensions"), { tab: "settings", settingsSection: "extensions" });
	assert.deepEqual(parseHashRoute("#/settings/config"), { tab: "settings", settingsSection: "config" });
	assert.deepEqual(parseHashRoute("#/settings/unknown"), { tab: "settings" });

	assert.equal(formatHashRoute({ tab: "deliverables" }), "#/deliverables");
	assert.equal(formatHashRoute({ tab: "deliverables", deliverableId: "d1" }), "#/deliverables/d1");
	assert.deepEqual(parseHashRoute("#/space/page-1"), { tab: "deliverables", spacePageId: "page-1" });
	assert.equal(formatHashRoute({ tab: "deliverables", spacePageId: "page-1" }), "#/space/page-1");
	assert.equal(formatHashRoute({ tab: "chats", matterId: "m1" }), "#/chats/m1");
	assert.equal(formatHashRoute({ tab: "chats", isNewMatter: true }), "#/chats/new");
	assert.equal(formatHashRoute({ tab: "team" }), "#/team");
	assert.equal(formatHashRoute({ tab: "materials" }), "#/materials");
	assert.equal(formatHashRoute({ tab: "settings" }), "#/settings");
	assert.equal(formatHashRoute({ tab: "settings", settingsSection: "all" }), "#/settings");
	assert.equal(formatHashRoute({ tab: "settings", settingsSection: "config" }), "#/settings/config");
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
		assert.match(seenPrompts[1] ?? "", /## Previous interruption and resume brief/);
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
