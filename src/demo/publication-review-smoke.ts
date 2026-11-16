/** Opt-in real-model paired evaluation, with an explicit manual quality rubric. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { PUBLICATION_REVIEW_GUIDANCE } from "../orchestrator/publication-review.ts";
import { TeamOrchestrator } from "../orchestrator/team-orchestrator.ts";
import { loadRoleTemplatesFromDir } from "../roles/template-loader.ts";
import { PiRpcWorker } from "../rpc/pi-rpc-worker.ts";
import { openPersonalAgentDatabase } from "../storage/database.ts";
import { PersonalAgentStore } from "../storage/repositories.ts";
import { PUBLICATION_REVIEW_CASE, PUBLICATION_REVIEW_RUBRIC } from "./publication-review-case.ts";
import { type ReviewToolTrace, specialistsBeforePublication } from "./publication-review-evidence.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const root = await mkdtemp(join(tmpdir(), "personal-agent-publication-review-"));
console.log(`Paired evaluation evidence: ${root}`);
const templates = (await loadRoleTemplatesFromDir(resolve("roles"))).map((template) => ({
	...template,
	thinkingLevel: "off" as const,
}));
const configuration = templates.map(({ id, defaultProvider, defaultModel, thinkingLevel }) => ({
	id,
	provider: defaultProvider,
	model: defaultModel,
	thinkingLevel,
}));
await writeFile(
	join(root, "case.json"),
	JSON.stringify(
		{
			...PUBLICATION_REVIEW_CASE,
			inputHash: hash(JSON.stringify(PUBLICATION_REVIEW_CASE)),
			configuration,
			roleDefinitionsHash: hash(JSON.stringify(templates)),
			guidanceHash: hash(PUBLICATION_REVIEW_GUIDANCE),
			rubric: PUBLICATION_REVIEW_RUBRIC,
			method: "Fresh isolated runs; baseline removes only the new lead guidance. No semantic auto-pass.",
		},
		null,
		2,
	),
);

async function run(policy: "baseline" | "current") {
	const directory = join(root, policy);
	const workspace = join(directory, "workspace");
	await mkdir(workspace, { recursive: true });
	for (const [path, content] of Object.entries(PUBLICATION_REVIEW_CASE.files)) {
		await mkdir(dirname(join(workspace, path)), { recursive: true });
		await writeFile(join(workspace, path), content, { flag: "wx" });
	}
	await promisify(execFile)("git", ["init", "-b", "main"], { cwd: workspace });
	const db = openPersonalAgentDatabase(join(directory, "proof.db"));
	const store = new PersonalAgentStore(db);
	const traces: ReviewToolTrace[] = [];
	const workerConfigurations: Array<{ id: string; provider?: string; model?: string; thinkingLevel: "off" }> = [];
	let sequence = 0;
	const orchestrator = new TeamOrchestrator({
		store,
		templates,
		defaultCwd: workspace,
		sessionDir: join(directory, "sessions"),
		workerFactory: (options) => {
			const memberId = options.env?.PA_MEMBER_ID ?? "unknown";
			const memberContext = options.env?.PA_MEMBER_CONTEXT ?? "";
			const worker = new PiRpcWorker({
				...options,
				env: {
					...options.env,
					PA_MEMBER_CONTEXT:
						policy === "baseline" ? memberContext.replace(PUBLICATION_REVIEW_GUIDANCE, "") : memberContext,
				},
			});
			workerConfigurations.push({
				id: memberId,
				provider: options.provider,
				model: options.model,
				thinkingLevel: "off",
			});
			worker.onEvent((event) => {
				if (event.type === "tool_execution_start") {
					traces.push({
						memberId,
						toolName: String(event.toolName),
						toolCallId: String(event.toolCallId),
						args: event.args,
						started: ++sequence,
					});
				} else if (event.type === "tool_execution_end") {
					const trace = traces.find((item) => item.memberId === memberId && item.toolCallId === event.toolCallId);
					if (trace) {
						trace.ended = ++sequence;
						trace.isError = event.isError === true;
					}
				}
			});
			return worker;
		},
	});
	const link = store.upsertWorkspace({ name: "合成设计复核案例", repoPath: workspace, orgId: null });
	const matter = store.createMatter({
		title: "发布前复核对照",
		workspaceId: link.id,
		leadMemberId: "product-manager",
		aiMemberIds: ["product-manager", "engineering-manager", "qa-manager"],
		observersEnabled: false,
	});
	// These two historical records are explicitly seeded inputs, not model-generated evidence.
	const history = store.recordDeliverables(
		([1, 2] as const).map((version) => ({
			matterId: matter.id,
			memberId: "product-manager",
			type: "document",
			title: PUBLICATION_REVIEW_CASE.title,
			contentOrPath: PUBLICATION_REVIEW_CASE.files[`deliverables/feedback-box-v${version}.md`],
			summary: "合成验证输入，不是本次模型产出",
		})),
	);
	let result: Awaited<ReturnType<TeamOrchestrator["dispatchMatter"]>> | undefined;
	let error: string | null = null;
	try {
		console.log(`RUN ${policy}`);
		result = await orchestrator.dispatchMatter({
			matterId: matter.id,
			prompt: PUBLICATION_REVIEW_CASE.prompt,
			timeoutMs: 240_000,
		});
	} catch (failure) {
		error = failure instanceof Error ? failure.message : String(failure);
	} finally {
		await orchestrator.shutdown();
	}
	try {
		const getV3 = async () => {
			try {
				return await readFile(join(workspace, "deliverables/feedback-box-v3.md"), "utf8");
			} catch (failure) {
				if (failure instanceof Error && "code" in failure && failure.code === "ENOENT") return null;
				throw failure;
			}
		};
		const v3 = await getV3();
		const deliveries = store.listDeliverables(matter.id);
		const fresh = deliveries.filter((delivery) => !history.some((old) => old.id === delivery.id));
		const preserved = await Promise.all(
			history.map(async (old) => ({
				version: old.version,
				fileUnchanged:
					hash(await readFile(join(workspace, `deliverables/feedback-box-v${old.version}.md`), "utf8")) ===
					hash(old.contentOrPath),
				indexUnchanged: store.getDeliverable(old.id)?.contentOrPath === old.contentOrPath,
			})),
		);
		const consulted = specialistsBeforePublication(traces);
		const fileSourceUsed = traces.some((trace) => {
			const args = trace.args;
			return (
				trace.memberId === "product-manager" &&
				trace.toolName === "publish_deliverable" &&
				trace.isError === false &&
				args !== null &&
				typeof args === "object" &&
				"sourcePath" in args &&
				typeof args.sourcePath === "string" &&
				!("content" in args) &&
				resolve(workspace, args.sourcePath) === join(workspace, "deliverables/feedback-box-v3.md")
			);
		});
		const checks = {
			executionSucceeded: !error && result?.runResult.aborted === false,
			historicalVersionsPreserved: preserved.every((item) => item.fileUnchanged && item.indexUnchanged),
			exactlyOneV3:
				fresh.length === 1 && fresh[0]?.title === PUBLICATION_REVIEW_CASE.title && fresh[0]?.version === 3,
			fileSourceUsed,
			fileMatchesPublication: v3 !== null && fresh.length === 1 && fresh[0]?.contentOrPath === v3,
			specialistsBeforePublication: ["engineering-manager", "qa-manager"].every((id) => consulted.includes(id)),
			noOutstandingLease: db.prepare("SELECT count(*) AS n FROM matter_execution_leases").get()?.n === 0,
		};
		const report = {
			policy,
			error,
			workerConfigurations,
			checks,
			preserved,
			consulted,
			quality: "UNREVIEWED: apply rubric to full V3, not to the presence of these records",
			deliverables: fresh,
			reply: result?.replyText,
			traces,
			internalMessages: store.listMessages(matter.id, "internal_collab"),
		};
		await writeFile(join(directory, "evidence.json"), JSON.stringify(report, null, 2));
		console.log(`${policy}: ${JSON.stringify(checks)}`);
		return { policy, checks, error };
	} finally {
		db.close();
	}
}

const outcomes = [];
for (const policy of ["baseline", "current"] as const) outcomes.push(await run(policy));
await writeFile(join(root, "comparison.json"), JSON.stringify(outcomes, null, 2));
await writeFile(
	join(root, "review.md"),
	[
		"# 发布前复核对照：待独立审阅",
		"",
		"两组使用相同输入、岗位定义、模型配置和新会话，仅负责人复核方法不同。单次配对存在模型随机性，不能证明稳定提升。",
		"基线/当前组的 V1/V2 都为合成输入。comparison.json 只记录流程事实，质量结论须逐项引用完整 V3 及实际协作内容。",
		"",
		"| 项目 | 基线及依据 | 当前及依据 |",
		"| --- | --- | --- |",
		...PUBLICATION_REVIEW_RUBRIC.map((item) => `| ${item.id}: ${item.question} | 待审阅 | 待审阅 |`),
		"",
		"检查协作任务是否指出具体矛盾，最终正文是否落实澄清，而不是只声称咨询完成。检查文件/发布正文一致性和历史保留。",
	].join("\n"),
);
if (
	outcomes.some((outcome) => !outcome.checks.executionSucceeded) ||
	outcomes.some((outcome) => outcome.policy === "current" && Object.values(outcome.checks).some((passed) => !passed))
)
	process.exitCode = 1;
console.log(`Review full output with rubric: ${join(root, "review.md")}`);
