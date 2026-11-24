import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import skillCaptureExtension from "../pa-extensions/skill-capture/pi/index.ts";
import { matchManagedSkillScriptCall } from "../pa-extensions/skill-capture/pi/skill-trust-gate.ts";
import {
	createPersonalAgentServer,
	DialogBroker,
	loadRoleTemplatesFromDir,
	openPersonalAgentDatabase,
	PersonalAgentStore,
	PreviewManager,
	TeamOrchestrator,
} from "../packages/server/src/index.ts";

test("matchManagedSkillScriptCall detects scripts under workspace/org/personal Skill roots and ignores unrelated bash commands", () => {
	const roots = [
		{ root: "/data/skills/users/u1", scope: "personal" as const, scopeId: "u1" },
		{ root: "/repo/.agents/skills", scope: "workspace" as const, scopeId: "ws1" },
	];

	const m1 = matchManagedSkillScriptCall(
		"node /data/skills/users/u1/release-check/scripts/preflight.mjs --fast",
		roots,
		"/repo",
	);
	assert.deepEqual(m1, {
		scope: "personal",
		scopeId: "u1",
		skillName: "release-check",
		scriptRelPath: "scripts/preflight.mjs",
		policyKey: "personal:u1:release-check",
	});

	const m2 = matchManagedSkillScriptCall("bash .agents/skills/repo-lint/scripts/check.sh", roots, "/repo");
	assert.deepEqual(m2, {
		scope: "workspace",
		scopeId: "ws1",
		skillName: "repo-lint",
		scriptRelPath: "scripts/check.sh",
		policyKey: "workspace:ws1:repo-lint",
	});

	assert.equal(matchManagedSkillScriptCall("npm test && git status", roots, "/repo"), null);
});

test("skillCaptureExtension tool_call gate blocks disabled, confirms step 3, and allows autonomous step 4", async () => {
	const prevRoots = process.env.PA_MANAGED_SKILL_ROOTS;
	const prevPolicies = process.env.PA_SKILL_TRUST_POLICIES;
	process.env.PA_MANAGED_SKILL_ROOTS = JSON.stringify([
		{ root: "/tmp/skills/users/u1", scope: "personal", scopeId: "u1" },
	]);
	process.env.PA_SKILL_TRUST_POLICIES = JSON.stringify({
		"personal:u1:blocked-skill": "disabled",
		"personal:u1:auto-skill": "autonomous",
		"personal:u1:confirm-skill": "confirm",
	});

	try {
		let toolCallHandler:
			| ((
					event: { toolName: string; toolCallId?: string; input: Record<string, unknown> },
					ctx?: { cwd?: string; ui?: { select?(t: string, opts: string[]): Promise<string | undefined> } },
			  ) => Promise<{ block: true; reason: string } | undefined> | { block: true; reason: string } | undefined)
			| undefined;

		skillCaptureExtension({
			registerTool() {},
			on(event, handler) {
				if (event === "tool_call") toolCallHandler = handler;
			},
		});
		assert.ok(toolCallHandler);

		// Disabled skill is blocked immediately
		const disabledRes = await toolCallHandler({
			toolName: "bash",
			input: { command: "node /tmp/skills/users/u1/blocked-skill/scripts/run.mjs" },
		});
		assert.equal(disabledRes?.block, true);
		assert.match(disabledRes?.reason ?? "", /disabled by trust policy/);

		// Autonomous skill passes without prompting
		let prompted = false;
		const autoRes = await toolCallHandler(
			{ toolName: "bash", input: { command: "node /tmp/skills/users/u1/auto-skill/scripts/run.mjs" } },
			{
				ui: {
					async select() {
						prompted = true;
						return undefined;
					},
				},
			},
		);
		assert.equal(autoRes, undefined);
		assert.equal(prompted, false);

		// Confirm skill prompts and blocks when user denies
		const denyRes = await toolCallHandler(
			{ toolName: "bash", input: { command: "node /tmp/skills/users/u1/confirm-skill/scripts/run.mjs" } },
			{
				ui: {
					async select() {
						return "拒绝执行";
					},
				},
			},
		);
		assert.equal(denyRes?.block, true);

		// Confirm skill allows when user chooses allow once
		const allowOnceRes = await toolCallHandler(
			{ toolName: "bash", input: { command: "node /tmp/skills/users/u1/confirm-skill/scripts/run.mjs" } },
			{
				ui: {
					async select() {
						return "仅本次允许执行";
					},
				},
			},
		);
		assert.equal(allowOnceRes, undefined);
	} finally {
		if (prevRoots === undefined) delete process.env.PA_MANAGED_SKILL_ROOTS;
		else process.env.PA_MANAGED_SKILL_ROOTS = prevRoots;
		if (prevPolicies === undefined) delete process.env.PA_SKILL_TRUST_POLICIES;
		else process.env.PA_SKILL_TRUST_POLICIES = prevPolicies;
	}
});

test("GET/PATCH /api/skills/trust lists scoped disk Skills and enforces trust policy RBAC", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pa-skill-trust-http-"));
	const skillsDir = join(dir, "skills");
	const repoDir = join(dir, "repo");
	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db);
	const templates = await loadRoleTemplatesFromDir(resolve("roles"));
	const previewManager = new PreviewManager();
	const dialogBroker = new DialogBroker();
	const orchestrator = new TeamOrchestrator({ store, templates, skillsDir, defaultCwd: repoDir, noSession: true });

	const org = store.ensureDefaultOrganization();
	const admin = store.ensureLocalBootstrapAdmin("Owner");
	store.upsertOrgMember({ orgId: org.id, userId: admin.id, orgRole: "org_owner" });
	const ws = store.upsertWorkspace({ name: "demo-repo", repoPath: repoDir, orgId: org.id });

	// Seed a workspace skill with script and a personal skill
	mkdirSync(join(repoDir, ".agents/skills/repo-preflight/scripts"), { recursive: true });
	writeFileSync(
		join(repoDir, ".agents/skills/repo-preflight/SKILL.md"),
		"---\nname: repo-preflight\ndescription: Run repo preflight\n---\nBody\n",
	);
	writeFileSync(join(repoDir, ".agents/skills/repo-preflight/scripts/preflight.mjs"), "#!/usr/bin/env node\n");

	mkdirSync(join(skillsDir, "users", admin.id, "my-digest"), { recursive: true });
	writeFileSync(
		join(skillsDir, "users", admin.id, "my-digest/SKILL.md"),
		"---\nname: my-digest\ndescription: Personal digest\n---\nBody\n",
	);

	const { server } = createPersonalAgentServer({
		store,
		orchestrator,
		templates,
		previewManager,
		dialogBroker,
		skillsDir,
	});
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const baseUrl = `http://127.0.0.1:${address.port}`;

	try {
		const listRes = await fetch(`${baseUrl}/api/skills/trust`);
		assert.equal(listRes.status, 200);
		const listJson = (await listRes.json()) as {
			skills: Array<{
				scope: string;
				scopeId: string;
				name: string;
				scripts: string[];
				trustLevel: string;
				canManage: boolean;
			}>;
		};
		const wsSkill = listJson.skills.find((s) => s.scope === "workspace" && s.name === "repo-preflight");
		const personalSkill = listJson.skills.find((s) => s.scope === "personal" && s.name === "my-digest");
		assert.ok(wsSkill);
		assert.deepEqual(wsSkill.scripts, ["scripts/preflight.mjs"]);
		assert.equal(wsSkill.trustLevel, "confirm");
		assert.equal(wsSkill.canManage, true);
		assert.ok(personalSkill);
		assert.equal(personalSkill.trustLevel, "confirm");

		// Promote workspace skill to autonomous
		const patchRes = await fetch(`${baseUrl}/api/skills/trust`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				scope: "workspace",
				scopeId: ws.id,
				skillName: "repo-preflight",
				trustLevel: "autonomous",
			}),
		});
		assert.equal(patchRes.status, 200);
		const patchJson = (await patchRes.json()) as { ok: boolean; policy: { trustLevel: string } };
		assert.equal(patchJson.ok, true);
		assert.equal(patchJson.policy.trustLevel, "autonomous");

		// Re-list reflects promoted trust level
		const afterList = (await (await fetch(`${baseUrl}/api/skills/trust`)).json()) as {
			skills: Array<{ scope: string; name: string; trustLevel: string }>;
		};
		assert.equal(
			afterList.skills.find((s) => s.scope === "workspace" && s.name === "repo-preflight")?.trustLevel,
			"autonomous",
		);
	} finally {
		await previewManager.stopAll();
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		await orchestrator.shutdown();
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
