import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
	createPersonalAgentServer,
	DialogBroker,
	loadRoleTemplatesFromDir,
	openPersonalAgentDatabase,
	PersonalAgentStore,
	PiDecisionError,
	PreviewManager,
	type RoleArchitectDraft,
	type RpcWorkerLike,
	runTypedPiDecision,
	TeamOrchestrator,
	validateInitiationModelDecision,
	validateRoleDesignDecision,
} from "../src/index.ts";

test("Typed Pi initiation decision model enforces schema, repo-read flag, owner auth, and abort cancellation", async () => {
	const tmp = mkdtempSync(join(tmpdir(), "pa-pi-decision-"));
	const rolesDir = join(tmp, "roles");
	const db = openPersonalAgentDatabase(join(tmp, "agent.db"));
	const store = new PersonalAgentStore(db);
	const templates = await loadRoleTemplatesFromDir(resolve("roles"));
	const ws = store.upsertWorkspace({ name: "demo-repo", repoPath: tmp, defaultBranch: "main" });
	const observedRuns: Array<{ args: string[]; thinkingLevel?: string; aborted: boolean }> = [];
	let workerReplyMode: "valid" | "hallucinated_id" | "malformed" | "slow_abort" = "valid";

	const makeWorker = (options: { args?: string[] }): RpcWorkerLike => {
		const record = { args: options.args ?? [], thinkingLevel: undefined as string | undefined, aborted: false };
		observedRuns.push(record);
		return {
			onNotice: () => () => {},
			setDialogHandler: () => {},
			start: async () => {},
			getState: async () => ({ sessionId: "decision-session" }),
			setThinkingLevel: async (level) => {
				record.thinkingLevel = level;
			},
			runPromptAndWait: async (_promptText, runOpts) => {
				if (workerReplyMode === "slow_abort") {
					await new Promise<void>((resolveWait) => {
						const timer = setTimeout(resolveWait, 2_000);
						runOpts?.signal?.addEventListener(
							"abort",
							() => {
								clearTimeout(timer);
								record.aborted = true;
								resolveWait();
							},
							{ once: true },
						);
					});
					return {
						disposition: "started",
						assistantText: "",
						aborted: true,
						stopReason: "aborted",
						assistantMessages: [],
						toolExecutions: [],
						notices: [],
						dialogs: [],
						events: [],
					};
				}
				const assistantText =
					workerReplyMode === "malformed"
						? "这不是合法的 JSON 响应"
						: workerReplyMode === "hallucinated_id"
							? JSON.stringify({
									fitStatus: "matched",
									recommendedMode: "solo",
									recommendedLeadId: "non-existent-member",
									recommendedConsultIds: [],
									recommendedObserverIds: [],
									confidence: "high",
									headline: "建议由虚构成员牵头",
									reasoning: "测试幻觉 ID 拦截",
								})
							: JSON.stringify({
									fitStatus: "matched",
									recommendedMode: "lead_review",
									recommendedLeadId: "engineering-manager",
									recommendedConsultIds: ["product-manager"],
									recommendedObserverIds: ["qa-manager"],
									confidence: "high",
									headline: "建议由「研发经理」牵头 · 加人旁听",
									reasoning: "需求涉及仓库接口改动与测试边界核对，研发牵头并由测试经理旁听把关。",
									gapSuggestion: null,
								});
				return {
					disposition: "started",
					assistantText,
					aborted: false,
					stopReason: "stop",
					assistantMessages: [],
					toolExecutions: [],
					notices: [],
					dialogs: [],
					events: [],
				};
			},
			abort: async () => {
				record.aborted = true;
			},
			stop: async () => {},
		};
	};

	const orchestrator = new TeamOrchestrator({
		store,
		templates,
		defaultCwd: tmp,
		noSession: true,
		workerFactory: (options) => makeWorker(options),
	});

	// Direct validator + runTypedPiDecision unit checks
	assert.equal(
		validateInitiationModelDecision(
			{
				fitStatus: "matched",
				recommendedMode: "solo",
				recommendedLeadId: "fake-ghost-id",
				headline: "标题",
				reasoning: "依据",
			},
			{
				members: store.listMembers(),
				primaryId: "product-manager",
				explicitMemberId: null,
				hasWorkspace: true,
			},
		),
		null,
	);

	workerReplyMode = "malformed";
	await assert.rejects(
		() =>
			runTypedPiDecision(
				{ cwd: tmp, provider: "kimi-coding", model: "kimi-for-coding", workerFactory: makeWorker },
				{
					name: "unit_parse_check",
					systemPrompt: "Return JSON",
					userPrompt: "Test",
					validate: () => ({ ok: true }),
				},
				{ signal: new AbortController().signal },
			),
		(err: unknown) => err instanceof PiDecisionError && err.kind === "parse_error",
	);
	workerReplyMode = "valid";

	const dialogBroker = new DialogBroker();
	const previewManager = new PreviewManager();
	const { server } = createPersonalAgentServer({
		store,
		orchestrator,
		templates,
		dialogBroker,
		previewManager,
		rolesDir,
	});
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const url = `http://127.0.0.1:${address.port}`;

	try {
		const collab = store.upsertCollaborator({ name: "Viewer", roleTitle: "旁观同事" });
		assert.ok(collab.token);
		// 1) Non-owner collaborator cannot trigger model decision
		const forbiddenRes = await fetch(`${url}/api/matters/assess`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${collab.token}` },
			body: JSON.stringify({ prompt: "帮我看下这个接口", mode: "model", workspaceId: ws.id }),
		});
		assert.equal(forbiddenRes.status, 403);

		// 2) Valid model decision without repo read -> uses --tools "" and the Pi thinking default
		const okRes = await fetch(`${url}/api/matters/assess`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: "调整订单状态机接口并检查边界回归", mode: "model", workspaceId: ws.id }),
		});
		assert.equal(okRes.status, 200);
		const okBody = (await okRes.json()) as {
			assessmentSource: string;
			confidence: string;
			usedRepoRead: boolean;
			recommendedMode: string;
			recommendedLeadId: string;
			recommendedAiMemberIds: string[];
			recommendedObserverIds: string[];
		};
		assert.equal(okBody.assessmentSource, "model");
		assert.equal(okBody.confidence, "high");
		assert.equal(okBody.usedRepoRead, false);
		assert.equal(okBody.recommendedMode, "lead_review");
		assert.equal(okBody.recommendedLeadId, "engineering-manager");
		assert.deepEqual(okBody.recommendedObserverIds, ["qa-manager"]);
		assert.deepEqual(okBody.recommendedAiMemberIds, ["engineering-manager", "product-manager", "qa-manager"]);
		const okRun = observedRuns[1]!;
		const toolsFlagIdx = okRun.args.indexOf("--tools");
		assert.equal(okRun.args[toolsFlagIdx + 1], "");
		assert.equal(okRun.thinkingLevel, undefined);

		// 3) readRepo: true opens read tools, but no completed reads are fabricated.
		const readRes = await fetch(`${url}/api/matters/assess`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				prompt: "检查仓库接口改动影响",
				mode: "model",
				workspaceId: ws.id,
				readRepo: true,
			}),
		});
		assert.equal(readRes.status, 200);
		const readBody = (await readRes.json()) as {
			usedRepoRead: boolean;
			repoReadEnabled: boolean;
			repoReadPaths: string[];
		};
		assert.equal(readBody.repoReadEnabled, true);
		assert.equal(readBody.usedRepoRead, false);
		assert.deepEqual(readBody.repoReadPaths, []);
		const readRun = observedRuns[2]!;
		const readToolsIdx = readRun.args.indexOf("--tools");
		assert.equal(readRun.args[readToolsIdx + 1], "read");

		// 4) Malformed JSON and unknown member IDs fall back to the local recommendation
		workerReplyMode = "malformed";
		const badJsonRes = await fetch(`${url}/api/matters/assess`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: "检查这个问题", mode: "model" }),
		});
		assert.equal(badJsonRes.status, 200);
		assert.equal(((await badJsonRes.json()) as { assessmentSource: string }).assessmentSource, "rules");

		workerReplyMode = "hallucinated_id";
		const hallucinatedRes = await fetch(`${url}/api/matters/assess`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: "检查这个问题", mode: "model" }),
		});
		assert.equal(hallucinatedRes.status, 200);
		assert.equal(((await hallucinatedRes.json()) as { assessmentSource: string }).assessmentSource, "rules");

		// 5) Direct AbortSignal cancellation aborts in-flight worker cleanly
		workerReplyMode = "slow_abort";
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 30);
		await assert.rejects(
			() =>
				orchestrator.assessInitiationWithModel({
					prompt: "取消这个慢查询",
					signal: ac.signal,
				}),
			/aborted|Abort/i,
		);
		assert.equal(observedRuns[observedRuns.length - 1]!.aborted, true);
	} finally {
		await orchestrator.shutdown();
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		db.close();
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("AI Role Designer validates installed skills, structured verificationPlan, and POST /api/members/design mode=model", async () => {
	const tmp = mkdtempSync(join(tmpdir(), "pa-role-design-decision-"));
	const rolesDir = join(tmp, "roles");
	const db = openPersonalAgentDatabase(join(tmp, "agent.db"));
	const store = new PersonalAgentStore(db);
	const templates = await loadRoleTemplatesFromDir(resolve("roles"));
	let malformed = false;

	const orchestrator = new TeamOrchestrator({
		store,
		templates,
		defaultCwd: tmp,
		noSession: true,
		workerFactory: () => ({
			onNotice: () => () => {},
			setDialogHandler: () => {},
			start: async () => {},
			getState: async () => ({ sessionId: "design-session" }),
			runPromptAndWait: async () => ({
				disposition: "started",
				assistantText: malformed
					? "invalid-non-json"
					: JSON.stringify({
							id: "release-ops",
							name: "发布运维专员",
							title: "Release Ops Specialist",
							oneJob: "每次版本上线前核对 CI 状态、版本号与 CHANGELOG 同步。",
							antiJobs: ["不直接修改业务功能代码", "无实质阻塞时保持简短"],
							quietWhen: "无发布风险时保持安静",
							keywords: ["发布", "CI", "上线", "release"],
							skills: ["repo-analysis", "nonexistent-fake-skill"],
							interactionStyle: "risk_observer",
							workspaceScope: "read_only_repo",
							communicationStyle: "先结论后清单。",
							workflowRules: "只核查仓库发版资产。",
							verificationPlan: {
								task: "检查 v0.5.0 CHANGELOG 与 package.json 版本一致",
								successCriteria: "明确指出一致或不一致行",
								boundaryCheck: "未执行修改文件操作",
							},
							designRationale: "仅需只读核查仓库发版物。",
						}),
				aborted: false,
				stopReason: "stop",
				assistantMessages: [],
				toolExecutions: [],
				notices: [],
				dialogs: [],
				events: [],
			}),
			abort: async () => {},
			stop: async () => {},
		}),
	});

	assert.equal(
		validateRoleDesignDecision(
			{
				name: "短名",
				title: "Short Title",
				oneJob: "单职责",
				antiJobs: ["不做越权"],
				keywords: ["测试"],
				skills: [],
				verificationPlan: { task: "t", successCriteria: "", boundaryCheck: "b" },
			},
			{
				explicit: { oneJob: "单职责" },
				existingMemberIds: ["product-manager"],
				installedSkills: new Set(["repo-analysis"]),
			},
		),
		null,
	);

	const dialogBroker = new DialogBroker();
	const previewManager = new PreviewManager();
	const { server } = createPersonalAgentServer({
		store,
		orchestrator,
		templates,
		dialogBroker,
		previewManager,
		rolesDir,
	});
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const url = `http://127.0.0.1:${address.port}`;

	try {
		const res = await fetch(`${url}/api/members/design`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				oneJob: "发布前检查版本号与 CHANGELOG",
				mode: "model",
			}),
		});
		assert.equal(res.status, 200);
		const body = (await res.json()) as {
			designSource: string;
			verificationPlanState: string;
			template: { id: string; name: string; title: string; skills: string[]; tools: string[] };
		};
		assert.equal(body.designSource, "model");
		assert.equal(body.verificationPlanState, "specified");
		assert.equal(body.template.id, "release-ops");
		assert.equal(body.template.name, "发布运维专员");
		assert.deepEqual(body.template.skills, ["repo-analysis"]);
		assert.deepEqual(body.template.tools, ["read"]);

		const explicitRes = await fetch(`${url}/api/members/design`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				oneJob: "检查发版",
				roleId: "explicit-release-check",
				mode: "model",
				verificationPlan: "以旧版清单检查全部变更",
				constraints: "不得访问客户数据",
				skills: ["explicit-missing-skill"],
			}),
		});
		assert.equal(explicitRes.status, 200);
		const explicitBody = (await explicitRes.json()) as RoleArchitectDraft;
		assert.equal(explicitBody.template.id, "explicit-release-check");
		assert.ok(explicitBody.markdown.includes("以旧版清单检查全部变更"));
		assert.ok(explicitBody.markdown.includes("不得访问客户数据"));
		assert.deepEqual(
			explicitBody.capabilityReport?.skills.find((s) => s.name === "explicit-missing-skill"),
			{
				name: "explicit-missing-skill",
				state: "missing",
			},
		);

		malformed = true;
		const badRes = await fetch(`${url}/api/members/design`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ oneJob: "检查发版", mode: "model" }),
		});
		assert.equal(badRes.status, 200);
		assert.equal(((await badRes.json()) as { designSource: string }).designSource, "rules");
	} finally {
		await orchestrator.shutdown();
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		db.close();
		rmSync(tmp, { recursive: true, force: true });
	}
});
