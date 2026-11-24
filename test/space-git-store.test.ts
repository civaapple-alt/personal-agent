import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	encodePiSessionCwdDir,
	resolveScopedPiSessionDir,
} from "../packages/server/src/orchestrator/execution/execution-context.ts";
import { canAccessSpace, canWriteSpace } from "../packages/server/src/server/acl.ts";
import { userToCollaboratorView } from "../packages/server/src/server/auth.ts";
import { persistUploadedFiles, resolveUploadMonthBucket } from "../packages/server/src/server/uploads.ts";
import { openPersonalAgentDatabase } from "../packages/server/src/storage/database.ts";
import {
	memberSpaceId,
	orgSpaceId,
	userSpaceId,
	workspaceSpaceId,
} from "../packages/server/src/storage/repos/space-repo.ts";
import { PersonalAgentStore } from "../packages/server/src/storage/repositories.ts";
import { resolveScopedSpaceRelativeDir, SpaceGitStore } from "../packages/server/src/storage/space-git-store.ts";

test("folder batch rejects invalid paths before changing any files", async () => {
	const spacesDir = await mkdtemp(join(tmpdir(), "pa-spaces-batch-"));
	try {
		const git = new SpaceGitStore(spacesDir);
		const base = {
			spaceId: "spc_batch",
			dirPath: "notes/bundle",
			authorName: "Alice",
			authorEmail: "alice@example.com",
			commitMessage: "Update bundle",
		};
		await git.writeFolderFiles({ ...base, files: [{ subPath: "first.md", content: "original" }] });
		await assert.rejects(
			git.writeFolderFiles({
				...base,
				files: [
					{ subPath: "first.md", content: "changed" },
					{ subPath: "../escape", content: "invalid" },
				],
			}),
			/Invalid space document path/,
		);
		assert.equal(await git.readDocument(base.spaceId, `${base.dirPath}/first.md`), "original");
	} finally {
		await rm(spacesDir, { recursive: true, force: true });
	}
});

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
		const firstFeedback = await store.spaces.saveDocumentFeedback({
			documentId: doc.id,
			commitHash: doc.headCommit,
			actorId: admin.id,
			actorName: "Alice",
			feedback: "Review the initial version",
			rating: "negative",
		});
		assert.equal(firstFeedback?.commitHash, doc.headCommit);
		await store.spaces.saveDocumentFeedback({
			documentId: doc.id,
			commitHash: doc.headCommit,
			actorId: admin.id,
			actorName: "Alice",
			feedback: "Updated review",
			rating: "neutral",
		});
		assert.deepEqual(
			store.spaces.listDocumentFeedback(doc.id).map((entry) => [entry.feedback, entry.rating]),
			[["Updated review", "neutral"]],
		);

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
		const memory = store.addMemory({
			memberId: "product-manager",
			scope: "role_general",
			content: "Use clear examples",
		});
		const applicationIds = store.recordMemoryApplications({
			memoryIds: [memory.id],
			matterId: matter.id,
			memberId: "product-manager",
		});
		const review = {
			documentId: linkedDoc.id,
			commitHash: linkedDoc.headCommit,
			actorId: admin.id,
			actorName: "Alice",
			feedback: "Looks good",
			rating: "positive" as const,
		};
		await store.spaces.saveDocumentFeedback(review);
		assert.equal(store.getMemory(memory.id)?.positiveCount, 0);
		store.recordTurnOutcome({
			candidates: [],
			applicationIds,
			spaceDocuments: [{ id: linkedDoc.id, headCommit: linkedDoc.headCommit }],
		});
		assert.equal(store.getMemory(memory.id)?.positiveCount, 1);
		await store.spaces.saveDocumentFeedback(review);
		assert.equal(store.getMemory(memory.id)?.positiveCount, 1);
		await store.spaces.saveDocumentFeedback({ ...review, rating: "negative" });
		assert.equal(store.getMemory(memory.id)?.positiveCount, 0);
		assert.equal(store.getMemory(memory.id)?.negativeCount, 1);
		await store.spaces.saveDocumentFeedback({ ...review, rating: "neutral" });
		assert.equal(store.getMemory(memory.id)?.negativeCount, 0);
		await store.spaces.saveDocumentFeedback({ ...review, rating: "negative" });
		await store.spaces.saveDocumentFeedback({ ...review, actorId: "another-reviewer", rating: "positive" });
		assert.equal(store.getMemory(memory.id)?.positiveCount, 1);
		assert.equal(store.getMemory(memory.id)?.negativeCount, 1);
		db.prepare("DELETE FROM space_document_feedback WHERE document_id = ? AND actor_id = ?").run(
			linkedDoc.id,
			"another-reviewer",
		);
		assert.equal(store.getMemory(memory.id)?.positiveCount, 0);
		assert.equal(store.getMemory(memory.id)?.negativeCount, 1);
		await store.spaces.saveDocumentFeedback({ ...review, rating: null });
		assert.equal(store.getMemory(memory.id)?.negativeCount, 0);
		const unrelated = await store.spaces.createDocument({
			spaceId: custom.id,
			title: "Another document",
			content: "unrelated",
			actorId: admin.id,
		});
		await assert.rejects(
			store.spaces.saveDocumentFeedback({
				documentId: doc.id,
				commitHash: unrelated.headCommit,
				actorId: admin.id,
				actorName: "Alice",
				feedback: "Unrelated commit",
				rating: null,
			}),
			/does not belong/,
		);

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
			collaborator: userToCollaboratorView(store, admin),
		};
		const bobActor = {
			authKind: "session" as const,
			viaToken: false,
			user: bob,
			collaborator: userToCollaboratorView(store, bob),
		};
		assert.equal(canAccessSpace(store, superAdminActor, adminSpace), true);
		assert.equal(canAccessSpace(store, superAdminActor, bobSpace), false);
		assert.equal(canWriteSpace(store, superAdminActor, bobSpace), false);
		assert.equal(canAccessSpace(store, bobActor, bobSpace), true);
		assert.equal(canWriteSpace(store, bobActor, bobSpace), true);

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

test("SpaceRepo supports folder entries with entry-level .gitignore, sub-files, preview detection, and single-file promotion", async () => {
	const spacesDir = await mkdtemp(join(tmpdir(), "pa-spaces-folder-"));
	const db = openPersonalAgentDatabase(":memory:");
	try {
		const store = new PersonalAgentStore(db, { spacesDir });
		const org = store.ensureDefaultOrganization();
		const admin = store.ensureLocalBootstrapAdmin("Alice");
		store.spaces.ensureAllDefaultSpaces();
		const orgSpace = orgSpaceId(org.id);

		// 1. Create folder entry directly under decisions/
		const bundle = await store.spaces.createDocument({
			spaceId: orgSpace,
			title: "选型决策资料包",
			docType: "decision",
			entryKind: "folder",
			content: "# 选型结论\n\n选择方案 A。\n",
			actorId: admin.id,
			actorName: "Alice",
		});
		assert.equal(bundle.entryKind, "folder");
		assert.ok(bundle.filePath.startsWith("decisions/"));
		assert.ok(!bundle.filePath.endsWith(".md"));

		const initialFiles = await store.spaces.listDocumentFiles(bundle.id);
		assert.ok(initialFiles);
		assert.deepEqual(
			initialFiles.files.map((f) => f.path),
			["README.md", ".gitignore"],
		);
		assert.equal(initialFiles.previewEntryPath, null);

		// 2. Write reference doc + static demo site + an ignored log file
		await store.spaces.writeDocumentFile(bundle.id, {
			subPath: "option-a.md",
			content: "# 备选方案 A\n详细调研数据\n",
			actorId: admin.id,
		});
		const withDemo = await store.spaces.writeDocumentFile(bundle.id, {
			subPath: "demo/index.html",
			content: "<!doctype html><html><body><h1>Demo</h1></body></html>",
			actorId: admin.id,
		});
		assert.ok(withDemo);
		assert.equal(withDemo.previewEntryPath, "demo/index.html");
		assert.equal(await store.spaces.readDocumentFile(bundle.id, "option-a.md"), "# 备选方案 A\n详细调研数据\n");
		const rawHtml = await store.spaces.readDocumentFileRaw(bundle.id, "demo/index.html");
		assert.ok(rawHtml?.toString("utf8").includes("<h1>Demo</h1>"));

		// Verify entry-level .gitignore filters *.log files from git ls-files
		const repoDir = store.spaces.git.resolveRepoDir(orgSpace);
		writeFileSync(join(repoDir, bundle.filePath, "debug.log"), "should be ignored", "utf8");
		const listedAfterLog = await store.spaces.listDocumentFiles(bundle.id);
		assert.ok(listedAfterLog);
		assert.ok(!listedAfterLog.files.some((f) => f.path === "debug.log"));

		// 3. Delete non-README sub-file works; deleting README.md is rejected
		await store.spaces.deleteDocumentFile(bundle.id, { subPath: "option-a.md", actorId: admin.id });
		assert.equal(await store.spaces.readDocumentFile(bundle.id, "option-a.md"), null);
		await assert.rejects(
			() => store.spaces.deleteDocumentFile(bundle.id, { subPath: "README.md", actorId: admin.id }),
			/README\.md/,
		);

		// Directory-level commit log captures all folder entry commits
		const commits = await store.spaces.listDocumentCommits(bundle.id);
		assert.ok(commits.length >= 4);

		// 4. Promote an existing single-file document into a folder entry
		const single = await store.spaces.createDocument({
			spaceId: orgSpace,
			title: "初始方案",
			docType: "plan",
			content: "# 初始方案正文\n",
			actorId: admin.id,
		});
		assert.equal(single.entryKind, "file");
		await assert.rejects(
			store.spaces.writeDocumentFile(single.id, { subPath: "../escape", content: "bad", actorId: admin.id }),
			/Invalid space document path/,
		);
		assert.equal((await store.spaces.getDocument(single.id))?.entryKind, "file");
		const promoted = await store.spaces.promoteDocumentToFolder(single.id, { actorId: admin.id });
		assert.ok(promoted);
		assert.equal(promoted.entryKind, "folder");
		assert.equal(promoted.content, "# 初始方案正文\n");
		const promotedFiles = await store.spaces.listDocumentFiles(single.id);
		assert.ok(promotedFiles?.files.some((f) => f.path === "README.md"));
		assert.ok(promotedFiles?.files.some((f) => f.path === ".gitignore"));

		// 5. Create folder entry with multiple extraFiles in one commit + batch write multiple files
		const multi = await store.spaces.createDocument({
			spaceId: orgSpace,
			title: "多文件演示包",
			docType: "plan",
			entryKind: "folder",
			content: "# 入口说明\n",
			extraFiles: [
				{ subPath: "notes.md", content: "# 补充说明\n" },
				{ subPath: "demo/index.html", content: "<html><body>Hi</body></html>" },
			],
			actorId: admin.id,
		});
		const multiFiles = await store.spaces.listDocumentFiles(multi.id);
		assert.ok(multiFiles?.files.some((f) => f.path === "notes.md"));
		assert.equal(multiFiles?.previewEntryPath, "demo/index.html");
		const batchRes = await store.spaces.writeDocumentFiles(multi.id, {
			files: [
				{ subPath: "demo/app.js", content: "console.log('hi');" },
				{ subPath: "demo/style.css", content: "body { margin: 0; }" },
			],
			actorId: admin.id,
		});
		assert.ok(batchRes?.files.some((f) => f.path === "demo/app.js"));
		assert.ok(batchRes?.files.some((f) => f.path === "demo/style.css"));
	} finally {
		db.close();
		await rm(spacesDir, { recursive: true, force: true });
	}
});
