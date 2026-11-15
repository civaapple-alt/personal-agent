import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA_SQL = `
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
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_links (
	id TEXT PRIMARY KEY,
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
	observer_ids_json TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS member_memories (
	id TEXT PRIMARY KEY,
	member_id TEXT NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
	scope TEXT NOT NULL,
	workspace_id TEXT REFERENCES workspace_links(id) ON DELETE CASCADE,
	content TEXT NOT NULL,
	source_matter_id TEXT REFERENCES matters(id) ON DELETE SET NULL,
	verified INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL
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

CREATE INDEX IF NOT EXISTS idx_member_memories_lookup ON member_memories(member_id, scope, workspace_id);
CREATE INDEX IF NOT EXISTS idx_matter_messages_matter ON matter_messages(matter_id, channel, created_at);
CREATE INDEX IF NOT EXISTS idx_deliverables_matter ON deliverables(matter_id, version);
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
	const columns = db.prepare("PRAGMA table_info(worker_sessions)").all();
	if (!columns.some((column) => column.name === "context_key")) {
		db.exec("ALTER TABLE worker_sessions ADD COLUMN context_key TEXT");
	}
	if (!columns.some((column) => column.name === "message_cursor")) {
		db.exec("ALTER TABLE worker_sessions ADD COLUMN message_cursor TEXT");
	}
	db.exec("CREATE INDEX IF NOT EXISTS idx_worker_context ON worker_sessions(matter_id, member_id, context_key)");
	return db;
}
