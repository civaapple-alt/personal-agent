import type { DatabaseSync } from "node:sqlite";
import { MEMBER_MEMORIES_SQL, MESSAGE_WORKSPACE_ID_SQL, SCHEMA_SQL, WORKSPACE_LINKS_SQL } from "./schema.ts";

const SCHEMA_VERSION = 3;

export function migrateDatabase(db: DatabaseSync): void {
	const readVersion = () => Number(db.prepare("PRAGMA user_version").get()?.user_version);
	if (readVersion() === SCHEMA_VERSION) return;

	// Rebuilding tables preserves their names and inbound foreign keys. Check references before committing.
	db.exec("PRAGMA foreign_keys = OFF");
	try {
		db.exec("BEGIN IMMEDIATE");
		try {
			const version = readVersion();
			if (version > SCHEMA_VERSION) throw new Error(`Unsupported SQLite schema version: ${version}`);
			if (version < 1) {
				db.exec(SCHEMA_SQL);
				migrateLegacyColumns(db);
				db.exec("PRAGMA user_version = 1");
			}
			if (version < 2) {
				restoreLegacyForeignKeys(db);
				removeDeletedMatterRoles(db);
				createIndexes(db);
				const violation = db.prepare("PRAGMA foreign_key_check").get();
				if (violation) {
					throw new Error(
						`Foreign key violation during storage upgrade: ${violation.table}, row ${violation.rowid}`,
					);
				}
				db.exec("PRAGMA user_version = 2");
			}
			if (version < 3) {
				if (
					!db
						.prepare("PRAGMA table_info(matters)")
						.all()
						.some((column) => column.name === "model_selection_json")
				) {
					db.exec("ALTER TABLE matters ADD COLUMN model_selection_json TEXT");
				}
				migrateOrgModelOverrides(db);
				db.exec("PRAGMA user_version = 3");
			}
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	} finally {
		db.exec("PRAGMA foreign_keys = ON");
	}
}

// Older organization overrides could specify only one field. Preserve that organization's
// existing choice as a complete model pair before role-level preferences stop participating.
function migrateOrgModelOverrides(db: DatabaseSync): void {
	db.exec(`
		UPDATE organization_ai_roles AS config
		SET provider_override = COALESCE(
			NULLIF(TRIM(config.provider_override), ''),
			(SELECT NULLIF(TRIM(member.provider), '') FROM team_members AS member WHERE member.id = config.member_id)
		), model_override = COALESCE(
			NULLIF(TRIM(config.model_override), ''),
			(SELECT NULLIF(TRIM(member.model), '') FROM team_members AS member WHERE member.id = config.member_id)
		)
		WHERE (config.provider_override IS NOT NULL OR config.model_override IS NOT NULL OR config.thinking_level_override IS NOT NULL)
			AND (NULLIF(TRIM(config.provider_override), '') IS NULL OR NULLIF(TRIM(config.model_override), '') IS NULL);
	`);
}

function migrateLegacyColumns(db: DatabaseSync): void {
	const ensureColumn = (table: string, name: string, ddl: string): boolean => {
		if (
			db
				.prepare(`PRAGMA table_info(${table})`)
				.all()
				.some((column) => column.name === name)
		)
			return false;
		db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
		return true;
	};
	const ensureWorkspaceColumn = (name: string, ddl: string) => ensureColumn("workspace_links", name, ddl);
	ensureWorkspaceColumn("org_id", "TEXT REFERENCES organizations(id) ON DELETE SET NULL");
	ensureWorkspaceColumn("source_type", "TEXT NOT NULL DEFAULT 'local'");
	ensureWorkspaceColumn("clone_url", "TEXT");
	ensureWorkspaceColumn("visibility", "TEXT NOT NULL DEFAULT 'org'");

	const ensureMatterColumn = (name: string, ddl: string) => ensureColumn("matters", name, ddl);
	ensureMatterColumn("observer_ids_json", "TEXT");
	ensureMatterColumn("ai_member_ids_json", "TEXT");
	if (ensureMatterColumn("observers_enabled", "INTEGER NOT NULL DEFAULT 0")) {
		db.exec(`
			UPDATE matters SET observers_enabled = 1
			WHERE observer_ids_json IS NOT NULL AND observer_ids_json != '[]' AND trim(observer_ids_json) != '';
		`);
	}
	ensureMatterColumn("collaborator_ids_json", "TEXT");
	if (ensureMatterColumn("org_id", "TEXT REFERENCES organizations(id) ON DELETE SET NULL")) {
		db.exec(`
			UPDATE matters
			SET org_id = (SELECT workspace_links.org_id FROM workspace_links WHERE workspace_links.id = matters.workspace_id)
			WHERE org_id IS NULL AND workspace_id IS NOT NULL;
		`);
	}
	ensureMatterColumn("created_by_user_id", "TEXT");
	ensureMatterColumn("visibility", "TEXT NOT NULL DEFAULT 'org'");
	ensureMatterColumn("consult_member_ids_json", "TEXT");
	ensureMatterColumn("discussion_ai_enabled", "INTEGER NOT NULL DEFAULT 0");
	ensureColumn("worker_sessions", "context_key", "TEXT");
	ensureColumn("worker_sessions", "message_cursor", "TEXT");
	const ensureMemberColumn = (name: string, ddl: string) => ensureColumn("team_members", name, ddl);
	ensureMemberColumn("git_name", "TEXT NOT NULL DEFAULT ''");
	ensureMemberColumn("git_email", "TEXT NOT NULL DEFAULT ''");
	ensureMemberColumn("identity_summary", "TEXT NOT NULL DEFAULT ''");
	ensureMemberColumn("role_scope", "TEXT NOT NULL DEFAULT 'global'");
	ensureMemberColumn("owner_org_id", "TEXT");
	ensureMemberColumn("owner_user_id", "TEXT");
	if (ensureColumn("users", "max_personal_roles", "INTEGER NOT NULL DEFAULT 5")) {
		db.exec("UPDATE users SET max_personal_roles = 100 WHERE platform_role = 'super_admin'");
	}
	db.exec(`
		UPDATE team_members
		SET role_scope = CASE
			WHEN owner_user_id IS NOT NULL AND TRIM(owner_user_id) != '' THEN 'personal'
			WHEN owner_org_id IS NOT NULL AND TRIM(owner_org_id) != '' THEN 'org'
			ELSE 'global'
		END
		WHERE role_scope IS NULL OR TRIM(role_scope) = '' OR (role_scope = 'global' AND (owner_org_id IS NOT NULL OR owner_user_id IS NOT NULL));
	`);
	db.exec(`
		UPDATE team_members
		SET git_name = CASE
			WHEN TRIM(display_name) != '' AND display_name GLOB '[ -~]*' AND display_name NOT GLOB '*[^ -~]*' THEN TRIM(display_name)
			WHEN TRIM(role_title) != '' AND role_title GLOB '[ -~]*' AND role_title NOT GLOB '*[^ -~]*' THEN TRIM(role_title)
			ELSE id
		END
		WHERE TRIM(git_name) = '';
		UPDATE team_members SET git_email = id || '@team.local' WHERE TRIM(git_email) = '';
	`);
	const ensureOrgColumn = (name: string, ddl: string) => ensureColumn("organizations", name, ddl);
	ensureOrgColumn("is_default", "INTEGER NOT NULL DEFAULT 0");
	ensureOrgColumn("slug", "TEXT NOT NULL DEFAULT ''");
	ensureOrgColumn("use_role_git_identity", "INTEGER NOT NULL DEFAULT 0");
	ensureOrgColumn("workspaces_dir", "TEXT");
	ensureOrgColumn("created_by_user_id", "TEXT");
	ensureColumn("organization_ai_roles", "git_name_override", "TEXT");
	ensureColumn("organization_ai_roles", "git_email_override", "TEXT");

	const ensureMemoryColumn = (name: string, ddl: string) => ensureColumn("member_memories", name, ddl);
	ensureMemoryColumn("org_id", "TEXT REFERENCES organizations(id) ON DELETE SET NULL");
	ensureMemoryColumn("rationale", "TEXT NOT NULL DEFAULT ''");
	ensureMemoryColumn("category", "TEXT NOT NULL DEFAULT 'general'");
	ensureMemoryColumn("source_matter_id", "TEXT REFERENCES matters(id) ON DELETE SET NULL");
	ensureMemoryColumn("source_deliverable_id", "TEXT REFERENCES deliverables(id) ON DELETE SET NULL");
	ensureMemoryColumn("status", "TEXT");
	ensureMemoryColumn("superseded_by", "TEXT");
	ensureMemoryColumn("supersedes_memory_id", "TEXT");
	ensureMemoryColumn("applied_count", "INTEGER NOT NULL DEFAULT 0");
	ensureMemoryColumn("positive_count", "INTEGER NOT NULL DEFAULT 0");
	ensureMemoryColumn("negative_count", "INTEGER NOT NULL DEFAULT 0");
	ensureMemoryColumn("last_applied_at", "TEXT");
	ensureMemoryColumn("updated_at", "TEXT");
	db.exec(`
		UPDATE member_memories
		SET status = CASE WHEN verified = 1 THEN 'verified' ELSE 'candidate' END
		WHERE status IS NULL OR status = '';
		UPDATE member_memories SET category = 'general' WHERE category IS NULL OR category = '';
		UPDATE member_memories SET updated_at = created_at WHERE updated_at IS NULL;
	`);
	ensureColumn("deliverables", "feedback_rating", "TEXT");
}

function restoreLegacyForeignKeys(db: DatabaseSync): void {
	if (!hasForeignKeys(db, "workspace_links", ["org_id"])) {
		rebuildTable(db, "workspace_links", WORKSPACE_LINKS_SQL, [
			"id",
			"org_id",
			"name",
			"repo_path",
			"default_branch",
			"description",
			"created_at",
			"source_type",
			"clone_url",
			"visibility",
		]);
	}
	if (
		!hasForeignKeys(db, "member_memories", [
			"member_id",
			"org_id",
			"workspace_id",
			"source_matter_id",
			"source_deliverable_id",
		])
	) {
		rebuildTable(db, "member_memories", MEMBER_MEMORIES_SQL, [
			"id",
			"member_id",
			"scope",
			"category",
			"org_id",
			"workspace_id",
			"content",
			"rationale",
			"source_matter_id",
			"source_deliverable_id",
			"status",
			"verified",
			"superseded_by",
			"supersedes_memory_id",
			"applied_count",
			"positive_count",
			"negative_count",
			"last_applied_at",
			"created_at",
			"updated_at",
		]);
	}
}

function hasForeignKeys(db: DatabaseSync, table: string, columns: string[]): boolean {
	const keys = db.prepare(`PRAGMA foreign_key_list(${table})`).all();
	return columns.every((column) => keys.some((key) => key.from === column));
}

function rebuildTable(db: DatabaseSync, table: string, ddl: string, columns: string[]): void {
	const temporary = `${table}_upgrade`;
	db.exec(ddl.replace(`CREATE TABLE IF NOT EXISTS ${table}`, `CREATE TABLE ${temporary}`));
	const fields = columns.join(", ");
	db.exec(`
		INSERT INTO ${temporary} (rowid, ${fields}) SELECT rowid, ${fields} FROM ${table};
		DROP TABLE ${table};
		ALTER TABLE ${temporary} RENAME TO ${table};
	`);
}

function removeDeletedMatterRoles(db: DatabaseSync): void {
	const repairRoster = (column: string) => {
		db.exec(`
			UPDATE matters
			SET ${column} = (
				SELECT json_group_array(value)
				FROM json_each(matters.${column})
				WHERE EXISTS (SELECT 1 FROM team_members WHERE id = value)
			)
			WHERE CASE WHEN json_valid(${column}) THEN json_type(${column}) = 'array' ELSE 0 END
			AND EXISTS (
				SELECT 1 FROM json_each(${column})
				WHERE NOT EXISTS (SELECT 1 FROM team_members WHERE id = value)
			);
		`);
	};
	repairRoster("ai_member_ids_json");
	repairRoster("consult_member_ids_json");
	// Only turn off the switch if this cleanup removes every configured observer.
	db.exec(`
		UPDATE matters SET observers_enabled = 0
		WHERE observers_enabled = 1
		AND CASE WHEN json_valid(observer_ids_json) THEN json_type(observer_ids_json) = 'array'
			AND json_array_length(observer_ids_json) > 0 ELSE 0 END
		AND NOT EXISTS (
			SELECT 1 FROM json_each(observer_ids_json)
			JOIN team_members ON team_members.id = value
		);
	`);
	repairRoster("observer_ids_json");
}

function createIndexes(db: DatabaseSync): void {
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_member_memories_lookup ON member_memories(member_id, scope, workspace_id);
		CREATE INDEX IF NOT EXISTS idx_worker_context ON worker_sessions(matter_id, member_id, context_key);
		CREATE INDEX IF NOT EXISTS idx_matters_workspace ON matters(workspace_id);
		CREATE INDEX IF NOT EXISTS idx_worker_workspace ON worker_sessions(workspace_id);
		CREATE INDEX IF NOT EXISTS idx_memories_workspace ON member_memories(workspace_id);
		CREATE INDEX IF NOT EXISTS idx_matter_messages_workspace ON matter_messages(${MESSAGE_WORKSPACE_ID_SQL});
		CREATE INDEX IF NOT EXISTS idx_workspace_links_org ON workspace_links(org_id);
		CREATE INDEX IF NOT EXISTS idx_member_memories_org ON member_memories(member_id, org_id);
		CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
		CREATE INDEX IF NOT EXISTS idx_org_members_user ON organization_members(user_id, org_id);
		CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);
		CREATE INDEX IF NOT EXISTS idx_uploads_matter ON uploads_index(matter_id);
	`);
}
