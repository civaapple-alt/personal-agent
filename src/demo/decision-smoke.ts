import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
	assessMatterInitiationWithModel,
	designRoleDraftWithModel,
	loadRoleTemplatesFromDir,
	openPersonalAgentDatabase,
	PersonalAgentStore,
	PiDecisionError,
} from "../index.ts";
import { defaultWorkerFactory } from "../orchestrator/types.ts";

interface DecisionCheckRecord {
	id: string;
	kind: "initiation_decision" | "role_design";
	passed: boolean;
	durationMs: number;
	summary: string;
	detail: unknown;
	error?: string;
}

async function runDecisionSmoke(options: { provider?: string; model?: string; directory: string }) {
	const dbPath = join(options.directory, "agent.db");
	const sampleRepo = join(options.directory, "sample-repo");
	mkdirSync(sampleRepo, { recursive: true });
	writeFileSync(
		join(sampleRepo, "package.json"),
		JSON.stringify({ name: "order-service", version: "1.0.0", scripts: { test: "node --test" } }, null, 2),
	);
	writeFileSync(
		join(sampleRepo, "README.md"),
		"# order-service\nNode.js HTTP order and refund service. Critical paths: refund calculation & idempotency ledger.\n",
	);

	const db = openPersonalAgentDatabase(dbPath);
	const store = new PersonalAgentStore(db);
	const templates = await loadRoleTemplatesFromDir(resolve("roles"));
	const templatesMap = new Map(templates.map((t) => [t.id, t]));
	const seededMembers = templates.map((t) =>
		store.upsertMember({
			id: t.id,
			templateId: t.id,
			displayName: t.name,
			roleTitle: t.title,
			isPrimaryContact: t.isPrimaryContact,
			provider: options.provider ?? t.defaultProvider,
			model: options.model ?? t.defaultModel,
			thinkingLevel: t.thinkingLevel,
			keywords: t.keywords,
		}),
	);

	const records: DecisionCheckRecord[] = [];
	const ac = new AbortController();

	// Scenario 1: Human alignment first
	{
		const started = Date.now();
		try {
			const res = await assessMatterInitiationWithModel(
				{
					defaultCwd: options.directory,
					workerFactory: defaultWorkerFactory,
					members: seededMembers,
					templatesByRoleId: templatesMap,
				},
				{
					prompt: "大家先讨论对齐一下：下个季度重点做个人经验沉淀，还是先扩展多人局域网协同体验？先不要改代码。",
					signal: ac.signal,
				},
			);
			const passed = res.assessmentSource === "model" && res.recommendedMode === "human_first";
			records.push({
				id: "initiation_human_first",
				kind: "initiation_decision",
				passed,
				durationMs: Date.now() - started,
				summary: `mode=${res.recommendedMode}, confidence=${res.confidence}, lead=${res.recommendedLeadId}`,
				detail: res,
			});
		} catch (err) {
			records.push({
				id: "initiation_human_first",
				kind: "initiation_decision",
				passed: false,
				durationMs: Date.now() - started,
				summary: "failed",
				detail: err instanceof PiDecisionError ? { kind: err.kind, rawText: err.rawText } : String(err),
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	// Scenario 2: Legal contract review gap even when PM explicitly states non-responsibility
	{
		const started = Date.now();
		const negativeTemplates = new Map(templatesMap);
		const pm = negativeTemplates.get("product-manager");
		if (pm) {
			negativeTemplates.set("product-manager", {
				...pm,
				sections: {
					...pm.sections,
					responsibilitiesAndBoundaries: `${pm.sections.responsibilitiesAndBoundaries}\n- 不负责：商业合同法务条款审核与合规签署`,
				},
			});
		}
		try {
			const res = await assessMatterInitiationWithModel(
				{
					defaultCwd: options.directory,
					workerFactory: defaultWorkerFactory,
					members: seededMembers,
					templatesByRoleId: negativeTemplates,
				},
				{
					prompt: "请逐条审核这份客户合作协议里的合同违约责任、商业赔偿上限和知识产权合规风险。",
					signal: ac.signal,
				},
			);
			const passed = res.assessmentSource === "model" && res.fitStatus === "gap_detected";
			records.push({
				id: "initiation_gap_with_negative",
				kind: "initiation_decision",
				passed,
				durationMs: Date.now() - started,
				summary: `fitStatus=${res.fitStatus}, gap=${res.gapSuggestion?.missingRoleTitle ?? "none"}, mode=${res.recommendedMode}`,
				detail: res,
			});
		} catch (err) {
			records.push({
				id: "initiation_gap_with_negative",
				kind: "initiation_decision",
				passed: false,
				durationMs: Date.now() - started,
				summary: "failed",
				detail: err instanceof PiDecisionError ? { kind: err.kind, rawText: err.rawText } : String(err),
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	// Scenario 3: Repo-bound engineering + QA review decision with readRepo: true
	{
		const started = Date.now();
		try {
			const res = await assessMatterInitiationWithModel(
				{
					defaultCwd: options.directory,
					workerFactory: defaultWorkerFactory,
					members: seededMembers,
					templatesByRoleId: templatesMap,
				},
				{
					prompt:
						"请先读取仓库 README.md 与 package.json，再判断由谁负责以下工作：在 order-service 中新增退款幂等接口实现，并补充关键边界回归测试验证。",
					workspacePath: sampleRepo,
					workspaceName: "order-service",
					readRepo: true,
					signal: ac.signal,
				},
			);
			const passed =
				res.assessmentSource === "model" &&
				res.usedRepoRead === true &&
				res.repoReadPaths?.includes("README.md") === true &&
				res.repoReadPaths?.includes("package.json") === true &&
				res.recommendedLeadId === "engineering-manager" &&
				(res.recommendedMode === "lead_review" || res.recommendedMode === "lead_consult");
			records.push({
				id: "initiation_repo_read",
				kind: "initiation_decision",
				passed,
				durationMs: Date.now() - started,
				summary: `mode=${res.recommendedMode}, lead=${res.recommendedLeadId}, ai=${res.recommendedAiMemberIds.join(",")}, obs=${res.recommendedObserverIds.join(",")}`,
				detail: res,
			});
		} catch (err) {
			records.push({
				id: "initiation_repo_read",
				kind: "initiation_decision",
				passed: false,
				durationMs: Date.now() - started,
				summary: "failed",
				detail: err instanceof PiDecisionError ? { kind: err.kind, rawText: err.rawText } : String(err),
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	// Scenario 4: AI Typed Role Designer
	{
		const started = Date.now();
		try {
			const draft = await designRoleDraftWithModel(
				{
					defaultCwd: options.directory,
					workerFactory: defaultWorkerFactory,
					members: seededMembers,
					templatesByRoleId: templatesMap,
				},
				{
					oneJob: "每次版本上线前核查 CI 结果、版本号、CHANGELOG 同步与回滚预案，不直接修改业务代码。",
					workspaceScope: "read_only_repo",
					signal: ac.signal,
				},
			);
			const passed =
				draft.designSource === "model" &&
				draft.verificationPlanState === "specified" &&
				draft.template.id.length > 0 &&
				draft.template.name.length <= 16 &&
				draft.antiJobs.length > 0;
			records.push({
				id: "role_designer",
				kind: "role_design",
				passed,
				durationMs: Date.now() - started,
				summary: `id=${draft.template.id}, name=${draft.template.name}, title=${draft.template.title}, skills=[${draft.template.skills.join(",")}]`,
				detail: draft,
			});
		} catch (err) {
			records.push({
				id: "role_designer",
				kind: "role_design",
				passed: false,
				durationMs: Date.now() - started,
				summary: "failed",
				detail: err instanceof PiDecisionError ? { kind: err.kind, rawText: err.rawText } : String(err),
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	db.close();
	const report = {
		generatedAt: new Date().toISOString(),
		directory: options.directory,
		allPassed: records.every((r) => r.passed),
		records,
	};
	writeFileSync(join(options.directory, "decision-report.json"), JSON.stringify(report, null, 2));
	return report;
}

async function main() {
	const { values } = parseArgs({
		options: {
			help: { type: "boolean" },
			provider: { type: "string" },
			model: { type: "string" },
		},
		strict: true,
		allowPositionals: false,
	});
	if (values.help) {
		console.log(
			"demo:decision: exercises real Pi LLM typed decision APIs (initiation formation + AI role designer) in an isolated temp workspace.\n--help calls no model.\nOptions:\n  --provider <id>  Override Pi provider\n  --model <id>     Override Pi model",
		);
		return;
	}
	const directory = mkdtempSync(join(tmpdir(), "personal-agent-decision-"));
	console.log(`Isolated decision evidence: ${directory}`);
	const report = await runDecisionSmoke({
		directory,
		provider: values.provider,
		model: values.model,
	});
	console.log(
		JSON.stringify(
			{
				directory: report.directory,
				allPassed: report.allPassed,
				results: report.records.map(({ id, kind, passed, durationMs, summary, error }) => ({
					id,
					kind,
					passed,
					durationMs,
					summary,
					...(error ? { error } : {}),
				})),
			},
			null,
			2,
		),
	);
	process.exitCode = report.allPassed ? 0 : 1;
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
