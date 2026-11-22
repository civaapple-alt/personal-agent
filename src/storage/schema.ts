export const MESSAGE_WORKSPACE_ID_SQL =
	"CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.workspaceId') END";

export const MEMBER_MEMORIES_SQL = `CREATE TABLE IF NOT EXISTS member_memories (
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
);`;

export const WORKSPACE_LINKS_SQL = `CREATE TABLE IF NOT EXISTS workspace_links (
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
);`;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS organizations (
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

CREATE TABLE IF NOT EXISTS users (
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

CREATE TABLE IF NOT EXISTS user_sessions (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	expires_at TEXT NOT NULL,
	revoked_at TEXT,
	ip TEXT NOT NULL DEFAULT '',
	user_agent TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_settings (
	key TEXT PRIMARY KEY,
	value_json TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS organization_members (
	org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	org_role TEXT NOT NULL DEFAULT 'org_member',
	role_title TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (org_id, user_id)
);

CREATE TABLE IF NOT EXISTS organization_invites (
	id TEXT PRIMARY KEY,
	org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
	token_hash TEXT NOT NULL UNIQUE,
	org_role TEXT NOT NULL DEFAULT 'org_member',
	created_by_user_id TEXT NOT NULL,
	max_uses INTEGER NOT NULL DEFAULT 1,
	used_count INTEGER NOT NULL DEFAULT 0,
	expires_at TEXT,
	revoked_at TEXT,
	created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS organization_ai_roles (
	org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
	member_id TEXT NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
	enabled INTEGER NOT NULL DEFAULT 1,
	is_primary_contact INTEGER NOT NULL DEFAULT 0,
	display_name_override TEXT,
	provider_override TEXT,
	model_override TEXT,
	thinking_level_override TEXT,
	git_name_override TEXT,
	git_email_override TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (org_id, member_id)
);

CREATE TABLE IF NOT EXISTS workspace_members (
	workspace_id TEXT NOT NULL REFERENCES workspace_links(id) ON DELETE CASCADE,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	created_at TEXT NOT NULL,
	PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS uploads_index (
	filename TEXT PRIMARY KEY,
	org_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
	matter_id TEXT REFERENCES matters(id) ON DELETE SET NULL,
	uploader_user_id TEXT,
	kind TEXT NOT NULL DEFAULT 'image',
	mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
	created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
	id TEXT PRIMARY KEY,
	actor_user_id TEXT,
	actor_email TEXT NOT NULL DEFAULT '',
	actor_name TEXT NOT NULL DEFAULT '',
	action TEXT NOT NULL,
	target_type TEXT NOT NULL DEFAULT '',
	target_id TEXT NOT NULL DEFAULT '',
	org_id TEXT,
	detail_json TEXT,
	ip TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collaborators (
	id TEXT PRIMARY KEY,
	org_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
	name TEXT NOT NULL,
	role_title TEXT NOT NULL DEFAULT '',
	permission_role TEXT NOT NULL DEFAULT 'collaborator',
	token TEXT NOT NULL UNIQUE,
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
	role_scope TEXT NOT NULL DEFAULT 'global',
	owner_org_id TEXT,
	owner_user_id TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS removed_role_templates (
	template_id TEXT PRIMARY KEY,
	removed_at TEXT NOT NULL
);

${WORKSPACE_LINKS_SQL}

CREATE TABLE IF NOT EXISTS matters (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	summary TEXT NOT NULL DEFAULT '',
	status TEXT NOT NULL DEFAULT 'open',
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
	updated_at TEXT NOT NULL
);

${MEMBER_MEMORIES_SQL}

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

CREATE TABLE IF NOT EXISTS space_pages (
	id TEXT PRIMARY KEY,
	matter_id TEXT NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
	title TEXT NOT NULL,
	content TEXT NOT NULL,
	revision INTEGER NOT NULL,
	created_by TEXT NOT NULL,
	updated_by TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS space_page_revisions (
	page_id TEXT NOT NULL REFERENCES space_pages(id) ON DELETE CASCADE,
	revision INTEGER NOT NULL,
	title TEXT NOT NULL,
	content TEXT NOT NULL,
	updated_by TEXT NOT NULL,
	created_at TEXT NOT NULL,
	PRIMARY KEY (page_id, revision)
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
CREATE INDEX IF NOT EXISTS idx_matter_messages_matter ON matter_messages(matter_id, channel, created_at);
CREATE INDEX IF NOT EXISTS idx_deliverables_matter ON deliverables(matter_id, version);
CREATE INDEX IF NOT EXISTS idx_memory_applications_lookup ON memory_applications(memory_id, created_at);
CREATE INDEX IF NOT EXISTS idx_memory_applications_matter ON memory_applications(matter_id, member_id);
`;
