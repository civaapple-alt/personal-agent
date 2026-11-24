import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRoleSkills } from "../orchestrator/execution/execution-context.ts";
import { TeamOrchestrator } from "../orchestrator/team-orchestrator.ts";
import { defaultWorkerFactory } from "../orchestrator/types.ts";
import { loadRoleTemplatesFromDir } from "../roles/template-loader.ts";
import type { ToolExecutionRecord } from "../rpc/pi-rpc-worker.ts";
import { openPersonalAgentDatabase } from "../storage/database.ts";
import { PersonalAgentStore } from "../storage/repositories.ts";
import { selectDemoModel } from "./model-selection.ts";
import { hasPstackReadEvidence } from "./pstack-evidence.ts";
import { preparePstackRuntime, readPstackResource } from "./pstack-fixture.ts";
import { earlierIntake, type SelectionId, selectionCases, selectionFiles } from "./pstack-selection-cases.ts";
import { assessQuality, qualityReviewTemplate, reviewHash, reviewObject } from "./publication-review-quality.ts";

export async function selectionTree(root: string, prefix = ""): Promise<Record<string, string>> {
	const entries: Record<string, string> = {};
	for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) =>
		a.name.localeCompare(b.name),
	)) {
		if (entry.name === ".git") continue;
		const path = join(prefix, entry.name);
		if (entry.isDirectory()) Object.assign(entries, await selectionTree(root, path));
		else if (entry.isFile())
			entries[path] = createHash("sha256")
				.update(await readFile(join(root, path)))
				.digest("hex");
		else throw new Error(`Unexpected fixture entry: ${path}`);
	}
	return entries;
}

function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Fixture Author",
			GIT_AUTHOR_EMAIL: "fixture@example.invalid",
			GIT_COMMITTER_NAME: "Fixture Author",
			GIT_COMMITTER_EMAIL: "fixture@example.invalid",
		},
	});
	if (result.status !== 0) throw new Error(`Fixture git ${args[0]} failed: ${result.stderr}`);
	return result.stdout;
}

async function writeWorkspace(path: string) {
	await mkdir(path, { recursive: true });
	for (const [name, text] of Object.entries(selectionFiles)) {
		await mkdir(resolve(path, name, ".."), { recursive: true });
		await writeFile(join(path, name), text);
	}
	await writeFile(join(path, "src/intake.mjs"), earlierIntake);
	await writeFile(
		join(path, "docs/decisions.md"),
		"# Initial design\nRetry protection is keyed by the caller-supplied key only. Five minutes is an initial hypothesis, not production data. Storage is process memory.\n",
	);
	git(path, ["init", "--quiet"]);
	git(path, ["add", "."]);
	git(path, ["commit", "--quiet", "-m", "Introduce process-local feedback intake and short retry window"]);
	await writeFile(join(path, "src/intake.mjs"), selectionFiles["src/intake.mjs"]);
	await writeFile(join(path, "docs/decisions.md"), selectionFiles["docs/decisions.md"]);
	git(path, ["add", "."]);
	git(path, ["commit", "--quiet", "-m", "Scope retry keys by actor to prevent cross-user result reuse"]);
	const history = git(path, [
		"log",
		"--format=commit %H%nsubject %s",
		"--patch",
		"--",
		"src/intake.mjs",
		"docs/decisions.md",
	]);
	await writeFile(
		join(path, "docs/history.md"),
		`# Git record snapshot\nGenerated from this repository's actual commits and patches.\n\n${history}`,
	);
	await writeFile(
		join(path, "README.md"),
		`${selectionFiles["README.md"]}\nThe read-only Git record snapshot is docs/history.md.\n`,
	);
	git(path, ["add", "."]);
	git(path, ["commit", "--quiet", "-m", "Add read-only history snapshot for repository readers"]);
}

function methodActions(tools: ToolExecutionRecord[]) {
	return tools
		.filter((tool) => tool.toolName === "load_available_skill")
		.map((tool) => ({ args: tool.args, succeeded: !tool.isError && tool.result !== undefined }));
}

/** Counts a complete returned body; failed calls and mere mentions never count. */
export async function selectionMethodLoaded(
	tools: ToolExecutionRecord[],
	expected: Awaited<ReturnType<typeof readPstackResource>>,
	cwd = process.cwd(),
): Promise<boolean> {
	if (hasPstackReadEvidence(tools, expected)) return true;
	const expectedPath = await realpath(expected.path).catch(() => null);
	for (const tool of tools) {
		if (
			tool.toolName !== "read" ||
			tool.isError ||
			!tool.result ||
			typeof tool.result !== "object" ||
			!("content" in tool.result) ||
			!Array.isArray(tool.result.content)
		)
			continue;
		// Ordinary read output has no method hash; require the full frozen body and the exact source path.
		if (
			!tool.args ||
			typeof tool.args !== "object" ||
			!("path" in tool.args) ||
			typeof tool.args.path !== "string" ||
			!expectedPath ||
			(await realpath(resolve(cwd, tool.args.path)).catch(() => null)) !== expectedPath
		)
			continue;
		if (
			tool.result.content.some(
				(item: unknown) =>
					item &&
					typeof item === "object" &&
					"text" in item &&
					typeof item.text === "string" &&
					item.text.includes(expected.text),
			)
		)
			return true;
	}
	return false;
}

export async function summarizeSelection(directory: string) {
	const run = reviewObject(JSON.parse(await readFile(join(directory, "run.json"), "utf8")));
	if (!Array.isArray(run.ids) || run.ids.length === 0 || new Set(run.ids).size !== run.ids.length)
		throw new Error("Invalid selection run index");
	const results = [];
	for (const id of run.ids) {
		const scenario = selectionCases.find((entry) => entry.id === id);
		if (!scenario) throw new Error("Unknown selection case");
		const evidence = join(directory, "evidence", scenario.id);
		const execution = reviewObject(JSON.parse(await readFile(join(evidence, "execution.json"), "utf8")));
		const transcript = await readFile(join(evidence, "transcript.md"), "utf8");
		const review: unknown = JSON.parse(await readFile(join(evidence, "quality-review.json"), "utf8"));
		const quality = assessQuality({
			content: transcript,
			documentSha256: typeof execution.transcriptSha256 === "string" ? execution.transcriptSha256 : null,
			rubric: scenario.rubric,
			review,
		});
		const runtimePassed =
			execution.executionSucceeded === true &&
			execution.workspaceUnchanged === true &&
			execution.methodsUnchanged === true &&
			execution.noDeliverables === true &&
			execution.sessionResumed === true;
		results.push({
			id: scenario.id,
			runtimePassed,
			targetMethodObserved: execution.targetMethodObserved === true,
			modeObserved: execution.modeObserved === true,
			quality,
			error: execution.error,
			actions: execution.actions,
		});
	}
	const exitCode = results.some(
		(entry) =>
			!entry.runtimePassed ||
			!entry.targetMethodObserved ||
			["fail", "invalid", "unavailable"].includes(entry.quality.status),
	)
		? 1
		: results.some((entry) => entry.quality.status === "pending")
			? 2
			: 0;
	const summary = {
		exitCode,
		scope: "Natural requests without method names; target selection and semantic quality reported separately. Missing target selection alone is not a semantic failure.",
		results,
	};
	await writeFile(join(directory, "summary.json"), JSON.stringify(summary, null, 2));
	return summary;
}

export async function runSelection(options: {
	directory: string;
	source: string;
	ids: SelectionId[];
	provider?: string;
	model?: string;
}) {
	const source = await preparePstackRuntime(options.source);
	const pack = join(options.directory, "methods");
	await mkdir(pack, { recursive: true });
	await cp(join(source.root, "skills"), join(pack, "skills"), { recursive: true });
	await cp(join(source.root, "plugin.json"), join(pack, "plugin.json"));
	const frozenMethods = await selectionTree(pack);
	const templates = (await loadRoleTemplatesFromDir(resolve("roles"))).map((template) => ({
		...template,
		tools: ["read"],
	}));
	const modelSelection = await selectDemoModel(options.directory, options);
	const approvedRoleMethods = (await Promise.all(templates.map((template) => resolveRoleSkills(template)))).flat();
	const planned = selectionCases.filter((scenario) => options.ids.includes(scenario.id));
	await writeFile(
		join(options.directory, "run.json"),
		JSON.stringify(
			{ ids: options.ids, packageVersion: source.version, modeSha256: source.modeSha256, frozenMethods },
			null,
			2,
		),
	);
	for (const scenario of planned) {
		const evidence = join(options.directory, "evidence", scenario.id);
		const area = join(options.directory, "work", randomUUID());
		const workspace = join(area, "feedback-desk");
		const sessions = join(area, "sessions");
		await mkdir(evidence, { recursive: true });
		await writeWorkspace(workspace);
		const original = await selectionTree(workspace);
		const originalHead = git(workspace, ["rev-parse", "HEAD"]);
		const db = openPersonalAgentDatabase(join(area, "agent.db"));
		const store = new PersonalAgentStore(db);
		store.updatePlatformSettings({ defaultModelSelection: modelSelection });
		const ws = store.upsertWorkspace({ name: "Feedback Desk", repoPath: workspace });
		const makeOrchestrator = () =>
			new TeamOrchestrator({
				store,
				templates,
				defaultCwd: workspace,
				sessionDir: sessions,
				extensions: [
					fileURLToPath(
						new URL(
							import.meta.url.endsWith(".js") ? "./fixture-read-guard.js" : "./fixture-read-guard.ts",
							import.meta.url,
						),
					),
				],
				workerFactory: (config) =>
					defaultWorkerFactory({
						...config,
						args: [...(config.args ?? []), "--no-skills", "--skill", join(pack, "skills")],
						env: {
							...config.env,
							PA_FIXTURE_READ_ROOTS: JSON.stringify([workspace, sessions, pack, ...approvedRoleMethods]),
						},
					}),
			});
		let orchestrator = makeOrchestrator();
		let result: Awaited<ReturnType<TeamOrchestrator["dispatchMatter"]>> | undefined;
		let prior: typeof result;
		let sessionResumed = !scenario.priorMessage;
		let error: string | undefined;
		console.log(`RUN ${scenario.id}`);
		try {
			if (scenario.priorMessage) {
				prior = await orchestrator.dispatchMatter({
					workspaceId: ws.id,
					preferredMemberId: scenario.memberId,
					aiMemberIds: [scenario.memberId],
					observersEnabled: false,
					timeoutMs: 180_000,
					prompt: scenario.priorMessage,
				});
				const before = db
					.prepare("SELECT pi_session_id FROM worker_sessions WHERE matter_id = ? ORDER BY rowid DESC LIMIT 1")
					.get(prior.matter.id);
				await orchestrator.shutdown();
				orchestrator = makeOrchestrator();
				result = await orchestrator.dispatchMatter({
					matterId: prior.matter.id,
					timeoutMs: 180_000,
					prompt: scenario.prompt,
				});
				const after = db
					.prepare("SELECT pi_session_id FROM worker_sessions WHERE matter_id = ? ORDER BY rowid DESC LIMIT 1")
					.get(prior.matter.id);
				sessionResumed = typeof before?.pi_session_id === "string" && before.pi_session_id === after?.pi_session_id;
			} else {
				result = await orchestrator.dispatchMatter({
					workspaceId: ws.id,
					preferredMemberId: scenario.memberId,
					aiMemberIds: [scenario.memberId],
					observersEnabled: false,
					timeoutMs: 180_000,
					prompt: scenario.prompt,
				});
			}
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		} finally {
			await orchestrator.shutdown();
		}
		const tools = result?.runResult.toolExecutions ?? [];
		const target = await readPstackResource(pack, scenario.id);
		const mode = await readPstackResource(pack, "poteto-mode");
		const observations = {
			executionSucceeded: result !== undefined && !result.runResult.aborted,
			workspaceUnchanged:
				JSON.stringify(await selectionTree(workspace)) === JSON.stringify(original) &&
				git(workspace, ["rev-parse", "HEAD"]) === originalHead,
			methodsUnchanged: JSON.stringify(await selectionTree(pack)) === JSON.stringify(frozenMethods),
			noDeliverables: store.spaces.listDocuments({}).length === 0,
			sessionResumed,
			targetMethodObserved: await selectionMethodLoaded(tools, target, workspace),
			modeObserved: await selectionMethodLoaded(tools, mode, workspace),
			actions: methodActions(tools),
			error,
		};
		const records = {
			userPrompt: scenario.prompt,
			priorPrompt: scenario.priorMessage,
			prior,
			result,
			messages: store.listMessages(result?.matter.id ?? prior?.matter.id ?? ""),
		};
		await writeFile(join(evidence, "turns.json"), JSON.stringify(records, null, 2));
		const transcript = [
			"# Work record",
			"## User request",
			scenario.prompt,
			...(scenario.priorMessage
				? ["## Earlier agreed decisions", scenario.priorMessage, "## Earlier response", prior?.replyText ?? ""]
				: []),
			"## Repository files",
			...(await Promise.all(
				Object.keys(original)
					.sort()
					.map(async (path) => `### ${path}\n${await readFile(join(workspace, path), "utf8")}`),
			)),
			"## Tool actions",
			...tools.map(
				(tool) =>
					`- ${tool.toolName}: ${JSON.stringify(tool.args)}; completed=${tool.result !== undefined}; error=${tool.isError}`,
			),
			"## Final response",
			result?.replyText ?? `Execution failed: ${error}`,
			"",
		].join("\n");
		await writeFile(join(evidence, "transcript.md"), transcript);
		await writeFile(
			join(evidence, "quality-review.json"),
			JSON.stringify(qualityReviewTemplate(transcript, scenario.rubric), null, 2),
		);
		await writeFile(join(evidence, "rubric.json"), JSON.stringify(scenario.rubric, null, 2));
		await writeFile(
			join(evidence, "execution.json"),
			JSON.stringify(
				{
					...observations,
					promptSha256: reviewHash(scenario.prompt),
					transcriptSha256: reviewHash(transcript),
					targetSha256: target.sha256,
					targetPath: target.path,
					area,
				},
				null,
				2,
			),
		);
		db.close();
		console.log(JSON.stringify({ id: scenario.id, ...observations }));
	}
	return summarizeSelection(options.directory);
}
