import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { SessionInsightsReport } from "@pa/contracts/session-insights";
import {
	buildSessionInsightsReport,
	formatSessionInsightsMarkdown,
	redactInsightText,
} from "../packages/server/src/orchestrator/runtime/session-insights.ts";
import { TeamOrchestrator } from "../packages/server/src/orchestrator/team-orchestrator.ts";
import { loadRoleTemplatesFromDir } from "../packages/server/src/roles/template-loader.ts";
import { createPersonalAgentServer } from "../packages/server/src/server/app.ts";
import { DialogBroker } from "../packages/server/src/server/dialog-broker.ts";
import { PreviewManager } from "../packages/server/src/server/preview-manager.ts";
import { openPersonalAgentDatabase } from "../packages/server/src/storage/database.ts";
import { PersonalAgentStore } from "../packages/server/src/storage/repositories.ts";

function writeJsonl(filePath: string, entries: unknown[]): void {
	writeFileSync(filePath, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
}

test("redactInsightText masks home paths, tokens, URL credentials, private keys, and emails", () => {
	const home = "/Users/alice";
	const raw =
		"File /Users/alice/code/app.ts failed with Bearer tok_secret_1234567890 sk-abcdefghijklmnop https://bob:pass@git.example.com and alice@example.com";
	const masked = redactInsightText(raw, home);
	assert.ok(masked.includes("~/code/app.ts"));
	assert.ok(!masked.includes("/Users/alice"));
	assert.ok(!masked.includes("tok_secret_1234567890"));
	assert.ok(!masked.includes("sk-abcdefghijklmnop"));
	assert.ok(!masked.includes("bob:pass"));
	assert.ok(!masked.includes("alice@example.com"));
});

test("session-insights detects failing commands, unused skills, rework, repeated calls, unverified claims, and repeated instructions", () => {
	const tmp = mkdtempSync(join(tmpdir(), "pa-insights-"));
	try {
		const s1 = join(tmp, "sess-1.jsonl");
		const s2 = join(tmp, "sess-2.jsonl");
		const skillListing =
			"<available_skills><skill><name>used-skill</name></skill><skill><name>zombie-skill</name></skill></available_skills>";

		writeJsonl(s1, [
			{ type: "session", id: "sess-1", timestamp: "2026-11-24T10:00:00Z" },
			{
				type: "message",
				timestamp: "2026-11-24T10:00:01Z",
				message: {
					role: "user",
					content: `${skillListing}\nPlease generate the weekly release preflight checklist for this repo`,
				},
			},
			{
				type: "message",
				timestamp: "2026-11-24T10:00:05Z",
				message: {
					role: "assistant",
					provider: "anthropic",
					model: "claude-sonnet",
					usage: { input: 2000, output: 300, cacheRead: 1000, cacheWrite: 200, cost: { total: 0.12 } },
					content: [
						{ type: "toolCall", id: "c1", name: "load_available_skill", arguments: { name: "used-skill" } },
						{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "npm run lint" } },
						{ type: "toolCall", id: "c3", name: "bash", arguments: { command: "npm run lint" } },
						{ type: "toolCall", id: "c4", name: "bash", arguments: { command: "npm run lint" } },
						{ type: "toolCall", id: "c5", name: "edit", arguments: { path: "src/app.ts" } },
						{ type: "toolCall", id: "c6", name: "edit", arguments: { path: "src/app.ts" } },
						{ type: "toolCall", id: "c7", name: "edit", arguments: { path: "src/app.ts" } },
						{ type: "toolCall", id: "c8", name: "edit", arguments: { path: "src/app.ts" } },
						{ type: "toolCall", id: "c9", name: "edit", arguments: { path: "src/app.ts" } },
						{ type: "text", text: "Done! All tests passed cleanly." },
					],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "c2",
					toolName: "bash",
					isError: true,
					content: [{ type: "text", text: "Biome error on token sk-1234567890abcdef" }],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "c3",
					toolName: "bash",
					isError: true,
					content: [{ type: "text", text: "Biome error again" }],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "c4",
					toolName: "bash",
					isError: false,
					content: [{ type: "text", text: "OK" }],
				},
			},
		]);

		writeJsonl(s2, [
			{ type: "session", id: "sess-2", timestamp: "2026-11-24T11:00:00Z" },
			{
				type: "message",
				timestamp: "2026-11-24T11:00:01Z",
				message: {
					role: "user",
					content: `${skillListing}\nPlease generate the weekly release preflight checklist for this repo`,
				},
			},
			{
				type: "message",
				timestamp: "2026-11-24T11:00:05Z",
				message: {
					role: "assistant",
					provider: "anthropic",
					model: "claude-sonnet",
					usage: { input: 1500, output: 200, cacheRead: 500, cacheWrite: 0, cost: { total: 0.08 } },
					content: [{ type: "text", text: "Checklist ready." }],
				},
			},
		]);

		const report = buildSessionInsightsReport([
			{ sessionFile: s1, memberId: "engineering-manager", memberName: "研发经理" },
			{ sessionFile: s2, memberId: "engineering-manager", memberName: "研发经理" },
		]);

		assert.equal(report.usage.sessions, 2);
		assert.equal(report.usage.toolCalls, 9);
		assert.equal(report.usage.toolErrors, 2);
		assert.equal(report.usage.totalCostUsd, 0.2);

		const kinds = new Set(report.findings.map((f) => f.kind));
		assert.ok(kinds.has("failing_command"));
		assert.ok(kinds.has("unused_skill"));
		assert.ok(kinds.has("file_rework"));
		assert.ok(kinds.has("repeated_tool_call"));
		assert.ok(kinds.has("unverified_claim"));
		assert.ok(kinds.has("repeated_instruction"));

		const failing = report.findings.find((f) => f.kind === "failing_command");
		assert.equal(failing?.suggestSkillCapture, true);
		assert.ok(!JSON.stringify(failing).includes("sk-1234567890abcdef"));

		const unused = report.findings.find((f) => f.kind === "unused_skill");
		assert.ok(unused?.detail.includes("zombie-skill"));
		assert.ok(!unused?.detail.includes("used-skill"));

		const md = formatSessionInsightsMarkdown(report);
		assert.match(md, /确定性会话洞察/);
		assert.match(md, /建议沉淀为 Skill/);

		// Verify standalone self-inspect CLI script produces matching JSON
		const cliPath = resolve("pa-extensions/self-inspect/skills/pa-self-inspection/scripts/session-insights.mjs");
		const cliOut = execFileSync(process.execPath, [cliPath, "--dir", tmp, "--json"], { encoding: "utf8" });
		const cliJson = JSON.parse(cliOut) as { sessions: number; findings: Array<{ kind: string }> };
		assert.equal(cliJson.sessions, 2);
		assert.ok(cliJson.findings.some((f) => f.kind === "failing_command"));
		assert.ok(cliJson.findings.some((f) => f.kind === "unused_skill"));
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("GET /api/runtime/insights enforces matter ACL and returns scoped deterministic report", async () => {
	const tmp = mkdtempSync(join(tmpdir(), "pa-insights-http-"));
	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db);
	const templates = await loadRoleTemplatesFromDir(resolve("roles"));
	const orchestrator = new TeamOrchestrator({ store, templates, sessionDir: join(tmp, "sessions") });
	const { server } = createPersonalAgentServer({
		store,
		orchestrator,
		templates,
		previewManager: new PreviewManager(),
		dialogBroker: new DialogBroker(),
		rolesDir: resolve("roles"),
		webDistDir: join(tmp, "web-dist"),
		requireAuth: false,
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const addr = server.address();
	assert.ok(addr && typeof addr !== "string");
	const baseUrl = `http://127.0.0.1:${addr.port}`;

	try {
		const org = store.ensureDefaultOrganization();
		const matter = store.createMatter({ title: "Insights HTTP test", orgId: org.id });
		const sessionFile = join(tmp, "pi-http-1.jsonl");
		writeJsonl(sessionFile, [
			{ type: "session", id: "pi-http-1", timestamp: "2026-11-24T12:00:00Z" },
			{ type: "message", message: { role: "user", content: "Inspect runtime behavior" } },
			{
				type: "message",
				message: {
					role: "assistant",
					provider: "anthropic",
					model: "claude-sonnet",
					usage: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0, cost: { total: 0.02 } },
					content: [{ type: "text", text: "All good." }],
				},
			},
		]);
		store.recordWorkerSession({
			memberId: "engineering-manager",
			matterId: matter.id,
			workspaceId: null,
			piSessionId: "pi-http-1",
			sessionFile,
			status: "idle",
		});

		const res = await fetch(`${baseUrl}/api/runtime/insights?matterId=${encodeURIComponent(matter.id)}`);
		assert.equal(res.status, 200);
		const body = (await res.json()) as SessionInsightsReport;
		assert.equal(body.scope.matterId, matter.id);
		assert.equal(body.usage.sessions, 1);
		assert.equal(body.recentSessions[0]?.memberId, "engineering-manager");

		const notFound = await fetch(`${baseUrl}/api/runtime/insights?matterId=mat_missing`);
		assert.equal(notFound.status, 404);
	} finally {
		await new Promise<void>((r) => server.close(() => r()));
		await orchestrator.shutdown();
		db.close();
		rmSync(tmp, { recursive: true, force: true });
	}
});
