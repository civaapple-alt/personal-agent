/** Opt-in real-model evaluation; --summarize and --help never start a model. */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { PUBLICATION_REVIEW_GUIDANCE } from "../orchestrator/publication-review.ts";
import { TeamOrchestrator } from "../orchestrator/team-orchestrator.ts";
import { loadRoleTemplatesFromDir } from "../roles/template-loader.ts";
import type { ModelSelection } from "../rpc/model-selection.ts";
import { PiRpcWorker } from "../rpc/pi-rpc-worker.ts";
import { openPersonalAgentDatabase } from "../storage/database.ts";
import { PersonalAgentStore } from "../storage/repositories.ts";
import { selectDemoModel } from "./model-selection.ts";
import { REVIEW_SCENARIOS, type ReviewScenario } from "./publication-review-case.ts";
import {
	assessCollaboration,
	type ReviewToolTrace,
	specialistsBeforePublication,
} from "./publication-review-evidence.ts";
import { parseReviewOptions, type ReviewPlanItem, reviewDirectory, reviewPlan } from "./publication-review-options.ts";
import { qualityReviewTemplate, reviewHash } from "./publication-review-quality.ts";
import { optionalReviewText, type PublicationChecks, summarizeReview } from "./publication-review-report.ts";

type Templates = Awaited<ReturnType<typeof loadRoleTemplatesFromDir>>;
const outputPath = "deliverables/feedback-box-v3.md";

async function run(input: {
	root: string;
	item: ReviewPlanItem;
	scenario: ReviewScenario;
	templates: Templates;
	configurationHash: string;
	modelSelection: ModelSelection;
}) {
	const { item, scenario, templates } = input;
	const directory = join(input.root, reviewDirectory(item));
	const workspace = join(directory, "workspace");
	await mkdir(workspace, { recursive: true });
	for (const [path, content] of Object.entries(scenario.files)) {
		await mkdir(dirname(join(workspace, path)), { recursive: true });
		await writeFile(join(workspace, path), content, { flag: "wx" });
	}
	await promisify(execFile)("git", ["init", "-b", "main"], { cwd: workspace });
	const db = openPersonalAgentDatabase(join(directory, "proof.db"));
	const store = new PersonalAgentStore(db, { spacesDir: join(directory, "spaces") });
	store.updatePlatformSettings({ defaultModelSelection: input.modelSelection });
	const traces: ReviewToolTrace[] = [];
	const workerConfigurations: Array<{
		id: string;
		provider?: string;
		model?: string;
		thinkingLevel: ModelSelection["thinkingLevel"];
	}> = [];
	let sequence = 0;
	const orchestrator = new TeamOrchestrator({
		store,
		templates,
		defaultCwd: workspace,
		sessionDir: join(directory, "sessions"),
		workerFactory: (options) => {
			const memberId = options.env?.PA_MEMBER_ID ?? "unknown";
			const memberContext = options.env?.PA_MEMBER_CONTEXT ?? "";
			if (options.env?.PA_CAN_SAVE_SPACE === "true" && memberContext.split(PUBLICATION_REVIEW_GUIDANCE).length !== 2)
				throw new Error("Expected exactly one review-guidance block for a controlled comparison");
			const worker = new PiRpcWorker({
				...options,
				env: {
					...options.env,
					PA_MEMBER_CONTEXT:
						item.policy === "baseline" ? memberContext.replace(PUBLICATION_REVIEW_GUIDANCE, "") : memberContext,
				},
			});
			workerConfigurations.push({
				id: memberId,
				provider: options.provider,
				model: options.model,
				thinkingLevel: input.modelSelection.thinkingLevel,
			});
			worker.onEvent((event) => {
				if (event.type === "tool_execution_start")
					traces.push({
						memberId,
						toolName: String(event.toolName),
						toolCallId: String(event.toolCallId),
						args: event.args,
						started: ++sequence,
					});
				else if (event.type === "tool_execution_end") {
					const trace = traces.find((row) => row.memberId === memberId && row.toolCallId === event.toolCallId);
					if (trace) {
						trace.ended = ++sequence;
						trace.isError = event.isError === true;
					}
				}
			});
			return worker;
		},
	});
	try {
		const link = store.upsertWorkspace({ name: `合成复核案例 ${scenario.id}`, repoPath: workspace, orgId: null });
		const matter = store.createMatter({
			title: "发布前复核对照",
			workspaceId: link.id,
			leadMemberId: "product-manager",
			aiMemberIds: ["product-manager", "engineering-manager", "qa-manager"],
			observersEnabled: false,
		});
		store.spaces.ensureAllDefaultSpaces();
		const initial = await store.spaces.createDocument({
			spaceId: `spc_ws_${link.id}`,
			matterId: matter.id,
			title: scenario.title,
			content: scenario.files["deliverables/feedback-box-v1.md"] ?? "",
			actorId: "product-manager",
		});
		const second = await store.spaces.updateDocument(initial.id, {
			revision: initial.revision,
			title: scenario.title,
			content: scenario.files["deliverables/feedback-box-v2.md"] ?? "",
			actorId: "product-manager",
		});
		if (!second) throw new Error("Failed to seed the second document revision");
		const history = [initial, second];
		let result: Awaited<ReturnType<TeamOrchestrator["dispatchMatter"]>> | undefined;
		let error: string | null = null;
		try {
			console.log(`RUN ${scenario.id} repeat-${item.repetition} ${item.policy}`);
			result = await orchestrator.dispatchMatter({
				matterId: matter.id,
				prompt: scenario.prompt,
				timeoutMs: 240_000,
			});
		} catch (failure) {
			error = failure instanceof Error ? failure.message : String(failure);
		} finally {
			await orchestrator.shutdown();
		}
		const v3 = await optionalReviewText(join(workspace, outputPath));
		const fresh = store.spaces.listDocuments({ matterId: matter.id });
		const current = await store.spaces.getDocument(initial.id);
		const preserved = await Promise.all(
			history.map(async (old) => ({
				version: old.revision,
				fileUnchanged:
					(await optionalReviewText(join(workspace, `deliverables/feedback-box-v${old.revision}.md`))) ===
					old.content,
				indexUnchanged:
					(await store.spaces.getDocumentCommitDetail(old.id, old.headCommit))?.content === old.content,
			})),
		);
		const consulted = specialistsBeforePublication(traces, scenario.title);
		const fileSourceUsed = traces.some((trace) => {
			const args = trace.args;
			return (
				trace.memberId === "product-manager" &&
				trace.toolName === "save_space_page" &&
				trace.isError === false &&
				args !== null &&
				typeof args === "object" &&
				"title" in args &&
				args.title === scenario.title &&
				"sourcePath" in args &&
				typeof args.sourcePath === "string" &&
				!("content" in args) &&
				resolve(workspace, args.sourcePath) === join(workspace, outputPath)
			);
		});
		const checks: PublicationChecks = {
			executionSucceeded: !error && result?.runResult.aborted === false,
			historicalVersionsPreserved: preserved.every((row) => row.fileUnchanged && row.indexUnchanged),
			exactlyOneV3:
				fresh.length === 1 &&
				fresh[0]?.title === scenario.title &&
				fresh[0]?.id === initial.id &&
				fresh[0]?.revision === 3,
			fileSourceUsed,
			fileMatchesPublication: v3 !== null && fresh.length === 1 && current?.content === v3,
			noOutstandingLease: db.prepare("SELECT count(*) AS n FROM matter_execution_leases").get()?.n === 0,
		};
		const published = fresh.length === 1 && current?.revision === 3 ? current.content : null;
		if (published !== null) {
			await writeFile(join(directory, "published.md"), published, { flag: "wx" });
			await writeFile(
				join(directory, "quality-review.json"),
				JSON.stringify(qualityReviewTemplate(published, scenario.rubric), null, 2),
				{ flag: "wx" },
			);
		}
		const publication = { status: Object.values(checks).every(Boolean) ? "pass" : "fail", checks };
		const collaboration = assessCollaboration(scenario.collaboration, consulted);
		const quality = published === null ? "unavailable" : "pending";
		await writeFile(
			join(directory, "evidence.json"),
			JSON.stringify(
				{
					...item,
					inputHash: reviewHash(JSON.stringify(scenario)),
					configurationHash: input.configurationHash,
					error,
					workerConfigurations,
					checks,
					preserved,
					consulted,
					documentSha256: published === null ? null : reviewHash(published),
					documents: fresh,
					reply: result?.replyText,
					traces,
					internalMessages: store.listMessages(matter.id, "internal_collab"),
				},
				null,
				2,
			),
		);
		console.log(`${scenario.id}/${item.policy}: ${JSON.stringify({ publication, collaboration, quality })}`);
	} finally {
		await orchestrator.shutdown();
		db.close();
	}
}

async function main() {
	const options = parseReviewOptions(process.argv.slice(2));
	if (options.kind === "help") {
		console.log(
			"demo:review [--scenario autonomous|required|solo|all] [--repeat 1..10]\ndemo:review --summarize <evidence-directory>\nDefault: one autonomous pair. Run mode calls real models; summarize/help do not.\nExit: 0 = all layers reviewed and passed; 1 = failure; 2 = incomplete quality review.",
		);
		return;
	}
	if (options.kind === "summarize") {
		const summary = await summarizeReview(resolve(options.directory));
		console.log(JSON.stringify(summary, null, 2));
		process.exitCode = summary.exitCode;
		return;
	}
	const root = await mkdtemp(join(tmpdir(), "personal-agent-publication-review-"));
	const templates = await loadRoleTemplatesFromDir(resolve("roles"));
	const modelSelection = await selectDemoModel(root, { thinkingLevel: "off" });
	const scenarios = options.scenarioIds.map((id) => REVIEW_SCENARIOS[id]);
	const configuration = templates.map(({ id }) => ({ id, ...modelSelection }));
	const configurationHash = reviewHash(
		JSON.stringify({ templates, modelSelection, guidance: PUBLICATION_REVIEW_GUIDANCE }),
	);
	await writeFile(
		join(root, "case.json"),
		JSON.stringify(
			{
				schemaVersion: 2,
				createdAt: new Date().toISOString(),
				repeat: options.repeat,
				configuration,
				configurationHash,
				scenarios: scenarios.map((scenario) => ({ ...scenario, inputHash: reviewHash(JSON.stringify(scenario)) })),
				roleDefinitionsHash: reviewHash(JSON.stringify(templates)),
				guidanceHash: reviewHash(PUBLICATION_REVIEW_GUIDANCE),
				method:
					"Fresh isolated runs, alternate policy order between repeats, baseline removes only lead review guidance; no automatic semantic pass.",
			},
			null,
			2,
		),
	);
	const plan = reviewPlan(options.scenarioIds, options.repeat);
	console.log(
		`Evaluation evidence: ${root}\nPlanned real lead turns: ${plan.length}; colleague calls depend on scenario and model decisions.`,
	);
	for (const item of plan)
		await run({
			root,
			item,
			scenario: REVIEW_SCENARIOS[item.scenarioId],
			templates,
			modelSelection,
			configurationHash,
		});
	await writeFile(
		join(root, "review.md"),
		[
			"# 独立审阅说明",
			"",
			"先读 case.json 中的场景要求与 rubric，再读每轮的 published.md 和 evidence.json 中的实际协作记录。",
			"填写对应 quality-review.json：reviewer 写明审阅者，逐项 verdict 改为 pass/fail，附 explanation 及 evidence 数组，每条包含从 1 开始的 line 与该行完整原文 text。未审阅保持 pending。",
			"复核规则、验收及组合路径是否一致，同时记录新增问题；咨询次数与模型自评不作为质量通过依据。原始文件、发布快照、执行证据及哈希保持原样。",
			"完成后运行 npm run demo:review -- --summarize <本目录>，只刷新 summary.json/summary.md，不调用模型。不要把待审阅、无效引用或原文已变化的记录算作通过。",
		].join("\n"),
	);
	const summary = await summarizeReview(root);
	console.log(
		`Overall: ${summary.status.toUpperCase()}\n${JSON.stringify(summary.aggregates, null, 2)}\nIndependent review: ${join(root, "review.md")}`,
	);
	process.exitCode = summary.exitCode;
}
main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
