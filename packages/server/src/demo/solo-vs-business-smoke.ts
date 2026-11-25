/**
 * Opt-in real Pi verification comparing `pi-default` (`roleKind: solo`) against
 * `product-manager` (`roleKind: business`) on the exact same isolated workspace task:
 * - Verifies actual Pi startup handshake tools (`delegate_to_member` absent on solo, present on business;
 *   `space`, `propose_skill`, `visualize`, `request_clarification`, `suggest_next_steps`, `read_team_roles`,
 *   `propose_role` present on solo).
 * - Verifies actual `PA_MEMBER_CONTEXT` and `PA_TURN_CONTEXT` injected into Pi RPC
 *   (no multi-role team roster/capabilities/review boilerplate on `pi-default`; present on `product-manager`).
 * - Writes `solo-vs-business-report.json` with side-by-side context & token comparison.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TeamOrchestrator } from "../orchestrator/team-orchestrator.ts";
import { loadRoleTemplatesFromDir } from "../roles/template-loader.ts";
import { PiRpcWorker } from "../rpc/pi-rpc-worker.ts";
import { openPersonalAgentDatabase } from "../storage/database.ts";
import { PersonalAgentStore } from "../storage/repositories.ts";
import { selectDemoModel } from "./model-selection.ts";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
	console.log(
		[
			"Usage: npm run demo:solo",
			"Runs an isolated real-Pi side-by-side comparison between `pi-default` (roleKind: solo) and `product-manager` (roleKind: business):",
			"  1. Captures exact PA_MEMBER_CONTEXT, PA_TURN_CONTEXT, CLI args, and runtime_ready tool lists.",
			"  2. Verifies solo disables delegate_to_member & multi-role roster/review prompts while preserving PA extensions.",
			"  3. Saves solo-vs-business-report.json. Set PA_KEEP_DEMO_DIR=1 to keep the temp directory.",
		].join("\n"),
	);
	process.exit(0);
}

interface CapturedWorkerLaunch {
	memberId: string;
	memberContext: string;
	turnContext: string;
	args: string[];
}

const directory = mkdtempSync(join(tmpdir(), "pa-solo-vs-business-"));
const workspaceDir = join(directory, "isolated-workspace");
const sessionDir = join(directory, "sessions");
const dbPath = join(directory, "personal-agent.db");
const db = openPersonalAgentDatabase(dbPath);
const store = new PersonalAgentStore(db, { spacesDir: join(directory, "spaces") });
const templates = await loadRoleTemplatesFromDir(resolve("roles"));
const launches: CapturedWorkerLaunch[] = [];

const orchestrator = new TeamOrchestrator({
	store,
	templates,
	defaultCwd: workspaceDir,
	sessionDir,
	workerFactory: (options) => {
		launches.push({
			memberId: options.env?.PA_MEMBER_ID ?? "unknown",
			memberContext: options.env?.PA_MEMBER_CONTEXT ?? "",
			turnContext: options.env?.PA_TURN_CONTEXT ?? "",
			args: options.args ?? [],
		});
		return new PiRpcWorker(options);
	},
});

function readObservedTools(matterId: string, memberId: string): string[] {
	const notices = store.listMessages(matterId, "notice").filter((m) => m.senderId === memberId);
	for (const notice of notices) {
		try {
			const parsed = JSON.parse(notice.content) as { method?: string; tools?: unknown };
			if (parsed.method === "runtime_ready" && Array.isArray(parsed.tools)) {
				return parsed.tools.filter((t): t is string => typeof t === "string");
			}
		} catch {
			// Ignore non-JSON notices.
		}
	}
	return [];
}

try {
	await mkdir(workspaceDir, { recursive: true });
	await writeFile(
		join(workspaceDir, "README.md"),
		"# solo-check-app\nA tiny isolated demo workspace for comparing solo vs business Pi contexts.\n",
		"utf8",
	);
	await writeFile(
		join(workspaceDir, "package.json"),
		JSON.stringify({ name: "solo-check-app", version: "2.4.0" }, null, 2),
		"utf8",
	);
	store.updatePlatformSettings({
		defaultModelSelection: await selectDemoModel(workspaceDir, { thinkingLevel: "off" }),
	});
	const workspace = store.upsertWorkspace({ name: "solo-check-app", repoPath: workspaceDir });
	store.spaces.ensureAllDefaultSpaces();

	const sharedPrompt =
		"请用 read 工具读取当前工作区的 README.md 和 package.json，然后用 1-2 句中文说出项目名称与版本号。不要修改文件，不要委托同事。";

	console.log("1/2 Running `pi-default` (roleKind: solo)...");
	const soloTurn = await orchestrator.dispatchMatter({
		workspaceId: workspace.id,
		preferredMemberId: "pi-default",
		observersEnabled: false,
		timeoutMs: 120_000,
		prompt: sharedPrompt,
	});
	const soloLaunch = launches.find((l) => l.memberId === "pi-default");
	assert.ok(soloLaunch, "Expected pi-default launch capture");
	const soloTools = readObservedTools(soloTurn.matter.id, "pi-default");

	console.log("2/2 Running `product-manager` (roleKind: business)...");
	const businessTurn = await orchestrator.dispatchMatter({
		workspaceId: workspace.id,
		preferredMemberId: "product-manager",
		observersEnabled: false,
		timeoutMs: 120_000,
		prompt: sharedPrompt,
	});
	const businessLaunch = launches.find((l) => l.memberId === "product-manager");
	assert.ok(businessLaunch, "Expected product-manager launch capture");
	const businessTools = readObservedTools(businessTurn.matter.id, "product-manager");

	// Hard assertions on tool surface
	assert.ok(!soloTools.includes("delegate_to_member"), "pi-default must NOT register delegate_to_member");
	assert.ok(businessTools.includes("delegate_to_member"), "product-manager should register delegate_to_member");
	for (const expectedTool of [
		"read_space",
		"save_space_page",
		"propose_skill",
		"visualize",
		"request_clarification",
		"suggest_next_steps",
		"read_team_roles",
		"propose_role",
	]) {
		assert.ok(soloTools.includes(expectedTool), `pi-default must register PA extension tool: ${expectedTool}`);
	}

	// Hard assertions on injected Pi context
	assert.doesNotMatch(soloLaunch.memberContext, /Personal Agent team/);
	assert.doesNotMatch(soloLaunch.turnContext, /## Current team/);
	assert.doesNotMatch(soloLaunch.turnContext, /## Team capability evidence/);
	assert.match(businessLaunch.memberContext, /Personal Agent team/);
	assert.match(businessLaunch.turnContext, /## Current team/);
	assert.match(businessLaunch.turnContext, /## Team capability evidence/);

	// Verify both real Pi runs actually read the workspace and reported accurate facts
	assert.match(soloTurn.replyText, /solo-check-app/);
	assert.match(soloTurn.replyText, /2\.4\.0/);
	assert.match(businessTurn.replyText, /solo-check-app/);
	assert.match(businessTurn.replyText, /2\.4\.0/);

	const soloSet = new Set(soloTools);
	const businessSet = new Set(businessTools);
	const report = {
		directory,
		comparison: {
			solo: {
				memberId: "pi-default",
				memberContextChars: soloLaunch.memberContext.length,
				turnContextChars: soloLaunch.turnContext.length,
				totalContextChars: soloLaunch.memberContext.length + soloLaunch.turnContext.length,
				observedToolsCount: soloTools.length,
				hasDelegateTool: soloTools.includes("delegate_to_member"),
				hasTeamRoster: soloLaunch.turnContext.includes("## Current team"),
				hasTeamCapabilities: soloLaunch.turnContext.includes("## Team capability evidence"),
				reply: soloTurn.replyText,
			},
			business: {
				memberId: "product-manager",
				memberContextChars: businessLaunch.memberContext.length,
				turnContextChars: businessLaunch.turnContext.length,
				totalContextChars: businessLaunch.memberContext.length + businessLaunch.turnContext.length,
				observedToolsCount: businessTools.length,
				hasDelegateTool: businessTools.includes("delegate_to_member"),
				hasTeamRoster: businessLaunch.turnContext.includes("## Current team"),
				hasTeamCapabilities: businessLaunch.turnContext.includes("## Team capability evidence"),
				reply: businessTurn.replyText,
			},
			contextDeltaChars:
				businessLaunch.memberContext.length +
				businessLaunch.turnContext.length -
				(soloLaunch.memberContext.length + soloLaunch.turnContext.length),
			toolsOnlyInBusiness: businessTools.filter((t) => !soloSet.has(t)),
			toolsOnlyInSolo: soloTools.filter((t) => !businessSet.has(t)),
		},
	};

	const reportPath = join(directory, "solo-vs-business-report.json");
	await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
	console.log(JSON.stringify(report.comparison, null, 2));
	console.log(`PASS demo:solo — report saved to ${reportPath}`);
} finally {
	await orchestrator.shutdown();
	db.close();
	if (process.env.PA_KEEP_DEMO_DIR !== "1") {
		rmSync(directory, { recursive: true, force: true });
	}
}
