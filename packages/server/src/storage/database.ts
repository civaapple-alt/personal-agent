import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { backfillLegacyMessagesToBoardAndEvents, runInImmediateTransaction } from "./repos/board-repo.ts";
import { MATTER_BOARD_SCHEMA_SQL, SCHEMA_SQL } from "./schema.ts";

// Preserves the PA70 application_id while advancing user_version for 0.9.0 schema additions.
const DATABASE_APPLICATION_ID = 0x50413730;
const DATABASE_USER_VERSION_090 = 900;

function listTableColumns(db: DatabaseSync, tableName: string): Set<string> {
	const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>;
	return new Set(rows.map((row) => String(row.name)));
}

function migrateExistingDatabase(db: DatabaseSync): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS user_access_tokens (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			name TEXT NOT NULL,
			token_hash TEXT NOT NULL UNIQUE,
			token_prefix TEXT NOT NULL,
			scope TEXT NOT NULL DEFAULT 'read' CHECK (scope IN ('read', 'full')),
			allowed_org_ids_json TEXT,
			allowed_workspace_ids_json TEXT,
			expires_at TEXT,
			last_used_at TEXT,
			revoked_at TEXT,
			created_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_user_access_tokens_user ON user_access_tokens(user_id, created_at DESC);
		CREATE INDEX IF NOT EXISTS idx_user_access_tokens_hash ON user_access_tokens(token_hash);
		CREATE TABLE IF NOT EXISTS skill_trust_policies (
			storage_scope TEXT NOT NULL CHECK (storage_scope IN ('global', 'org', 'personal', 'workspace')),
			scope_id TEXT NOT NULL DEFAULT '',
			skill_name TEXT NOT NULL,
			trust_level TEXT NOT NULL DEFAULT 'confirm' CHECK (trust_level IN ('confirm', 'autonomous', 'disabled')),
			run_count INTEGER NOT NULL DEFAULT 0,
			last_run_at TEXT,
			last_outcome TEXT,
			updated_by_user_id TEXT,
			updated_at TEXT NOT NULL,
			PRIMARY KEY (storage_scope, scope_id, skill_name)
		);
		CREATE INDEX IF NOT EXISTS idx_skill_trust_policies_scope ON skill_trust_policies(storage_scope, scope_id);
	`);
	db.exec(MATTER_BOARD_SCHEMA_SQL);

	const matterCols = listTableColumns(db, "matters");
	if (!matterCols.has("collaboration_mode")) {
		db.exec(
			"ALTER TABLE matters ADD COLUMN collaboration_mode TEXT NOT NULL DEFAULT 'lead' CHECK (collaboration_mode IN ('lead', 'board'))",
		);
	}
	if (!matterCols.has("coordinator_member_id")) {
		db.exec("ALTER TABLE matters ADD COLUMN coordinator_member_id TEXT REFERENCES team_members(id)");
	}

	const messageCols = listTableColumns(db, "matter_messages");
	if (!messageCols.has("kind")) {
		db.exec(
			"ALTER TABLE matter_messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat' CHECK (kind IN ('chat', 'ai_request', 'human_decision', 'observer', 'system_summary'))",
		);
	}
	if (!messageCols.has("decision_status")) {
		db.exec(
			"ALTER TABLE matter_messages ADD COLUMN decision_status TEXT CHECK (decision_status IS NULL OR decision_status IN ('pending', 'approved', 'dismissed', 'answered'))",
		);
	}
	if (!messageCols.has("board_post_no")) {
		db.exec("ALTER TABLE matter_messages ADD COLUMN board_post_no INTEGER");
	}
	db.exec(
		"CREATE INDEX IF NOT EXISTS idx_matter_messages_decision_status ON matter_messages(matter_id, decision_status) WHERE decision_status IS NOT NULL",
	);

	backfillLegacyMessagesToBoardAndEvents(db);
	const currentVersion = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
	if (currentVersion < DATABASE_USER_VERSION_090) {
		db.exec(`PRAGMA user_version = ${DATABASE_USER_VERSION_090}`);
	}
}

/** Open a Personal Agent database, creating the 0.9.0 schema when empty or idempotently migrating existing 0.8.x (PA70) DBs. */
export function openPersonalAgentDatabase(dbPath = ":memory:"): DatabaseSync {
	if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
	const db = new DatabaseSync(dbPath);
	try {
		db.exec("PRAGMA foreign_keys = ON");
		runInImmediateTransaction(db, () => {
			const applicationId = Number(db.prepare("PRAGMA application_id").get()?.application_id);
			if (applicationId !== DATABASE_APPLICATION_ID) {
				const existing = db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get();
				const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
				if (applicationId !== 0 || version !== 0 || existing) {
					throw new Error("This database is not a Personal Agent 0.7.0 database. Select a new data directory.");
				}
				db.exec(SCHEMA_SQL);
				db.exec(`PRAGMA application_id = ${DATABASE_APPLICATION_ID}`);
				db.exec(`PRAGMA user_version = ${DATABASE_USER_VERSION_090}`);
			} else {
				migrateExistingDatabase(db);
			}
		});
		if (dbPath !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}
