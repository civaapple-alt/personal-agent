import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TeamOrchestrator, type WorkerFactory } from "../orchestrator/team-orchestrator.ts";
import { isObserverSilentReply } from "../orchestrator/types.ts";
import type { RoleTemplate } from "../roles/types.ts";
import { PiRpcWorker } from "../rpc/pi-rpc-worker.ts";
import { openPersonalAgentDatabase } from "../storage/database.ts";
import { PersonalAgentStore } from "../storage/repositories.ts";
import type { Deliverable, MatterMessage } from "../storage/types.ts";
import { selectDemoModel } from "./model-selection.ts";
import {
	isControlledObserverProposal,
	OBSERVER_BRIEF,
	OBSERVER_DELIVERY_TITLE,
	OBSERVER_DEMO_ID,
	OBSERVER_RUBRIC,
	OBSERVER_STEPS,
	type ObserverStepId,
} from "./observer-case.ts";
import { summarizeObserver } from "./observer-evidence.ts";
import { qualityReviewTemplate, reviewHash } from "./publication-review-quality.ts";

interface WorkerRecord {
	id: string;
	stepId: ObserverStepId;
	memberId: string;
	mode: "lead" | "internal" | "observer";
	started: number;
	tools: string[];
	canPublish: boolean;
	canDelegate: boolean;
	canExperience: boolean;
	resumedSessionFile?: string;
}
type WorkerOutcome = { workerId: string; prompt: string; finished: number } & (
	| {
			status: "success";
			reply: string;
			aborted: boolean;
			sessionId: string;
			sessionFile?: string;
			tools: Array<{ name: string; isError: boolean }>;
	  }
	| { status: "failed"; error: string }
);
type StepOutcome = { stepId: ObserverStepId; matterId: string } & (
	| { status: "success"; reply: string; observerMessages: MatterMessage[]; deliverable: Deliverable | null }
	| { status: "failed"; error: string }
);
const seed =
	"# 旁听演示工作区\n这是虚构的反馈箱设计讨论，仅在本工作区读取资料。没有应用实现或试用，不编码、不部署、不读取其他仓库。业务约束以对话中明确的信息为准。\n";

/** Real workers by default. Tests replace only the model, retaining the shipped orchestrator/bridge/store. */
export async function runObserverSmoke(input: {
	directory: string;
	templates: RoleTemplate[];
	workerFactory?: WorkerFactory;
}) {
	const workspace = join(input.directory, "workspace");
	await mkdir(workspace, { recursive: true });
	await writeFile(join(workspace, "README.md"), seed, { flag: "wx" });
	const db = openPersonalAgentDatabase(join(input.directory, "proof.db"));
	const store = new PersonalAgentStore(db);
	if (!input.workerFactory)
		store.updatePlatformSettings({
			defaultModelSelection: await selectDemoModel(workspace, { thinkingLevel: "off" }),
		});
	const workers: WorkerRecord[] = [];
	const outcomes: WorkerOutcome[] = [];
	const steps: StepOutcome[] = [];
	let currentStep: ObserverStepId = "brief";
	let order = 0;
	const orchestrator = new TeamOrchestrator({
		store,
		templates: input.templates.map((template) => ({ ...template, tools: ["read"] })),
		defaultCwd: workspace,
		sessionDir: join(input.directory, "sessions"),
		workerFactory: (options) => {
			const worker = input.workerFactory?.(options) ?? new PiRpcWorker(options);
			const toolsIndex = options.args?.indexOf("--tools") ?? -1;
			const record: WorkerRecord = {
				id: randomUUID(),
				stepId: currentStep,
				memberId: options.env?.PA_MEMBER_ID ?? "unknown",
				mode:
					options.env?.PA_CAN_PUBLISH === "true"
						? "lead"
						: options.env?.PA_CAN_DELEGATE === "true"
							? "internal"
							: "observer",
				started: ++order,
				tools: toolsIndex < 0 ? [] : (options.args?.[toolsIndex + 1]?.split(",") ?? []),
				canPublish: options.env?.PA_CAN_PUBLISH === "true",
				canDelegate: options.env?.PA_CAN_DELEGATE === "true",
				canExperience: options.env?.PA_CAN_EXPERIENCE === "true",
				resumedSessionFile: options.sessionFile,
			};
			workers.push(record);
			return {
				start: worker.start.bind(worker),
				stop: worker.stop.bind(worker),
				getState: worker.getState.bind(worker),
				onNotice: worker.onNotice.bind(worker),
				setDialogHandler: worker.setDialogHandler.bind(worker),
				onEvent: worker.onEvent?.bind(worker),
				abort: worker.abort?.bind(worker),
				setThinkingLevel: worker.setThinkingLevel?.bind(worker),
				suspendIdleTimeout: worker.suspendIdleTimeout?.bind(worker),
				async runPromptAndWait(prompt, options) {
					try {
						const result = await worker.runPromptAndWait(prompt, options);
						const state = await worker.getState();
						outcomes.push({
							workerId: record.id,
							prompt,
							finished: ++order,
							status: "success",
							reply: result.assistantText,
							aborted: result.aborted,
							sessionId: state.sessionId,
							sessionFile: state.sessionFile,
							tools: result.toolExecutions.map((tool) => ({ name: tool.toolName, isError: tool.isError })),
						});
						return result;
					} catch (error) {
						outcomes.push({
							workerId: record.id,
							prompt,
							finished: ++order,
							status: "failed",
							error: error instanceof Error ? error.message : String(error),
						});
						throw error;
					}
				},
			};
		},
	});
	try {
		const link = store.upsertWorkspace({ name: "旁听功能隔离验证", repoPath: workspace, orgId: null });
		const roster = ["product-manager", "qa-manager", "engineering-manager"];
		const riskMatter = store.createMatter({
			title: "删除恢复设计讨论",
			workspaceId: link.id,
			leadMemberId: "product-manager",
			aiMemberIds: roster,
			observersEnabled: false,
		});
		const quietMatter = store.createMatter({
			title: "轻量通知修订",
			workspaceId: link.id,
			leadMemberId: "product-manager",
			aiMemberIds: roster,
			observerMemberIds: ["qa-manager"],
		});
		for (const step of OBSERVER_STEPS) {
			currentStep = step.id;
			if (step.id === "risk") store.updateMatterObservers(riskMatter.id, ["qa-manager"]);
			if (step.id === "disabled") store.updateMatterObserversEnabled(quietMatter.id, false);
			const matterId = step.matter === "risk" ? riskMatter.id : quietMatter.id;
			console.log(`RUN ${step.id}: ${step.label}`);
			try {
				const result = await orchestrator.dispatchMatter({ matterId, prompt: step.prompt, timeoutMs: 180_000 });
				steps.push({
					stepId: step.id,
					matterId,
					status: "success",
					reply: result.replyText,
					observerMessages: result.observerMessages ?? [],
					deliverable: result.deliverable,
				});
				console.log(
					`  lead replied; observer messages=${result.observerMessages?.length ?? 0}; deliveries=${result.deliverable ? 1 : 0}`,
				);
			} catch (error) {
				steps.push({
					stepId: step.id,
					matterId,
					status: "failed",
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		await orchestrator.shutdown();
		const observerWorkers = workers.filter((worker) => worker.mode === "observer");
		const completed = (stepId: ObserverStepId, mode: WorkerRecord["mode"]) => {
			const worker = workers.find((worker) => worker.stepId === stepId && worker.mode === mode);
			const outcome = outcomes.find((row) => row.workerId === worker?.id);
			return outcome?.status === "success" ? outcome : null;
		};
		const risk = steps.find((step) => step.stepId === "risk");
		const revision = steps.find((step) => step.stepId === "revise");
		const riskObserver = completed("risk", "observer");
		const revisionObserver = completed("revise", "observer");
		const quietObserver = completed("quiet", "observer");
		const quietLead = completed("quiet", "lead");
		const riskLead = completed("risk", "lead");
		const deliveries = store.listDeliverables();
		const allMessages = [...store.listMessages(riskMatter.id), ...store.listMessages(quietMatter.id)];
		const checks = {
			executionSucceeded:
				steps.every((step) => step.status === "success") &&
				workers.length === outcomes.length &&
				outcomes.every((row) => row.status === "success" && !row.aborted && row.reply.trim().length > 0) &&
				!allMessages.some((msg) => msg.metadata?.observerFailed),
			selectedRosterOnly:
				workers.length === 8 &&
				observerWorkers.length === 3 &&
				workers.every((worker) =>
					worker.mode === "lead"
						? worker.memberId === "product-manager"
						: worker.mode === "observer" && worker.memberId === "qa-manager",
				) &&
				observerWorkers.every((worker) => ["risk", "revise", "quiet"].includes(worker.stepId)),
			lateJoinContext: riskObserver?.prompt.includes(OBSERVER_BRIEF) === true,
			feedbackReachedLead:
				riskObserver !== null &&
				!isObserverSilentReply(riskObserver.reply) &&
				completed("revise", "lead")?.prompt.includes(riskObserver.reply.trim()) === true,
			observerSessionScopes:
				riskObserver !== null &&
				revisionObserver !== null &&
				quietObserver !== null &&
				quietLead !== null &&
				riskLead !== null &&
				riskObserver.sessionId === revisionObserver.sessionId &&
				riskObserver.sessionId !== quietObserver.sessionId &&
				riskObserver.sessionId !== riskLead.sessionId &&
				quietObserver.sessionId !== quietLead.sessionId,
			observerLoadout:
				observerWorkers.length === 3 &&
				observerWorkers.every(
					(worker) =>
						worker.tools.length === 2 &&
						worker.tools.includes("read") &&
						worker.tools.includes("read_pa_help") &&
						!worker.canPublish &&
						!worker.canDelegate &&
						!worker.canExperience,
				) &&
				observerWorkers.every((worker) => {
					const outcome = outcomes.find((row) => row.workerId === worker.id);
					return outcome?.status === "success" && outcome.tools.every((tool) => worker.tools.includes(tool.name));
				}),
			leadBeforeObserver:
				observerWorkers.length === 3 &&
				observerWorkers.every((worker) => {
					const lead = completed(worker.stepId, "lead");
					return lead !== null && lead.finished < worker.started;
				}),
			onlyLeadDelivery:
				deliveries.length === 1 &&
				deliveries[0]?.memberId === "product-manager" &&
				deliveries[0]?.title === OBSERVER_DELIVERY_TITLE &&
				deliveries[0]?.version === 1 &&
				revision?.status === "success" &&
				revision.deliverable?.id === deliveries[0].id &&
				steps.every((step) => step.status === "success" && (step.stepId === "revise" || step.deliverable === null)),
			workspacePreserved: (await readFile(join(workspace, "README.md"), "utf8")) === seed,
			noOutstandingLease: db.prepare("SELECT count(*) AS n FROM matter_execution_leases").get()?.n === 0,
		};
		const behavior = {
			controlledRiskInput: risk?.status === "success" && isControlledObserverProposal(risk.reply),
			riskIntervened:
				riskObserver !== null &&
				!isObserverSilentReply(riskObserver.reply) &&
				risk?.status === "success" &&
				risk.observerMessages.length === 1 &&
				risk.observerMessages[0]?.metadata?.observerIntervention === true,
			quietStayedSilent:
				quietObserver !== null &&
				quietObserver.reply.trim().length > 0 &&
				isObserverSilentReply(quietObserver.reply) &&
				steps.some(
					(step) => step.stepId === "quiet" && step.status === "success" && step.observerMessages.length === 0,
				),
			disabledStayedOff:
				!observerWorkers.some((worker) => worker.stepId === "brief" || worker.stepId === "disabled") &&
				steps.some(
					(step) => step.stepId === "disabled" && step.status === "success" && step.observerMessages.length === 0,
				),
		};
		const transcript = [
			"# 旁听演示对话快照",
			"",
			"这是受控的虚构设计任务；风险回合要求主负责人只记录提案，不代表自然任务中负责人必然遗漏风险。",
			"",
			...steps.flatMap((step) => {
				const definition = OBSERVER_STEPS.find((row) => row.id === step.stepId);
				return [
					`## ${step.stepId}`,
					"",
					`用户：${definition?.prompt ?? ""}`,
					"",
					step.status === "failed" ? `执行失败：${step.error}` : `负责人：${step.reply}`,
					"",
					...workers
						.filter((worker) => worker.stepId === step.stepId && worker.mode === "observer")
						.flatMap((worker) => {
							const outcome = outcomes.find((row) => row.workerId === worker.id);
							return [
								`旁听 ${worker.memberId}：${outcome?.status === "success" ? outcome.reply : "评估未成功完成"}`,
								"",
							];
						}),
				];
			}),
			"## 正式阶段成果",
			"",
			...deliveries.flatMap((delivery) => [
				`${delivery.title} V${delivery.version}，发布者 ${delivery.memberId}`,
				"",
				delivery.contentOrPath,
				"",
			]),
		].join("\n");
		await writeFile(join(input.directory, "transcript.md"), transcript, { flag: "wx" });
		await writeFile(
			join(input.directory, "quality-review.json"),
			JSON.stringify(qualityReviewTemplate(transcript, OBSERVER_RUBRIC), null, 2),
			{ flag: "wx" },
		);
		await writeFile(
			join(input.directory, "evidence.json"),
			JSON.stringify(
				{
					schemaVersion: 1,
					caseId: OBSERVER_DEMO_ID,
					checks,
					behavior,
					workers,
					outcomes,
					steps,
					deliveries,
					rubric: OBSERVER_RUBRIC,
					transcriptSha256: reviewHash(transcript),
					notices: allMessages.filter((message) => message.channel === "notice"),
				},
				null,
				2,
			),
		);
		return await summarizeObserver(input.directory);
	} finally {
		await orchestrator.shutdown();
		db.close();
	}
}
