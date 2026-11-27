import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
	createPersonalAgentServer,
	DialogBroker,
	loadRoleTemplatesFromDir,
	openPersonalAgentDatabase,
	PersonalAgentStore,
	PreviewManager,
	type RpcWorkerLike,
	TeamOrchestrator,
} from "../packages/server/src/index.ts";

function createStubOrchestrator(
	store: PersonalAgentStore,
	templates: Awaited<ReturnType<typeof loadRoleTemplatesFromDir>>,
) {
	return new TeamOrchestrator({
		store,
		templates,
		noSession: true,
		workerFactory: (opts) =>
			({
				options: opts,
				onEvent: () => () => {},
				onNotice: () => () => {},
				setDialogHandler: () => {},
				start: async () => {},
				stop: async () => {},
				getState: async () => ({ sessionId: "stub-session", isStreaming: false }),
				runPromptAndWait: async () => ({
					disposition: "started",
					aborted: false,
					assistantText: "ok",
					assistantMessages: [],
					toolExecutions: [],
					notices: [],
					dialogs: [],
					events: [],
				}),
			}) as unknown as RpcWorkerLike,
	});
}

test("fresh 0.9.0 database creates split tables, columns, and indexes cleanly", () => {
	const db = openPersonalAgentDatabase(":memory:");
	try {
		assert.equal(Number(db.prepare("PRAGMA application_id").get()?.application_id), 0x50413730);
		assert.equal(Number(db.prepare("PRAGMA user_version").get()?.user_version), 900);
		assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);

		const tables = new Set(
			(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
				(r) => r.name,
			),
		);
		for (const table of ["matter_events", "matter_board_posts", "matter_board_members"]) {
			assert.ok(tables.has(table), `Expected table ${table}`);
		}

		const matterCols = new Set(
			(db.prepare("PRAGMA table_info(matters)").all() as Array<{ name: string }>).map((r) => r.name),
		);
		assert.ok(matterCols.has("collaboration_mode"));
		assert.ok(matterCols.has("coordinator_member_id"));

		const msgCols = new Set(
			(db.prepare("PRAGMA table_info(matter_messages)").all() as Array<{ name: string }>).map((r) => r.name),
		);
		assert.ok(msgCols.has("kind"));
		assert.ok(msgCols.has("decision_status"));
		assert.ok(msgCols.has("board_post_no"));

		const indexes = new Set(
			(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map(
				(r) => r.name,
			),
		);
		for (const idx of [
			"idx_matter_events_matter",
			"idx_matter_events_post",
			"idx_board_posts_matter",
			"idx_matter_messages_decision_status",
		]) {
			assert.ok(indexes.has(idx), `Expected index ${idx}`);
		}
	} finally {
		db.close();
	}
});

test("0.8.x (0x50413730) database migrates losslessly and idempotently with sequential post_no backfill", () => {
	const dir = mkdtempSync(join(tmpdir(), "pa-migrate-08x-"));
	const dbPath = join(dir, "legacy-08x.db");
	try {
		const legacy = new DatabaseSync(dbPath);
		legacy.exec(`
			PRAGMA foreign_keys = ON;
			CREATE TABLE organizations (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				slug TEXT NOT NULL DEFAULT '',
				git_email_domain TEXT NOT NULL DEFAULT '',
				use_role_git_identity INTEGER NOT NULL DEFAULT 0,
				description TEXT NOT NULL DEFAULT '',
				is_default INTEGER NOT NULL DEFAULT 0,
				workspaces_dir TEXT,
				created_by_user_id TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE TABLE users (
				id TEXT PRIMARY KEY,
				email TEXT NOT NULL UNIQUE COLLATE NOCASE,
				display_name TEXT NOT NULL,
				password_hash TEXT NOT NULL DEFAULT '',
				platform_role TEXT NOT NULL DEFAULT 'user',
				status TEXT NOT NULL DEFAULT 'active',
				max_orgs INTEGER NOT NULL DEFAULT 5,
				max_active_dispatches INTEGER NOT NULL DEFAULT 3,
				max_personal_roles INTEGER NOT NULL DEFAULT 5,
				can_dispatch_ai INTEGER NOT NULL DEFAULT 1,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE TABLE team_members (
				id TEXT PRIMARY KEY,
				template_id TEXT NOT NULL,
				display_name TEXT NOT NULL,
				role_title TEXT NOT NULL,
				is_primary_contact INTEGER NOT NULL DEFAULT 0,
				keywords_json TEXT NOT NULL DEFAULT '[]',
				git_name TEXT NOT NULL DEFAULT '',
				git_email TEXT NOT NULL DEFAULT '',
				identity_summary TEXT NOT NULL DEFAULT '',
				role_scope TEXT NOT NULL DEFAULT 'global',
				owner_org_id TEXT,
				owner_user_id TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE TABLE workspace_links (
				id TEXT PRIMARY KEY,
				org_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
				name TEXT NOT NULL,
				repo_path TEXT NOT NULL UNIQUE,
				default_branch TEXT NOT NULL DEFAULT 'main',
				description TEXT NOT NULL DEFAULT '',
				created_at TEXT NOT NULL,
				source_type TEXT NOT NULL DEFAULT 'local',
				clone_url TEXT,
				visibility TEXT NOT NULL DEFAULT 'org'
			);
			CREATE TABLE matters (
				id TEXT PRIMARY KEY,
				title TEXT NOT NULL,
				summary TEXT NOT NULL DEFAULT '',
				status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waiting_user', 'archived')),
				lead_member_id TEXT REFERENCES team_members(id),
				workspace_id TEXT REFERENCES workspace_links(id),
				org_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
				ai_member_ids_json TEXT,
				consult_member_ids_json TEXT,
				observers_enabled INTEGER NOT NULL DEFAULT 0,
				observer_ids_json TEXT,
				discussion_ai_enabled INTEGER NOT NULL DEFAULT 0,
				collaborator_ids_json TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				created_by_user_id TEXT,
				visibility TEXT NOT NULL DEFAULT 'org',
				model_selection_json TEXT
			);
			CREATE TABLE matter_messages (
				id TEXT PRIMARY KEY,
				matter_id TEXT NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
				channel TEXT NOT NULL,
				sender_type TEXT NOT NULL,
				sender_id TEXT NOT NULL,
				content TEXT NOT NULL,
				metadata_json TEXT,
				created_at TEXT NOT NULL
			);
			INSERT INTO team_members (id, template_id, display_name, role_title, created_at, updated_at)
			VALUES ('product-manager', 'product-manager', 'PM', 'Product Manager', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
			       ('qa-manager', 'qa-manager', 'QA', 'QA Manager', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
			INSERT INTO matters (id, title, status, lead_member_id, created_at, updated_at)
			VALUES ('mat_1', 'Legacy Matter 1', 'open', 'product-manager', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
			       ('mat_2', 'Legacy Matter 2', 'open', 'product-manager', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
			INSERT INTO matter_messages (id, matter_id, channel, sender_type, sender_id, content, metadata_json, created_at)
			VALUES
				('msg_u1', 'mat_1', 'user', 'user', 'usr_1', 'Build feature', '{"mode":"ai_request","aiRequestStatus":"pending"}', '2026-01-01T00:00:01Z'),
				('msg_u2', 'mat_1', 'user', 'member', 'product-manager', 'Need decision', '{"humanDecision":{"status":"pending","revision":1,"requests":[{"id":"q1","question":"Pick one"}]}}', '2026-01-01T00:00:02Z'),
				('msg_u3', 'mat_1', 'user', 'member', 'qa-manager', 'Observer note', '{"observerIntervention":true}', '2026-01-01T00:00:03Z'),
				('msg_n1', 'mat_1', 'notice', 'system', 'product-manager', '{"method":"runtime_ready","tools":["read"]}', '{"sourceUserMessageId":"msg_u1"}', '2026-01-01T00:00:04Z'),
				('msg_n2', 'mat_1', 'notice', 'system', 'product-manager', '{"type":"tool_execution_start","toolCallId":"tc1","toolName":"read"}', '{"sourceUserMessageId":"msg_u1"}', '2026-01-01T00:00:05Z'),
				('msg_n3', 'mat_1', 'notice', 'system', 'orchestrator', 'Plain legacy notice', NULL, '2026-01-01T00:00:06Z'),
				('msg_c1', 'mat_1', 'internal_collab', 'member', 'product-manager', '@QA: Please verify feature', '{"toMemberId":"qa-manager","sourceUserMessageId":"msg_u1"}', '2026-01-01T00:00:07Z'),
				('msg_c2', 'mat_1', 'internal_collab', 'member', 'qa-manager', 'Verification passed\n\nDetailed evidence body...', '{"replyToMemberId":"product-manager","requestMessageId":"msg_c1","verification":{"verdict":"passed","summary":"Verification passed","evidence":["ok"]}}', '2026-01-01T00:00:08Z'),
				('msg_c3', 'mat_2', 'internal_collab', 'member', 'product-manager', '@QA: Check matter 2', '{"toMemberId":"qa-manager"}', '2026-01-01T00:00:09Z');
			PRAGMA application_id = 0x50413730;
		`);
		legacy.close();

		// First open: migrates schema and backfills
		const migrated = openPersonalAgentDatabase(dbPath);
		const store = new PersonalAgentStore(migrated);
		assert.equal(Number(migrated.prepare("PRAGMA user_version").get()?.user_version), 900);
		assert.equal(migrated.prepare("PRAGMA foreign_key_check").all().length, 0);

		// Verify backward-compatible listMessages still returns all historical channels losslessly
		assert.equal(store.listMessages("mat_1", "user").length, 3);
		assert.equal(store.listMessages("mat_1", "notice").length, 3);
		assert.equal(store.listMessages("mat_1", "internal_collab").length, 2);

		// Verify user message lifecycle columns backfilled
		const u1Row = migrated.prepare("SELECT kind, decision_status FROM matter_messages WHERE id = 'msg_u1'").get() as {
			kind: string;
			decision_status: string | null;
		};
		assert.equal(u1Row.kind, "ai_request");
		assert.equal(u1Row.decision_status, "pending");
		const u2Row = migrated.prepare("SELECT kind, decision_status FROM matter_messages WHERE id = 'msg_u2'").get() as {
			kind: string;
			decision_status: string | null;
		};
		assert.equal(u2Row.kind, "human_decision");
		assert.equal(u2Row.decision_status, "pending");
		const u3Row = migrated.prepare("SELECT kind FROM matter_messages WHERE id = 'msg_u3'").get() as { kind: string };
		assert.equal(u3Row.kind, "observer");

		// Verify notices backfilled to matter_events
		const mat1Events = store.listEvents("mat_1", { order: "asc" });
		assert.equal(mat1Events.total, 3);
		assert.deepEqual(
			mat1Events.events.map((e) => e.eventType),
			["capability_ready", "tool_start", "notice"],
		);
		assert.equal(mat1Events.events[0]?.runId, "msg_u1");
		assert.equal(mat1Events.events[2]?.payload.message, "Plain legacy notice");

		// Verify internal_collab backfilled to matter_board_posts with per-matter sequential post_no
		const mat1Posts = store.listBoardPostSummaries("mat_1");
		assert.equal(mat1Posts.length, 2);
		assert.equal(mat1Posts[0]?.postNo, 1);
		assert.equal(mat1Posts[0]?.kind, "assign");
		assert.deepEqual(mat1Posts[0]?.mentions, ["qa-manager"]);
		assert.equal("body" in mat1Posts[0]!, false);
		assert.equal(mat1Posts[1]?.postNo, 2);
		assert.equal(mat1Posts[1]?.kind, "verify_pass");
		assert.deepEqual(mat1Posts[1]?.refPostNos, [1]);
		assert.equal("body" in mat1Posts[1]!, false);

		const fullPost2 = store.getBoardPost("mat_1", 2);
		assert.ok(fullPost2);
		assert.match(fullPost2.body, /Detailed evidence body/);

		const mat2Posts = store.listBoardPostSummaries("mat_2");
		assert.equal(mat2Posts.length, 1);
		assert.equal(mat2Posts[0]?.postNo, 1);

		const c2MsgRow = migrated.prepare("SELECT board_post_no FROM matter_messages WHERE id = 'msg_c2'").get() as {
			board_post_no: number | null;
		};
		assert.equal(c2MsgRow.board_post_no, 2);

		// Verify matter updated_at was not clobbered by migration backfill
		assert.equal(store.getMatter("mat_1")?.updatedAt, "2026-01-01T00:00:00Z");
		migrated.close();

		// Second open (and even with user_version reset to 0): backfill remains strictly idempotent
		const resetDb = new DatabaseSync(dbPath);
		resetDb.exec("PRAGMA user_version = 0");
		resetDb.close();

		const reopened = openPersonalAgentDatabase(dbPath);
		const reopenedStore = new PersonalAgentStore(reopened);
		assert.equal(reopenedStore.listEvents("mat_1").total, 3);
		assert.equal(reopenedStore.listBoardPostSummaries("mat_1").length, 2);
		assert.equal(reopenedStore.listBoardPostSummaries("mat_2").length, 1);
		assert.deepEqual(
			reopenedStore.listBoardPostSummaries("mat_1").map((p) => p.postNo),
			[1, 2],
		);
		reopened.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("BoardRepo monotonic post_no, lazy body loading, member state, event pagination, and appendMessage mirroring", () => {
	const db = openPersonalAgentDatabase(":memory:");
	try {
		const store = new PersonalAgentStore(db);
		const org = store.ensureDefaultOrganization();
		store.upsertMember({
			id: "product-manager",
			templateId: "product-manager",
			displayName: "PM",
			roleTitle: "Product Manager",
			isPrimaryContact: true,
			keywords: [],
		});
		store.upsertMember({
			id: "qa-manager",
			templateId: "qa-manager",
			displayName: "QA",
			roleTitle: "QA Manager",
			isPrimaryContact: false,
			keywords: [],
		});
		const matter = store.createMatter({
			title: "Board Storage Test",
			leadMemberId: "product-manager",
			collaborationMode: "board",
			coordinatorMemberId: "product-manager",
			orgId: org.id,
		});
		assert.deepEqual(store.getMatterBoardMeta(matter.id), {
			collaborationMode: "board",
			coordinatorMemberId: "product-manager",
		});

		// Upsert and update board members
		const m1 = store.upsertBoardMember({
			matterId: matter.id,
			agentId: "coordinator",
			sourceMemberId: "product-manager",
			displayName: "Coordinator",
			boardRole: "coordinator",
			brief: "Orchestrate slices",
			skills: ["pa-self-inspection"],
			ownedScope: ["docs/"],
		});
		assert.equal(m1.status, "waiting");
		const m2 = store.upsertBoardMember({
			matterId: matter.id,
			agentId: "storage-slice",
			displayName: "Storage Builder",
			boardRole: "builder",
			ownedScope: ["packages/server/src/storage/"],
		});
		assert.equal(m2.sourceMemberId, null);
		const updatedMember = store.updateBoardMemberState(matter.id, "storage-slice", {
			status: "working",
			activePostNo: 1,
			lastReadPostNo: 1,
			metrics: { linesAdded: 120, testsPassed: 5, testsTotal: 5 },
		});
		assert.equal(updatedMember?.status, "working");
		assert.equal(updatedMember?.activePostNo, 1);
		assert.equal(store.listBoardMembers(matter.id).length, 2);

		// Create board posts and test monotonic post_no & lazy body
		const heavyBody = `${"A".repeat(5000)}\nFull technical details`;
		const post1 = store.createBoardPost({
			matterId: matter.id,
			authorType: "agent",
			authorId: "coordinator",
			kind: "assign",
			mentions: ["storage-slice"],
			summary: "Assign storage split slice",
			body: heavyBody,
		});
		assert.equal(post1.postNo, 1);

		// Mirroring through MatterRepo.appendMessage shares the same per-matter monotonic post_no sequence
		const collabMsg = store.appendMessage({
			matterId: matter.id,
			channel: "internal_collab",
			senderType: "member",
			senderId: "qa-manager",
			content: "Rework needed on pagination cursor",
			metadata: {
				replyToMemberId: "product-manager",
				verification: { verdict: "changes_requested", summary: "Rework needed", evidence: ["cursor test"] },
			},
		});
		const msgRow = db.prepare("SELECT board_post_no FROM matter_messages WHERE id = ?").get(collabMsg.id) as {
			board_post_no: number | null;
		};
		assert.equal(msgRow.board_post_no, 2);

		const post3 = store.createBoardPost({
			matterId: matter.id,
			authorType: "user",
			authorId: "usr_local_owner",
			kind: "summary",
			refPostNos: [1, 2],
			summary: "Approved final direction",
			body: "Proceed with #2 fixes.",
		});
		assert.equal(post3.postNo, 3);

		const summaries = store.listBoardPostSummaries(matter.id);
		assert.deepEqual(
			summaries.map((s) => s.postNo),
			[1, 2, 3],
		);
		for (const item of summaries) {
			assert.equal("body" in item, false, "Summary listing must not include heavy body");
		}
		assert.equal(summaries[0]?.hasBody, true);
		assert.equal(store.listBoardPostSummaries(matter.id, { afterPostNo: 1 }).length, 2);
		assert.equal(store.getBoardPost(matter.id, 1)?.body, heavyBody);
		assert.equal(store.getBoardPost(matter.id, 2)?.kind, "verify_rework");
		assert.equal(store.getBoardPost(matter.id, 99), null);

		// Mirror notice via appendMessage + direct appendEvent + keyset pagination with equal timestamps
		store.appendMessage({
			matterId: matter.id,
			channel: "notice",
			senderType: "system",
			senderId: "product-manager",
			content: JSON.stringify({ type: "tool_execution_start", toolCallId: "tc1", toolName: "read" }),
			metadata: { sourceUserMessageId: "run_1" },
		});
		for (let i = 1; i <= 5; i++) {
			store.appendEvent({
				matterId: matter.id,
				runId: "run_2",
				agentId: "storage-slice",
				boardPostNo: 1,
				eventType: "tool_end",
				payload: { seq: i },
				createdAt: "2026-02-01T00:00:00.000Z",
			});
		}

		const page1 = store.listEvents(matter.id, { agentId: "storage-slice", limit: 2, order: "asc" });
		assert.equal(page1.total, 5);
		assert.equal(page1.hasMore, true);
		assert.ok(page1.nextCursor);
		assert.deepEqual(
			page1.events.map((e) => e.payload.seq),
			[1, 2],
		);

		const page2 = store.listEvents(matter.id, {
			agentId: "storage-slice",
			limit: 2,
			order: "asc",
			cursor: page1.nextCursor,
		});
		assert.equal(page2.hasMore, true);
		assert.deepEqual(
			page2.events.map((e) => e.payload.seq),
			[3, 4],
		);

		const page3 = store.listEvents(matter.id, {
			agentId: "storage-slice",
			limit: 2,
			order: "asc",
			cursor: page2.nextCursor,
		});
		assert.equal(page3.hasMore, false);
		assert.equal(page3.nextCursor, null);
		assert.deepEqual(
			page3.events.map((e) => e.payload.seq),
			[5],
		);
	} finally {
		db.close();
	}
});

test("HTTP board & event endpoints enforce matter visibility, org ACL, lazy body loading, and pagination", async () => {
	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db);
	const templates = await loadRoleTemplatesFromDir(resolve(process.cwd(), "roles"));
	const dialogBroker = new DialogBroker();
	const previewManager = new PreviewManager();
	const orchestrator = createStubOrchestrator(store, templates);
	const { server } = createPersonalAgentServer({
		store,
		orchestrator,
		templates,
		dialogBroker,
		previewManager,
		requireAuth: true,
	});
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const baseUrl = `http://127.0.0.1:${address.port}`;

	try {
		const alice = store.createUser({
			email: "alice@example.com",
			displayName: "Alice",
			password: "password-123",
			platformRole: "user",
		});
		const bob = store.createUser({
			email: "bob@example.com",
			displayName: "Bob",
			password: "password-123",
			platformRole: "user",
		});
		const charlie = store.createUser({
			email: "charlie@example.com",
			displayName: "Charlie",
			password: "password-123",
			platformRole: "user",
		});

		const orgA = store.upsertOrganization({ name: "Org A", createdByUserId: alice.id });
		const orgB = store.upsertOrganization({ name: "Org B", createdByUserId: charlie.id });
		store.upsertOrgMember({ orgId: orgA.id, userId: alice.id, orgRole: "org_owner" });
		store.upsertOrgMember({ orgId: orgA.id, userId: bob.id, orgRole: "org_member" });
		store.upsertOrgMember({ orgId: orgB.id, userId: charlie.id, orgRole: "org_owner" });

		const aliceToken = store.createSession(alice.id).rawToken;
		const bobToken = store.createSession(bob.id).rawToken;
		const charlieToken = store.createSession(charlie.id).rawToken;
		const aliceCookie = `pa_session=${aliceToken}`;
		const bobCookie = `pa_session=${bobToken}`;
		const charlieCookie = `pa_session=${charlieToken}`;

		const orgMatter = store.createMatter({
			title: "Org A Board Matter",
			orgId: orgA.id,
			createdByUserId: alice.id,
			visibility: "org",
			collaborationMode: "board",
			coordinatorMemberId: "product-manager",
		});
		const privateMatter = store.createMatter({
			title: "Alice Private Matter",
			orgId: orgA.id,
			createdByUserId: alice.id,
			visibility: "private",
			collaborationMode: "board",
		});

		store.upsertBoardMember({
			matterId: orgMatter.id,
			agentId: "builder-1",
			displayName: "Builder 1",
			boardRole: "builder",
		});
		store.createBoardPost({
			matterId: orgMatter.id,
			authorType: "agent",
			authorId: "builder-1",
			kind: "handoff",
			summary: "Ready for review",
			body: "VERY_LONG_BODY_CONTENT_ONLY_LAZY_LOADED",
		});
		store.createBoardPost({
			matterId: privateMatter.id,
			authorType: "agent",
			authorId: "coordinator",
			kind: "assign",
			summary: "Private slice",
			body: "Secret body",
		});
		store.appendEvent({
			matterId: orgMatter.id,
			runId: "run_1",
			agentId: "builder-1",
			boardPostNo: 1,
			eventType: "tool_start",
			payload: { toolName: "read" },
		});
		store.appendEvent({
			matterId: orgMatter.id,
			runId: "run_1",
			agentId: "builder-1",
			boardPostNo: 1,
			eventType: "tool_end",
			payload: { toolName: "read", isError: false },
		});

		// Unauthenticated -> 401
		assert.equal((await fetch(`${baseUrl}/api/matters/${orgMatter.id}/board`)).status, 401);

		// Missing matter -> 404
		assert.equal(
			(await fetch(`${baseUrl}/api/matters/mat_missing/board`, { headers: { Cookie: aliceCookie } })).status,
			404,
		);
		assert.equal(
			(await fetch(`${baseUrl}/api/matters/mat_missing/board/posts/1`, { headers: { Cookie: aliceCookie } })).status,
			404,
		);
		assert.equal(
			(await fetch(`${baseUrl}/api/matters/mat_missing/events`, { headers: { Cookie: aliceCookie } })).status,
			404,
		);

		// Cross-org access -> 403
		assert.equal(
			(await fetch(`${baseUrl}/api/matters/${orgMatter.id}/board`, { headers: { Cookie: charlieCookie } })).status,
			403,
		);
		assert.equal(
			(await fetch(`${baseUrl}/api/matters/${orgMatter.id}/board/posts/1`, { headers: { Cookie: charlieCookie } }))
				.status,
			403,
		);
		assert.equal(
			(await fetch(`${baseUrl}/api/matters/${orgMatter.id}/events`, { headers: { Cookie: charlieCookie } })).status,
			403,
		);

		// Same-org non-collaborator on private matter -> 403
		assert.equal(
			(await fetch(`${baseUrl}/api/matters/${privateMatter.id}/board`, { headers: { Cookie: bobCookie } })).status,
			403,
		);
		assert.equal(
			(await fetch(`${baseUrl}/api/matters/${privateMatter.id}/board/posts/1`, { headers: { Cookie: bobCookie } }))
				.status,
			403,
		);
		assert.equal(
			(await fetch(`${baseUrl}/api/matters/${privateMatter.id}/events`, { headers: { Cookie: bobCookie } })).status,
			403,
		);

		// Same-org member on org matter -> 200 and lazy-read omits body in board summary
		const boardRes = await fetch(`${baseUrl}/api/matters/${orgMatter.id}/board`, {
			headers: { Cookie: bobCookie },
		});
		assert.equal(boardRes.status, 200);
		const boardJson = (await boardRes.json()) as {
			collaborationMode: string;
			coordinatorMemberId: string | null;
			members: Array<{ agentId: string }>;
			posts: Array<Record<string, unknown>>;
		};
		assert.equal(boardJson.collaborationMode, "board");
		assert.equal(boardJson.coordinatorMemberId, "product-manager");
		assert.equal(boardJson.members.length, 1);
		assert.equal(boardJson.posts.length, 1);
		assert.equal("body" in boardJson.posts[0]!, false);
		assert.equal(boardJson.posts[0]?.hasBody, true);

		// Lazy full post endpoint -> 200 with body, 404 for unknown postNo, 400 for invalid postNo
		const postRes = await fetch(`${baseUrl}/api/matters/${orgMatter.id}/board/posts/1`, {
			headers: { Cookie: bobCookie },
		});
		assert.equal(postRes.status, 200);
		const postJson = (await postRes.json()) as { post: { postNo: number; body: string } };
		assert.equal(postJson.post.postNo, 1);
		assert.equal(postJson.post.body, "VERY_LONG_BODY_CONTENT_ONLY_LAZY_LOADED");
		assert.equal(
			(await fetch(`${baseUrl}/api/matters/${orgMatter.id}/board/posts/99`, { headers: { Cookie: bobCookie } }))
				.status,
			404,
		);
		assert.equal(
			(
				await fetch(`${baseUrl}/api/matters/${orgMatter.id}/board/posts/not-a-num`, {
					headers: { Cookie: bobCookie },
				})
			).status,
			400,
		);

		// Paginated events endpoint
		const eventsPage1Res = await fetch(`${baseUrl}/api/matters/${orgMatter.id}/events?limit=1&order=asc`, {
			headers: { Cookie: bobCookie },
		});
		assert.equal(eventsPage1Res.status, 200);
		const eventsPage1 = (await eventsPage1Res.json()) as {
			events: Array<{ eventType: string }>;
			nextCursor: string | null;
			hasMore: boolean;
			total: number;
		};
		assert.equal(eventsPage1.total, 2);
		assert.equal(eventsPage1.hasMore, true);
		assert.equal(eventsPage1.events[0]?.eventType, "tool_start");
		assert.ok(eventsPage1.nextCursor);

		const eventsPage2Res = await fetch(
			`${baseUrl}/api/matters/${orgMatter.id}/events?limit=1&order=asc&cursor=${encodeURIComponent(eventsPage1.nextCursor)}`,
			{ headers: { Cookie: bobCookie } },
		);
		assert.equal(eventsPage2Res.status, 200);
		const eventsPage2 = (await eventsPage2Res.json()) as {
			events: Array<{ eventType: string }>;
			hasMore: boolean;
		};
		assert.equal(eventsPage2.hasMore, false);
		assert.equal(eventsPage2.events[0]?.eventType, "tool_end");

		// Invalid cursor -> 400
		assert.equal(
			(
				await fetch(`${baseUrl}/api/matters/${orgMatter.id}/events?cursor=invalid-cursor`, {
					headers: { Cookie: bobCookie },
				})
			).status,
			400,
		);
	} finally {
		await previewManager.stopAll();
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		db.close();
	}
});
