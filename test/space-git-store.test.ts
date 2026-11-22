import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openPersonalAgentDatabase } from "../src/storage/database.ts";
import { memberSpaceId, orgSpaceId, userSpaceId, workspaceSpaceId } from "../src/storage/repos/space-repo.ts";
import { PersonalAgentStore } from "../src/storage/repositories.ts";

test("SpaceRepo initializes 5 space kinds, routes private matters to user space, and tracks Git commits + diffs", async () => {
	const spacesDir = await mkdtemp(join(tmpdir(), "pa-spaces-test-"));
	const db = openPersonalAgentDatabase(":memory:");
	try {
		const store = new PersonalAgentStore(db, { spacesDir });
		const org = store.ensureDefaultOrganization();
		const admin = store.ensureLocalBootstrapAdmin("Alice");
		const ws = store.upsertWorkspace({
			orgId: org.id,
			name: "how-to",
			repoPath: spacesDir,
			visibility: "org",
		});
		store.upsertMember({
			id: "product-manager",
			templateId: "product-manager",
			displayName: "Product Manager",
			roleTitle: "产品经理",
			isPrimaryContact: true,
			provider: "anthropic",
			model: "claude",
			thinkingLevel: "low",
			keywords: [],
		});

		store.spaces.ensureAllDefaultSpaces();
		const spaces = store.spaces.listSpaces();
		assert.ok(spaces.some((s) => s.id === orgSpaceId(org.id) && s.kind === "org"));
		assert.ok(spaces.some((s) => s.id === workspaceSpaceId(ws.id) && s.kind === "workspace"));
		assert.ok(spaces.some((s) => s.id === userSpaceId(admin.id) && s.kind === "user"));
		assert.ok(spaces.some((s) => s.id === memberSpaceId("product-manager") && s.kind === "member"));

		// Matter routing: private -> user space, workspace-bound -> workspace space, org-only -> org space
		const privateSpace = store.spaces.resolveMatterDefaultSpace({
			id: "mat_priv",
			orgId: org.id,
			workspaceId: ws.id,
			visibility: "private",
			createdByUserId: admin.id,
		});
		assert.equal(privateSpace.id, userSpaceId(admin.id));

		const wsSpace = store.spaces.resolveMatterDefaultSpace({
			id: "mat_ws",
			orgId: org.id,
			workspaceId: ws.id,
			visibility: "org",
			createdByUserId: admin.id,
		});
		assert.equal(wsSpace.id, workspaceSpaceId(ws.id));

		const orgSpace = store.spaces.resolveMatterDefaultSpace({
			id: "mat_org",
			orgId: org.id,
			workspaceId: null,
			visibility: "org",
			createdByUserId: admin.id,
		});
		assert.equal(orgSpace.id, orgSpaceId(org.id));

		// Custom space + Git document lifecycle
		const custom = store.spaces.createCustomSpace({
			name: "架构备忘",
			description: "跨仓库架构笔记",
			orgId: org.id,
			ownerUserId: admin.id,
			visibility: "org",
			createdBy: admin.id,
		});
		assert.equal(custom.kind, "custom");

		const doc = await store.spaces.createDocument({
			spaceId: custom.id,
			title: "设计原则",
			content: "# 设计原则\n\n第一版内容\n",
			actorId: admin.id,
			actorName: "Alice",
			commitMessage: "Init design doc",
		});
		assert.equal(doc.revision, 1);
		assert.match(doc.headCommit, /^[0-9a-f]{40}$/);
		assert.ok(existsSync(join(spacesDir, custom.id, ".git")));

		// Update generates a new commit and preserves diff
		const updated = await store.spaces.updateDocument(doc.id, {
			revision: 1,
			title: "设计原则（修订）",
			content: "# 设计原则\n\n第一版内容\n新增 Git 空间约定\n",
			actorId: "product-manager",
			actorName: "Product Manager",
			commitMessage: "Add Git space convention",
		});
		assert.ok(updated);
		assert.equal(updated.revision, 2);
		assert.notEqual(updated.headCommit, doc.headCommit);

		// Concurrent stale revision is rejected
		const conflict = await store.spaces.updateDocument(doc.id, {
			revision: 1,
			title: "过期修改",
			content: "stale",
			actorId: admin.id,
		});
		assert.equal(conflict, null);

		const commits = await store.spaces.listDocumentCommits(doc.id);
		assert.equal(commits.length, 2);
		assert.equal(commits[0]!.subject, "Add Git space convention");
		assert.equal(commits[0]!.authorName, "Product Manager");

		const detail = await store.spaces.getDocumentCommitDetail(doc.id, commits[0]!.hash);
		assert.ok(detail);
		assert.match(detail.diff, /\+新增 Git 空间约定/);
		assert.match(detail.content ?? "", /新增 Git 空间约定/);

		// Document can optionally link to an organization, workspace, and relative file path
		const matter = store.createMatter({
			title: "记录项目",
			orgId: org.id,
			workspaceId: ws.id,
			leadMemberId: "product-manager",
		});
		const linkedDoc = await store.spaces.createDocument({
			spaceId: wsSpace.id,
			matterId: matter.id,
			title: "仓库说明草案",
			content: "# how-to\n",
			linkedOrgId: org.id,
			linkedWorkspaceId: ws.id,
			linkedFilePath: "README.md",
			actorId: "product-manager",
			actorName: "Product Manager",
		});
		assert.equal(linkedDoc.linkedOrgId, org.id);
		assert.equal(linkedDoc.linkedWorkspaceId, ws.id);
		assert.equal(linkedDoc.linkedFilePath, "README.md");
		const reloadedLinked = await store.spaces.getDocument(linkedDoc.id);
		assert.equal(reloadedLinked?.linkedFilePath, "README.md");

		// Legacy space_pages migration imports into the target default space Git repo
		const legacy = store.spacePages.create({
			matterId: matter.id,
			title: "历史页面",
			content: "来自旧表的正文",
			actorId: "product-manager",
		});
		const migratedCount = await store.spaces.migrateLegacySpacePages();
		assert.equal(migratedCount, 1);
		const migratedDoc = await store.spaces.getDocument(legacy.id);
		assert.ok(migratedDoc);
		assert.equal(migratedDoc.spaceId, wsSpace.id);
		assert.equal(migratedDoc.content, "来自旧表的正文");
		assert.equal(await store.spaces.migrateLegacySpacePages(), 0);
	} finally {
		db.close();
		await rm(spacesDir, { recursive: true, force: true });
	}
});
