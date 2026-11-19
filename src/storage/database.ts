import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrateDatabase } from "./migrations.ts";

/** Open a local SQLite database and apply all pending schema migrations. */
export function openPersonalAgentDatabase(dbPath = ":memory:"): DatabaseSync {
	if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
	const db = new DatabaseSync(dbPath);
	try {
		db.exec("PRAGMA foreign_keys = ON");
		if (dbPath !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
		migrateDatabase(db);
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}
