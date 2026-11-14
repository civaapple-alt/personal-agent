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
	PreviewManager,
	type PromptRunResult,
	type RpcExtensionUIDialogRequest,
	type RpcExtensionUIResponsePayload,
	type RpcWorkerLike,
	TeamOrchestrator,
} from "../src/index.ts";

class InteractiveTestWorker implements RpcWorkerLike {
	private dialogHandler:
		| ((req: RpcExtensionUIDialogRequest) => Promise<RpcExtensionUIResponsePayload> | RpcExtensionUIResponsePayload)
		| undefined;
	private noticeListeners: Array<(notice: { method: string; [key: string]: unknown }) => void> = [];

	async start(): Promise<void> {}
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
		workerFactory: () => new InteractiveTestWorker(),
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
				assert.equal(detail.noticeMessages.length, 1);
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
