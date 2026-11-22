import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { TeamOrchestrator, type WorkerFactory } from "../orchestrator/team-orchestrator.ts";
import { BUILTIN_ROLE_ARCHITECT_TEMPLATE } from "../roles/role-architect.ts";
import type { RoleTemplate } from "../roles/types.ts";
import { PiRpcWorker, type PromptRunResult } from "../rpc/pi-rpc-worker.ts";
import { createPersonalAgentServer } from "../server/app.ts";
import { DialogBroker } from "../server/dialog-broker.ts";
import { PreviewManager } from "../server/preview-manager.ts";
import { openPersonalAgentDatabase } from "../storage/database.ts";
import { PersonalAgentStore } from "../storage/repositories.ts";
import { qualityReviewTemplate, reviewHash } from "./publication-review-quality.ts";
import {
	ARCHITECT_DEMO_PROMPT,
	ROLE_DEMO_FILES,
	ROLE_DEMO_TASKS,
	type RoleDemoScenario,
	roleDemoRubric,
} from "./role-design-case.ts";
import { summarizeRoleDemo } from "./role-design-report.ts";

interface DemoTurn {
	memberId: string;
	matterId: string;
	title: string;
	prompt: string;
	reply: string;
	structuredReply?: string;
	aborted: boolean;
	tools: PromptRunResult["toolExecutions"];
}

async function snapshot(directory: string, prefix = ""): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
		a.name.localeCompare(b.name),
	)) {
		if (entry.name === ".git") continue;
		const local = `${prefix}${entry.name}`;
		if (entry.isDirectory()) Object.assign(files, await snapshot(join(directory, entry.name), `${local}/`));
		else files[local] = reviewHash(await readFile(join(directory, entry.name), "utf8"));
	}
	return files;
}

export async function runRoleDesignDemo(input: {
	directory: string;
	scenario: RoleDemoScenario;
	templates: RoleTemplate[];
	workerFactory?: WorkerFactory;
}) {
	const { directory, scenario } = input;
	if ((await readdir(directory)).length > 0)
		throw new Error("Role demo requires an empty evidence directory; existing data is never reset");
	const workspaceDir = join(directory, "workspace");
	await mkdir(workspaceDir);
	for (const [name, content] of Object.entries(ROLE_DEMO_FILES)) await writeFile(join(workspaceDir, name), content);
	const exec = promisify(execFile);
	await exec("git", ["init", "-q", workspaceDir]);
	await exec("git", ["-C", workspaceDir, "config", "user.name", "Demo User"]);
	await exec("git", ["-C", workspaceDir, "config", "user.email", "demo@example.invalid"]);
	const before = await snapshot(workspaceDir);
	const db = openPersonalAgentDatabase(join(directory, "proof.db"));
	const store = new PersonalAgentStore(db);
	const templates = [...input.templates, BUILTIN_ROLE_ARCHITECT_TEMPLATE];
	const workers: Array<{
		memberId: string;
		tools: string[];
		skills: string[];
		canSaveSpace: boolean;
		canDelegate: boolean;
		contextSha256: string;
		skillSnapshots: Array<{ path: string; sha256: string }>;
	}> = [];
	const orchestrator = new TeamOrchestrator({
		store,
		templates,
		defaultCwd: workspaceDir,
		sessionDir: join(directory, "sessions"),
		workerFactory: (options) => {
			const worker = input.workerFactory?.(options) ?? new PiRpcWorker(options);
			const args = options.args ?? [];
			workers.push({
				memberId: options.env?.PA_MEMBER_ID ?? "unknown",
				tools: args[args.indexOf("--tools") + 1]?.split(",").filter(Boolean) ?? [],
				skills: args.flatMap((arg, index) => (arg === "--skill" ? [args[index + 1] ?? ""] : [])),
				canSaveSpace: options.env?.PA_CAN_SAVE_SPACE === "true",
				canDelegate: options.env?.PA_CAN_DELEGATE === "true",
				contextSha256: reviewHash(options.env?.PA_MEMBER_CONTEXT ?? ""),
				skillSnapshots: args.flatMap((arg, index) =>
					arg === "--skill" && args[index + 1]
						? [
								{
									path: args[index + 1]!,
									sha256: createHash("sha256")
										.update(readFileSync(args[index + 1]!))
										.digest("hex"),
								},
							]
						: [],
				),
			});
			return worker;
		},
	});
	store.ensureOwnerCollaborator("隔离验证所有者");
	const workspace = store.upsertWorkspace({ name: "虚构角色验证", repoPath: workspaceDir });
	const turns: DemoTurn[] = [];
	let error: string | null = null;
	let createdTemplate: RoleTemplate | undefined;
	let verificationSpecified = false;
	const execute = async (memberId: string, title: string, prompt: string, bindWorkspace = true) => {
		console.log(`RUN ${title} (${memberId})`);
		const result = await orchestrator.dispatchMatter({
			prompt,
			preferredMemberId: memberId,
			workspaceId: bindWorkspace ? workspace.id : undefined,
			aiMemberIds: [memberId],
			observersEnabled: false,
			timeoutMs: 150_000,
		});
		turns.push({
			memberId,
			matterId: result.matter.id,
			title,
			prompt,
			reply: result.replyText,
			...(memberId === "role-architect" ? { structuredReply: result.runResult.assistantText } : {}),
			aborted: result.runResult.aborted,
			tools: result.runResult.toolExecutions,
		});
		return result;
	};
	try {
		if (scenario === "architect") {
			const designed = await execute("role-architect", "角色设计", ARCHITECT_DEMO_PROMPT, false);
			const reply = store
				.listMessages(designed.matter.id, "user")
				.findLast((message) => message.senderId === "role-architect" && message.metadata?.roleProposals);
			if (!reply) throw new Error("No persisted proposal message");
			const parsed = await import("../orchestrator/meta-architect.ts");
			const original = await parsed.buildArchitectMessageProposals(
				designed.runResult.assistantText,
				store,
				new Map(templates.map((role) => [role.id, role])),
			);
			if (
				original.roleProposals?.blueprints.length !== 1 ||
				JSON.stringify(original.roleProposals) !== JSON.stringify(reply.metadata?.roleProposals)
			)
				throw new Error("Persisted role proposal differs from parsed output");
			const draft = original.roleProposals.blueprints[0]?.draft;
			if (
				!draft ||
				draft.template.id !== "release-reviewer" ||
				draft.template.tools.join(",") !== "read" ||
				draft.template.mcpDependencies.length ||
				!draft.template.skills.length
			)
				throw new Error("Role blueprint does not match requested read-only job");
			verificationSpecified = draft.verificationPlanState === "specified";
			const { server } = createPersonalAgentServer({
				store,
				orchestrator,
				templates,
				rolesDir: join(directory, "roles"),
				previewManager: new PreviewManager(),
				dialogBroker: new DialogBroker(),
			});
			await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
			try {
				const address = server.address();
				if (!address || typeof address === "string") throw new Error("Missing test server address");
				const template = draft.template;
				const response = await fetch(
					`http://127.0.0.1:${address.port}/api/matters/${designed.matter.id}/messages/${reply.id}/apply-role-proposals`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							action: "apply",
							members: [
								{
									id: template.id,
									name: template.name,
									title: template.title,
									tools: template.tools,
									skills: template.skills,
									mcpDependencies: template.mcpDependencies,
									antiJobs: template.antiJobs,
									sections: template.sections,
									responsibilities: template.sections.responsibilitiesAndBoundaries,
								},
							],
						}),
					},
				);
				if (!response.ok) throw new Error(`Role application failed: ${await response.text()}`);
			} finally {
				await new Promise<void>((done) => server.close(() => done()));
			}
			const member = store.getMember(draft.template.id);
			if (!member) throw new Error("Applied role is missing");
			createdTemplate = orchestrator.getTemplateForMember(member);
			await writeFile(
				join(directory, "created-role.json"),
				JSON.stringify({ draft, template: createdTemplate }, null, 2),
			);
			await execute(
				member.id,
				"新角色实际履职",
				"只读取 package.json、release.md、requirements.md，核对发布说明与实际版本及范围，指出矛盾并附文件依据。只返回审阅意见，不改文件、不执行命令、不对外发送、不发布正式成果。",
			);
		} else {
			for (const task of ROLE_DEMO_TASKS) await execute(task.id, task.title, task.prompt);
		}
	} catch (failure) {
		error = failure instanceof Error ? failure.message : String(failure);
	} finally {
		await orchestrator.shutdown();
	}
	try {
		const expected = scenario === "architect" ? 2 : 4;
		const actualTaskTools =
			scenario === "architect"
				? ["package.json", "release.md", "requirements.md"].every((name) =>
						turns[1]?.tools.some((tool) => tool.toolName === "read" && JSON.stringify(tool.args).includes(name)),
					)
				: turns.length === 4 &&
					turns.every((turn) => turn.tools.some((tool) => tool.toolName === "read")) &&
					Boolean(
						turns
							.find((turn) => turn.memberId === "qa-manager")
							?.tools.some(
								(tool) => tool.toolName === "bash" && JSON.stringify(tool.args).includes("verify.mjs"),
							),
					);
		const capabilitiesAsRequested =
			scenario === "architect"
				? verificationSpecified &&
					workers.length === 2 &&
					workers[0]?.tools.length === 0 &&
					!workers[0]?.canSaveSpace &&
					workers[1]?.tools.every((tool) => !["write", "edit", "bash", "delegate_to_member"].includes(tool)) &&
					Boolean(
						createdTemplate?.skills.every((name) =>
							workers[1]?.skills.some((path) => path.endsWith(`/${name}/SKILL.md`)),
						),
					)
				: workers.length === 4 && workers.every((worker) => !worker.canDelegate && worker.skills.length > 0);
		const checks = {
			executionSucceeded: error === null && turns.every((turn) => !turn.aborted),
			expectedTurns: turns.length === expected,
			workspacePreserved: JSON.stringify(before) === JSON.stringify(await snapshot(workspaceDir)),
			noFormalDeliveries: store.listDeliverables().length === 0,
			noOutstandingLease: store.listMatters().every((matter) => !store.hasLiveMatterLease(matter.id)),
			capabilitiesAsRequested,
			actualTaskTools,
		};
		const transcript = [
			`# ${scenario} role demo`,
			"All input records are synthetic. This is one isolated run, not a before/after improvement study.",
			"## Fixed input",
			...Object.entries(ROLE_DEMO_FILES).map(([name, content]) => `### ${name}\n${content}`),
			"## Role definition snapshots",
			JSON.stringify(templates, null, 2),
			"## Worker loadouts",
			JSON.stringify(workers, null, 2),
			...(createdTemplate ? ["## Applied role", JSON.stringify(createdTemplate, null, 2)] : []),
			...turns.map(
				(turn, index) =>
					`## Turn ${index + 1}: ${turn.title}\nMember: ${turn.memberId}\n### Prompt\n${turn.prompt}\n### Reply\n${turn.reply}\n${turn.structuredReply ? `### Raw structured response\n${turn.structuredReply}\n` : ""}### Actual tools\n${JSON.stringify(turn.tools, null, 2)}`,
			),
			...(error ? [`## Execution failure\n${error}`] : []),
		].join("\n\n");
		const rubric = roleDemoRubric(scenario);
		await writeFile(join(directory, "transcript.md"), transcript);
		await writeFile(join(directory, "turns.json"), JSON.stringify(turns, null, 2));
		await writeFile(
			join(directory, "quality-review.json"),
			JSON.stringify(qualityReviewTemplate(transcript, rubric), null, 2),
		);
		await writeFile(
			join(directory, "evidence.json"),
			JSON.stringify(
				{
					schemaVersion: 1,
					caseVersion: "role-design-v1",
					scenario,
					executionMode: input.workerFactory ? "controlled" : "real_pi",
					fixtureSha256: reviewHash(JSON.stringify(ROLE_DEMO_FILES)),
					roleVersions: templates.map(({ id, version }) => ({ id, version })),
					checks,
					workers,
					rubric,
					transcriptSha256: reviewHash(transcript),
					error,
				},
				null,
				2,
			),
		);
		return await summarizeRoleDemo(directory);
	} finally {
		db.close();
	}
}
