import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { readSkillProposals } from "@pa/contracts/skill-proposal";
import { TeamOrchestrator } from "../packages/server/src/orchestrator/team-orchestrator.ts";
import { SkillNameConflictError, saveSkillProposalToDisk } from "../packages/server/src/roles/role-package-store.ts";
import { loadRoleTemplatesFromDir } from "../packages/server/src/roles/template-loader.ts";
import { createTeamToolBridge } from "../packages/server/src/rpc/team-tool-bridge.ts";
import { createPersonalAgentServer } from "../packages/server/src/server/app.ts";
import { DialogBroker } from "../packages/server/src/server/dialog-broker.ts";
import { PreviewManager } from "../packages/server/src/server/preview-manager.ts";
import { openPersonalAgentDatabase } from "../packages/server/src/storage/database.ts";
import { PersonalAgentStore } from "../packages/server/src/storage/repositories.ts";

test("team-tool-bridge validates propose_skill arguments and rejects unsafe script paths", async () => {
	const received: unknown[] = [];
	const bridge = await createTeamToolBridge(async (call) => {
		received.push(call);
		return { ok: true };
	}, new AbortController().signal);
	try {
		const okRes = await fetch(`${bridge.env.PA_TEAM_BRIDGE_URL}/tool`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${bridge.env.PA_TEAM_BRIDGE_TOKEN}`,
			},
			body: JSON.stringify({
				tool: "propose_skill",
				callId: "c1",
				args: {
					name: "release-preflight",
					description: "Run release preflight checks",
					body: "# Steps\n1. Run check",
					storageScope: "workspace",
					rationale: "Avoid forgetting release checks",
					scripts: [{ path: "scripts/preflight.mjs", content: "console.log('ok');\n", executable: true }],
				},
			}),
		});
		assert.equal(okRes.status, 200);
		assert.equal(received.length, 1);

		const badRes = await fetch(`${bridge.env.PA_TEAM_BRIDGE_URL}/tool`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${bridge.env.PA_TEAM_BRIDGE_TOKEN}`,
			},
			body: JSON.stringify({
				tool: "propose_skill",
				callId: "c2",
				args: {
					name: "release-preflight",
					description: "Bad path",
					body: "# Steps",
					storageScope: "workspace",
					rationale: "Test traversal block",
					scripts: [{ path: "../evil.sh", content: "echo nope" }],
				},
			}),
		});
		assert.equal(badRes.status, 400);
	} finally {
		await bridge.close();
	}
});

test("saveSkillProposalToDisk writes SKILL.md + executable scripts and HTTP route applies/dismisses proposals", async () => {
	const tmp = mkdtempSync(join(tmpdir(), "pa-skill-proposal-"));
	const skillsDir = join(tmp, "skills");
	const workspaceDir = join(tmp, "repo");
	const db = openPersonalAgentDatabase(join(tmp, "agent.db"));
	const store = new PersonalAgentStore(db);
	const templates = await loadRoleTemplatesFromDir(resolve("roles"));
	const orchestrator = new TeamOrchestrator({ store, templates, defaultCwd: tmp, noSession: true });
	const dialogBroker = new DialogBroker();
	const previewManager = new PreviewManager();
	const { server } = createPersonalAgentServer({
		store,
		orchestrator,
		templates,
		previewManager,
		dialogBroker,
		webDistDir: resolve("apps/web/dist"),
		skillsDir,
		dataDir: tmp,
		requireAuth: false,
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const addr = server.address();
	assert.ok(addr && typeof addr !== "string");
	const baseUrl = `http://127.0.0.1:${addr.port}`;

	try {
		// Direct disk writer check (SKILL.md + executable script + conflict rejection)
		const saved = await saveSkillProposalToDisk({
			proposal: {
				name: "repo-health",
				description: "Check repo health",
				body: "## Steps\nRun scripts/check.mjs",
				scripts: [
					{ path: "scripts/check.mjs", content: "#!/usr/bin/env node\nconsole.log('ok');\n", executable: true },
				],
			},
			storageScope: "workspace",
			workspaceRepoPath: workspaceDir,
		});
		assert.equal(saved.writtenPaths.length, 2);
		assert.ok(existsSync(join(workspaceDir, ".agents/skills/repo-health/SKILL.md")));
		assert.match(
			readFileSync(join(workspaceDir, ".agents/skills/repo-health/SKILL.md"), "utf8"),
			/name: repo-health/,
		);
		const scriptStat = statSync(join(workspaceDir, ".agents/skills/repo-health/scripts/check.mjs"));
		if (process.platform !== "win32") assert.ok((scriptStat.mode & 0o111) !== 0);

		await assert.rejects(
			() =>
				saveSkillProposalToDisk({
					proposal: { name: "repo-health", description: "dup", body: "dup" },
					storageScope: "workspace",
					workspaceRepoPath: workspaceDir,
				}),
			SkillNameConflictError,
		);

		// HTTP route apply & dismiss check
		const org = store.ensureDefaultOrganization();
		const matter = store.createMatter({ title: "Skill proposal flow", orgId: org.id });
		const msg = store.appendMessage({
			matterId: matter.id,
			channel: "user",
			senderType: "member",
			senderId: "engineering-manager",
			content: "我整理了两个可复用技能提案。",
			metadata: {
				skillProposals: [
					{
						id: "skp_1",
						name: "ci-triage",
						description: "Triage CI failures",
						body: "1. Read logs\n2. Group root causes",
						scripts: [{ path: "scripts/parse.mjs", content: "export const ok = true;\n" }],
						storageScope: "global",
						rationale: "Repeatable CI triage",
						status: "pending",
					},
					{
						id: "skp_2",
						name: "skip-me",
						description: "Dismiss test",
						body: "noop",
						storageScope: "global",
						rationale: "Dismiss test",
						status: "pending",
					},
				],
			},
		});

		const applyRes = await fetch(`${baseUrl}/api/matters/${matter.id}/messages/${msg.id}/skill-proposals`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ proposalId: "skp_1", action: "apply" }),
		});
		assert.equal(applyRes.status, 200);
		const appliedBody = (await applyRes.json()) as {
			writtenPaths: string[];
			message: { metadata: Record<string, unknown> };
		};
		assert.equal(appliedBody.writtenPaths.length, 2);
		assert.ok(existsSync(join(skillsDir, "global/ci-triage/SKILL.md")));
		assert.ok(existsSync(join(skillsDir, "global/ci-triage/scripts/parse.mjs")));

		const dismissRes = await fetch(`${baseUrl}/api/matters/${matter.id}/messages/${msg.id}/skill-proposals`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ proposalId: "skp_2", action: "dismiss" }),
		});
		assert.equal(dismissRes.status, 200);
		const finalProposals = readSkillProposals(store.getMessage(msg.id)?.metadata);
		assert.equal(finalProposals.find((p) => p.id === "skp_1")?.status, "applied");
		assert.equal(finalProposals.find((p) => p.id === "skp_2")?.status, "dismissed");
	} finally {
		await new Promise<void>((r) => server.close(() => r()));
		await orchestrator.shutdown();
		db.close();
		rmSync(tmp, { recursive: true, force: true });
	}
});
