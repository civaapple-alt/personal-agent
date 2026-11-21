import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { reviewObject } from "../src/demo/publication-review-quality.ts";
import { resolveRoleSkills } from "../src/orchestrator/execution-context.ts";
import { parseMetaArchitectResponse } from "../src/orchestrator/meta-architect.ts";
import { collectTeamHealthEvidence } from "../src/orchestrator/team-health.ts";
import { TeamOrchestrator } from "../src/orchestrator/team-orchestrator.ts";
import { assessRoleCapabilities, listRoleSkillCatalog } from "../src/roles/capabilities.ts";
import {
	BUILTIN_ROLE_ARCHITECT_TEMPLATE,
	buildRoleDesignDraft,
	normalizeRoleVerificationPlan,
} from "../src/roles/role-architect.ts";
import {
	loadRoleTemplatesFromDir,
	parseRoleTemplateMarkdown,
	serializeRoleTemplateMarkdown,
} from "../src/roles/template-loader.ts";
import { createPersonalAgentServer } from "../src/server/app.ts";
import { DialogBroker } from "../src/server/dialog-broker.ts";
import { PreviewManager } from "../src/server/preview-manager.ts";
import { openPersonalAgentDatabase } from "../src/storage/database.ts";
import { PersonalAgentStore } from "../src/storage/repositories.ts";
import { invokeTool, reportReady } from "./worker-helpers.ts";

test("All built-in roles load declared methods, explicit boundaries and round-trip definitions", async () => {
	const templates = [...(await loadRoleTemplatesFromDir(resolve("roles"))), BUILTIN_ROLE_ARCHITECT_TEMPLATE];
	for (const template of templates) {
		assert.ok(template.antiJobs?.length, template.id);
		assert.ok((await resolveRoleSkills(template)).length > 0, template.id);
		const parsed = parseRoleTemplateMarkdown(serializeRoleTemplateMarkdown(template));
		assert.deepEqual(parsed.skills, template.skills);
		assert.deepEqual(parsed.responsibilityKeywords, template.responsibilityKeywords);
		assert.deepEqual(parsed.sections, template.sections);
		assert.deepEqual(parsed.antiJobs, template.antiJobs);
		assert.ok(
			Object.values(parsed.sections).every((section) => section.trim()),
			template.id,
		);
		assert.deepEqual(
			(await assessRoleCapabilities(template)).skills.map((skill) => skill.state),
			template.skills.map(() => "file_present"),
		);
	}
	const catalog = await listRoleSkillCatalog();
	assert.ok(catalog.some((item) => item.name === "role-design"));
	assert.ok(catalog.every((item) => item.description.length > 0));
});

test("Architect preserves selected capabilities, communication and concrete verification without claiming runtime availability", async () => {
	const parsed = parseMetaArchitectResponse(
		JSON.stringify({
			reply: "方案",
			blueprints: [
				{
					oneJob: "核对发布说明和实际版本",
					name: "发布审阅员",
					title: "Release Reviewer",
					workspaceScope: "read_only_repo",
					skills: ["repo-analysis", "repo-analysis", "missing-method"],
					mcpDependencies: ["external-docs"],
					communicationStyle: "先指出矛盾，再给文件依据",
					verificationPlan: "读取 package.json 与 release.md，指出版本差异并保留原文件",
				},
			],
		}),
		[],
	);
	const draft = parsed.blueprints[0]?.draft;
	assert.ok(draft);
	assert.deepEqual(draft.template.skills, ["repo-analysis", "missing-method"]);
	assert.deepEqual(draft.template.mcpDependencies, ["external-docs"]);
	assert.match(draft.template.sections.collaborationConventions, /先指出矛盾/);
	assert.match(draft.template.sections.deliveryAndVerification, /package.json/);
	assert.deepEqual(await assessRoleCapabilities(draft.template), {
		skills: [
			{ name: "repo-analysis", state: "file_present" },
			{ name: "missing-method", state: "missing" },
		],
		mcpDependencies: [{ name: "external-docs", state: "runtime_check_required" }],
	});
});

test("Structured verification plans retain tasks, result conditions and boundaries instead of falling back silently", () => {
	const plan = { task: "读取原文件", successCriteria: "指出版本矛盾", boundaryCheck: "不修改原文件" };
	const result = parseMetaArchitectResponse(
		JSON.stringify({ blueprints: [{ oneJob: "核对发布", verificationPlan: plan }] }),
		[],
	);
	const draft = result.blueprints[0]?.draft;
	assert.equal(draft?.verificationPlanState, "specified");
	assert.match(
		draft?.template.sections.deliveryAndVerification ?? "",
		/读取原文件[\s\S]*指出版本矛盾[\s\S]*不修改原文件/,
	);
	assert.equal(normalizeRoleVerificationPlan({ task: "缺少标准" }), undefined);
	assert.equal(buildRoleDesignDraft({ oneJob: "核对发布" }).verificationPlanState, "missing");
});

test("Team health findings resolve only actual source IDs and preserve source records", async () => {
	const db = openPersonalAgentDatabase(":memory:");
	try {
		const store = new PersonalAgentStore(db);
		const templates = await loadRoleTemplatesFromDir(resolve("roles"));
		const orchestrator = new TeamOrchestrator({ store, templates });
		const matter = store.createMatter({ title: "原始故障", leadMemberId: "product-manager" });
		const message = store.appendMessage({
			matterId: matter.id,
			senderType: "system",
			senderId: "system",
			channel: "user",
			content: "真实失败记录 MARKER_HEALTH",
			metadata: { failed: true },
		});
		const sources = collectTeamHealthEvidence(store, new Map(templates.map((role) => [role.id, role])));
		const result = parseMetaArchitectResponse(
			JSON.stringify({
				reply: "检查",
				healthFindings: [
					{
						status: "warn",
						title: "核查失败",
						detail: "需要定位原因",
						evidenceIds: [`message:${message.id}`, "invented-source"],
					},
				],
			}),
			store.listMembers(),
			{ healthEvidence: sources },
		);
		assert.equal(result.healthFindings?.[0]?.evidence?.length, 1);
		assert.equal(result.healthFindings?.[0]?.evidence?.[0]?.matterId, matter.id);
		assert.match(result.healthFindings?.[0]?.evidence?.[0]?.excerpt ?? "", /MARKER_HEALTH/);
		assert.equal(store.getMessage(message.id)?.content, message.content);
		await orchestrator.shutdown();
	} finally {
		db.close();
	}
});

test("Design, create and export preserve dependency selections while missing Skills block before worker startup", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pa-capabilities-"));
	const db = openPersonalAgentDatabase(join(directory, "proof.db"));
	const store = new PersonalAgentStore(db);
	let started = false;
	const orchestrator = new TeamOrchestrator({
		store,
		templates: [],
		defaultCwd: directory,
		workerFactory: () => {
			started = true;
			throw new Error("Must not start");
		},
	});
	const { server } = createPersonalAgentServer({
		store,
		orchestrator,
		templates: [],
		rolesDir: join(directory, "roles"),
		previewManager: new PreviewManager(),
		dialogBroker: new DialogBroker(),
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const base = `http://127.0.0.1:${address.port}`;
	const post = (path: string, body: unknown) =>
		fetch(base + path, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	try {
		const response = await post("/api/members/design", {
			oneJob: "检查发布说明",
			roleTitle: "Release Reviewer",
			skills: ["missing-method"],
			mcpDependencies: ["external-docs"],
			workspaceScope: "read_only_repo",
			verificationPlan: "核对原文件",
		});
		assert.equal(response.status, 200);
		const designed = reviewObject(await response.json());
		assert.deepEqual(designed.capabilityReport, {
			skills: [{ name: "missing-method", state: "missing" }],
			mcpDependencies: [{ name: "external-docs", state: "runtime_check_required" }],
		});
		assert.equal(
			(
				await post("/api/members", {
					name: "发布审阅员",
					title: "Release Reviewer",
					id: "release-reviewer",
					skills: ["missing-method"],
					mcpDependencies: ["external-docs"],
					tools: ["read"],
				})
			).status,
			201,
		);
		const exported = reviewObject(await (await fetch(`${base}/api/members/release-reviewer/export`)).json());
		assert.equal(typeof exported.markdown, "string");
		if (typeof exported.markdown !== "string") throw new Error("Missing Markdown");
		assert.deepEqual(parseRoleTemplateMarkdown(exported.markdown).mcpDependencies, ["external-docs"]);
		await assert.rejects(
			orchestrator.dispatchMatter({
				prompt: "检查",
				preferredMemberId: "release-reviewer",
				aiMemberIds: ["release-reviewer"],
				observersEnabled: false,
			}),
			/Skill missing-method is not installed/,
		);
		assert.equal(started, false);
		assert.ok(store.listMatters().every((matter) => !store.hasLiveMatterLease(matter.id)));
	} finally {
		await orchestrator.shutdown();
		await new Promise<void>((done) => server.close(() => done()));
		db.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("Architect receives the design method and workbench help while publication is rejected by the host", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pa-architect-boundary-"));
	const db = openPersonalAgentDatabase(":memory:");
	try {
		const store = new PersonalAgentStore(db);
		const orchestrator = new TeamOrchestrator({
			store,
			templates: [BUILTIN_ROLE_ARCHITECT_TEMPLATE],
			defaultCwd: directory,
			noSession: true,
			workerFactory: (options) => ({
				start: () => reportReady(options, ["read_pa_help"]),
				getState: async () => ({ sessionId: "controlled-architect" }),
				stop: async () => {},
				onNotice: () => () => {},
				setDialogHandler: () => {},
				runPromptAndWait: async () => {
					assert.equal(options.env?.PA_CAN_PUBLISH, "false");
					assert.match(options.env?.PA_MEMBER_CONTEXT ?? "", /Give each role one core outcome/);
					assert.match(options.env?.PA_MEMBER_CONTEXT ?? "", /Write user-facing prose in the user's language/);
					assert.match(options.env?.PA_TURN_CONTEXT ?? "", /## Installed Skill catalog/);
					assert.match(
						JSON.stringify(await invokeTool(options, "read_pa_help", { topics: ["roles"], language: "zh" })),
						/角色架构师/,
					);
					await assert.rejects(
						invokeTool(options, "publish_deliverable", {
							type: "document",
							title: "越权",
							content: "不应发布",
							changeNote: "测试",
						}),
						/Role architect cannot execute team tools/,
					);
					return {
						disposition: "started",
						aborted: false,
						assistantText: '{"reply":"先复用已有岗位","blueprints":[]}',
						assistantMessages: [],
						toolExecutions: [],
						notices: [],
						dialogs: [],
						events: [],
					};
				},
			}),
		});
		await orchestrator.dispatchMatter({
			prompt: "规划",
			preferredMemberId: "role-architect",
			observersEnabled: false,
		});
		assert.equal(store.listDeliverables().length, 0);
		await orchestrator.shutdown();
	} finally {
		db.close();
		await rm(directory, { recursive: true, force: true });
	}
});
