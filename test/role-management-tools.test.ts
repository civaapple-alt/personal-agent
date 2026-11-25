import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { PiHostToolExtensionApi } from "../pa-extensions/worker-runtime/pi/bridge-client.ts";
import workerRuntimeExtension, { type WorkerRuntimeExtensionApi } from "../pa-extensions/worker-runtime/pi/index.ts";
import { prepareTeamExtension } from "../packages/server/src/extensions/team-extension/runtime.ts";
import type { RoleProposalPayload } from "../packages/server/src/orchestrator/architect/meta-architect.ts";
import { buildMemberPrompts } from "../packages/server/src/orchestrator/execution/prompts.ts";
import { TeamOrchestrator } from "../packages/server/src/orchestrator/team-orchestrator.ts";
import { BUILTIN_ROLE_ARCHITECT_TEMPLATE } from "../packages/server/src/roles/role-architect.ts";
import { loadRoleTemplatesFromDir } from "../packages/server/src/roles/template-loader.ts";
import { createTeamToolBridge, type TeamToolCall } from "../packages/server/src/rpc/team-tool-bridge.ts";
import { openPersonalAgentDatabase } from "../packages/server/src/storage/database.ts";
import { PersonalAgentStore } from "../packages/server/src/storage/repositories.ts";
import { invokeTool, reportReady } from "./worker-helpers.ts";

test("workerRuntimeExtension registers read_team_roles and propose_role only when PA_CAN_MANAGE_ROLES is true", (t) => {
	const original = process.env.PA_CAN_MANAGE_ROLES;
	t.after(() => {
		if (original === undefined) delete process.env.PA_CAN_MANAGE_ROLES;
		else process.env.PA_CAN_MANAGE_ROLES = original;
	});

	const collectRegisteredTools = (flag: string | undefined) => {
		if (flag === undefined) delete process.env.PA_CAN_MANAGE_ROLES;
		else process.env.PA_CAN_MANAGE_ROLES = flag;
		const registered: string[] = [];
		const api: WorkerRuntimeExtensionApi = {
			on: () => {},
			registerTool: (tool: Parameters<PiHostToolExtensionApi["registerTool"]>[0]) => {
				registered.push(tool.name);
			},
			getActiveTools: () => [],
			getAllTools: () => [],
			setActiveTools: () => {},
		};
		workerRuntimeExtension(api);
		return registered;
	};

	assert.deepEqual(collectRegisteredTools(undefined), []);
	assert.deepEqual(collectRegisteredTools("false"), []);
	assert.deepEqual(collectRegisteredTools("true"), ["read_team_roles", "propose_role"]);
});

test("prepareTeamExtension enables role management tools for non-discussion lead roles only", () => {
	const regularLead = prepareTeamExtension({
		sessionMode: "lead",
		discussionMode: false,
		isArchitect: false,
		hasConsultTargets: false,
	});
	assert.equal(regularLead.canManageRoles, true);
	assert.ok(regularLead.tools.includes("read_team_roles"));
	assert.ok(regularLead.tools.includes("propose_role"));

	const architectLead = prepareTeamExtension({
		sessionMode: "lead",
		discussionMode: false,
		isArchitect: true,
		hasConsultTargets: false,
	});
	assert.equal(architectLead.canManageRoles, true);
	assert.ok(architectLead.tools.includes("read_team_roles"));
	assert.ok(architectLead.tools.includes("propose_role"));

	const discussionLead = prepareTeamExtension({
		sessionMode: "lead",
		discussionMode: true,
		isArchitect: false,
		hasConsultTargets: false,
	});
	assert.equal(discussionLead.canManageRoles, false);
	assert.ok(!discussionLead.tools.includes("propose_role"));

	const internalWorker = prepareTeamExtension({
		sessionMode: "internal",
		discussionMode: false,
		isArchitect: false,
		hasConsultTargets: true,
	});
	assert.equal(internalWorker.canManageRoles, false);
	assert.ok(!internalWorker.tools.includes("read_team_roles"));
});

test("team-tool-bridge validates read_team_roles and propose_role payloads", async () => {
	const received: TeamToolCall[] = [];
	const controller = new AbortController();
	const bridge = await createTeamToolBridge(async (call) => {
		received.push(call);
		return { ok: true, tool: call.tool };
	}, controller.signal);

	const post = (body: unknown) =>
		fetch(`${bridge.env.PA_TEAM_BRIDGE_URL}/tool`, {
			method: "POST",
			headers: { Authorization: `Bearer ${bridge.env.PA_TEAM_BRIDGE_TOKEN}` },
			body: JSON.stringify(body),
		});

	try {
		const readRes = await post({
			tool: "read_team_roles",
			callId: "r1",
			args: { includeHealthEvidence: true },
		});
		assert.equal(readRes.status, 200);

		const createRes = await post({
			tool: "propose_role",
			callId: "c1",
			args: {
				action: "create",
				name: "合规审查顾问",
				title: "Compliance Reviewer",
				oneJob: "审查对外发布文案与合同条款的合规风险",
				antiJobs: ["不直接修改业务代码"],
				skills: ["compliance-checklist"],
				newSkills: [
					{
						name: "release-compliance",
						description: "Use when reviewing outbound release copy for legal or privacy risks.",
						body: "# Compliance Checklist\n1. Check PII exposure.",
						storageScope: "role_local",
					},
				],
				rationale: "现有团队缺少合规风险把关角色",
			},
		});
		assert.equal(createRes.status, 200);

		const updateRes = await post({
			tool: "propose_role",
			callId: "u1",
			args: {
				action: "update",
				memberId: "product-manager",
				addAntiJobs: ["幕僚长担任主责时不作为默认入口分派任务"],
				workflowNote: "在幕僚长主责事项中聚焦产品决策与验收标准。",
				rationale: "消除与新设幕僚长的入口职责重叠",
			},
		});
		assert.equal(updateRes.status, 200);

		// Invalid payloads should be rejected with 400
		const missingOneJob = await post({
			tool: "propose_role",
			callId: "bad-create",
			args: { action: "create", rationale: "missing oneJob" },
		});
		assert.equal(missingOneJob.status, 400);

		const emptyUpdate = await post({
			tool: "propose_role",
			callId: "bad-update",
			args: { action: "update", memberId: "product-manager", rationale: "no changes" },
		});
		assert.equal(emptyUpdate.status, 400);

		assert.equal(received.length, 3);
		assert.equal(received[0]?.tool, "read_team_roles");
		assert.equal(received[1]?.tool, "propose_role");
		assert.equal(received[2]?.tool, "propose_role");
	} finally {
		controller.abort();
		await bridge.close();
	}
});

test("non-architect lead role can read_team_roles and stage propose_role proposals onto metadata.roleProposals, discarding on abort", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pa-role-tools-e2e-"));
	const db = openPersonalAgentDatabase(join(directory, "test.db"));
	t.after(async () => {
		db.close();
		await rm(directory, { recursive: true, force: true });
	});
	const store = new PersonalAgentStore(db);
	const templates = [...(await loadRoleTemplatesFromDir(resolve("roles"))), BUILTIN_ROLE_ARCHITECT_TEMPLATE];
	let mode: "clean" | "abort" = "clean";
	let observedRolesCount = 0;
	let observedHealthDigest = "";

	const orchestrator = new TeamOrchestrator({
		store,
		templates,
		defaultCwd: directory,
		noSession: true,
		readPiModels: async () => ({ models: [], defaultModel: null }),
		workerFactory: (options) => ({
			start: async () => {
				await reportReady(options);
			},
			stop: async () => {},
			getState: async () => ({ sessionId: "s-role-tools" }),
			setDialogHandler: () => {},
			onNotice: () => () => {},
			runPromptAndWait: async () => {
				const readOut = (await invokeTool(options, "read_team_roles", {
					includeHealthEvidence: true,
				})) as {
					result: {
						roles: Array<{ id: string }>;
						healthEvidenceDigest?: string;
					};
				};
				observedRolesCount = readOut.result.roles.length;
				observedHealthDigest = readOut.result.healthEvidenceDigest ?? "";

				// Unknown memberId should be rejected
				await assert.rejects(
					invokeTool(options, "propose_role", {
						action: "update",
						memberId: "non-existent-role",
						addAntiJobs: ["不应生效"],
						rationale: "测试越界目标",
					}),
					/was not found in the current visible scope/,
				);

				await invokeTool(options, "propose_role", {
					action: "create",
					id: "chief-of-staff",
					name: "幕僚长",
					title: "Chief of Staff",
					oneJob: "统筹跨角色分派与推进闭环",
					antiJobs: ["不直接编写业务代码"],
					newSkills: [
						{
							name: "chief-of-staff-sop",
							description: "Use when coordinating multi-role handoffs.",
							body: "# Chief of Staff SOP\n1. Intake and dispatch.",
							storageScope: "role_local",
						},
					],
					rationale: "补齐跨角色统筹入口",
				});

				await invokeTool(options, "propose_role", {
					action: "update",
					memberId: "product-manager",
					addAntiJobs: ["幕僚长主责时不承担默认跨事项分派"],
					workflowNote: "聚焦产品决策与验收标准。",
					rationale: "避免与幕僚长职责重叠",
				});

				return {
					disposition: "started",
					aborted: mode === "abort",
					assistantText: mode === "abort" ? "已中止" : "已根据团队现状提交幕僚长创建与 PM 边界调整提案。",
					assistantMessages: [],
					toolExecutions: [],
					notices: [],
					dialogs: [],
					events: [],
				};
			},
		}),
	});
	t.after(async () => {
		await orchestrator.shutdown();
	});

	// 1. Clean turn from a regular lead role (product-manager, not role-architect)
	const clean = await orchestrator.dispatchMatter({
		prompt: "帮我设计一个幕僚长角色并收敛 PM 边界",
		preferredMemberId: "product-manager",
		observersEnabled: false,
	});
	assert.ok(observedRolesCount >= 4);
	assert.match(observedHealthDigest, /Current AI roles/);
	// Never auto-creates members before user confirmation
	assert.equal(store.getMember("chief-of-staff"), null);

	const cleanMsg = store.listMessages(clean.matter.id, "user").findLast((m) => m.senderId === "product-manager");
	const proposals = cleanMsg?.metadata?.roleProposals as RoleProposalPayload | undefined;
	assert.ok(proposals);
	assert.equal(proposals.status, "pending");
	assert.equal(proposals.blueprints.length, 1);
	assert.equal(proposals.blueprints[0]?.draft.template.id, "chief-of-staff");
	assert.equal(proposals.blueprints[0]?.draft.newSkills?.[0]?.name, "chief-of-staff-sop");
	assert.equal(proposals.roleAdjustments?.length, 1);
	assert.equal(proposals.roleAdjustments?.[0]?.memberId, "product-manager");

	// 2. Aborted turn must discard staged proposals
	mode = "abort";
	const aborted = await orchestrator.dispatchMatter({
		prompt: "再次尝试设计角色但中途取消",
		preferredMemberId: "product-manager",
		observersEnabled: false,
	});
	const abortedMsg = store.listMessages(aborted.matter.id, "user").findLast((m) => m.senderId === "product-manager");
	assert.equal(abortedMsg?.metadata?.roleProposals, undefined);
});

test("pi-default solo role disables delegate_to_member while preserving PA extensions and native Pi prompt", async () => {
	const templates = await loadRoleTemplatesFromDir(resolve("roles"));
	const piDefault = templates.find((t) => t.id === "pi-default");
	assert.ok(piDefault);
	assert.equal(piDefault.roleKind, "solo");

	const soloExt = prepareTeamExtension({
		sessionMode: "lead",
		discussionMode: false,
		isArchitect: false,
		isSolo: true,
		hasConsultTargets: true,
	});
	assert.equal(soloExt.canDelegate, false);
	assert.ok(!soloExt.tools.includes("delegate_to_member"));
	assert.equal(soloExt.canReadSpace, true);
	assert.equal(soloExt.canSaveSpace, true);
	assert.equal(soloExt.canCaptureSkill, true);
	assert.equal(soloExt.canManageRoles, true);

	const { systemPrompt, turnContext } = buildMemberPrompts({
		member: {
			id: "pi-default",
			templateId: "pi-default",
			displayName: "Pi Default",
			roleTitle: "Solo Pi Assistant",
			gitName: "Pi Default",
			gitEmail: "pi-default@team.local",
			identitySummary: "",
			roleScope: "global",
			isPrimaryContact: false,
			keywords: piDefault.keywords,
			createdAt: "2026-11-25T00:00:00.000Z",
			updatedAt: "2026-11-25T00:00:00.000Z",
		},
		template: piDefault,
		workspace: null,
		sessionMode: "lead",
		teamMembers: [],
		teamCapabilities: "synthetic capability card",
	});
	assert.match(systemPrompt, /solo Pi assistant/i);
	assert.doesNotMatch(systemPrompt, /Personal Agent team/);
	assert.doesNotMatch(turnContext, /## Current team/);
	assert.doesNotMatch(turnContext, /## Team capability evidence/);
});
