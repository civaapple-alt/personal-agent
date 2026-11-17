import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
	applyRoleTemplatePatch,
	assessMatterInitiation,
	BUILTIN_ROLE_ARCHITECT_TEMPLATE,
	buildRoleDesignDraft,
	createPersonalAgentServer,
	DialogBroker,
	loadRoleTemplatesFromDir,
	loadRoleTemplatesWithCustomDir,
	openPersonalAgentDatabase,
	PersonalAgentStore,
	PreviewManager,
	parseMetaArchitectResponse,
	parseRoleTemplateMarkdown,
	ROLE_ARCHITECT_MEMBER_ID,
	type RoleProposalPayload,
	type RpcWorkerLike,
	serializeRoleTemplateMarkdown,
	TeamOrchestrator,
} from "../src/index.ts";
import { buildStarterTasks, formatRoleToolTierLabel } from "../web/src/utils.ts";
import { reportReady } from "./worker-helpers.ts";

test("RoleArchitect enforces One Job, Explicit Anti-Jobs, and least-privilege tools across round-trips", async () => {
	const draft = buildRoleDesignDraft({
		oneJob: "审查对外合同条款中的知识产权、违约责任与隐私合规风险",
		antiJobs: ["不替代团队决定商业合作报价", "不直接修改仓库代码"],
		quietWhen: "合同条款无新增风险或冲突时保持安静",
		interactionStyle: "risk_observer",
		workspaceScope: "no_repo_docs",
		roleName: "合同风控官",
		roleTitle: "Contract Risk Reviewer",
		workflowRules: "高风险条款必须逐条标出修改建议",
	});

	assert.deepEqual(draft.template.tools, []);
	assert.ok(draft.antiJobs.some((item) => item.includes("不替代团队决定商业合作报价")));
	assert.ok(draft.antiJobs.some((item) => item.includes("静默原则")));
	assert.equal(draft.template.id, "contract-risk-reviewer");

	const roundTripped = parseRoleTemplateMarkdown(draft.markdown);
	assert.deepEqual(roundTripped.tools, []);
	assert.deepEqual(roundTripped.antiJobs, draft.antiJobs);

	const builtIn = await loadRoleTemplatesFromDir(resolve("roles"));
	const pm = builtIn.find((item) => item.id === "product-manager")!;
	assert.ok(pm.antiJobs?.length);
	assert.deepEqual(parseRoleTemplateMarkdown(serializeRoleTemplateMarkdown(pm)).antiJobs, pm.antiJobs);
	// Older shared definitions without explicit Anti-Jobs still round-trip without invented boundaries.
	const legacy = { ...pm, antiJobs: undefined };
	assert.ok(!serializeRoleTemplateMarkdown(legacy).includes("antiJobs:"));
});

test("Solo and selective observer runtime scopes enforce delegate restrictions, antiJobs prompt injection, and selective observers", async () => {
	const tmp = mkdtempSync(join(tmpdir(), "pa-solo-selective-"));
	try {
		const db = openPersonalAgentDatabase(join(tmp, "agent.db"));
		const store = new PersonalAgentStore(db);
		const templates = await loadRoleTemplatesFromDir(resolve("roles"));
		const promptsBySession: Array<{ tools: string; prompt: string }> = [];
		const observerInvokedFor: string[] = [];

		const orchestrator = new TeamOrchestrator({
			store,
			templates,
			defaultCwd: tmp,
			noSession: true,
			workerFactory: (options) => {
				const toolsIdx = options.args?.indexOf("--tools") ?? -1;
				const toolsArg = toolsIdx >= 0 ? (options.args?.[toolsIdx + 1] ?? "") : "";
				const ctx = options.env?.PA_MEMBER_CONTEXT ?? "";
				promptsBySession.push({ tools: toolsArg, prompt: ctx });
				const worker: RpcWorkerLike = {
					onNotice: () => () => {},
					setDialogHandler: () => {},
					start: async () => {
						await reportReady(options);
					},
					runPromptAndWait: async () => {
						if (ctx.includes("旁听与主动发言规则")) {
							const match = ctx.match(/成员标识：`([^`]+)`/);
							if (match?.[1]) observerInvokedFor.push(match[1]);
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
						return {
							disposition: "started",
							aborted: false,
							assistantText: "单兵已完成梳理。",
							assistantMessages: [],
							toolExecutions: [],
							notices: [],
							dialogs: [],
							events: [],
						};
					},
					abort: async () => {},
					stop: async () => {},
					getState: async () => ({ sessionId: `sess_${Math.random().toString(36).slice(2)}` }),
				};
				return worker;
			},
		});

		const archDraft = buildRoleDesignDraft({
			oneJob: "只审查上线前外部条款合规性",
			antiJobs: ["绝不直接修改代码"],
			interactionStyle: "lead_direct",
			workspaceScope: "no_repo_docs",
			roleName: "合规审阅",
			roleTitle: "Compliance Reviewer",
			existingMemberIds: store.listMembers().map((m) => m.id),
		});
		const customMember = orchestrator.registerRoleTemplate(archDraft.template);

		// 1) Solo run: only 1 AI in matter -> no delegate_to_member tool, antiJobs injected, solo guidance present
		const soloResult = await orchestrator.dispatchMatter({
			prompt: "请按合规标准审阅这份外部声明。",
			preferredMemberId: customMember.id,
			aiMemberIds: [customMember.id],
			observersEnabled: false,
		});
		assert.equal(soloResult.matter.aiMemberIds?.length, 1);
		assert.ok(!promptsBySession[0]!.tools.includes("delegate_to_member"));
		assert.ok(!promptsBySession[0]!.tools.includes("bash"));
		assert.ok(!promptsBySession[0]!.tools.includes("edit"));
		assert.ok(promptsBySession[0]!.prompt.includes("单兵专办"));
		assert.ok(promptsBySession[0]!.prompt.includes("## 明确不做清单（Anti-Jobs）"));
		assert.ok(promptsBySession[0]!.prompt.includes("绝不直接修改代码"));

		// 2) Selective observers on createMatter: observersEnabled: true + observerMemberIds: ["qa-manager"] must NOT pull in all non-lead members
		const selective = await orchestrator.dispatchMatter({
			prompt: "请重构支付核心链路。",
			preferredMemberId: "engineering-manager",
			aiMemberIds: ["engineering-manager", "product-manager", "qa-manager"],
			observersEnabled: true,
			observerMemberIds: ["qa-manager"],
		});
		assert.deepEqual(selective.matter.observerMemberIds, ["qa-manager"]);
		assert.deepEqual(observerInvokedFor, ["qa-manager"]);

		await orchestrator.shutdown();
		db.close();
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("assessMatterInitiation and HTTP endpoints surface role gaps, design new roles, and persist scoped roster & collaborators", async () => {
	const tmp = mkdtempSync(join(tmpdir(), "pa-init-http-"));
	const rolesDir = join(tmp, "roles");
	const db = openPersonalAgentDatabase(join(tmp, "agent.db"));
	const store = new PersonalAgentStore(db);
	const templates = await loadRoleTemplatesFromDir(resolve("roles"));
	const templatesMap = new Map(templates.map((t) => [t.id, t]));

	const alignAssess = assessMatterInitiation({
		prompt: "大家先讨论一下接下来两个季度怎么定方向，哪种方案更合适？",
		members: templates.map((t) =>
			store.upsertMember({
				id: t.id,
				templateId: t.id,
				displayName: t.name,
				roleTitle: t.title,
				isPrimaryContact: t.isPrimaryContact,
				provider: t.defaultProvider,
				model: t.defaultModel,
				thinkingLevel: t.thinkingLevel,
				keywords: t.keywords,
			}),
		),
		templatesByRoleId: templatesMap,
	});
	assert.equal(alignAssess.recommendedMode, "human_first");

	// Negative "不负责/不做" lines must not count as positive skill/domain coverage, and non-gap prompts stay solo when single-lead suffices.
	const seededMembers = store.listMembers();
	const pmTpl = templatesMap.get("product-manager");
	const negativeCoverageTemplates = new Map(templatesMap);
	if (pmTpl) {
		negativeCoverageTemplates.set("product-manager", {
			...pmTpl,
			sections: {
				...pmTpl.sections,
				responsibilitiesAndBoundaries: `${pmTpl.sections.responsibilitiesAndBoundaries}\n- 不负责：合同、法务条款审核与合规签署。`,
			},
		});
	}
	const negativeCheck = assessMatterInitiation({
		prompt: "请审核这份客户合同条款和法务合规边界",
		members: seededMembers,
		templatesByRoleId: negativeCoverageTemplates,
	});
	assert.equal(negativeCheck.fitStatus, "gap_detected");

	const soloCheck = assessMatterInitiation({
		prompt: "请列出这批需求的优先级清单",
		members: seededMembers,
		templatesByRoleId: templatesMap,
		preferredMemberId: "product-manager",
	});
	assert.equal(soloCheck.recommendedMode, "solo");
	assert.deepEqual(soloCheck.recommendedAiMemberIds, ["product-manager"]);
	assert.notEqual(soloCheck.fitStatus, "gap_detected");

	const orchestrator = new TeamOrchestrator({ store, templates, defaultCwd: tmp, noSession: true });
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
		const col = (await (
			await fetch(`${url}/api/collaborators`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Bob", roleTitle: "运营同事" }),
			})
		).json()) as { collaborator: { id: string } };

		// 1) Gap detection for contract/legal prompt when only 4 default roles exist
		const gapRes = (await (
			await fetch(`${url}/api/matters/assess`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					prompt: "帮我逐条审查这份客户合作协议里的合同条款、违约金与知识产权合规风险。",
				}),
			})
		).json()) as {
			fitStatus: string;
			gapSuggestion?: { missingRoleTitle: string; suggestedJob: string; suggestedWorkspaceScope: string };
		};
		assert.equal(gapRes.fitStatus, "gap_detected");
		assert.ok(gapRes.gapSuggestion?.suggestedJob);

		// 2) Design role via Role Architect endpoint and create with minimal tools (no bash/edit!)
		const designed = (await (
			await fetch(`${url}/api/members/design`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					oneJob: gapRes.gapSuggestion!.suggestedJob,
					roleName: gapRes.gapSuggestion!.missingRoleTitle,
					antiJobs: ["不决定商业折扣"],
					interactionStyle: "lead_direct",
					workspaceScope: "no_repo_docs",
				}),
			})
		).json()) as {
			template: {
				name: string;
				title: string;
				tools: string[];
				keywords: string[];
				sections: Record<string, string>;
			};
			antiJobs: string[];
		};
		assert.deepEqual(designed.template.tools, []);

		const createdMember = (await (
			await fetch(`${url}/api/members`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: designed.template.name,
					title: designed.template.title,
					responsibilities: designed.template.sections.responsibilitiesAndBoundaries,
					keywords: [...designed.template.keywords, "合同条款", "知识产权", "合规风险"],
					tools: designed.template.tools,
					antiJobs: designed.antiJobs,
					sections: designed.template.sections,
				}),
			})
		).json()) as { member: { id: string } };

		// 3) Re-assess same prompt -> now matched to the newly designed specialist!
		const matchedRes = (await (
			await fetch(`${url}/api/matters/assess`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					prompt: "帮我逐条审查这份客户合作协议里的合同条款、违约金与知识产权合规风险。",
				}),
			})
		).json()) as { fitStatus: string; recommendedLeadId: string | null };
		assert.equal(matchedRes.fitStatus, "matched");
		assert.equal(matchedRes.recommendedLeadId, createdMember.member.id);

		// 4) Create human-first matter with pre-selected human collaborator and selective observer
		const createdMatter = (await (
			await fetch(`${url}/api/matters`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					mode: "discussion",
					prompt: "我们先对齐这份协议的边界与责任分工",
					preferredMemberId: createdMember.member.id,
					aiMemberIds: [createdMember.member.id, "qa-manager"],
					observerMemberIds: ["qa-manager"],
					collaboratorIds: [col.collaborator.id],
				}),
			})
		).json()) as {
			matter: {
				aiMemberIds: string[] | null;
				observerMemberIds: string[];
				collaboratorIds: string[];
			};
		};
		assert.deepEqual(createdMatter.matter.aiMemberIds, [createdMember.member.id, "qa-manager"]);
		assert.deepEqual(createdMatter.matter.observerMemberIds, ["qa-manager"]);
		assert.deepEqual(createdMatter.matter.collaboratorIds, [col.collaborator.id]);

		// 5) Frontend starter tasks adapt cleanly when no Git repository is bound
		const nonRepoStarters = buildStarterTasks([], null);
		assert.ok(
			nonRepoStarters.some(
				(task) => task.collaborationPreset === "human_first" && task.suggestedMode === "discussion",
			),
		);
		assert.ok(nonRepoStarters.some((task) => task.collaborationPreset === "solo"));
	} finally {
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		db.close();
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("Meta-Bot Role Architect runs isolated multi-turn intake, proposes 1..N least-privilege roles without auto-creating, and batches creation on confirm", async () => {
	const tmp = mkdtempSync(join(tmpdir(), "pa-meta-bot-"));
	const rolesDir = join(tmp, "roles");
	const db = openPersonalAgentDatabase(join(tmp, "agent.db"));
	const store = new PersonalAgentStore(db);
	const templates = await loadRoleTemplatesFromDir(resolve("roles"));
	const observedPrompts: Array<{ args: string[]; prompt: string }> = [];

	const orchestrator = new TeamOrchestrator({
		store,
		templates,
		defaultCwd: tmp,
		noSession: true,
		workerFactory: (options) => ({
			onNotice: () => () => {},
			setDialogHandler: () => {},
			start: async () => {},
			runPromptAndWait: async (promptText) => {
				observedPrompts.push({ args: options.args ?? [], prompt: promptText });
				const isSecondTurn = promptText.includes("只读核查客户访谈，不需要改代码");
				if (!isSecondTurn) {
					return {
						disposition: "started",
						aborted: false,
						assistantText: JSON.stringify({
							reply: "收到！在给你拆解角色前先确认两件事：\n1. 新角色需要修改代码仓库，还是仅做访谈分析与风险审阅？\n2. 审阅角色是否只在发现严重逻辑漏洞时插话？",
							followUpQuestions: ["只读核查客户访谈，不需要改代码；审阅无风险时保持静默"],
							blueprints: [],
						}),
						assistantMessages: [],
						toolExecutions: [],
						notices: [],
						dialogs: [],
						events: [],
					};
				}
				return {
					disposition: "started",
					aborted: false,
					assistantText: JSON.stringify({
						reply: "已按你们的流程拆成「研究主理 + 静默逻辑把关」两个互补角色，默认都不带 bash/edit 工具；请勾选确认后入队。",
						followUpQuestions: [],
						recommendedFormation: {
							mode: "lead_review",
							existingMemberIds: ["product-manager", "qa-manager"],
							observerMemberIds: ["qa-manager"],
							rationale: "1 位研究主理出结论 + 1 位静默把关，不拉开发旁听。",
						},
						blueprints: [
							{
								name: "用户访谈提炼官",
								title: "Interview Synthesizer",
								oneJob: "只从客户访谈原文提炼真实痛点、使用频次与原话证据",
								antiJobs: ["不编造未出现的需求", "不直接替团队决定研发排期"],
								interactionStyle: "lead_direct",
								workspaceScope: "no_repo_docs",
								keywords: ["访谈", "痛点", "原话"],
								rationale: "聚焦证据提炼主线工作",
							},
							{
								name: "逻辑漏洞审阅员",
								title: "Logic Gap Reviewer",
								oneJob: "只检查结论推导中的样本偏差与因果跳跃风险",
								antiJobs: ["无实质漏洞时保持静默", "不重写整份研究报告"],
								quietWhen: "样本依据充分且无明显偏差时输出 [SILENT]",
								interactionStyle: "risk_observer",
								workspaceScope: "read_only_repo",
								keywords: ["样本偏差", "逻辑漏洞"],
								rationale: "作为轻量旁听防过早下结论",
							},
						],
					}),
					assistantMessages: [],
					toolExecutions: [],
					notices: [],
					dialogs: [],
					events: [],
				};
			},
			abort: async () => {},
			stop: async () => {},
			getState: async () => ({ sessionId: `meta_${Math.random().toString(36).slice(2)}` }),
		}),
	});

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
		const initialCount = store.listMembers().length;

		// Turn 1: Meta-Bot asks clarifying Intake questions with toolless isolation (--tools "") and team healthcheck digest
		const turn1Resp = await fetch(`${url}/api/members/architect/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				messages: [{ role: "user", content: "我们要做一轮客户需求调研，顺便帮我看下当前团队有没有重叠。" }],
				includeHealthcheck: true,
			}),
		});
		assert.equal(turn1Resp.status, 200);
		const turn1 = (await turn1Resp.json()) as {
			reply: string;
			followUpQuestions: string[];
			blueprints: unknown[];
			usedHealthcheck: boolean;
		};
		assert.equal(turn1.usedHealthcheck, true);
		assert.equal(turn1.blueprints.length, 0);
		assert.equal(turn1.followUpQuestions.length, 1);
		assert.ok(observedPrompts[0]!.args.includes("--tools"));
		const toolsVal = observedPrompts[0]!.args[observedPrompts[0]!.args.indexOf("--tools") + 1];
		assert.equal(toolsVal, "");
		assert.ok(observedPrompts[0]!.prompt.includes("团队近期运行摩擦与健康摘要"));
		assert.equal(store.listMembers().length, initialCount);

		// Turn 2: Proposes 2 complementary roles + recommended formation; STILL does not auto-create any member
		const turn2 = (await (
			await fetch(`${url}/api/members/architect/chat`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					messages: [
						{ role: "user", content: "我们要做一轮客户需求调研，顺便帮我看下当前团队有没有重叠。" },
						{ role: "assistant", content: turn1.reply },
						{ role: "user", content: "只读核查客户访谈，不需要改代码；审阅无风险时保持静默。" },
					],
				}),
			})
		).json()) as {
			blueprints: Array<{
				draft: {
					template: {
						name: string;
						title: string;
						tools: string[];
						keywords: string[];
						sections: Record<string, string>;
					};
					antiJobs: string[];
				};
			}>;
			recommendedFormation?: { mode: string; observerMemberIds: string[] };
		};
		assert.equal(turn2.blueprints.length, 2);
		assert.deepEqual(turn2.blueprints[0]!.draft.template.tools, []);
		assert.deepEqual(turn2.blueprints[1]!.draft.template.tools, ["read"]);
		assert.equal(turn2.recommendedFormation?.mode, "lead_review");
		assert.deepEqual(turn2.recommendedFormation?.observerMemberIds, ["qa-manager"]);
		assert.equal(store.listMembers().length, initialCount);

		// Confirm creation only when user submits chosen blueprints via /api/members/batch
		const batchRes = (await (
			await fetch(`${url}/api/members/batch`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					members: turn2.blueprints.map((item) => ({
						name: item.draft.template.name,
						title: item.draft.template.title,
						responsibilities: item.draft.template.sections.responsibilitiesAndBoundaries,
						keywords: item.draft.template.keywords,
						tools: item.draft.template.tools,
						antiJobs: item.draft.antiJobs,
						sections: item.draft.template.sections,
					})),
				}),
			})
		).json()) as { members: Array<{ id: string; displayName: string }> };
		assert.equal(batchRes.members.length, 2);
		assert.equal(store.listMembers().length, initialCount + 2);

		// Non-owner collaborator cannot invoke Meta-Bot or batch member creation
		const col = (await (
			await fetch(`${url}/api/collaborators`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: "Guest", roleTitle: "成员" }),
			})
		).json()) as { collaborator: { token: string } };
		const forbiddenChat = await fetch(`${url}/api/members/architect/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "x-pa-token": col.collaborator.token },
			body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
		});
		assert.equal(forbiddenChat.status, 403);

		// Healthcheck parses structured findings + actionable roleAdjustments (ignoring recommendedFormation) and applies them cleanly
		const parsedHealth = parseMetaArchitectResponse(
			JSON.stringify({
				reply: "职责清晰，建议收窄非工程岗命令行权限。",
				healthFindings: [
					{ status: "ok", title: "职责重叠度低", detail: "四位分工明确。" },
					{ status: "warn", title: "工具权限过宽", detail: "产品经理无需 bash。" },
				],
				roleAdjustments: [
					{
						memberId: "product-manager",
						suggestedTools: ["read"],
						addAntiJobs: ["不直接运行终端命令或改动源码"],
						rationale: "收敛为只读核查",
					},
				],
				recommendedFormation: {
					mode: "lead_review",
					existingMemberIds: ["product-manager"],
					observerMemberIds: [],
				},
				blueprints: [],
			}),
			store.listMembers(),
			{ isHealthcheck: true },
		);
		assert.equal(parsedHealth.recommendedFormation, undefined);
		assert.equal(parsedHealth.healthFindings?.length, 2);
		assert.equal(parsedHealth.roleAdjustments?.[0]?.memberId, "product-manager");

		const applyRes = await fetch(`${url}/api/members/adjustments/apply`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				adjustments: [
					{
						memberId: "product-manager",
						tools: parsedHealth.roleAdjustments![0]!.suggestedTools,
						addAntiJobs: parsedHealth.roleAdjustments![0]!.addAntiJobs,
					},
				],
			}),
		});
		assert.equal(applyRes.status, 200);
		const pmTpl = orchestrator.getTemplateForMember(store.getMember("product-manager")!)!;
		assert.deepEqual(pmTpl.tools, ["read"]);
		assert.ok(pmTpl.antiJobs?.includes("不直接运行终端命令或改动源码"));
		assert.equal(formatRoleToolTierLabel(["read", "bash", "mcp"]), "含命令");
		assert.equal(formatRoleToolTierLabel(["read", "edit", "write", "bash"]), "可改代码");
		assert.equal(formatRoleToolTierLabel(["read"]), "只读");
		assert.equal(formatRoleToolTierLabel([]), "纯文稿");
		assert.deepEqual(applyRoleTemplatePatch(pmTpl, { tools: [] }).tools, []);
	} finally {
		await orchestrator.shutdown();
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		db.close();
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("Built-in Role Architect acts as a persistent AI role without polluting auto routing or observers, and supports mid-matter role joining", async () => {
	const tmp = mkdtempSync(join(tmpdir(), "pa-unified-architect-"));
	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db);
	const businessTemplates = await loadRoleTemplatesFromDir(resolve("roles"));
	const templates = [...businessTemplates, BUILTIN_ROLE_ARCHITECT_TEMPLATE];
	const capturedRuns: Array<{ memberId: string; args: string[]; context: string; prompt: string }> = [];

	const workerFactory = (opts: { args?: string[]; env?: Record<string, string | undefined> }): RpcWorkerLike => {
		const memberId = opts.env?.PA_MEMBER_ID ?? "";
		const context = opts.env?.PA_MEMBER_CONTEXT ?? "";
		const args = opts.args ?? [];
		return {
			start: async () => reportReady(opts, memberId === ROLE_ARCHITECT_MEMBER_ID ? [] : ["read"]),
			stop: async () => {},
			onNotice: () => () => {},
			setDialogHandler: () => {},
			getState: async () => ({
				sessionId: `sess-${memberId}-${Date.now()}`,
				sessionFile: join(tmp, `${memberId}-${Date.now()}.jsonl`),
				model: { id: "kimi-for-coding", provider: "kimi-coding" },
				thinkingLevel: "high",
				isStreaming: false,
				pendingMessageCount: 0,
			}),
			runPromptAndWait: async (prompt) => {
				capturedRuns.push({ memberId, args, context, prompt });
				if (memberId === ROLE_ARCHITECT_MEMBER_ID) {
					const replyJson = prompt.includes("体检")
						? {
								reply: "已检查现有分工与工具权限，建议收窄产品经理权限。",
								followUpQuestions: ["是否直接补一位法务风控官？"],
								healthFindings: [
									{ status: "warn", title: "工具权限过宽", detail: "产品经理当前含命令执行权限。" },
								],
								roleAdjustments: [
									{
										memberId: "product-manager",
										suggestedTools: ["read"],
										addAntiJobs: ["不执行 shell 命令或修改源码"],
										rationale: "收敛为只读核查",
									},
								],
								blueprints: [],
							}
						: {
								reply: "结合当前卡点，建议补充 1 位合同合规官加入协同。",
								followUpQuestions: [],
								blueprints: [
									{
										name: "合同合规官",
										title: "Compliance Reviewer",
										oneJob: "审阅本事项涉及的合作协议条款合规风险并给出修改意见",
										antiJobs: ["不替代人类最终商业拍板"],
										interactionStyle: "risk_observer",
										workspaceScope: "no_repo_docs",
										rationale: "补齐当前法律条文核查缺口",
									},
								],
							};
					return {
						assistantText: JSON.stringify(replyJson),
						assistantMessages: [],
						notices: [],
						dialogs: [],
						events: [],
						aborted: false,
						toolExecutions: [],
						disposition: "started",
					};
				}
				return {
					assistantText: "我是业务主责角色，当前推进到合作协议审阅环节。",
					assistantMessages: [],
					notices: [],
					dialogs: [],
					events: [],
					aborted: false,
					toolExecutions: [],
					disposition: "started",
				};
			},
		};
	};

	const orchestrator = new TeamOrchestrator({
		store,
		templates,
		defaultCwd: tmp,
		workerFactory,
	});
	const dialogBroker = new DialogBroker();
	const previewManager = new PreviewManager();
	const { server } = createPersonalAgentServer({
		store,
		orchestrator,
		templates,
		rolesDir: join(tmp, "roles"),
		dialogBroker,
		previewManager,
	});

	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
	const addr = server.address();
	assert.ok(addr && typeof addr !== "string");
	const url = `http://127.0.0.1:${addr.port}`;

	try {
		// 1. Isolation invariants: keyword auto-routing and auto-observers never pick role-architect
		const routed = orchestrator.routeMemberForRequest("请帮我分析权限、分工、工作流和角色边界问题");
		assert.notEqual(routed.id, ROLE_ARCHITECT_MEMBER_ID);

		const defaultBusinessMatter = store.createMatter({
			title: "普通业务事项",
			leadMemberId: businessTemplates[0]!.id,
			observersEnabled: true,
		});
		assert.ok(!defaultBusinessMatter.observerMemberIds.includes(ROLE_ARCHITECT_MEMBER_ID));

		// 2. Persistent Architect Matter: chat directly with role-architect & persist RoleProposalPayload
		const archTurn = await orchestrator.dispatchMatter({
			prompt: "请给当前团队做一次协作体检",
			preferredMemberId: ROLE_ARCHITECT_MEMBER_ID,
		});
		assert.equal(archTurn.matter.leadMemberId, ROLE_ARCHITECT_MEMBER_ID);
		assert.deepEqual(archTurn.matter.aiMemberIds, [ROLE_ARCHITECT_MEMBER_ID]);
		assert.equal(archTurn.observerMessages?.length ?? 0, 0);
		assert.equal(archTurn.replyText, "已检查现有分工与工具权限，建议收窄产品经理权限。");
		const archRun = capturedRuns.at(-1)!;
		assert.equal(archRun.args[archRun.args.indexOf("--tools") + 1], "");
		assert.ok(archRun.context.includes("当前已有业务 AI 成员"));
		const archPersistedMsg = store
			.listMessages(archTurn.matter.id, "user")
			.find((m) => m.senderType === "member" && m.senderId === ROLE_ARCHITECT_MEMBER_ID)!;
		const archProposals = archPersistedMsg.metadata?.roleProposals as RoleProposalPayload;
		assert.equal(archProposals.status, "pending");
		assert.equal(archProposals.healthFindings?.length, 1);
		assert.equal(archProposals.roleAdjustments?.[0]?.memberId, "product-manager");

		// 3. Mid-matter consult inside an ongoing business matter: keeps original lead and enables join on confirm
		const pmId = "product-manager";
		const bizMatter = store.createMatter({
			title: "推进对外合作协议",
			leadMemberId: pmId,
			aiMemberIds: [pmId],
			observersEnabled: false,
		});
		const postBizMsg = await fetch(`${url}/api/matters/${bizMatter.id}/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				mode: "dispatch",
				prompt: "这一步卡在合同条文风险核查了，请架构师帮我们加个角色",
				preferredMemberId: ROLE_ARCHITECT_MEMBER_ID,
			}),
		});
		assert.equal(postBizMsg.status, 202);

		interface ConsultDetailPayload {
			matter: { leadMemberId: string; aiMemberIds: string[] | null; observerMemberIds: string[] };
			userMessages: Array<{ id: string; senderType: string; senderId: string; metadata?: Record<string, unknown> }>;
		}
		let detailAfterConsult: ConsultDetailPayload | null = null;
		for (let i = 0; i < 40; i += 1) {
			const res = (await (await fetch(`${url}/api/matters/${bizMatter.id}`)).json()) as ConsultDetailPayload;
			const archReply = res.userMessages.find(
				(m) => m.senderType === "member" && m.senderId === ROLE_ARCHITECT_MEMBER_ID,
			);
			if (archReply) {
				detailAfterConsult = res;
				break;
			}
			await new Promise((r) => setTimeout(r, 25));
		}
		assert.ok(detailAfterConsult !== null);
		assert.equal(detailAfterConsult.matter.leadMemberId, pmId);
		const proposalMsg = detailAfterConsult.userMessages.find(
			(m) => m.senderType === "member" && m.senderId === ROLE_ARCHITECT_MEMBER_ID,
		)!;
		const consultProposals = proposalMsg.metadata?.roleProposals as RoleProposalPayload;
		assert.equal(consultProposals.isMidMatterConsult, true);
		assert.equal(consultProposals.blueprints.length, 1);

		const blueprintDraft = consultProposals.blueprints[0]!.draft;
		const applyRes = await fetch(
			`${url}/api/matters/${bizMatter.id}/messages/${proposalMsg.id}/apply-role-proposals`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					action: "apply",
					matterJoinMode: "observer",
					members: [
						{
							name: blueprintDraft.template.name,
							title: blueprintDraft.template.title,
							responsibilities: blueprintDraft.template.sections.responsibilitiesAndBoundaries,
							keywords: blueprintDraft.template.keywords,
							tools: blueprintDraft.template.tools,
							antiJobs: blueprintDraft.antiJobs,
							sections: blueprintDraft.template.sections,
						},
					],
					adjustments: [
						{
							memberId: "product-manager",
							tools: ["read"],
							addAntiJobs: ["不直接签署对外法律文件"],
						},
					],
				}),
			},
		);
		assert.equal(applyRes.status, 200);
		const appliedBody = (await applyRes.json()) as {
			createdMembers: Array<{ id: string }>;
			updatedMembers: Array<{ id: string }>;
			matter: { leadMemberId: string; aiMemberIds: string[] | null; observerMemberIds: string[] };
		};
		assert.equal(appliedBody.createdMembers.length, 1);
		const newRoleId = appliedBody.createdMembers[0]!.id;
		assert.equal(appliedBody.matter.leadMemberId, pmId);
		assert.ok(appliedBody.matter.aiMemberIds?.includes(newRoleId));
		assert.ok(appliedBody.matter.observerMemberIds.includes(newRoleId));

		// Duplicate apply on the same message returns 409 Conflict
		const dupRes = await fetch(`${url}/api/matters/${bizMatter.id}/messages/${proposalMsg.id}/apply-role-proposals`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "apply", members: [] }),
		});
		assert.equal(dupRes.status, 409);

		// 4. Short name & explicit kebab ID derivation + custom roles dir merge never mutating repo roles/
		const parsedNamed = parseMetaArchitectResponse(
			JSON.stringify({
				reply: "建议新增交互与视觉设计师。",
				blueprints: [
					{
						id: "ux-designer",
						title: "交互与视觉设计师",
						oneJob: "围绕真实使用场景起草交互流程、状态与视觉方向",
						interactionStyle: "consult_specialist",
						workspaceScope: "read_only_repo",
					},
				],
			}),
			store.listMembers(),
		);
		assert.equal(parsedNamed.blueprints[0]!.draft.template.id, "ux-designer");
		assert.equal(parsedNamed.blueprints[0]!.draft.template.name, "交互与视觉设计师");

		const merged = await loadRoleTemplatesWithCustomDir(resolve("roles"), join(tmp, "roles"));
		assert.ok(merged.some((t) => t.id === "product-manager"));
		assert.ok(merged.some((t) => t.id === newRoleId));

		// 5. Delete custom member cleanly; protect primary contact and role-architect
		const delPrimaryRes = await fetch(`${url}/api/members/product-manager`, { method: "DELETE" });
		assert.equal(delPrimaryRes.status, 409);
		const delArchRes = await fetch(`${url}/api/members/${ROLE_ARCHITECT_MEMBER_ID}`, { method: "DELETE" });
		assert.equal(delArchRes.status, 409);
		const delNewRes = await fetch(`${url}/api/members/${newRoleId}`, { method: "DELETE" });
		assert.equal(delNewRes.status, 200);
		assert.equal(store.getMember(newRoleId), null);
	} finally {
		await orchestrator.shutdown();
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		db.close();
		rmSync(tmp, { recursive: true, force: true });
	}
});
