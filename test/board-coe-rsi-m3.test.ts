import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
	BOARD_SMOKE_HELP_TEXT,
	formatBoardSmokeSummary,
	parseBoardSmokeArgs,
	runBoardSmoke,
	summarizeBoardRun,
} from "../packages/server/src/demo/board-smoke.ts";
import {
	collectBoardFrictionSignals,
	collectTeamHealthEvidence,
	formatTeamHealthEvidence,
} from "../packages/server/src/orchestrator/rsi/team-health.ts";
import {
	buildSessionInsightsReport,
	formatSessionInsightsMarkdown,
} from "../packages/server/src/orchestrator/runtime/session-insights.ts";
import { loadRoleTemplatesFromDir } from "../packages/server/src/roles/template-loader.ts";
import { openPersonalAgentDatabase } from "../packages/server/src/storage/database.ts";
import { PersonalAgentStore } from "../packages/server/src/storage/repositories.ts";

test("collectTeamHealthEvidence ingests board verify_rework, escalate, and monitor_alert and maps to 4 CoE asset categories", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pa-board-coe-m3-"));
	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db);
	const templates = await loadRoleTemplatesFromDir(resolve("roles"));
	const templatesById = new Map(templates.map((t) => [t.id, t]));

	try {
		for (const tpl of templates) {
			store.upsertMember({
				id: tpl.id,
				templateId: tpl.id,
				displayName: tpl.name,
				roleTitle: tpl.title,
				isPrimaryContact: tpl.isPrimaryContact,
				keywords: tpl.keywords,
			});
		}

		const orgA = store.upsertOrganization({ id: "org-a", name: "Org A" });
		const wsPublic = store.upsertWorkspace({
			name: "ws-public",
			repoPath: dir,
			orgId: orgA.id,
			visibility: "org",
		});

		const boardMatter = store.createMatter({
			title: "Board Feature Delivery",
			leadMemberId: "product-manager",
			collaborationMode: "board",
			coordinatorMemberId: "product-manager",
			workspaceId: wsPublic.id,
			orgId: orgA.id,
			visibility: "org",
		});

		// Post #1: normal assign (should NOT appear as board_friction)
		store.createBoardPost({
			matterId: boardMatter.id,
			authorType: "agent",
			authorId: "coordinator",
			kind: "assign",
			mentions: ["builder-api"],
			summary: "Implement API endpoint",
			orgId: orgA.id,
			workspaceId: wsPublic.id,
		});

		// Post #2: verify_rework with verification target/criteria and a secret that must be redacted
		store.createBoardPost({
			matterId: boardMatter.id,
			authorType: "agent",
			authorId: "verifier-qa",
			kind: "verify_rework",
			mentions: ["builder-api"],
			summary: "Missing rate-limit check with token sk-supersecret1234567890",
			verification: {
				target: "src/api/rate-limit.ts",
				criteria: "Reject burst > 60 req/min with HTTP 429",
				verdict: "rework",
				authorAgentId: "builder-api",
			},
			orgId: orgA.id,
			workspaceId: wsPublic.id,
		});

		// Post #3: second verify_rework on same target
		store.createBoardPost({
			matterId: boardMatter.id,
			authorType: "agent",
			authorId: "verifier-qa",
			kind: "verify_rework",
			mentions: ["builder-api"],
			summary: "Edge case for burst window boundary still failing",
			verification: {
				target: "src/api/rate-limit.ts",
				criteria: "Window resets cleanly at 60s",
				verdict: "rework",
				authorAgentId: "builder-api",
			},
			orgId: orgA.id,
			workspaceId: wsPublic.id,
		});

		// Post #4: escalate to coordinator
		store.createBoardPost({
			matterId: boardMatter.id,
			authorType: "monitor",
			authorId: "monitor",
			kind: "escalate",
			mentions: ["coordinator"],
			summary: "@builder-api stalled twice on rate-limit fixture setup",
			orgId: orgA.id,
			workspaceId: wsPublic.id,
		});

		// Event: monitor_alert
		store.appendEvent({
			matterId: boardMatter.id,
			runId: "run-1",
			agentId: "builder-api",
			eventType: "monitor_alert",
			payload: {
				targetAgentId: "builder-api",
				nudgeCount: 2,
				reason: "silent_stall_nudge",
			},
		});

		const evidence = collectTeamHealthEvidence(store, templatesById, { orgId: orgA.id });
		const boardEvidence = evidence.filter((item) => item.kind === "board_friction");
		assert.ok(boardEvidence.length >= 4, "Expected CoE summary + rework + escalate + monitor_alert evidence");

		const summaryItem = boardEvidence.find((item) => item.id === "board_friction:coe_summary");
		assert.ok(summaryItem, "Expected aggregated CoE summary evidence item");
		assert.match(summaryItem.excerpt, /返工 2 次/);
		assert.match(summaryItem.excerpt, /升级 1 次/);
		assert.match(summaryItem.excerpt, /停滞告警 1 次/);
		assert.match(summaryItem.excerpt, /Execution Skills/);
		assert.match(summaryItem.excerpt, /Verifier checklists/);
		assert.match(summaryItem.excerpt, /Role-Skill bindings/);
		assert.match(summaryItem.excerpt, /Coordinator orchestration Skills/);

		const reworkItem = boardEvidence.find((item) => item.id === `board_friction:rework:${boardMatter.id}:2`);
		assert.ok(reworkItem, "Expected post #2 verify_rework item");
		assert.match(reworkItem.excerpt, /post#2/);
		assert.match(reworkItem.excerpt, /verifier-qa/);
		assert.match(reworkItem.excerpt, /@builder-api/);
		assert.match(reworkItem.excerpt, /target=src\/api\/rate-limit\.ts/);
		assert.match(reworkItem.excerpt, /Reject burst > 60 req\/min/);
		assert.equal(
			reworkItem.excerpt.includes("sk-supersecret1234567890"),
			false,
			"Secrets in board summaries must be redacted",
		);

		const escalateItem = boardEvidence.find((item) => item.id === `board_friction:escalate:${boardMatter.id}:4`);
		assert.ok(escalateItem, "Expected post #4 escalate item");
		assert.match(escalateItem.excerpt, /@coordinator/);

		const monitorItem = boardEvidence.find((item) => item.id.startsWith(`board_friction:monitor:${boardMatter.id}:`));
		assert.ok(monitorItem, "Expected monitor_alert evidence item");
		assert.match(monitorItem.excerpt, /targetAgentId=builder-api/);
		assert.match(monitorItem.excerpt, /nudgeCount=2/);
		assert.match(monitorItem.excerpt, /reason=silent_stall_nudge/);

		const formatted = formatTeamHealthEvidence(evidence);
		assert.match(formatted, /board_friction:coe_summary/);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("collectTeamHealthEvidence strictly enforces ACL for board friction (excludes private, other-org, and restricted-workspace matters)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pa-board-coe-acl-"));
	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db);
	const templates = await loadRoleTemplatesFromDir(resolve("roles"));
	const templatesById = new Map(templates.map((t) => [t.id, t]));

	try {
		const orgA = store.upsertOrganization({ id: "org-a", name: "Org A" });
		const orgB = store.upsertOrganization({ id: "org-b", name: "Org B" });
		const wsOrgA = store.upsertWorkspace({
			name: "ws-org-a",
			repoPath: join(dir, "ws-org-a"),
			orgId: orgA.id,
			visibility: "org",
		});
		const wsRestricted = store.upsertWorkspace({
			name: "ws-restricted",
			repoPath: join(dir, "ws-restricted"),
			orgId: orgA.id,
			visibility: "restricted",
		});
		const wsOrgB = store.upsertWorkspace({
			name: "ws-org-b",
			repoPath: join(dir, "ws-org-b"),
			orgId: orgB.id,
			visibility: "org",
		});

		// 1. Visible Org A matter
		const visibleMatter = store.createMatter({
			title: "Visible Org A Board",
			collaborationMode: "board",
			orgId: orgA.id,
			workspaceId: wsOrgA.id,
			visibility: "org",
		});
		store.createBoardPost({
			matterId: visibleMatter.id,
			authorType: "agent",
			authorId: "verifier-visible",
			kind: "verify_rework",
			mentions: ["builder-visible"],
			summary: "VISIBLE_REWORK_SIGNAL",
			orgId: orgA.id,
			workspaceId: wsOrgA.id,
		});

		// 2. Private matter in Org A (MUST be excluded)
		const privateMatter = store.createMatter({
			title: "Private Org A Board",
			collaborationMode: "board",
			orgId: orgA.id,
			workspaceId: wsOrgA.id,
			visibility: "private",
		});
		store.createBoardPost({
			matterId: privateMatter.id,
			authorType: "agent",
			authorId: "verifier-priv",
			kind: "verify_rework",
			mentions: ["builder-priv"],
			summary: "SECRET_PRIVATE_REWORK",
			orgId: orgA.id,
			workspaceId: wsOrgA.id,
		});
		store.appendEvent({
			matterId: privateMatter.id,
			runId: "run-priv",
			agentId: "builder-priv",
			eventType: "monitor_alert",
			payload: { targetAgentId: "builder-priv", nudgeCount: 3, reason: "SECRET_PRIVATE_STALL" },
		});

		// 3. Other-org matter in Org B (MUST be excluded when scoped to Org A)
		const otherOrgMatter = store.createMatter({
			title: "Other Org B Board",
			collaborationMode: "board",
			orgId: orgB.id,
			workspaceId: wsOrgB.id,
			visibility: "org",
		});
		store.createBoardPost({
			matterId: otherOrgMatter.id,
			authorType: "agent",
			authorId: "verifier-orgb",
			kind: "escalate",
			mentions: ["coordinator"],
			summary: "SECRET_ORGB_ESCALATE",
			orgId: orgB.id,
			workspaceId: wsOrgB.id,
		});

		// 4. Restricted-workspace matter in Org A (MUST be excluded)
		const restrictedWsMatter = store.createMatter({
			title: "Restricted WS Board",
			collaborationMode: "board",
			orgId: orgA.id,
			workspaceId: wsRestricted.id,
			visibility: "org",
		});
		store.createBoardPost({
			matterId: restrictedWsMatter.id,
			authorType: "agent",
			authorId: "verifier-restr",
			kind: "verify_rework",
			mentions: ["builder-restr"],
			summary: "SECRET_RESTRICTED_WS_REWORK",
			orgId: orgA.id,
			workspaceId: wsRestricted.id,
		});

		// 5. Post tagged with restricted workspace inside visible matter (defensive exclusion)
		store.createBoardPost({
			matterId: visibleMatter.id,
			authorType: "agent",
			authorId: "verifier-leak",
			kind: "escalate",
			mentions: ["coordinator"],
			summary: "SECRET_POST_RESTRICTED_WS",
			orgId: orgA.id,
			workspaceId: wsRestricted.id,
		});

		const evidenceOrgA = collectTeamHealthEvidence(store, templatesById, { orgId: orgA.id });
		const serialized = JSON.stringify(evidenceOrgA);

		assert.ok(serialized.includes("VISIBLE_REWORK_SIGNAL"), "Org-visible board friction must be ingested");
		assert.equal(serialized.includes("SECRET_PRIVATE_REWORK"), false, "Private matter rework must be excluded");
		assert.equal(serialized.includes("SECRET_PRIVATE_STALL"), false, "Private matter monitor_alert must be excluded");
		assert.equal(serialized.includes("SECRET_ORGB_ESCALATE"), false, "Other-org matter escalate must be excluded");
		assert.equal(
			serialized.includes("SECRET_RESTRICTED_WS_REWORK"),
			false,
			"Restricted-workspace matter rework must be excluded",
		);
		assert.equal(
			serialized.includes("SECRET_POST_RESTRICTED_WS"),
			false,
			"Board post referencing restricted workspace must be excluded",
		);

		const allowedOrgsEvidence = collectTeamHealthEvidence(store, templatesById, {
			allowedOrgIds: new Set([orgA.id]),
		});
		assert.equal(
			JSON.stringify(allowedOrgsEvidence).includes("SECRET_ORGB_ESCALATE"),
			false,
			"allowedOrgIds scope must also exclude Org B board friction",
		);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("buildSessionInsightsReport supports optional boardSignals without breaking existing callers", () => {
	const dir = mkdtempSync(join(tmpdir(), "pa-insights-board-"));
	try {
		const sessPath = join(dir, "s1.jsonl");
		writeFileSync(
			sessPath,
			`${[
				JSON.stringify({ type: "session", id: "s1", timestamp: "2026-11-27T00:00:00Z" }),
				JSON.stringify({ type: "message", message: { role: "user", content: "Inspect board work" } }),
				JSON.stringify({
					type: "message",
					message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
				}),
			].join("\n")}\n`,
			"utf8",
		);

		// Without boardInputs -> boardSignals is omitted (backward-compatible)
		const plainReport = buildSessionInsightsReport([{ sessionFile: sessPath }]);
		assert.equal(plainReport.boardSignals, undefined);
		assert.equal(
			plainReport.findings.some((f) => f.kind === "board_friction"),
			false,
		);

		// With boardInputs -> boardSignals aggregated + deterministic board_friction findings + Markdown output
		const withBoardReport = buildSessionInsightsReport([{ sessionFile: sessPath }], {
			boardInputs: [
				{
					matterId: "mat_1",
					matterTitle: "Board Matter 1",
					reworkPosts: [
						{
							postNo: 2,
							authorId: "verifier",
							mentions: ["builder-1"],
							summary: "Tests failed on edge case",
							target: "src/math.mjs",
						},
						{
							postNo: 4,
							authorId: "verifier",
							mentions: ["builder-1"],
							summary: "RangeError missing for min > max",
							target: "src/math.mjs",
						},
					],
					escalatePosts: [
						{
							postNo: 5,
							authorId: "monitor",
							mentions: ["coordinator"],
							summary: "Builder stalled after 2 nudges",
						},
					],
					monitorAlerts: [
						{ targetAgentId: "builder-1", nudgeCount: 1, reason: "silent_stall_nudge" },
						{ targetAgentId: "builder-1", nudgeCount: 2, reason: "silent_stall_nudge" },
					],
				},
			],
		});

		assert.deepEqual(withBoardReport.boardSignals, {
			reworkCount: 2,
			escalateCount: 1,
			monitorAlertCount: 2,
			mattersWithBoardFriction: 1,
		});
		const boardFindings = withBoardReport.findings.filter((f) => f.kind === "board_friction");
		assert.equal(boardFindings.length, 3);
		assert.ok(boardFindings.every((f) => f.suggestSkillCapture === true));

		const md = formatSessionInsightsMarkdown(withBoardReport);
		assert.match(md, /公告板协同摩擦：返工 2 次 · 升级 1 次 · 停滞告警 2 次（涉及 1 个事项）/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("demo:board CLI arg parser, summary formatter, and offline --dry-run work cleanly without external APIs", async () => {
	assert.match(BOARD_SMOKE_HELP_TEXT, /demo:board/);
	assert.match(BOARD_SMOKE_HELP_TEXT, /--dry-run/);

	assert.deepEqual(parseBoardSmokeArgs(["--help"]), { help: true, dryRun: false });
	assert.deepEqual(
		parseBoardSmokeArgs([
			"--dry-run",
			"--provider",
			"anthropic",
			"--model",
			"claude-sonnet-4",
			"--verifier-provider",
			"openai",
			"--verifier-model",
			"gpt-5.2",
			"--silence-ms",
			"15000",
		]),
		{
			help: false,
			dryRun: true,
			provider: "anthropic",
			model: "claude-sonnet-4",
			verifierProvider: "openai",
			verifierModel: "gpt-5.2",
			silenceMs: 15000,
		},
	);
	assert.throws(() => parseBoardSmokeArgs(["--provider", "anthropic"]), /Pass both --provider and --model/);
	assert.throws(() => parseBoardSmokeArgs(["--verifier-model", "gpt-5.2"]), /Pass both --verifier-provider/);
	assert.throws(() => parseBoardSmokeArgs(["--silence-ms", "0"]), /positive number/);

	// Dry-run executes fully offline, isolates temp dir, and cleans up automatically
	const dryReport = await runBoardSmoke({ dryRun: true });
	assert.equal(dryReport.ok, true);
	assert.equal(dryReport.dryRun, true);
	assert.equal(dryReport.summary.collaborationMode, "board");
	assert.equal(dryReport.launches.length, 0);
	assert.equal(dryReport.directory.includes(".data"), false, "demo:board must never use .data/");
	assert.equal(existsSync(dryReport.directory), false, "Temp directory must be cleaned up after dry-run");

	// Verify summarizeBoardRun + formatBoardSmokeSummary + collectBoardFrictionSignals on synthetic board run
	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db);
	try {
		const org = store.ensureDefaultOrganization();
		store.upsertMember({
			id: "product-manager",
			templateId: "product-manager",
			displayName: "Product Manager",
			roleTitle: "Product Manager",
			isPrimaryContact: true,
			keywords: [],
		});
		const matter = store.createMatter({
			title: "Synthetic Board Run",
			collaborationMode: "board",
			coordinatorMemberId: "product-manager",
			orgId: org.id,
		});
		store.upsertBoardMember({
			matterId: matter.id,
			agentId: "coordinator",
			displayName: "Coordinator",
			boardRole: "coordinator",
			status: "waiting",
			lastReadPostNo: 3,
		});
		store.upsertBoardMember({
			matterId: matter.id,
			agentId: "builder-math",
			displayName: "Math Builder",
			boardRole: "builder",
			ownedScope: ["src/math.mjs"],
			status: "waiting",
			lastReadPostNo: 2,
		});
		store.upsertBoardMember({
			matterId: matter.id,
			agentId: "verifier-math",
			displayName: "Math Verifier",
			boardRole: "verifier",
			ownedScope: ["test/math.test.mjs"],
			status: "waiting",
			lastReadPostNo: 2,
		});
		store.createBoardPost({
			matterId: matter.id,
			authorType: "agent",
			authorId: "coordinator",
			kind: "assign",
			mentions: ["builder-math"],
			summary: "Fix clamp() in src/math.mjs",
		});
		store.createBoardPost({
			matterId: matter.id,
			authorType: "agent",
			authorId: "builder-math",
			kind: "handoff",
			mentions: ["verifier-math"],
			refPostNos: [1],
			summary: "Fixed clamp() and added RangeError guard",
		});
		store.createBoardPost({
			matterId: matter.id,
			authorType: "agent",
			authorId: "verifier-math",
			kind: "verify_pass",
			mentions: ["coordinator"],
			refPostNos: [2],
			summary: "All tests pass cleanly",
			verification: { target: "src/math.mjs", criteria: "node --test passes", verdict: "pass" },
		});
		store.appendEvent({
			matterId: matter.id,
			runId: "r1",
			agentId: "builder-math",
			eventType: "tool_start",
			payload: { tool: "edit" },
		});
		store.appendEvent({
			matterId: matter.id,
			runId: "r1",
			agentId: "builder-math",
			eventType: "tool_end",
			payload: { tool: "edit" },
		});

		const summary = summarizeBoardRun(store, matter.id);
		assert.equal(summary.hasBuilder, true);
		assert.equal(summary.hasVerifier, true);
		assert.equal(summary.hasHandoff, true);
		assert.equal(summary.hasVerificationVerdict, true);
		assert.equal(summary.verificationVerdict, "pass");
		assert.equal(summary.totalEvents, 2);
		assert.equal(summary.eventCounts.tool_start, 1);
		assert.equal(summary.eventCounts.tool_end, 1);

		const text = formatBoardSmokeSummary(summary);
		assert.match(text, /lastReadPostNo=3/);
		assert.match(text, /#1 \[assign\]/);
		assert.match(text, /#2 \[handoff\]/);
		assert.match(text, /#3 \[verify_pass\]/);
		assert.match(text, /tool_end=1, tool_start=1/);

		// Clean run without rework/escalate/monitor_alert produces zero friction
		const cleanFriction = collectBoardFrictionSignals(store, [matter]);
		assert.equal(cleanFriction.evidence.length, 0);
		assert.equal(cleanFriction.summary.reworkCount, 0);
	} finally {
		db.close();
	}
});
