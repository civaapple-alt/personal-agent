export const MESSAGE_WORKSPACE_ID_SQL =
	"CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.workspaceId') END";

// The complete schema for newly created 0.7.0 databases.
export const SCHEMA_SQL = `
CREATE TABLE audit_logs (
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

CREATE TABLE collaborators (
	id TEXT PRIMARY KEY,
	org_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
	name TEXT NOT NULL,
	role_title TEXT NOT NULL DEFAULT '',
	permission_role TEXT NOT NULL DEFAULT 'collaborator',
	token TEXT NOT NULL UNIQUE,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE deliverable_memory_applications (
	deliverable_id TEXT NOT NULL REFERENCES deliverables(id) ON DELETE CASCADE,
	application_id TEXT NOT NULL REFERENCES memory_applications(id) ON DELETE CASCADE,
	PRIMARY KEY (deliverable_id, application_id)
);

CREATE TABLE deliverables (
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

CREATE TABLE matter_execution_leases (
	matter_id TEXT PRIMARY KEY REFERENCES matters(id) ON DELETE CASCADE,
	owner_id TEXT NOT NULL,
	owner_pid INTEGER NOT NULL
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

CREATE TABLE matters (
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
	updated_at TEXT NOT NULL,
	created_by_user_id TEXT,
	visibility TEXT NOT NULL DEFAULT 'org',
	model_selection_json TEXT
);

CREATE TABLE member_memories (
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

CREATE TABLE memory_applications (
	id TEXT PRIMARY KEY,
	memory_id TEXT NOT NULL REFERENCES member_memories(id) ON DELETE CASCADE,
	matter_id TEXT NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
	member_id TEXT NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
	deliverable_id TEXT REFERENCES deliverables(id) ON DELETE SET NULL,
	document_id TEXT REFERENCES space_documents(id) ON DELETE SET NULL,
	commit_hash TEXT,
	actor_id TEXT,
	outcome TEXT NOT NULL DEFAULT 'applied',
	note TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL
);

CREATE TABLE memory_feedback_votes (
	deliverable_id TEXT NOT NULL REFERENCES deliverables(id) ON DELETE CASCADE,
	memory_id TEXT NOT NULL REFERENCES member_memories(id) ON DELETE CASCADE,
	rating TEXT NOT NULL,
	PRIMARY KEY (deliverable_id, memory_id)
);

CREATE TABLE organization_ai_roles (
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

CREATE TABLE organization_invites (
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

CREATE TABLE organization_members (
	org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	org_role TEXT NOT NULL DEFAULT 'org_member',
	role_title TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (org_id, user_id)
);

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

CREATE TABLE platform_settings (
	key TEXT PRIMARY KEY,
	value_json TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE removed_role_templates (
	template_id TEXT PRIMARY KEY,
	removed_at TEXT NOT NULL
);

CREATE TABLE space_documents (
	id TEXT PRIMARY KEY,
	space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
	matter_id TEXT REFERENCES matters(id) ON DELETE SET NULL,
	file_path TEXT NOT NULL,
	title TEXT NOT NULL,
	doc_type TEXT NOT NULL DEFAULT 'note',
	entry_kind TEXT NOT NULL DEFAULT 'file' CHECK (entry_kind IN ('file', 'folder')),
	linked_org_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
	linked_workspace_id TEXT REFERENCES workspace_links(id) ON DELETE SET NULL,
	linked_file_path TEXT,
	head_commit TEXT NOT NULL DEFAULT '',
	revision INTEGER NOT NULL DEFAULT 1,
	created_by TEXT NOT NULL,
	updated_by TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	UNIQUE (space_id, file_path)
);

CREATE TABLE space_document_feedback (
	document_id TEXT NOT NULL REFERENCES space_documents(id) ON DELETE CASCADE,
	commit_hash TEXT NOT NULL,
	actor_id TEXT NOT NULL,
	actor_name TEXT NOT NULL,
	feedback TEXT NOT NULL DEFAULT '',
	rating TEXT CHECK (rating IS NULL OR rating IN ('positive', 'negative', 'neutral')),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (document_id, commit_hash, actor_id)
);

CREATE TABLE space_document_memory_applications (
	document_id TEXT NOT NULL REFERENCES space_documents(id) ON DELETE CASCADE,
	commit_hash TEXT NOT NULL,
	application_id TEXT NOT NULL REFERENCES memory_applications(id) ON DELETE CASCADE,
	PRIMARY KEY (document_id, commit_hash, application_id)
);

CREATE TABLE space_document_memory_votes (
	document_id TEXT NOT NULL,
	commit_hash TEXT NOT NULL,
	actor_id TEXT NOT NULL,
	memory_id TEXT NOT NULL REFERENCES member_memories(id) ON DELETE CASCADE,
	rating TEXT NOT NULL CHECK (rating IN ('positive', 'negative')),
	PRIMARY KEY (document_id, commit_hash, actor_id, memory_id),
	FOREIGN KEY (document_id, commit_hash, actor_id) REFERENCES space_document_feedback(document_id, commit_hash, actor_id) ON DELETE CASCADE
);

CREATE TRIGGER space_memory_vote_insert AFTER INSERT ON space_document_memory_votes BEGIN
	UPDATE member_memories SET positive_count = positive_count + (NEW.rating = 'positive'),
		negative_count = negative_count + (NEW.rating = 'negative'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
		WHERE id = NEW.memory_id;
END;

CREATE TRIGGER space_memory_vote_update AFTER UPDATE OF rating ON space_document_memory_votes BEGIN
	UPDATE member_memories SET positive_count = positive_count + (NEW.rating = 'positive') - (OLD.rating = 'positive'),
		negative_count = negative_count + (NEW.rating = 'negative') - (OLD.rating = 'negative'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
		WHERE id = NEW.memory_id;
END;

CREATE TRIGGER space_memory_vote_delete AFTER DELETE ON space_document_memory_votes BEGIN
	UPDATE member_memories SET positive_count = positive_count - (OLD.rating = 'positive'),
		negative_count = negative_count - (OLD.rating = 'negative'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
		WHERE id = OLD.memory_id;
END;

CREATE TABLE spaces (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL CHECK (kind IN ('org', 'workspace', 'user', 'member', 'custom')),
	org_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
	workspace_id TEXT REFERENCES workspace_links(id) ON DELETE CASCADE,
	owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
	member_id TEXT REFERENCES team_members(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	description TEXT NOT NULL DEFAULT '',
	visibility TEXT NOT NULL DEFAULT 'org' CHECK (visibility IN ('org', 'private')),
	created_by TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE team_members (
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

CREATE TABLE uploads_index (
	filename TEXT PRIMARY KEY,
	org_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
	matter_id TEXT REFERENCES matters(id) ON DELETE SET NULL,
	uploader_user_id TEXT,
	kind TEXT NOT NULL DEFAULT 'image',
	mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
	created_at TEXT NOT NULL
);

CREATE TABLE user_sessions (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	expires_at TEXT NOT NULL,
	revoked_at TEXT,
	ip TEXT NOT NULL DEFAULT '',
	user_agent TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL
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

CREATE TABLE worker_sessions (
	id TEXT PRIMARY KEY,
	member_id TEXT NOT NULL REFERENCES team_members(id),
	matter_id TEXT NOT NULL REFERENCES matters(id) ON DELETE CASCADE,
	workspace_id TEXT REFERENCES workspace_links(id),
	pi_session_id TEXT,
	session_file TEXT,
	status TEXT NOT NULL DEFAULT 'active',
	last_active_at TEXT NOT NULL,
	context_key TEXT,
	message_cursor TEXT
);

CREATE TABLE workspace_folders (
	id TEXT PRIMARY KEY,
	workspace_id TEXT NOT NULL REFERENCES workspace_links(id) ON DELETE CASCADE,
	label TEXT NOT NULL,
	path TEXT NOT NULL,
	source_type TEXT NOT NULL DEFAULT 'local' CHECK (source_type IN ('local', 'cloned')),
	role TEXT NOT NULL DEFAULT 'attached' CHECK (role IN ('primary', 'attached')),
	load_rules INTEGER NOT NULL DEFAULT 1,
	load_skills INTEGER NOT NULL DEFAULT 1,
	sort_order INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	UNIQUE (workspace_id, path)
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

CREATE TABLE workspace_members (
	workspace_id TEXT NOT NULL REFERENCES workspace_links(id) ON DELETE CASCADE,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	created_at TEXT NOT NULL,
	PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX idx_audit_logs_created ON audit_logs(created_at DESC);

CREATE INDEX idx_deliverables_matter ON deliverables(matter_id, version);

CREATE INDEX idx_matter_messages_matter ON matter_messages(matter_id, channel, created_at);

CREATE INDEX idx_matter_messages_workspace ON matter_messages(CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.workspaceId') END);

CREATE INDEX idx_matters_workspace ON matters(workspace_id);

CREATE INDEX idx_member_memories_lookup ON member_memories(member_id, scope, workspace_id);

CREATE INDEX idx_member_memories_org ON member_memories(member_id, org_id);

CREATE INDEX idx_memories_workspace ON member_memories(workspace_id);

CREATE INDEX idx_memory_applications_lookup ON memory_applications(memory_id, created_at);

CREATE INDEX idx_memory_applications_matter ON memory_applications(matter_id, member_id);

CREATE INDEX idx_org_members_user ON organization_members(user_id, org_id);

CREATE INDEX idx_space_documents_matter ON space_documents(matter_id, updated_at DESC);

CREATE INDEX idx_space_documents_space ON space_documents(space_id, updated_at DESC);

CREATE INDEX idx_space_documents_type ON space_documents(space_id, doc_type, updated_at DESC);

CREATE INDEX idx_spaces_kind ON spaces(kind, org_id, updated_at DESC);

CREATE INDEX idx_uploads_matter ON uploads_index(matter_id);

CREATE INDEX idx_user_sessions_user ON user_sessions(user_id);

CREATE INDEX idx_worker_context ON worker_sessions(matter_id, member_id, context_key);

CREATE INDEX idx_worker_workspace ON worker_sessions(workspace_id);

CREATE INDEX idx_workspace_folders_ws ON workspace_folders(workspace_id, sort_order, created_at);

CREATE INDEX idx_workspace_links_org ON workspace_links(org_id);
`;
