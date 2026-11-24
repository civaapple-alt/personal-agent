import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
	loadRoleTemplatesFromDir,
	openPersonalAgentDatabase,
	PersonalAgentStore,
	type PiRpcWorkerOptions,
	type PromptRunResult,
	type RpcWorkerLike,
	TeamOrchestrator,
} from "../packages/server/src/index.ts";
import { invokeTool, reportReady } from "./worker-helpers.ts";

class RsiScriptedWorker implements RpcWorkerLike {
	readonly options: PiRpcWorkerOptions;
	private readonly handler: (
		prompt: string,
		options: PiRpcWorkerOptions,
		runOptions?: { timeoutMs?: number; signal?: AbortSignal },
	) => Promise<PromptRunResult>;
	private abortController = new AbortController();

	constructor(
		options: PiRpcWorkerOptions,
		handler: (
			prompt: string,
			options: PiRpcWorkerOptions,
			runOptions?: { timeoutMs?: number; signal?: AbortSignal },
		) => Promise<PromptRunResult>,
	) {
		this.options = options;
		this.handler = handler;
	}

	async start(): Promise<void> {
		if (this.options.env?.PA_TEAM_BRIDGE_URL) {
			await reportReady(this.options);
		}
	}

	async stop(): Promise<void> {}

	async abort(): Promise<void> {
		this.abortController.abort();
	}

	async getState(): Promise<{ sessionId: string; sessionFile?: string }> {
		return {
			sessionId: `rsi-session-${this.options.model ?? "default"}`,
			sessionFile: this.options.sessionFile,
		};
	}

	onNotice(): () => void {
		return () => {};
	}

	setDialogHandler(): void {}

	runPromptAndWait(
		message: string,
		runOptions?: { timeoutMs?: number; signal?: AbortSignal },
	): Promise<PromptRunResult> {
		return this.handler(message, this.options, runOptions);
	}
}

test("propose_skill stages skill proposals on clean finish, blocks invalid scopes/observers, and discards on failure", async () => {
	const tempRoot = mkdtempSync(join(tmpdir(), "pa-rsi-propose-"));
	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db);
	const templates = await loadRoleTemplatesFromDir(resolve("roles"));

	try {
		let rejectPrivateErr: string | null = null;
		let allowPersonalRes: unknown = null;
		let observerRejectRes: unknown = null;
		const orchestrator = new TeamOrchestrator({
			store,
			templates,
			sessionDir: join(tempRoot, "sessions"),
			workerFactory: (options) =>
				new RsiScriptedWorker(options, async (prompt) => {
					const isObserver = !options.args?.some((arg) => arg.endsWith("pa-extensions/skill-capture/pi/index.ts"));
					if (isObserver) {
						try {
							await invokeTool(options, "propose_skill", {
								name: "observer-blocked-skill",
								description: "旁听不应提出技能提案",
								body: "不应通过",
								storageScope: "personal",
								rationale: "旁听模式禁用",
							});
						} catch (err) {
							observerRejectRes = err instanceof Error ? err.message : String(err);
						}
						return {
							disposition: "started",
							aborted: false,
							assistantText: "[SILENT]",
							assistantMessages: [],
							toolExecutions: [],
							notices: [],
							dialogs: [],
							events: [],
						};
					}

					if (prompt.includes("无工作区")) {
						try {
							await invokeTool(options, "propose_skill", {
								name: "unbound-workspace-skill",
								description: "未绑定仓库时不应落盘的规范",
								body: "测试工作区隔离",
								storageScope: "workspace",
								rationale: "测试工作区隔离",
							});
						} catch (err) {
							rejectPrivateErr = err instanceof Error ? err.message : String(err);
						}
						allowPersonalRes = await invokeTool(options, "propose_skill", {
							name: "decision-options-first",
							description: "先列出关键决策选项，再展开细节分析",
							body: "整理产品决策时先给 2-3 个选项与推荐理由，再展开细节。",
							storageScope: "personal",
							rationale: "方便用户快速拍板",
						});
						return {
							disposition: "started",
							aborted: false,
							assistantText: "已完成方案整理。",
							assistantMessages: [],
							toolExecutions: [],
							notices: [],
							dialogs: [],
							events: [],
						};
					}

					// Aborted/failed turn should discard staged skill proposals
					await invokeTool(options, "propose_skill", {
						name: "failed-turn-skill",
						description: "失败回合中暂存但不应保留的技能提案",
						body: "会被丢弃",
						storageScope: "personal",
						rationale: "会被丢弃",
					});
					throw new Error("simulated worker failure");
				}),
		});

		const okResult = await orchestrator.dispatchMatter({
			prompt: "无工作区下整理产品决策",
			observerMemberIds: ["engineering-manager"],
		});
		assert.match(String(rejectPrivateErr ?? ""), /require a bound workspace/);
		assert.equal((allowPersonalRes as { result?: { staged?: boolean } })?.result?.staged, true);
		assert.match(String(observerRejectRes ?? ""), /Observing specialists cannot propose skills/);

		const replyMsg = store.listMessages(okResult.matter.id, "user").find((m) => m.senderType === "member");
		const proposals = (replyMsg?.metadata?.skillProposals ?? []) as Array<{
			name: string;
			storageScope: string;
			status: string;
			rationale: string;
		}>;
		assert.equal(proposals.length, 1);
		assert.equal(proposals[0]?.name, "decision-options-first");
		assert.equal(proposals[0]?.storageScope, "personal");
		assert.equal(proposals[0]?.status, "pending");
		assert.equal(proposals[0]?.rationale, "方便用户快速拍板");

		// Verify failure discards staged skill proposal
		await assert.rejects(
			() => orchestrator.dispatchMatter({ prompt: "这轮会在中途失败" }),
			/simulated worker failure/,
		);
		const failedMessages = store
			.listMatters()
			.filter((m) => m.id !== okResult.matter.id)
			.flatMap((m) => store.listMessages(m.id, "user"));
		assert.equal(
			failedMessages.some((m) => Array.isArray(m.metadata?.skillProposals) && m.metadata.skillProposals.length > 0),
			false,
		);
	} finally {
		db.close();
		rmSync(tempRoot, { recursive: true, force: true });
	}
});
