import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "./schema.ts";

// Identifies the fresh 0.7.0 database format, rather than a sequence of upgrades.
const DATABASE_APPLICATION_ID = 0x50413730;

/** Open a 0.7.0 database, creating its schema only when the database is empty. */
export function openPersonalAgentDatabase(dbPath = ":memory:"): DatabaseSync {
	if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
	const db = new DatabaseSync(dbPath);
	try {
		db.exec("PRAGMA foreign_keys = ON");
		db.exec("BEGIN IMMEDIATE");
		try {
			const applicationId = Number(db.prepare("PRAGMA application_id").get()?.application_id);
			if (applicationId !== DATABASE_APPLICATION_ID) {
				const existing = db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get();
				const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
				if (applicationId !== 0 || version !== 0 || existing) {
					throw new Error("This database is not a Personal Agent 0.7.0 database. Select a new data directory.");
				}
				db.exec(SCHEMA_SQL);
				db.exec(`PRAGMA application_id = ${DATABASE_APPLICATION_ID}`);
			} else {
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
				`);
			}
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
		if (dbPath !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}
