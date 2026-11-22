import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openPersonalAgentDatabase } from "../src/storage/database.ts";

test("a fresh database can be reopened with its data and complete schema", () => {
	const dir = mkdtempSync(join(tmpdir(), "pa-baseline-"));
	const path = join(dir, "data.db");
	try {
		const db = openPersonalAgentDatabase(path);
		db.prepare("INSERT INTO platform_settings VALUES (?, ?, ?)").run("test", "true", "2026-01-01");
		assert.ok(
			db
				.prepare("PRAGMA table_info(matters)")
				.all()
				.some((column) => column.name === "model_selection_json"),
		);
		assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
		const tables = db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
			.all()
			.map((row) => row.name);
		assert.ok(tables.includes("space_document_memory_votes"));
		assert.ok(!tables.includes("deliverables"));
		assert.ok(!tables.includes("deliverable_memory_applications"));
		assert.ok(!tables.includes("memory_feedback_votes"));
		db.close();
		const reopened = openPersonalAgentDatabase(path);
		assert.equal(
			reopened.prepare("SELECT value_json FROM platform_settings WHERE key = 'test'").get()?.value_json,
			"true",
		);
		reopened.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an older or unrelated database is rejected without altering its contents", () => {
	const dir = mkdtempSync(join(tmpdir(), "pa-old-database-"));
	const path = join(dir, "data.db");
	try {
		const old = new DatabaseSync(path);
		old.exec(
			"CREATE TABLE original (value TEXT); INSERT INTO original VALUES ('preserved'); PRAGMA user_version = 11",
		);
		old.close();
		assert.throws(() => openPersonalAgentDatabase(path), /not a Personal Agent 0\.7\.0 database/);
		const check = new DatabaseSync(path);
		assert.equal(check.prepare("SELECT value FROM original").get()?.value, "preserved");
		assert.equal(check.prepare("PRAGMA user_version").get()?.user_version, 11);
		check.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
