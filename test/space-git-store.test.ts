import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { encodePiSessionCwdDir, resolveScopedPiSessionDir } from "../src/orchestrator/execution-context.ts";
import { canAccessSpace, canWriteSpace } from "../src/server/acl.ts";
import { persistUploadedFiles, resolveUploadMonthBucket } from "../src/server/uploads.ts";
import { openPersonalAgentDatabase } from "../src/storage/database.ts";
import { memberSpaceId, orgSpaceId, userSpaceId, workspaceSpaceId } from "../src/storage/repos/space-repo.ts";
import { PersonalAgentStore } from "../src/storage/repositories.ts";
import { resolveScopedSpaceRelativeDir } from "../src/storage/space-git-store.ts";

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
		assert.ok(existsSync(join(spacesDir, "custom", custom.id, ".git")));
		assert.equal(resolveScopedSpaceRelativeDir(orgSpaceId(org.id)), join("orgs", org.id));
		assert.equal(resolveScopedSpaceRelativeDir(workspaceSpaceId(ws.id)), join("workspaces", ws.id));
		assert.equal(resolveScopedSpaceRelativeDir(userSpaceId(admin.id)), join("users", admin.id));
		assert.equal(resolveScopedSpaceRelativeDir(memberSpaceId("product-manager")), join("members", "product-manager"));

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

		// Personal user spaces and private custom spaces are strictly isolated to their owner (even from super_admin)
		const bob = store.createUser({
			email: "bob@example.com",
			password: "password123",
			displayName: "Bob",
			status: "active",
		});
		store.spaces.ensureAllDefaultSpaces();
		const bobSpace = store.spaces.getSpace(userSpaceId(bob.id));
		const adminSpace = store.spaces.getSpace(userSpaceId(admin.id));
		const superAdminActor = {
			authKind: "session" as const,
			viaToken: false,
			user: { ...admin, platformRole: "super_admin" as const, status: "active" as const },
			collaborator: store.ensureOwnerCollaborator("Alice"),
		};
		const bobActor = {
			authKind: "session" as const,
			viaToken: false,
			user: bob,
			collaborator: store.ensureOwnerCollaborator("Bob"),
		};
		assert.equal(canAccessSpace(store, superAdminActor, adminSpace), true);
		assert.equal(canAccessSpace(store, superAdminActor, bobSpace), false);
		assert.equal(canWriteSpace(store, superAdminActor, bobSpace), false);
		assert.equal(canAccessSpace(store, bobActor, bobSpace), true);
		assert.equal(canWriteSpace(store, bobActor, bobSpace), true);

		// Legacy flat space directory migrates transparently into scoped directory
		const legacyWsId = "spc_ws_ws_legacy_flat";
		const legacyFlatDir = join(spacesDir, legacyWsId);
		mkdirSync(join(legacyFlatDir, ".git"), { recursive: true });
		writeFileSync(join(legacyFlatDir, "marker.txt"), "ok");
		const resolvedMigrated = store.spaces.git.resolveRepoDir(legacyWsId);
		assert.equal(resolvedMigrated, join(spacesDir, "workspaces", "ws_legacy_flat"));
		assert.ok(existsSync(join(resolvedMigrated, "marker.txt")));
		assert.ok(!existsSync(legacyFlatDir));

		// Pi session directory encoding matches native ~/.pi/agent/sessions/--<path>--/
		assert.equal(encodePiSessionCwdDir("/Users/cch/code/how-to"), "--Users-cch-code-how-to--");
		assert.equal(
			resolveScopedPiSessionDir("/tmp/pi-sessions", "/Users/cch/code/how-to"),
			"/tmp/pi-sessions/--Users-cch-code-how-to--",
		);

		// Uploads persist into YYYY-MM buckets while keeping flat URL format
		const uploadsDir = await mkdtemp(join(tmpdir(), "pa-uploads-bucket-"));
		try {
			const storedFiles = await persistUploadedFiles(
				[
					{
						kind: "file",
						name: "note.txt",
						mimeType: "text/plain",
						content: "hello bucket",
						buffer: Buffer.from("hello bucket", "utf8"),
						sizeBytes: 12,
						lineCount: 1,
						charCount: 12,
						previewText: "hello bucket",
					},
				],
				uploadsDir,
				new Map(),
			);
			const filename = storedFiles[0]!.url!.slice("/api/uploads/".length);
			const bucket = resolveUploadMonthBucket(filename);
			assert.match(bucket, /^\d{4}-\d{2}$/);
			assert.ok(existsSync(join(uploadsDir, bucket, filename)));
		} finally {
			await rm(uploadsDir, { recursive: true, force: true });
		}
	} finally {
		db.close();
		await rm(spacesDir, { recursive: true, force: true });
	}
});

test("SpaceRepo stores documents in docType Git subdirectories, supports type filtering and cross-space recent listing", async () => {
	const spacesDir = await mkdtemp(join(tmpdir(), "pa-spaces-doctype-"));
	const db = openPersonalAgentDatabase(":memory:");
	try {
		const store = new PersonalAgentStore(db, { spacesDir });
		const org = store.ensureDefaultOrganization();
		const admin = store.ensureLocalBootstrapAdmin("Alice");
		store.spaces.ensureAllDefaultSpaces();

		const orgSpace = orgSpaceId(org.id);
		const userSpace = userSpaceId(admin.id);

		const planDoc = await store.spaces.createDocument({
			spaceId: orgSpace,
			title: "Q4 架构改造计划",
			docType: "plan",
			content: "# 计划\n",
			actorId: admin.id,
		});
		const specDoc = await store.spaces.createDocument({
			spaceId: orgSpace,
			title: "登录接口规格",
			docType: "spec",
			content: "# 规格\n",
			actorId: admin.id,
		});
		const decisionDoc = await store.spaces.createDocument({
			spaceId: orgSpace,
			title: "ADR-01 选择 SQLite",
			docType: "decision",
			content: "# 决策\n",
			actorId: admin.id,
		});
		const ruleDoc = await store.spaces.createDocument({
			spaceId: orgSpace,
			title: "代码评审 SOP",
			docType: "rule",
			content: "# 规范\n",
			actorId: admin.id,
		});
		const noteDoc = await store.spaces.createDocument({
			spaceId: userSpace,
			title: "私密调研草稿",
			content: "# 资料\n",
			actorId: admin.id,
		});

		assert.equal(planDoc.docType, "plan");
		assert.ok(planDoc.filePath.startsWith("plans/"));
		assert.ok(specDoc.filePath.startsWith("specs/"));
		assert.ok(decisionDoc.filePath.startsWith("decisions/"));
		assert.ok(ruleDoc.filePath.startsWith("rules/"));
		assert.equal(noteDoc.docType, "note");
		assert.ok(noteDoc.filePath.startsWith("notes/"));

		// Type filter within a single space
		const onlyPlans = store.spaces.listDocuments({ spaceId: orgSpace, docType: "plan" });
		assert.equal(onlyPlans.length, 1);
		assert.equal(onlyPlans[0]?.id, planDoc.id);

		// Re-classifying docType preserves filePath and Git history
		const reclassified = await store.spaces.updateDocument(noteDoc.id, {
			revision: 1,
			title: "私密调研草稿",
			docType: "decision",
			content: "# 决策结论\n",
			actorId: admin.id,
		});
		assert.ok(reclassified);
		assert.equal(reclassified.docType, "decision");
		assert.equal(reclassified.filePath, noteDoc.filePath);
		const commits = await store.spaces.listDocumentCommits(noteDoc.id);
		assert.equal(commits.length, 2);

		// Cross-space recent listing respects provided spaceIds boundary and docType/query filters
		const orgOnlyRecent = store.spaces.listRecentDocumentsForSpaces([orgSpace]);
		assert.equal(orgOnlyRecent.length, 4);
		assert.ok(!orgOnlyRecent.some((d) => d.id === noteDoc.id));

		const allDecisions = store.spaces.listRecentDocumentsForSpaces([orgSpace, userSpace], { docType: "decision" });
		assert.equal(allDecisions.length, 2);

		const queried = store.spaces.listRecentDocumentsForSpaces([orgSpace, userSpace], { query: "SOP" });
		assert.equal(queried.length, 1);
		assert.equal(queried[0]?.id, ruleDoc.id);
	} finally {
		db.close();
		await rm(spacesDir, { recursive: true, force: true });
	}
});
