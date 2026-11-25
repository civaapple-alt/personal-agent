import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

	// Real-path canonicalization handles macOS /var -> /private/var symlinked workspaces
	const rawTmp = mkdtempSync(join(tmpdir(), "pa-symlink-trust-"));
	try {
		const scriptDir = join(rawTmp, ".agents/skills/demo-preflight/scripts");
		mkdirSync(scriptDir, { recursive: true });
		writeFileSync(join(scriptDir, "check.mjs"), "#!/usr/bin/env node\n");
		const canonicalTmp = realpathSync(rawTmp);
		const matched = matchManagedSkillScriptCall(
			"node .agents/skills/demo-preflight/scripts/check.mjs",
			[{ root: join(rawTmp, ".agents/skills"), scope: "workspace", scopeId: "ws-symlink" }],
			canonicalTmp,
		);
		assert.equal(matched?.policyKey, "workspace:ws-symlink:demo-preflight");
	} finally {
		rmSync(rawTmp, { recursive: true, force: true });
	}
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
		readPiNativeSkills: async () => [
			{
				name: "poteto-mode",
				description: "Poteto agent style",
				source: "git:github.com/backnotprop/pstack",
				scope: "user",
				origin: "package",
				filePath: "/Users/owner/.pi/agent/git/pstack/skills/poteto-mode/SKILL.md",
			},
			{
				name: "frontend-design",
				description: "Frontend design skill",
				source: "local",
				scope: "user",
				origin: "top-level",
				filePath: "/Users/owner/.agents/skills/frontend-design/SKILL.md",
			},
		],
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
			piNativeSkills: Array<{
				name: string;
				source: string;
				origin: string;
				filePath: string | null;
			}>;
			piNativeSkillsError: string | null;
		};
		assert.equal(listJson.piNativeSkillsError, null);
		assert.equal(listJson.piNativeSkills.length, 2);
		assert.ok(listJson.piNativeSkills.some((s) => s.name === "frontend-design" && s.source === "local"));
		assert.ok(listJson.piNativeSkills.some((s) => s.name === "poteto-mode" && s.origin === "package"));
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

		// Read-only detail endpoint returns SKILL.md and scripts/*
		const detailRes = await fetch(
			`${baseUrl}/api/skills/trust/detail?scope=workspace&scopeId=${encodeURIComponent(ws.id)}&skillName=repo-preflight`,
		);
		assert.equal(detailRes.status, 200);
		const detailJson = (await detailRes.json()) as {
			detail: { name: string; content: string; scripts: Array<{ path: string; content: string }> };
		};
		assert.equal(detailJson.detail.name, "repo-preflight");
		assert.match(detailJson.detail.content, /Run repo preflight/);
		assert.equal(detailJson.detail.scripts.length, 1);
		assert.equal(detailJson.detail.scripts[0]?.path, "scripts/preflight.mjs");
		assert.match(detailJson.detail.scripts[0]?.content ?? "", /#!\/usr\/bin\/env node/);

		// Invalid skill name or unauthorized personal scope is rejected
		const badNameRes = await fetch(
			`${baseUrl}/api/skills/trust/detail?scope=workspace&scopeId=${encodeURIComponent(ws.id)}&skillName=../evil`,
		);
		assert.equal(badNameRes.status, 400);

		const forbiddenRes = await fetch(
			`${baseUrl}/api/skills/trust/detail?scope=personal&scopeId=someone-else&skillName=my-digest`,
		);
		assert.equal(forbiddenRes.status, 403);

		const missingRes = await fetch(
			`${baseUrl}/api/skills/trust/detail?scope=workspace&scopeId=${encodeURIComponent(ws.id)}&skillName=not-found`,
		);
		assert.equal(missingRes.status, 404);
	} finally {
		await previewManager.stopAll();
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		await orchestrator.shutdown();
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
