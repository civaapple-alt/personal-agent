import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { collectTeamHealthEvidence } from "../packages/server/src/orchestrator/rsi/team-health.ts";
import { loadRoleTemplatesFromDir } from "../packages/server/src/roles/template-loader.ts";
import { openPersonalAgentDatabase } from "../packages/server/src/storage/database.ts";
import { PersonalAgentStore } from "../packages/server/src/storage/repositories.ts";

test("collectTeamHealthEvidence feeds scoped Pi session-insights findings and Four-Step Trust skill telemetry into RSI healthchecks", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pa-rsi-health-insights-"));
	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db);
	const templates = await loadRoleTemplatesFromDir(resolve("roles"));
	const templatesById = new Map(templates.map((t) => [t.id, t]));

	try {
		const orgA = store.upsertOrganization({ id: "org-a", name: "Org A" });
		const orgB = store.upsertOrganization({ id: "org-b", name: "Org B" });
		const wsA = store.upsertWorkspace({ name: "ws-a", repoPath: dir, orgId: orgA.id });

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

		// Create a real Pi JSONL session with a repeated failing bash command (triggers failing_command insight)
		const sessionA = join(dir, "session-a.jsonl");
		const lines = [
			JSON.stringify({ type: "session", id: "sess-a", cwd: dir, timestamp: "2026-11-24T00:00:00.000Z" }),
			JSON.stringify({
				type: "message",
				timestamp: "2026-11-24T00:00:01.000Z",
				message: { role: "user", content: "run build" },
			}),
			...[1, 2, 3].flatMap((n) => [
				JSON.stringify({
					type: "message",
					timestamp: `2026-11-24T00:00:0${n + 1}.000Z`,
					message: {
						role: "assistant",
						content: [
							{ type: "toolCall", id: `c${n}`, name: "bash", arguments: { command: "npm run broken-script" } },
						],
					},
				}),
				JSON.stringify({
					type: "message",
					timestamp: `2026-11-24T00:00:0${n + 1}.500Z`,
					message: {
						role: "toolResult",
						toolCallId: `c${n}`,
						toolName: "bash",
						isError: true,
						content: [{ type: "text", text: "Missing script: broken-script" }],
					},
				}),
			]),
		];
		writeFileSync(sessionA, `${lines.join("\n")}\n`, "utf8");

		const matterA = store.createMatter({
			title: "Org A Matter",
			leadMemberId: "engineering-manager",
			workspaceId: wsA.id,
			orgId: orgA.id,
		});
		store.recordWorkerSession({
			matterId: matterA.id,
			memberId: "engineering-manager",
			workspaceId: wsA.id,
			piSessionId: "sess-a",
			sessionFile: sessionA,
			status: "idle",
		});

		// Seed Skill trust policies: Org A confirm skill with 3 runs (ready for Step 4), and Org B skill (must be isolated!)
		store.skillTrust.recordExecution({
			scope: "org",
			scopeId: orgA.id,
			skillName: "release-check",
			outcome: "confirmed_once",
		});
		store.skillTrust.recordExecution({
			scope: "org",
			scopeId: orgA.id,
			skillName: "release-check",
			outcome: "confirmed_once",
		});
		store.skillTrust.recordExecution({
			scope: "org",
			scopeId: orgB.id,
			skillName: "secret-org-b-skill",
			outcome: "confirmed_once",
		});

		const evidenceA = collectTeamHealthEvidence(store, templatesById, { orgId: orgA.id });
		assert.ok(
			evidenceA.some((item) => item.kind === "insight" && item.id.includes("failing_command")),
			"Expected deterministic Pi session-insights failing_command finding in Org A health evidence",
		);
		const skillEvidence = evidenceA.find((item) => item.kind === "skill_trust" && item.sourceId === "release-check");
		assert.ok(skillEvidence, "Expected Org A skill_trust telemetry in health evidence");
		assert.match(skillEvidence.excerpt, /升级步骤 4 自主执行/);
		assert.equal(
			evidenceA.some((item) => item.sourceId === "secret-org-b-skill"),
			false,
			"Org B skill_trust policy must not leak into Org A health evidence",
		);
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
