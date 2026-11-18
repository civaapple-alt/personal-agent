import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
	assessMatterInitiationWithModel,
	designRoleDraftWithModel,
	loadRoleTemplatesFromDir,
	PiDecisionError,
	type PromptRunResult,
	type RpcWorkerLike,
	runTypedPiDecision,
} from "../src/index.ts";
import { normalizeRoleVerificationPlan } from "../src/roles/role-architect.ts";

function workerReturning(result: Partial<PromptRunResult>, onPrompt?: (prompt: string) => void): RpcWorkerLike {
	return {
		onNotice: () => () => {},
		setDialogHandler: () => {},
		start: async () => {},
		getState: async () => ({ sessionId: "decision-fixture" }),
		stop: async () => {},
		runPromptAndWait: async (prompt) => {
			onPrompt?.(prompt);
			return {
				disposition: "started",
				aborted: false,
				assistantText: "{}",
				assistantMessages: [],
				toolExecutions: [],
				notices: [],
				dialogs: [],
				events: [],
				...result,
			};
		},
	};
}

test("model role design retains explicit requirements and exposes missing dependencies", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pa-decision-contract-"));
	try {
		let prompt = "";
		const verificationPlan = { task: "核对旧版来源", successCriteria: "保留全部来源", boundaryCheck: "不改业务代码" };
		const antiJobs = Array.from({ length: 7 }, (_, i) => `不执行用户禁止操作 ${i + 1}`);
		const draft = await designRoleDraftWithModel(
			{
				defaultCwd: directory,
				members: [],
				templatesByRoleId: new Map(),
				workerFactory: () =>
					workerReturning(
						{
							assistantText: JSON.stringify({
								id: "model-choice",
								name: "核查专员",
								title: "Review Specialist",
								oneJob: "核查发布资料",
								antiJobs: ["不代替业务拍板"],
								keywords: ["发布"],
								skills: ["repo-analysis", "invented-model-skill"],
								interactionStyle: "mixed",
								workspaceScope: "read_write_code",
								verificationPlan: { task: "模型任务", successCriteria: "模型条件", boundaryCheck: "模型边界" },
							}),
						},
						(text) => {
							prompt = text;
						},
					),
			},
			{
				oneJob: "核查发布资料",
				roleId: "explicit-reviewer",
				workspaceScope: "no_repo_docs",
				skills: ["not-installed-explicit-method"],
				mcpDependencies: ["external-review"],
				antiJobs,
				constraints: "只使用合成数据，不联系客户",
				verificationPlan,
				signal: new AbortController().signal,
			},
		);
		assert.equal(draft.template.id, "explicit-reviewer");
		assert.deepEqual(draft.template.tools, []);
		assert.deepEqual(draft.template.skills, ["not-installed-explicit-method", "repo-analysis"]);
		assert.deepEqual(draft.template.mcpDependencies, ["external-review"]);
		for (const rule of antiJobs) assert.ok(draft.template.antiJobs?.includes(rule), rule);
		assert.ok(
			draft.template.sections.deliveryAndVerification.includes(normalizeRoleVerificationPlan(verificationPlan)!),
		);
		assert.ok(draft.template.rawBody.includes("只使用合成数据，不联系客户"));
		assert.ok(prompt.includes("只使用合成数据，不联系客户"));
		assert.ok(prompt.includes("not-installed-explicit-method"));
		assert.ok(prompt.includes("核对旧版来源"));
		assert.deepEqual(
			draft.capabilityReport?.skills.find((s) => s.name === "not-installed-explicit-method"),
			{
				name: "not-installed-explicit-method",
				state: "missing",
			},
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("repository evidence requires a completed successful read inside the selected workspace", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pa-decision-read-"));
	try {
		await writeFile(join(directory, "README.md"), "Synthetic repository only\n");
		await symlink(tmpdir(), join(directory, "outside"));
		const templates = await loadRoleTemplatesFromDir(resolve("roles"));
		const template = templates.find((t) => t.id === "product-manager")!;
		const member = {
			id: template.id,
			templateId: template.id,
			displayName: template.name,
			roleTitle: template.title,
			isPrimaryContact: true,
			roleScope: "global" as const,
			provider: template.defaultProvider,
			model: template.defaultModel,
			thinkingLevel: template.thinkingLevel,
			keywords: template.keywords,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			gitName: "Fixture",
			gitEmail: "fixture@example.invalid",
			identitySummary: "",
		};
		const reply = JSON.stringify({
			fitStatus: "matched",
			recommendedMode: "solo",
			recommendedLeadId: member.id,
			recommendedConsultIds: [],
			recommendedObserverIds: [],
			confidence: "medium",
			headline: "由产品牵头",
			reasoning: "核对资料",
		});
		const read = { toolCallId: "read-1", toolName: "read", args: { path: "README.md" }, isError: false };
		for (const [label, tools, expected] of [
			["unused", [], []],
			["unfinished", [read], []],
			["failed", [{ ...read, isError: true, result: "denied" }], []],
			["outside", [{ ...read, args: { path: "../outside.md" }, result: "outside" }], []],
			["symlink outside", [{ ...read, args: { path: "outside" }, result: "outside" }], []],
			["completed", [{ ...read, result: "Synthetic repository only" }], ["README.md"]],
		] as const) {
			const result = await assessMatterInitiationWithModel(
				{
					defaultCwd: directory,
					members: [member],
					templatesByRoleId: new Map([[template.id, template]]),
					workerFactory: () => workerReturning({ assistantText: reply, toolExecutions: [...tools] }),
				},
				{ prompt: "查看资料", workspacePath: directory, readRepo: true, signal: new AbortController().signal },
			);
			assert.equal(result.usedRepoRead, expected.length > 0, label);
			assert.deepEqual(result.repoReadPaths, expected, label);
			assert.equal(result.repoReadEnabled, true, label);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("throwing decision validators produce typed schema failures after worker cleanup", async () => {
	let stopped = false;
	const worker = workerReturning({ assistantText: '{"value":"invalid"}' });
	worker.stop = async () => {
		stopped = true;
	};
	await assert.rejects(
		() =>
			runTypedPiDecision(
				{
					cwd: tmpdir(),
					provider: "fixture",
					model: "fixture",
					workerFactory: () => worker,
				},
				{
					name: "throwing-schema",
					systemPrompt: "JSON",
					userPrompt: "fixture",
					validate: () => {
						throw new Error("schema violation");
					},
				},
				{ signal: new AbortController().signal },
			),
		(error: unknown) => {
			assert.ok(error instanceof PiDecisionError);
			assert.equal(error.kind, "validation_error");
			assert.equal(error.rawText, '{"value":"invalid"}');
			assert.ok(error.cause instanceof Error);
			return true;
		},
	);
	assert.equal(stopped, true);
});
