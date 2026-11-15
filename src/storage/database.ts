import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS organizations (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	git_email_domain TEXT NOT NULL DEFAULT '',
	description TEXT NOT NULL DEFAULT '',
	is_default INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS team_members (
	id TEXT PRIMARY KEY,
	template_id TEXT NOT NULL,
	display_name TEXT NOT NULL,
	role_title TEXT NOT NULL,
	is_primary_contact INTEGER NOT NULL DEFAULT 0,
	provider TEXT NOT NULL,
	model TEXT NOT NULL,
	thinking_level TEXT NOT NULL,
	keywords_json TEXT NOT NULL DEFAULT '[]',
	git_name TEXT NOT NULL DEFAULT '',
	git_email TEXT NOT NULL DEFAULT '',
	identity_summary TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_links (
	id TEXT PRIMARY KEY,
	org_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
	name TEXT NOT NULL,
	repo_path TEXT NOT NULL UNIQUE,
	default_branch TEXT NOT NULL DEFAULT 'main',
	description TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS matters (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	summary TEXT NOT NULL DEFAULT '',
	status TEXT NOT NULL DEFAULT 'open',
	lead_member_id TEXT REFERENCES team_members(id),
	workspace_id TEXT REFERENCES workspace_links(id),
	org_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
	observer_ids_json TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS member_memories (
	id TEXT PRIMARY KEY,
	member_id TEXT NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
	scope TEXT NOT NULL,
	category TEXT NOT NULL DEFAULT 'general',
	org_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
	workspace_id TEXT REFERENCES workspace_links(id) ON DELETE CASCADE,
	content TEXT NOT NULL,
	rationale TEXT NOT NULL DEFAULT '',
	source_matter_id TEXT REFERENCES matters(id) ON DELETE SET NULL,
	source_deliverable_id TEXT REFERENCES deliverables(id) ON DELETE SET NULL,
	status TEXT NOT NULL DEFAULT 'candidate',
	verified INTEGER NOT NULL DEFAULT 0,
	superseded_by TEXT,
	supersedes_memory_id TEXT,
	applied_count INTEGER NOT NULL DEFAULT 0,
	positive_count INTEGER NOT NULL DEFAULT 0,
	negative_count INTEGER NOT NULL DEFAULT 0,
	last_applied_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT
);

CREATE TABLE IF NOT EXISTS matter_messages (
	id TEXT PRIMARY KEY,
	matter_id TEXT NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
	channel TEXT NOT NULL,
	sender_type TEXT NOT NULL,
	sender_id TEXT NOT NULL,
	content TEXT NOT NULL,
	metadata_json TEXT,
	created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deliverables (
	id TEXT PRIMARY KEY,
	matter_id TEXT NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
	member_id TEXT NOT NULL REFERENCES team_members(id),
	type TEXT NOT NULL,
	title TEXT NOT NULL,
	summary TEXT NOT NULL DEFAULT '',
	content_or_path TEXT NOT NULL,
	service_url TEXT,
	version INTEGER NOT NULL,
	feedback TEXT,
	feedback_rating TEXT,
	created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_applications (
	id TEXT PRIMARY KEY,
	memory_id TEXT NOT NULL REFERENCES member_memories(id) ON DELETE CASCADE,
	matter_id TEXT NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
	member_id TEXT NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
	deliverable_id TEXT REFERENCES deliverables(id) ON DELETE SET NULL,
	outcome TEXT NOT NULL DEFAULT 'applied',
	note TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS matter_execution_leases (
	matter_id TEXT PRIMARY KEY REFERENCES matters(id) ON DELETE CASCADE,
	owner_id TEXT NOT NULL,
	owner_pid INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_sessions (
	id TEXT PRIMARY KEY,
	member_id TEXT NOT NULL REFERENCES team_members(id),
	matter_id TEXT NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
	workspace_id TEXT REFERENCES workspace_links(id),
	pi_session_id TEXT,
	session_file TEXT,
	status TEXT NOT NULL DEFAULT 'active',
	last_active_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deliverable_memory_applications (
	deliverable_id TEXT NOT NULL REFERENCES deliverables(id) ON DELETE CASCADE,
	application_id TEXT NOT NULL REFERENCES memory_applications(id) ON DELETE CASCADE,
	PRIMARY KEY (deliverable_id, application_id)
);
CREATE TABLE IF NOT EXISTS memory_feedback_votes (
	deliverable_id TEXT NOT NULL REFERENCES deliverables(id) ON DELETE CASCADE,
	memory_id TEXT NOT NULL REFERENCES member_memories(id) ON DELETE CASCADE,
	rating TEXT NOT NULL,
	PRIMARY KEY (deliverable_id, memory_id)
);
CREATE INDEX IF NOT EXISTS idx_member_memories_lookup ON member_memories(member_id, scope, workspace_id);
CREATE INDEX IF NOT EXISTS idx_matter_messages_matter ON matter_messages(matter_id, channel, created_at);
CREATE INDEX IF NOT EXISTS idx_deliverables_matter ON deliverables(matter_id, version);
CREATE INDEX IF NOT EXISTS idx_memory_applications_lookup ON memory_applications(memory_id, created_at);
CREATE INDEX IF NOT EXISTS idx_memory_applications_matter ON memory_applications(matter_id, member_id);
`;

/**
 * Open a local SQLite database (or `:memory:` for tests) and initialize all
 * Personal Agent domain tables.
 */
export function openPersonalAgentDatabase(dbPath = ":memory:"): DatabaseSync {
	if (dbPath !== ":memory:") {
		mkdirSync(dirname(dbPath), { recursive: true });
	}
	const db = new DatabaseSync(dbPath);
	db.exec("PRAGMA foreign_keys = ON;");
	if (dbPath !== ":memory:") {
		db.exec("PRAGMA journal_mode = WAL;");
	}
	db.exec(SCHEMA_SQL);
	const matterColumns = db.prepare("PRAGMA table_info(matters)").all();
	if (!matterColumns.some((column) => column.name === "observer_ids_json")) {
		db.exec("ALTER TABLE matters ADD COLUMN observer_ids_json TEXT");
	}
	if (!matterColumns.some((column) => column.name === "org_id")) {
		db.exec("ALTER TABLE matters ADD COLUMN org_id TEXT REFERENCES organizations(id) ON DELETE SET NULL");
		db.exec(`
			UPDATE matters
			SET org_id = (SELECT org_id FROM workspace_links WHERE workspace_links.id = matters.workspace_id)
			WHERE org_id IS NULL AND workspace_id IS NOT NULL;
		`);
	}
	const columns = db.prepare("PRAGMA table_info(worker_sessions)").all();
	if (!columns.some((column) => column.name === "context_key")) {
		db.exec("ALTER TABLE worker_sessions ADD COLUMN context_key TEXT");
	}
	if (!columns.some((column) => column.name === "message_cursor")) {
		db.exec("ALTER TABLE worker_sessions ADD COLUMN message_cursor TEXT");
	}
	const memberColumns = db.prepare("PRAGMA table_info(team_members)").all();
	const ensureMemberCol = (name: string, ddl: string) => {
		if (!memberColumns.some((column) => column.name === name)) {
			db.exec(`ALTER TABLE team_members ADD COLUMN ${ddl}`);
		}
	};
	ensureMemberCol("git_name", "git_name TEXT NOT NULL DEFAULT ''");
	ensureMemberCol("git_email", "git_email TEXT NOT NULL DEFAULT ''");
	ensureMemberCol("identity_summary", "identity_summary TEXT NOT NULL DEFAULT ''");
	db.exec(`
		UPDATE team_members
		SET git_name = CASE
			WHEN TRIM(display_name) != '' AND display_name GLOB '[ -~]*' AND display_name NOT GLOB '*[^ -~]*' THEN TRIM(display_name)
			WHEN TRIM(role_title) != '' AND role_title GLOB '[ -~]*' AND role_title NOT GLOB '*[^ -~]*' THEN TRIM(role_title)
			ELSE id
		END
		WHERE TRIM(git_name) = ''
		   OR (git_name = display_name AND display_name GLOB '*[^ -~]*');
		UPDATE team_members SET git_email = id || '@team.local' WHERE TRIM(git_email) = '';
	`);
	const orgColumns = db.prepare("PRAGMA table_info(organizations)").all();
	if (!orgColumns.some((column) => column.name === "is_default")) {
		db.exec("ALTER TABLE organizations ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0");
	}
	const workspaceColumns = db.prepare("PRAGMA table_info(workspace_links)").all();
	if (!workspaceColumns.some((column) => column.name === "org_id")) {
		db.exec("ALTER TABLE workspace_links ADD COLUMN org_id TEXT");
	}
	const memoryColumns = db.prepare("PRAGMA table_info(member_memories)").all();
	const ensureMemoryCol = (name: string, ddl: string) => {
		if (!memoryColumns.some((column) => column.name === name)) {
			db.exec(`ALTER TABLE member_memories ADD COLUMN ${ddl}`);
		}
	};
	ensureMemoryCol("org_id", "org_id TEXT");
	ensureMemoryCol("rationale", "rationale TEXT NOT NULL DEFAULT ''");
	ensureMemoryCol("category", "category TEXT NOT NULL DEFAULT 'general'");
	ensureMemoryCol("source_deliverable_id", "source_deliverable_id TEXT");
	ensureMemoryCol("status", "status TEXT");
	ensureMemoryCol("superseded_by", "superseded_by TEXT");
	ensureMemoryCol("supersedes_memory_id", "supersedes_memory_id TEXT");
	ensureMemoryCol("applied_count", "applied_count INTEGER NOT NULL DEFAULT 0");
	ensureMemoryCol("positive_count", "positive_count INTEGER NOT NULL DEFAULT 0");
	ensureMemoryCol("negative_count", "negative_count INTEGER NOT NULL DEFAULT 0");
	ensureMemoryCol("last_applied_at", "last_applied_at TEXT");
	ensureMemoryCol("updated_at", "updated_at TEXT");
	db.exec(`
		UPDATE member_memories
		SET status = CASE WHEN verified = 1 THEN 'verified' ELSE 'candidate' END
		WHERE status IS NULL OR status = '';
		UPDATE member_memories SET category = 'general' WHERE category IS NULL OR category = '';
		UPDATE member_memories SET updated_at = created_at WHERE updated_at IS NULL;
	`);
	const deliverableColumns = db.prepare("PRAGMA table_info(deliverables)").all();
	if (!deliverableColumns.some((column) => column.name === "feedback_rating")) {
		db.exec("ALTER TABLE deliverables ADD COLUMN feedback_rating TEXT");
	}
	db.exec("CREATE INDEX IF NOT EXISTS idx_worker_context ON worker_sessions(matter_id, member_id, context_key)");
	db.exec("CREATE INDEX IF NOT EXISTS idx_workspace_links_org ON workspace_links(org_id)");
	db.exec("CREATE INDEX IF NOT EXISTS idx_member_memories_org ON member_memories(member_id, org_id)");
	return db;
}
