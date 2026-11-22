import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
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
	type RpcWorkerLike,
	TeamOrchestrator,
} from "../src/index.ts";
import { formatMessageHistoryContent } from "../src/orchestrator/prompts.ts";
import { parseMessageFiles, parseMessageImages } from "../web/src/utils.ts";
import { invokeTool, reportReady } from "./worker-helpers.ts";

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
				const roleId = workerOptions.env?.PA_MEMBER_ID;
				const assistantText =
					roleId === "engineering-manager"
						? "技术补充：需要核查 SQLite 锁与连接复用。"
						: roleId === "qa-manager"
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

				await invokeTool(options, "save_space_page", {
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

test("HTTP server persists uploaded text files and folded pasted text, serves with nosniff, and reloads them on approve-ai", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pa-file-uploads-"));
	const dbPath = join(tempDir, "test.sqlite");
	const uploadsDir = join(tempDir, "uploads");
	const receivedPrompts: string[] = [];

	class TextCaptureWorker implements RpcWorkerLike {
		readonly options: PiRpcWorkerOptions;
		constructor(options: PiRpcWorkerOptions) {
			this.options = options;
		}
		async start() {
			await reportReady(this.options);
		}
		async getState() {
			return { sessionId: "sess-files", sessionFile: undefined };
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
		async runPromptAndWait(prompt: string): Promise<PromptRunResult> {
			receivedPrompts.push(prompt);
			return {
				disposition: "started",
				aborted: false,
				assistantText: "已阅读附带文件与粘贴文本",
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
	const previewManager = new PreviewManager();
	const orchestrator = new TeamOrchestrator({
		store,
		templates,
		defaultCwd: tempDir,
		workerFactory: (opts) => new TextCaptureWorker(opts),
	});
	const { server } = createPersonalAgentServer({
		store,
		orchestrator,
		templates,
		previewManager,
		dialogBroker: new DialogBroker(),
		uploadsDir,
	});

	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const baseUrl = `http://127.0.0.1:${address.port}`;

	try {
		// Reject files containing NUL bytes
		const badFileRes = await fetch(`${baseUrl}/api/matters`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				prompt: "inspect binary",
				files: [{ kind: "file", name: "bin.dat", content: "hello\0world" }],
			}),
		});
		assert.equal(badFileRes.status, 400);

		// Initiation assessment accepts attachment-only requests when hasFiles is true
		const assessRes = await fetch(`${baseUrl}/api/matters/assess`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: "", hasFiles: true }),
		});
		assert.equal(assessRes.status, 200);

		// File + folded pasted text matter creation without prompt text
		const createRes = await fetch(`${baseUrl}/api/matters`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				prompt: "",
				files: [
					{
						kind: "file",
						name: "notes.md",
						mimeType: "text/markdown",
						content: "# Notes\nline 2\nline 3",
					},
					{
						kind: "pasted_text",
						name: "pasted-text-1.txt",
						content: "alpha\nbeta\ngamma",
					},
				],
			}),
		});
		assert.equal(createRes.status, 202);
		const created = (await createRes.json()) as { matter: { id: string; title: string } };
		assert.equal(created.matter.title, "上传了 2 个文件");

		type DetailResult = {
			userMessages: Array<{
				id: string;
				senderType: string;
				content: string;
				metadata?: Record<string, unknown> | null;
			}>;
			activeRun?: unknown;
		};
		let detail: DetailResult | null = null;
		for (let i = 0; i < 40; i += 1) {
			const res = await fetch(`${baseUrl}/api/matters/${created.matter.id}`);
			const data = (await res.json()) as DetailResult;
			if (data.userMessages.length >= 2 && !data.activeRun) {
				detail = data;
				break;
			}
			await new Promise((r) => setTimeout(r, 25));
		}
		assert.ok(detail);
		assert.equal(receivedPrompts.length, 1);
		assert.match(receivedPrompts[0]!, /notes\.md/);
		assert.match(receivedPrompts[0]!, /# Notes\nline 2\nline 3/);
		assert.match(receivedPrompts[0]!, /pasted-text-1\.txt/);
		assert.match(receivedPrompts[0]!, /alpha\nbeta\ngamma/);

		const userMsg = detail.userMessages.find((m) => m.senderType === "user");
		assert.ok(userMsg);
		const storedFiles = parseMessageFiles(userMsg.metadata);
		assert.equal(storedFiles.length, 2);
		assert.equal(storedFiles[0]?.kind, "file");
		assert.equal(storedFiles[0]?.name, "notes.md");
		assert.equal(storedFiles[0]?.lineCount, 3);
		assert.match(storedFiles[0]?.url ?? "", /^\/api\/uploads\/.+\.txt$/);
		assert.equal(storedFiles[1]?.kind, "pasted_text");
		assert.equal(storedFiles[1]?.name, "pasted-text-1.txt");
		assert.equal(readdirSync(uploadsDir).length, 2);

		// Served uploaded text uses text/plain + nosniff
		const fileGetRes = await fetch(`${baseUrl}${storedFiles[0]!.url!}`);
		assert.equal(fileGetRes.status, 200);
		assert.equal(fileGetRes.headers.get("content-type"), "text/plain; charset=utf-8");
		assert.equal(fileGetRes.headers.get("x-content-type-options"), "nosniff");
		assert.equal(await fileGetRes.text(), "# Notes\nline 2\nline 3");

		// formatMessageHistoryContent includes stored files summary
		const formattedHistory = formatMessageHistoryContent({
			id: userMsg.id,
			matterId: created.matter.id,
			channel: "user",
			senderType: "user",
			senderId: "user",
			content: userMsg.content,
			metadata: userMsg.metadata ?? null,
			createdAt: new Date().toISOString(),
		});
		assert.match(formattedHistory, /notes\.md/);
		assert.match(formattedHistory, /pasted-text-1\.txt/);

		// Queue an ai_request with a file, then approve-ai reloads persisted content from disk
		const aiReqRes = await fetch(`${baseUrl}/api/matters/${created.matter.id}/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				mode: "ai_request",
				prompt: "",
				files: [
					{
						kind: "pasted_text",
						name: "pasted-text-2.txt",
						content: "approved payload line 1\napproved payload line 2",
					},
				],
			}),
		});
		assert.equal(aiReqRes.status, 201);
		const aiReqBody = (await aiReqRes.json()) as {
			message: { id: string; metadata?: Record<string, unknown> | null };
		};
		assert.equal(parseMessageFiles(aiReqBody.message.metadata).length, 1);

		const approveRes = await fetch(
			`${baseUrl}/api/matters/${created.matter.id}/messages/${aiReqBody.message.id}/approve-ai`,
			{ method: "POST" },
		);
		assert.equal(approveRes.status, 202);
		for (let i = 0; i < 40; i += 1) {
			if (receivedPrompts.length >= 2 && !orchestrator.isMatterRunning(created.matter.id)) break;
			await new Promise((r) => setTimeout(r, 25));
		}
		assert.equal(receivedPrompts.length, 2);
		assert.match(receivedPrompts[1]!, /pasted-text-2\.txt/);
		assert.match(receivedPrompts[1]!, /approved payload line 1\napproved payload line 2/);
	} finally {
		await previewManager.stopAll();
		await orchestrator.shutdown();
		server.closeAllConnections();
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		db.close();
		rmSync(tempDir, { recursive: true, force: true });
	}
});
