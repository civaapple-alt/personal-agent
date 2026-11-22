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
