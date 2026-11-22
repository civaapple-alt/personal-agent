import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	buildAttachedFolderContextFiles,
	buildWorkspaceCustomizations,
	extractAttachedSkillPaths,
} from "../src/orchestrator/workspace-customizations.ts";
import { openPersonalAgentDatabase } from "../src/storage/database.ts";
import { PersonalAgentStore } from "../src/storage/repositories.ts";

test("WorkspaceFolderRepo and workspace-customizations manage multi-folder rules, skills, and budget demotion", async () => {
	const root = await mkdtemp(join(tmpdir(), "pa-multifolder-test-"));
	const primaryDir = join(root, "personal-agent");
	const attachedDir = join(root, "pi");
	mkdirSync(join(primaryDir, ".agents", "skills", "react-best-practices"), { recursive: true });
	mkdirSync(join(attachedDir, ".pi", "skills", "pi-core-skill"), { recursive: true });

	writeFileSync(join(primaryDir, "AGENTS.md"), "# Personal Agent\nUse TypeScript and keep modules small.\n");
	writeFileSync(
		join(primaryDir, ".agents", "skills", "react-best-practices", "SKILL.md"),
		"---\nname: react-best-practices\ndescription: React optimization guidelines\n---\nBody\n",
	);
	writeFileSync(
		join(attachedDir, "AGENTS.md"),
		`# Pi Rules\n${"Keep answers concise and follow strict commit style. ".repeat(40)}\n`,
	);
	writeFileSync(
		join(attachedDir, ".pi", "skills", "pi-core-skill", "SKILL.md"),
		"---\nname: pi-core-skill\ndescription: Native Pi core architecture conventions\n---\nBody\n",
	);

	const db = openPersonalAgentDatabase(":memory:");
	try {
		const store = new PersonalAgentStore(db);
		const org = store.ensureDefaultOrganization();
		const ws = store.upsertWorkspace({
			orgId: org.id,
			name: "personal-agent",
			repoPath: primaryDir,
		});

		const initialFolders = store.workspaceFolders.listFolders(ws.id);
		assert.equal(initialFolders.length, 1);
		assert.equal(initialFolders[0]!.role, "primary");
		assert.equal(initialFolders[0]!.path, primaryDir);

		const attached = store.workspaceFolders.addFolder({
			workspaceId: ws.id,
			label: "pi",
			path: attachedDir,
		});
		assert.equal(attached.role, "attached");
		assert.equal(store.workspaceFolders.listFolders(ws.id).length, 2);

		// Cannot remove primary folder directly
		assert.throws(() => store.workspaceFolders.removeFolder(initialFolders[0]!.id));

		// Full budget: both rules stay full, both skills discovered
		const fullReport = buildWorkspaceCustomizations(store.workspaceFolders.listFolders(ws.id));
		assert.equal(fullReport.rules.length, 2);
		assert.ok(fullReport.rules.every((r) => r.mode === "full"));
		assert.equal(fullReport.skills.length, 2);
		assert.equal(extractAttachedSkillPaths(fullReport).length, 1);
		assert.equal(buildAttachedFolderContextFiles(fullReport).length, 1);

		// Tight rules budget: large attached folder rule demotes to path pointer first
		const tightReport = buildWorkspaceCustomizations(store.workspaceFolders.listFolders(ws.id), {
			rulesBudgetTokens: 120,
		});
		const piRule = tightReport.rules.find((r) => r.folderLabel === "pi");
		const paRule = tightReport.rules.find((r) => r.folderLabel === "personal-agent");
		assert.equal(piRule?.mode, "pointer");
		assert.equal(paRule?.mode, "full");
		const attachedCtx = buildAttachedFolderContextFiles(tightReport);
		assert.match(attachedCtx[0]!.content, /Demoted to path pointer/);

		// Disable rules on attached folder
		store.workspaceFolders.updateFolder(attached.id, { loadRules: false });
		const disabledReport = buildWorkspaceCustomizations(store.workspaceFolders.listFolders(ws.id));
		assert.equal(disabledReport.rules.find((r) => r.folderLabel === "pi")?.mode, "disabled");
		assert.equal(buildAttachedFolderContextFiles(disabledReport).length, 0);

		// Removing attached folder succeeds
		assert.equal(store.workspaceFolders.removeFolder(attached.id), true);
		assert.equal(store.workspaceFolders.listFolders(ws.id).length, 1);
	} finally {
		db.close();
		await rm(root, { recursive: true, force: true });
	}
});
