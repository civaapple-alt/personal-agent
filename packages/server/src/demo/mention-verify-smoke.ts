/**
 * Opt-in real Pi verification of lead-coordinated `@member` routing inside a matter (`interactionMode: "conversation"`):
 * - Turn 1 (lead: `product-manager`): summarizes timeout/retry settings from README.md (which intentionally
 *   disagrees with `src/config.mjs`).
 * - Turn 2 (multi-`@` in one turn: `@Engineering Manager` task + `@QA Manager` verification):
 *   routes through the matter lead (`product-manager`) so the lead retains full context and orchestrates both
 *   `engineering-manager` (compute `computeBackoffMs(2) === 1000`) and `qa-manager` (independent verification of
 *   `defaultTimeoutMs=5000` & `maxRetries=1` in `src/config.mjs`) via `delegate_to_member`, then synthesizes the reply.
 * - Turn 3 (no `@mention` follow-up): confirms the lead (`product-manager`) retained the full delegated context
 *   and produces the corrected summary.
 * - Optional cross-model verification: pass `--verifier-provider <id> --verifier-model <id>` to run
 *   `qa-manager` on a different model family than the lead during `delegate_to_member`.
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
import { resolveVerifierModelFromEnv, selectDemoModel } from "./model-selection.ts";

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
	console.log(
		[
			"Usage: npm run demo:mention-verify -- [--provider <id> --model <id>] [--verifier-provider <id> --verifier-model <id>]",
			"Runs an isolated 3-turn real-Pi verification of lead-coordinated `@member` routing in conversation mode:",
			"  1. Lead (product-manager) summarizes README.md claims (which conflict with src/config.mjs).",
			"  2. User mentions BOTH `@Engineering Manager` (task) and `@QA Manager` (independent verification) in one turn;",
			"     verifies routing stays with lead (product-manager), delegates to both teammates, and integrates evidence.",
			"  3. User follows up without @mention and verifies lead retains full delegated context in its final summary.",
			"  4. Saves mention-verify-report.json. Set PA_KEEP_DEMO_DIR=1 to preserve the temp directory.",
		].join("\n"),
	);
	process.exit(0);
}

function readFlag(name: string): string | undefined {
	const index = argv.indexOf(name);
	return index >= 0 ? argv[index + 1] : undefined;
}

const leadProvider = readFlag("--provider");
const leadModelArg = readFlag("--model");
if ((leadProvider && !leadModelArg) || (!leadProvider && leadModelArg)) {
	throw new Error("Pass both --provider and --model together");
}
const verifierProvider = readFlag("--verifier-provider");
const verifierModel = readFlag("--verifier-model");
if ((verifierProvider && !verifierModel) || (!verifierProvider && verifierModel)) {
	throw new Error("Pass both --verifier-provider and --verifier-model together");
}

const directory = mkdtempSync(join(tmpdir(), "pa-mention-verify-"));
const workspaceDir = join(directory, "isolated-workspace");
const sessionDir = join(directory, "sessions");
const dbPath = join(directory, "personal-agent.db");
const db = openPersonalAgentDatabase(dbPath);
const store = new PersonalAgentStore(db, { spacesDir: join(directory, "spaces") });
const templates = await loadRoleTemplatesFromDir(resolve("roles"));

interface LaunchRecord {
	memberId: string;
	provider?: string;
	model?: string;
	sessionFile?: string;
}
const launches: LaunchRecord[] = [];

const orchestrator = new TeamOrchestrator({
	store,
	templates,
	defaultCwd: workspaceDir,
	sessionDir,
	workerFactory: (options) => {
		launches.push({
			memberId: options.env?.PA_MEMBER_ID ?? "unknown",
			provider: options.provider,
			model: options.model,
			sessionFile: options.sessionFile,
		});
		return new PiRpcWorker(options);
	},
});

let failed = false;
try {
	await mkdir(join(workspaceDir, "src"), { recursive: true });
	await writeFile(
		join(workspaceDir, "README.md"),
		[
			"# Demo Sync Client",
			"",
			"## Default Runtime Settings",
			"- `defaultTimeoutMs`: `3000` (3 seconds)",
			"- `maxRetries`: `3`",
			"- Source of truth: `src/config.mjs`",
			"",
		].join("\n"),
		"utf8",
	);
	await writeFile(
		join(workspaceDir, "src", "config.mjs"),
		[
			"export const DEFAULT_CONFIG = {",
			"\tdefaultTimeoutMs: 5000,",
			"\tmaxRetries: 1,",
			"};",
			"",
			"export function computeBackoffMs(attempt) {",
			"\treturn Math.min(10000, 250 * 2 ** Math.max(0, attempt));",
			"}",
			"",
		].join("\n"),
		"utf8",
	);

	const leadModel = await selectDemoModel(
		workspaceDir,
		leadProvider && leadModelArg ? { provider: leadProvider, model: leadModelArg } : {},
	);
	const resolvedVerifier = resolveVerifierModelFromEnv({ verifierProvider, verifierModel });
	const org = store.ensureDefaultOrganization();
	const workspace = store.upsertWorkspace({
		orgId: org.id,
		name: "demo-sync-client",
		repoPath: workspaceDir,
		defaultBranch: "main",
	});

	if (resolvedVerifier.verifierProvider && resolvedVerifier.verifierModel) {
		store.setOrgAiRolesBatch(org.id, [
			{ memberId: "product-manager", enabled: true, isPrimaryContact: true },
			{
				memberId: "qa-manager",
				enabled: true,
				providerOverride: resolvedVerifier.verifierProvider,
				modelOverride: resolvedVerifier.verifierModel,
			},
			{ memberId: "engineering-manager", enabled: true },
		]);
	}

	const matter = store.createMatter({
		title: "Mention verify smoke",
		orgId: org.id,
		workspaceId: workspace.id,
		leadMemberId: "product-manager",
		aiMemberIds: ["product-manager", "qa-manager", "engineering-manager"],
		consultMemberIds: ["qa-manager", "engineering-manager"],
		observersEnabled: false,
		observerMemberIds: [],
		modelSelection: leadModel,
	});

	const sendConversationTurn = async (prompt: string) => {
		const userMessage = store.appendMessage({
			matterId: matter.id,
			channel: "user",
			senderType: "user",
			senderId: "user",
			content: prompt,
			metadata: {
				mode: "conversation",
				orgId: org.id,
				workspaceId: workspace.id,
				repoPath: resolve(workspaceDir),
			},
		});
		return orchestrator.dispatchMatter({
			matterId: matter.id,
			interactionMode: "conversation",
			existingUserMessageId: userMessage.id,
			prompt,
		});
	};

	console.log("Turn 1: Lead (product-manager) summarizes README.md...");
	const turn1 = await sendConversationTurn(
		"请快速阅读 README.md，用两句话总结当前项目的 defaultTimeoutMs 和 maxRetries 配置说明。",
	);
	assert.ok(turn1.directReply, "Turn 1 must produce a direct reply");
	assert.equal(turn1.directReply.senderId, "product-manager");

	console.log("Turn 2: User mentions @Engineering Manager (task) + @QA Manager (verification) in one message...");
	const launchesBeforeTurn2 = launches.length;
	const turn2 = await sendConversationTurn(
		"@Engineering Manager 请结合刚才的配置背景查看 src/config.mjs 的 computeBackoffMs，计算 attempt=2 时的退避毫秒数；同时请 @QA Manager 独立核查 README.md 关于 defaultTimeoutMs 和 maxRetries 的说明是否与 src/config.mjs 实际代码一致并给出文件证据。",
	);
	const turn2Launches = launches.slice(launchesBeforeTurn2);
	const matterAfterTurn2 = store.getMatter(matter.id);
	assert.ok(turn2.directReply, "Turn 2 must produce a direct reply");
	assert.equal(
		turn2.directReply.senderId,
		"product-manager",
		"Turn 2 @mentions on a matter with an active lead must route through the lead (product-manager)",
	);
	assert.equal(matterAfterTurn2?.leadMemberId, "product-manager", "Matter lead must remain product-manager");
	const turn2MemberIds = new Set(turn2Launches.map((launch) => launch.memberId));
	assert.ok(
		turn2MemberIds.has("engineering-manager"),
		"Lead must delegate to engineering-manager when @Engineering Manager is mentioned",
	);
	assert.ok(turn2MemberIds.has("qa-manager"), "Lead must delegate to qa-manager when @QA Manager is mentioned");
	if (verifierProvider && verifierModel) {
		const qaLaunch = turn2Launches.find((launch) => launch.memberId === "qa-manager");
		assert.equal(qaLaunch?.provider, verifierProvider, "QA Manager must run on --verifier-provider");
		assert.equal(qaLaunch?.model, verifierModel, "QA Manager must run on --verifier-model");
	}
	assert.match(turn2.directReply.content, /1000/, "Integrated lead reply must include computeBackoffMs(2) = 1000");
	assert.match(turn2.directReply.content, /5000/, "Integrated lead reply must include actual defaultTimeoutMs=5000");
	assert.match(turn2.directReply.content, /\b1\b/, "Integrated lead reply must include actual maxRetries=1");

	console.log("Turn 3: Follow-up without @mention confirms lead retains full delegated context...");
	const turn3 = await sendConversationTurn("用两句话总结刚才研发和 QA 核查后的最终准确配置。");
	assert.ok(turn3.directReply, "Turn 3 must produce a direct reply");
	assert.equal(
		turn3.directReply.senderId,
		"product-manager",
		"Follow-up without @mention must stay with the original matter lead",
	);
	assert.match(turn3.directReply.content, /5000/, "Lead follow-up must retain defaultTimeoutMs=5000");
	assert.match(turn3.directReply.content, /\b1\b/, "Lead follow-up must retain maxRetries=1");

	const internalCollab = store.listMessages(matter.id, "internal_collab");
	assert.ok(
		internalCollab.some((m) => m.senderId === "engineering-manager" && m.content.includes("1000")),
		"Internal collab must record engineering-manager response with 1000",
	);
	assert.ok(
		internalCollab.some((m) => m.senderId === "qa-manager" && m.content.includes("5000")),
		"Internal collab must record qa-manager verification response with 5000",
	);

	const notices = store.listMessages(matter.id, "notice").filter((m) => m.senderId === "qa-manager");
	const qaInspectedConfig = notices.some(
		(m) => m.content.includes("config.mjs") && (m.content.includes('"read"') || m.content.includes('"bash"')),
	);
	assert.ok(qaInspectedConfig, "QA Manager must actually inspect src/config.mjs via read/bash tools");

	const report = {
		ok: true,
		directory,
		leadModel,
		verifierModel:
			verifierProvider && verifierModel ? { provider: verifierProvider, model: verifierModel } : "default",
		launches,
		qaInspectedConfig,
		turns: [
			{ turn: 1, kind: "lead_summary", speaker: turn1.directReply.senderId, reply: turn1.directReply.content },
			{
				turn: 2,
				kind: "lead_coordinated_multi_mention",
				speaker: turn2.directReply.senderId,
				reply: turn2.directReply.content,
			},
			{ turn: 3, kind: "lead_followup", speaker: turn3.directReply.senderId, reply: turn3.directReply.content },
		],
	};
	const reportPath = join(directory, "mention-verify-report.json");
	await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
	console.log(`PASS demo:mention-verify (report: ${reportPath})`);
} catch (error) {
	failed = true;
	console.error("FAIL demo:mention-verify:", error);
	process.exitCode = 1;
} finally {
	await orchestrator.shutdown();
	db.close();
	if (!failed && process.env.PA_KEEP_DEMO_DIR !== "1") {
		rmSync(directory, { recursive: true, force: true });
	}
}
