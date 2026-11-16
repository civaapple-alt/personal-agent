import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
	assessMatterInitiation,
	buildRoleDesignDraft,
	createPersonalAgentServer,
	DialogBroker,
	loadRoleTemplatesFromDir,
	openPersonalAgentDatabase,
	PersonalAgentStore,
	PreviewManager,
	parseRoleTemplateMarkdown,
	type RpcWorkerLike,
	serializeRoleTemplateMarkdown,
	TeamOrchestrator,
} from "../src/index.ts";
import { buildStarterTasks } from "../web/src/utils.ts";
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
	assert.equal(pm.antiJobs, undefined);
	assert.ok(!serializeRoleTemplateMarkdown(pm).includes("antiJobs:"));
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
