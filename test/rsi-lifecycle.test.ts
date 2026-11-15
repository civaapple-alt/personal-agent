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
} from "../src/index.ts";
import { invokeTool, reportReady } from "./worker-helpers.ts";

class RsiScriptedWorker implements RpcWorkerLike {
	readonly options: PiRpcWorkerOptions;
	private readonly handler: (prompt: string, options: PiRpcWorkerOptions) => Promise<PromptRunResult>;
	private abortController = new AbortController();

	constructor(
		options: PiRpcWorkerOptions,
		handler: (prompt: string, options: PiRpcWorkerOptions) => Promise<PromptRunResult>,
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

	runPromptAndWait(message: string): Promise<PromptRunResult> {
		return this.handler(message, this.options);
	}
}

test("propose_experience stages candidate memories on clean finish, blocks invalid scopes/observers, and discards on failure", async () => {
	const tempRoot = mkdtempSync(join(tmpdir(), "pa-rsi-propose-"));
	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db);
	const templates = await loadRoleTemplatesFromDir(resolve("roles"));

	try {
		let rejectPrivateErr: string | null = null;
		let allowGeneralRes: unknown = null;
		let observerRejectRes: unknown = null;
		const orchestrator = new TeamOrchestrator({
			store,
			templates,
			sessionDir: join(tempRoot, "sessions"),
			workerFactory: (options) =>
				new RsiScriptedWorker(options, async (prompt) => {
					if (options.env?.PA_CAN_EXPERIENCE === "false") {
						try {
							await invokeTool(options, "propose_experience", {
								scope: "role_general",
								content: "旁听不应提出经验提案",
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
							await invokeTool(options, "propose_experience", {
								scope: "project_private",
								content: "未绑定仓库时不应落库的规范",
								rationale: "测试工作区隔离",
							});
						} catch (err) {
							rejectPrivateErr = err instanceof Error ? err.message : String(err);
						}
						allowGeneralRes = await invokeTool(options, "propose_experience", {
							scope: "role_general",
							content: "先列出关键决策选项，再展开细节分析",
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

					// Aborted/failed turn should discard staged candidate memories
					await invokeTool(options, "propose_experience", {
						scope: "role_general",
						content: "失败回合中暂存但不应保存的经验",
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
		assert.equal((allowGeneralRes as { result?: { staged?: boolean } })?.result?.staged, true);
		assert.match(String(observerRejectRes ?? ""), /Observing specialists cannot propose experiences/);

		const leadMemories = store.listMemberMemories(okResult.assignedMember.id);
		assert.equal(leadMemories.length, 1);
		assert.equal(leadMemories[0]?.status, "candidate");
		assert.equal(leadMemories[0]?.verified, false);
		assert.equal(leadMemories[0]?.workspaceId, null);
		assert.equal(leadMemories[0]?.rationale, "方便用户快速拍板");
		assert.equal(leadMemories[0]?.sourceMatterId, okResult.matter.id);

		const notices = store.listMessages(okResult.matter.id, "notice");
		assert.ok(
			notices.some((n) => {
				try {
					return (JSON.parse(n.content) as { method?: string }).method === "rsi_candidate_proposed";
				} catch {
					return false;
				}
			}),
		);

		// Verify failure discards staged candidate experience
		await assert.rejects(
			() => orchestrator.dispatchMatter({ prompt: "这轮会在中途失败" }),
			/simulated worker failure/,
		);
		const afterFail = store.listMemberMemories(okResult.assignedMember.id);
		assert.equal(afterFail.length, 1);
	} finally {
		db.close();
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

test("RSI lifecycle tracks injected vs candidate prompts, acceptance evaluation idempotency, AI distillation, and superseding", async () => {
	const tempRoot = mkdtempSync(join(tmpdir(), "pa-rsi-lifecycle-"));
	const repoDir = mkdtempSync(join(tmpdir(), "pa-rsi-repo-"));
	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db);
	const templates = await loadRoleTemplatesFromDir(resolve("roles"));

	const seenPrompts: string[] = [];
	const reflectionArgs: string[][] = [];

	try {
		const orchestrator = new TeamOrchestrator({
			store,
			templates,
			sessionDir: join(tempRoot, "sessions"),
			workerFactory: (options) =>
				new RsiScriptedWorker(options, async () => {
					if (!options.env?.PA_TEAM_BRIDGE_URL) {
						reflectionArgs.push([...(options.args ?? [])]);
						const currentOld = store
							.listMemberMemories("product-manager")
							.find((m) => m.content.includes("三段式背景说明"));
						return {
							disposition: "started",
							aborted: false,
							assistantText: `\`\`\`json
{
  "summary": "提炼出一条替代旧格式的通用规则与一条项目私有规则",
  "candidates": [
    {
      "scope": "role_general",
      "content": "产品结论直接给可执行决策清单，不再写冗长三段式背景",
      "rationale": "用户负反馈指出前序背景过多影响验收效率",
      "supersedesMemoryId": "${currentOld?.id ?? ""}"
    },
    {
      "scope": "project_private",
      "content": "在 repo-a 中同步列出受影响的接口路径",
      "rationale": "与现有候选重复，应被去重跳过"
    },
    {
      "scope": "company_private",
      "content": "输出项目级结论时附带本机验证命令清单",
      "rationale": "跨分支私有习惯"
    }
  ]
}
\`\`\``,
							assistantMessages: [],
							toolExecutions: [],
							notices: [],
							dialogs: [],
							events: [],
						};
					}

					seenPrompts.push(options.env?.PA_MEMBER_CONTEXT ?? "");
					await invokeTool(options, "publish_deliverable", {
						type: "document",
						title: "产品需求评审稿",
						summary: "首版输出",
						content: "# 需求评审\n\n已完成首版。",
						changeNote: "初稿发布",
					});
					return {
						disposition: "started",
						aborted: false,
						assistantText: "已提交产品需求评审稿。",
						assistantMessages: [],
						toolExecutions: [],
						notices: [],
						dialogs: [],
						events: [],
					};
				}),
		});

		const wsA = store.upsertWorkspace({ name: "repo-a", repoPath: repoDir });
		const wsB = store.upsertWorkspace({ name: "repo-b", repoPath: tempRoot });

		const oldVerified = store.addMemory({
			memberId: "product-manager",
			scope: "role_general",
			content: "产品结论先用三段式背景说明开头",
			verified: true,
			status: "verified",
		});
		const candidateRule = store.addMemory({
			memberId: "product-manager",
			scope: "project_private",
			workspaceId: wsA.id,
			content: "在 repo-a 中同步列出受影响的接口路径",
			verified: false,
			status: "candidate",
		});
		store.addMemory({
			memberId: "product-manager",
			scope: "project_private",
			workspaceId: wsB.id,
			content: "在 repo-b 中不要注入到 repo-a 的规范",
			verified: true,
			status: "verified",
		});

		const dispatchRes = await orchestrator.dispatchMatter({
			prompt: "整理 repo-a 的产品评审",
			workspaceId: wsA.id,
			preferredMemberId: "product-manager",
		});

		// Prompt must contain oldVerified ([已验证]) and candidateRule ([待验证]), never wsB memory
		assert.equal(seenPrompts.length, 1);
		assert.match(seenPrompts[0]!, new RegExp(`\\[${oldVerified.id} \\| 已验证 · role_general\\]`));
		assert.match(seenPrompts[0]!, new RegExp(`\\[${candidateRule.id} \\| 待验证 · project_private\\]`));
		assert.ok(!seenPrompts[0]!.includes("不要注入到 repo-a"));

		// Applied count incremented once on injection; positive/negative still 0
		const afterApplyOld = store.getMemory(oldVerified.id)!;
		assert.equal(afterApplyOld.appliedCount, 1);
		assert.equal(afterApplyOld.positiveCount, 0);
		assert.equal(afterApplyOld.negativeCount, 0);

		const deliverable = dispatchRes.deliverable!;
		assert.ok(deliverable);

		// Idempotent acceptance evaluation
		store.evaluateMatterMemories({
			matterId: dispatchRes.matter.id,
			memberId: "product-manager",
			deliverableId: deliverable.id,
			outcome: "feedback_negative",
			note: "背景太多",
		});
		store.evaluateMatterMemories({
			matterId: dispatchRes.matter.id,
			memberId: "product-manager",
			deliverableId: deliverable.id,
			outcome: "feedback_negative",
			note: "重复调用",
		});

		const afterNegOld = store.getMemory(oldVerified.id)!;
		assert.equal(afterNegOld.negativeCount, 1);
		assert.equal(afterNegOld.positiveCount, 0);

		// AI reflection distillation runs isolated (--no-extensions, --no-skills, --no-mcp, --tools "")
		const distilled = await orchestrator.distillExperiences({
			matterId: dispatchRes.matter.id,
			deliverableId: deliverable.id,
			feedback: "不要写三段式背景，直接给决策清单与验证命令",
			rating: "negative",
		});

		assert.equal(reflectionArgs.length, 1);
		assert.ok(reflectionArgs[0]!.includes("--no-extensions"));
		assert.ok(reflectionArgs[0]!.includes("--no-skills"));
		assert.ok(reflectionArgs[0]!.includes("--no-mcp"));
		assert.equal(distilled.skippedDuplicates, 1);
		assert.equal(distilled.createdMemories.length, 2);

		const generalCandidate = distilled.createdMemories.find((m) => m.scope === "role_general")!;
		const privateCandidate = distilled.createdMemories.find((m) => m.scope === "company_private")!;
		assert.equal(generalCandidate.status, "candidate");
		assert.equal(generalCandidate.verified, false);
		assert.equal(generalCandidate.workspaceId, null);
		assert.equal(generalCandidate.sourceDeliverableId, deliverable.id);
		assert.equal(generalCandidate.supersedesMemoryId, oldVerified.id);
		assert.equal(privateCandidate.workspaceId, wsA.id);

		// While generalCandidate is unverified, oldVerified remains verified
		assert.equal(store.getMemory(oldVerified.id)?.status, "verified");

		// Verifying generalCandidate automatically supersedes oldVerified
		const promoted = store.updateMemory(generalCandidate.id, { status: "verified" })!;
		assert.equal(promoted.status, "verified");
		assert.equal(promoted.verified, true);

		const supersededOld = store.getMemory(oldVerified.id)!;
		assert.equal(supersededOld.status, "superseded");
		assert.equal(supersededOld.verified, false);
		assert.equal(supersededOld.supersededBy, generalCandidate.id);

		// listRelevantMemories excludes superseded rule and retains verified replacement
		const relevantNow = store.listRelevantMemories("product-manager", wsA.id);
		assert.ok(!relevantNow.some((m) => m.id === oldVerified.id));
		assert.ok(relevantNow.some((m) => m.id === generalCandidate.id));
		assert.ok(relevantNow.some((m) => m.id === privateCandidate.id));
		assert.ok(!relevantNow.some((m) => m.workspaceId === wsB.id));
	} finally {
		db.close();
		rmSync(tempRoot, { recursive: true, force: true });
		rmSync(repoDir, { recursive: true, force: true });
	}
});

test("Phase 4 RSI multi-role distillation, categories, member reassignment, and cross-role evaluation", async () => {
	const tempRoot = mkdtempSync(join(tmpdir(), "pa-rsi-multi-test-"));
	const repoDir = mkdtempSync(join(tmpdir(), "pa-rsi-multi-repo-"));
	const db = openPersonalAgentDatabase(join(tempRoot, "pa.sqlite"));
	const store = new PersonalAgentStore(db);
	const templates = await loadRoleTemplatesFromDir(resolve("roles"));

	let seenPrompt = "";
	const orchestrator = new TeamOrchestrator({
		store,
		templates,
		sessionDir: join(tempRoot, "sessions"),
		workerFactory: (options) =>
			new RsiScriptedWorker(options, async (prompt) => {
				if (!options.env?.PA_TEAM_BRIDGE_URL) {
					seenPrompt = prompt;
					return {
						disposition: "started",
						aborted: false,
						assistantText: JSON.stringify({
							summary: "从研发排障、QA 止损与 PM 协同中提炼 3 条跨角色经验",
							candidates: [
								{
									memberId: "engineering-manager",
									scope: "role_general",
									category: "troubleshooting",
									content: "压测档位反转时先做服务端吞吐对比再清理后台进程。",
									rationale: "研发排查 p95 延迟异常时有效定位问题并防止进程泄漏",
								},
								{
									memberId: "qa-manager",
									scope: "role_general",
									category: "efficiency",
									content: "耗时基准测试优先先跑最小有效样本窗口再按需补测。",
									rationale: "避免全量测试长时间阻塞交付周期",
								},
								{
									memberId: "product-manager",
									scope: "role_general",
									category: "collaboration",
									content: "用户喊停长测后协调研发清理进程并让 QA 保留有效数据快速收口。",
									rationale: "用户纠偏后多角色协同顺利收口",
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
				await invokeTool(options, "propose_experience", {
					scope: "project_private",
					category: "domain_constraint",
					content: "M1 基准脚本固定使用 default-tier=T1。",
					rationale: "仓库规范固化",
				});
				return {
					disposition: "started",
					aborted: false,
					assistantText: "已沉淀经验",
					assistantMessages: [],
					toolExecutions: [],
					notices: [],
					dialogs: [],
					events: [],
				};
			}),
	});

	try {
		const ws = store.upsertWorkspace({ name: "multi-repo", repoPath: repoDir });
		const engRule = store.addMemory({
			memberId: "engineering-manager",
			scope: "role_general",
			category: "troubleshooting",
			content: "长时压测先跑小样本校准，再扩全量并及时清理后台进程。",
			status: "verified",
			verified: true,
		});
		const qaRule = store.addMemory({
			memberId: "qa-manager",
			scope: "role_general",
			category: "efficiency",
			content: "长链路测试超出阈值时优先保留已采集样本并标注部分达标。",
			status: "verified",
			verified: true,
		});

		const matter = store.createMatter({
			title: "多角色协同压测与验收",
			workspaceId: ws.id,
			leadMemberId: "product-manager",
		});

		// Record applied memories for two different participating roles on the same matter
		store.recordMemoryApplications({
			memoryIds: [engRule.id],
			matterId: matter.id,
			memberId: "engineering-manager",
		});
		store.recordMemoryApplications({
			memoryIds: [qaRule.id],
			matterId: matter.id,
			memberId: "qa-manager",
		});

		const deliverable = store.recordDeliverable({
			matterId: matter.id,
			memberId: "product-manager",
			type: "document",
			title: "M1 收口报告",
			summary: "已完成压测与回归",
			contentOrPath: "# M1 收口报告\n- 10/10 回归通过",
		});

		// Simulate multi-role conversation trajectory: user correction, internal delegations, error notice
		store.appendMessage({
			matterId: matter.id,
			channel: "user",
			senderType: "user",
			senderId: "user",
			content: "测试太长了先到这里，请止损收口并保留已有有效样本",
		});
		store.appendMessage({
			matterId: matter.id,
			channel: "internal_collab",
			senderType: "member",
			senderId: "product-manager",
			content: "请研发排查 p95 延迟突刺并修复阻塞缺陷",
			metadata: { kind: "delegation_request", delegationId: "del-1", toMemberId: "engineering-manager" },
		});
		store.appendMessage({
			matterId: matter.id,
			channel: "internal_collab",
			senderType: "member",
			senderId: "engineering-manager",
			content: "已切换默认 T1 档位并清理残留后台进程，2 个 blocker 已修复",
			metadata: {
				kind: "delegation_result",
				delegationId: "del-1",
				toMemberId: "engineering-manager",
				status: "completed",
			},
		});
		store.appendMessage({
			matterId: matter.id,
			channel: "internal_collab",
			senderType: "member",
			senderId: "product-manager",
			content: "请 QA 回归验证修复项并输出报告",
			metadata: { kind: "delegation_request", delegationId: "del-2", toMemberId: "qa-manager" },
		});
		store.appendMessage({
			matterId: matter.id,
			channel: "internal_collab",
			senderType: "member",
			senderId: "qa-manager",
			content: "6 个缺陷回归 10/10 通过，T2 样本不足部分已实标注",
			metadata: {
				kind: "delegation_result",
				delegationId: "del-2",
				toMemberId: "qa-manager",
				status: "completed",
			},
		});
		store.appendMessage({
			matterId: matter.id,
			channel: "notice",
			senderType: "system",
			senderId: "product-manager",
			content: JSON.stringify({ method: "error", message: "Timed out waiting for bench-p95" }),
		});

		// Cross-member acceptance scoring when omitting memberId
		const evaluated = store.evaluateMatterMemories({
			matterId: matter.id,
			deliverableId: deliverable.id,
			outcome: "feedback_positive",
			note: "止损收口做得好",
		});
		assert.equal(evaluated.length, 2);
		assert.equal(store.getMemory(engRule.id)?.positiveCount, 1);
		assert.equal(store.getMemory(qaRule.id)?.positiveCount, 1);

		// Distill in multi-role team mode
		const distilled = await orchestrator.distillExperiences({
			matterId: matter.id,
			deliverableId: deliverable.id,
		});
		assert.ok(seenPrompt.includes("engineering-manager"));
		assert.ok(seenPrompt.includes("qa-manager"));
		assert.ok(seenPrompt.includes("测试太长了先到这里"));
		assert.ok(seenPrompt.includes("Timed out waiting for bench-p95"));
		assert.deepEqual(
			new Set(distilled.participatingMemberIds),
			new Set(["product-manager", "engineering-manager", "qa-manager"]),
		);
		assert.equal(distilled.createdMemories.length, 3);

		const engCandidate = distilled.createdMemories.find((m) => m.memberId === "engineering-manager")!;
		const qaCandidate = distilled.createdMemories.find((m) => m.memberId === "qa-manager")!;
		const pmCandidate = distilled.createdMemories.find((m) => m.memberId === "product-manager")!;
		assert.equal(engCandidate.category, "troubleshooting");
		assert.equal(qaCandidate.category, "efficiency");
		assert.equal(pmCandidate.category, "collaboration");

		// Verify reassigning memberId & category works cleanly
		const reassigned = store.updateMemory(pmCandidate.id, {
			memberId: "qa-manager",
			category: "user_correction",
			status: "verified",
		})!;
		assert.equal(reassigned.memberId, "qa-manager");
		assert.equal(reassigned.category, "user_correction");
		assert.equal(reassigned.verified, true);
		assert.ok(!store.listMemberMemories("product-manager").some((m) => m.id === pmCandidate.id));
		assert.ok(store.listMemberMemories("qa-manager").some((m) => m.id === pmCandidate.id));

		// Also verify propose_experience tool call persists category properly
		await orchestrator.dispatchMatter({
			matterId: matter.id,
			workspaceId: ws.id,
			prompt: "请固化本次默认参数规范",
		});
		const domainRule = store.listMemberMemories("product-manager").find((m) => m.content.includes("default-tier=T1"));
		assert.ok(domainRule);
		assert.equal(domainRule.category, "domain_constraint");
		assert.equal(domainRule.scope, "project_private");
	} finally {
		db.close();
		rmSync(tempRoot, { recursive: true, force: true });
		rmSync(repoDir, { recursive: true, force: true });
	}
});
