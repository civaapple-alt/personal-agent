import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import {
	isControlledObserverProposal,
	OBSERVER_BRIEF,
	OBSERVER_DELIVERY_TITLE,
	OBSERVER_PROPOSAL,
} from "../packages/server/src/demo/observer-case.ts";
import { summarizeObserver } from "../packages/server/src/demo/observer-evidence.ts";
import { runObserverSmoke } from "../packages/server/src/demo/observer-runner.ts";
import { loadRoleTemplatesFromDir } from "../packages/server/src/roles/template-loader.ts";
import type { PromptRunResult } from "../packages/server/src/rpc/pi-rpc-worker.ts";
import { invokeTool, reportReady } from "./worker-helpers.ts";

const alert = "现有约束要求7天可恢复且保留全部来源。永久清空与之冲突；建议软删除、保留来源快照并验证恢复后来源一致。";
const plan =
	"# 删除恢复设计\n软删除后7天内可以恢复，保留原始来源。验收：恢复后内容和来源一致，超过期限另行明确策略。仅设计未实现。";

test("controlled risk input permits recording wrappers but rejects changed text or an added assessment", () => {
	assert.equal(isControlledObserverProposal(OBSERVER_PROPOSAL), true);
	assert.equal(isControlledObserverProposal(`已原样记录：\n\n「${OBSERVER_PROPOSAL}」`), true);
	assert.equal(isControlledObserverProposal(`已记录：“${OBSERVER_PROPOSAL}”`), true);
	assert.equal(isControlledObserverProposal(`${OBSERVER_PROPOSAL}\n但需要保留7天恢复。`), false);
	assert.equal(isControlledObserverProposal(OBSERVER_PROPOSAL.replace("永久", "临时")), false);
	assert.equal(isControlledObserverProposal(`「${OBSERVER_PROPOSAL}」\n已经评审通过`), false);
});

async function runFixture(t: test.TestContext, fault: "none" | "empty" | "failed" = "none") {
	const directory = await mkdtemp(join(tmpdir(), "pa-observer-demo-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	let leadCount = 0;
	let workerCount = 0;
	const tokens: string[] = [];
	const summary = await runObserverSmoke({
		directory,
		templates: await loadRoleTemplatesFromDir(resolve("roles")),
		workerFactory: (options) => {
			workerCount++;
			const sessionFile = options.sessionFile ?? join(options.sessionDir!, `${randomUUID()}.jsonl`);
			const sessionId = basename(sessionFile).replace(/\.jsonl$/, "");
			if (options.env?.PA_TEAM_BRIDGE_TOKEN) tokens.push(options.env.PA_TEAM_BRIDGE_TOKEN);
			return {
				async start() {
					await mkdir(options.sessionDir!, { recursive: true });
					if (!options.sessionFile)
						await writeFile(
							sessionFile,
							`${JSON.stringify({ type: "session", id: sessionId, cwd: options.cwd })}\n`,
						);
					await reportReady(options);
				},
				async stop() {},
				async getState() {
					return { sessionId, sessionFile };
				},
				onNotice: () => () => {},
				setDialogHandler() {},
				async runPromptAndWait(prompt): Promise<PromptRunResult> {
					let reply: string;
					const tools: PromptRunResult["toolExecutions"] = [];
					if (options.env?.PA_CAN_SAVE_SPACE === "true") {
						leadCount++;
						if (leadCount === 1) reply = OBSERVER_BRIEF;
						else if (leadCount === 2) reply = OBSERVER_PROPOSAL;
						else if (leadCount === 3) {
							assert.ok(
								prompt.includes(alert),
								"real stored observer intervention must enter the lead continuation prompt",
							);
							const args = {
								type: "document",
								title: OBSERVER_DELIVERY_TITLE,
								content: plan,
								changeNote: "采纳旁听补充的设计阶段方案",
							};
							await invokeTool(options, "save_space_page", args);
							tools.push({ toolCallId: randomUUID(), toolName: "save_space_page", args, isError: false });
							reply = plan;
						} else reply = leadCount === 4 ? "5人小组由负责人手动录入反馈。" : "已确认，无新增需求。";
					} else {
						assert.equal(
							options.args?.some((arg) => arg.endsWith("pi-extensions/delegation/index.ts")),
							false,
						);
						assert.equal(
							options.args?.some((arg) => arg.endsWith("pa-extensions/skill-capture/pi/index.ts")),
							false,
						);
						if (leadCount === 2) {
							assert.ok(
								prompt.includes(OBSERVER_BRIEF),
								"late observer receives prior brief, not only the latest proposal",
							);
							await assert.rejects(
								invokeTool(options, "save_space_page", {
									type: "document",
									title: "forbidden",
									content: "旁听不能发布",
									changeNote: "权限反例",
								}),
								/Only the matter lead/,
							);
							await assert.rejects(
								invokeTool(options, "delegate_to_member", {
									memberId: "engineering-manager",
									task: "forbidden",
								}),
								/cannot delegate/,
							);
							reply = alert;
						} else if (leadCount === 4 && fault === "failed")
							throw new Error("Controlled observer transport failure");
						else reply = leadCount === 4 && fault === "empty" ? "" : "[SILENT]";
					}
					return {
						disposition: "started",
						aborted: false,
						assistantText: reply,
						assistantMessages: [],
						toolExecutions: tools,
						notices: [],
						dialogs: [],
						events: [],
					};
				},
			};
		},
	});
	return { directory, summary, workerCount, tokens };
}

test("observer demo exercises selected late joining, real bridge restrictions, feedback, scoped sessions and off/silent paths", async (t) => {
	const f = await runFixture(t);
	assert.equal(f.workerCount, 8);
	assert.ok(Object.values(f.summary.runtime.checks).every((value) => value === true));
	assert.ok(Object.values(f.summary.behavior.checks).every((value) => value === true));
	assert.equal(f.summary.quality.status, "pending");
	assert.equal(f.summary.exitCode, 2);
	const evidence = await readFile(join(f.directory, "evidence.json"), "utf8");
	assert.ok(
		f.tokens.every((token) => !evidence.includes(token)),
		"do not archive bridge credentials",
	);
	const transcript = await readFile(join(f.directory, "transcript.md"), "utf8");
	const lines = transcript.split("\n");
	const review = JSON.parse(await readFile(join(f.directory, "quality-review.json"), "utf8"));
	const line = lines.findIndex((text) => text.includes(alert));
	assert.ok(line >= 0);
	review.reviewer = "独立审阅 fixture";
	review.judgments = review.judgments.map((item: { criterionId: string }) => ({
		criterionId: item.criterionId,
		verdict: "pass",
		explanation: "仅验证审阅输入处理的fixture",
		evidence: [{ line: line + 1, text: lines[line] }],
	}));
	await writeFile(join(f.directory, "quality-review.json"), JSON.stringify(review));
	assert.equal((await summarizeObserver(f.directory)).exitCode, 0);
	assert.equal(await readFile(join(f.directory, "evidence.json"), "utf8"), evidence);
	await writeFile(join(f.directory, "transcript.md"), `${transcript}\n后续改写`);
	assert.equal((await summarizeObserver(f.directory)).quality.status, "invalid");
});

test("empty or failed observer execution cannot masquerade as successful silence", async (t) => {
	for (const fault of ["empty", "failed"] as const)
		await t.test(fault, async (t) => {
			const f = await runFixture(t, fault);
			assert.equal(f.summary.runtime.checks.executionSucceeded, false);
			assert.equal(f.summary.behavior.checks.quietStayedSilent, false);
			assert.equal(f.summary.exitCode, 1);
		});
});
