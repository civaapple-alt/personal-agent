import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ThinkingLevel } from "../rpc/types.ts";
import type {
	Deliverable,
	DeliverableType,
	Matter,
	MatterMessage,
	MatterMessageChannel,
	MatterMessageSenderType,
	MatterStatus,
	MemberMemory,
	MemoryScope,
	TeamMember,
	WorkerSessionRecord,
	WorkspaceLink,
} from "./types.ts";

function nowIso(): string {
	return new Date().toISOString();
}

export class PersonalAgentStore {
	private readonly db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	upsertMember(input: {
		id: string;
		templateId: string;
		displayName: string;
		roleTitle: string;
		isPrimaryContact: boolean;
		provider: string;
		model: string;
		thinkingLevel: ThinkingLevel;
		keywords: string[];
	}): TeamMember {
		const timestamp = nowIso();
		const existing = this.getMember(input.id);
		if (existing) {
			this.db
				.prepare(
					`UPDATE team_members
					 SET template_id = ?, display_name = ?, role_title = ?, is_primary_contact = ?,
					     provider = ?, model = ?, thinking_level = ?, keywords_json = ?, updated_at = ?
					 WHERE id = ?`,
				)
				.run(
					input.templateId,
					input.displayName,
					input.roleTitle,
					input.isPrimaryContact ? 1 : 0,
					input.provider,
					input.model,
					input.thinkingLevel,
					JSON.stringify(input.keywords),
					timestamp,
					input.id,
				);
			return this.getMember(input.id)!;
		}

		this.db
			.prepare(
				`INSERT INTO team_members (
					id, template_id, display_name, role_title, is_primary_contact,
					provider, model, thinking_level, keywords_json, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				input.id,
				input.templateId,
				input.displayName,
				input.roleTitle,
				input.isPrimaryContact ? 1 : 0,
				input.provider,
				input.model,
				input.thinkingLevel,
				JSON.stringify(input.keywords),
				timestamp,
				timestamp,
			);
		return this.getMember(input.id)!;
	}

	getMember(id: string): TeamMember | null {
		const row = this.db.prepare("SELECT * FROM team_members WHERE id = ?").get(id) as
			| Record<string, unknown>
			| undefined;
		return row ? this.mapMember(row) : null;
	}

	listMembers(): TeamMember[] {
		const rows = this.db
			.prepare("SELECT * FROM team_members ORDER BY is_primary_contact DESC, created_at ASC")
			.all() as Record<string, unknown>[];
		return rows.map((row) => this.mapMember(row));
	}

	getPrimaryContact(): TeamMember | null {
		const row = this.db.prepare("SELECT * FROM team_members WHERE is_primary_contact = 1 LIMIT 1").get() as
			| Record<string, unknown>
			| undefined;
		return row ? this.mapMember(row) : null;
	}

	addMemory(input: {
		memberId: string;
		scope: MemoryScope;
		workspaceId?: string | null;
		content: string;
		sourceMatterId?: string | null;
		verified?: boolean;
	}): MemberMemory {
		const id = `mem_${randomUUID()}`;
		const timestamp = nowIso();
		this.db
			.prepare(
				`INSERT INTO member_memories (
					id, member_id, scope, workspace_id, content, source_matter_id, verified, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				input.memberId,
				input.scope,
				input.workspaceId ?? null,
				input.content,
				input.sourceMatterId ?? null,
				input.verified ? 1 : 0,
				timestamp,
			);
		return {
			id,
			memberId: input.memberId,
			scope: input.scope,
			workspaceId: input.workspaceId ?? null,
			content: input.content,
			sourceMatterId: input.sourceMatterId ?? null,
			verified: Boolean(input.verified),
			createdAt: timestamp,
		};
	}

	/**
	 * Load applicable memories for a member working in an optional workspace.
	 * Project-private memories from other workspaces are excluded to prevent cross-project leakage.
	 */
	listRelevantMemories(memberId: string, workspaceId: string | null): MemberMemory[] {
		const rows = (
			workspaceId
				? this.db
						.prepare(
							`SELECT * FROM member_memories
							 WHERE member_id = ?
							   AND (scope IN ('role_general', 'company_private')
							        OR (scope = 'project_private' AND workspace_id = ?))
							 ORDER BY created_at ASC, rowid ASC`,
						)
						.all(memberId, workspaceId)
				: this.db
						.prepare(
							`SELECT * FROM member_memories
							 WHERE member_id = ? AND scope IN ('role_general', 'company_private')
							 ORDER BY created_at ASC, rowid ASC`,
						)
						.all(memberId)
		) as Record<string, unknown>[];

		return rows.map((row) => ({
			id: String(row.id),
			memberId: String(row.member_id),
			scope: row.scope as MemoryScope,
			workspaceId: row.workspace_id ? String(row.workspace_id) : null,
			content: String(row.content),
			sourceMatterId: row.source_matter_id ? String(row.source_matter_id) : null,
			verified: Boolean(row.verified),
			createdAt: String(row.created_at),
		}));
	}

	upsertWorkspace(input: {
		id?: string;
		name: string;
		repoPath: string;
		defaultBranch?: string;
		description?: string;
	}): WorkspaceLink {
		const existing = this.db.prepare("SELECT * FROM workspace_links WHERE repo_path = ?").get(input.repoPath) as
			| Record<string, unknown>
			| undefined;
		if (existing) {
			this.db
				.prepare(
					`UPDATE workspace_links
					 SET name = ?, default_branch = ?, description = ?
					 WHERE id = ?`,
				)
				.run(
					input.name,
					input.defaultBranch ?? String(existing.default_branch),
					input.description ?? String(existing.description),
					String(existing.id),
				);
			return this.getWorkspace(String(existing.id))!;
		}

		const id = input.id ?? `ws_${randomUUID()}`;
		const timestamp = nowIso();
		this.db
			.prepare(
				`INSERT INTO workspace_links (id, name, repo_path, default_branch, description, created_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(id, input.name, input.repoPath, input.defaultBranch ?? "main", input.description ?? "", timestamp);
		return this.getWorkspace(id)!;
	}

	getWorkspace(id: string): WorkspaceLink | null {
		const row = this.db.prepare("SELECT * FROM workspace_links WHERE id = ?").get(id) as
			| Record<string, unknown>
			| undefined;
		return row ? this.mapWorkspace(row) : null;
	}

	listWorkspaces(): WorkspaceLink[] {
		const rows = this.db.prepare("SELECT * FROM workspace_links ORDER BY created_at ASC").all() as Record<
			string,
			unknown
		>[];
		return rows.map((row) => this.mapWorkspace(row));
	}

	createMatter(input: {
		title: string;
		summary?: string;
		leadMemberId?: string | null;
		workspaceId?: string | null;
	}): Matter {
		const id = `mat_${randomUUID()}`;
		const timestamp = nowIso();
		this.db
			.prepare(
				`INSERT INTO matters (id, title, summary, status, lead_member_id, workspace_id, created_at, updated_at)
				 VALUES (?, ?, ?, 'open', ?, ?, ?, ?)`,
			)
			.run(
				id,
				input.title,
				input.summary ?? "",
				input.leadMemberId ?? null,
				input.workspaceId ?? null,
				timestamp,
				timestamp,
			);
		return this.getMatter(id)!;
	}

	getMatter(id: string): Matter | null {
		const row = this.db.prepare("SELECT * FROM matters WHERE id = ?").get(id) as Record<string, unknown> | undefined;
		return row ? this.mapMatter(row) : null;
	}

	listMatters(): Matter[] {
		const rows = this.db.prepare("SELECT * FROM matters ORDER BY updated_at DESC").all() as Record<string, unknown>[];
		return rows.map((row) => this.mapMatter(row));
	}

	updateMatterStatus(matterId: string, status: MatterStatus, summary?: string): Matter {
		const timestamp = nowIso();
		if (summary !== undefined) {
			this.db
				.prepare("UPDATE matters SET status = ?, summary = ?, updated_at = ? WHERE id = ?")
				.run(status, summary, timestamp, matterId);
		} else {
			this.db.prepare("UPDATE matters SET status = ?, updated_at = ? WHERE id = ?").run(status, timestamp, matterId);
		}
		return this.getMatter(matterId)!;
	}

	appendMessage(input: {
		matterId: string;
		channel: MatterMessageChannel;
		senderType: MatterMessageSenderType;
		senderId: string;
		content: string;
		metadata?: Record<string, unknown> | null;
	}): MatterMessage {
		const id = `msg_${randomUUID()}`;
		const timestamp = nowIso();
		this.db
			.prepare(
				`INSERT INTO matter_messages (id, matter_id, channel, sender_type, sender_id, content, metadata_json, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				input.matterId,
				input.channel,
				input.senderType,
				input.senderId,
				input.content,
				input.metadata ? JSON.stringify(input.metadata) : null,
				timestamp,
			);
		this.db.prepare("UPDATE matters SET updated_at = ? WHERE id = ?").run(timestamp, input.matterId);
		return {
			id,
			matterId: input.matterId,
			channel: input.channel,
			senderType: input.senderType,
			senderId: input.senderId,
			content: input.content,
			metadata: input.metadata ?? null,
			createdAt: timestamp,
		};
	}

	listMessages(matterId: string, channel?: MatterMessageChannel): MatterMessage[] {
		const rows = (
			channel
				? this.db
						.prepare(
							"SELECT * FROM matter_messages WHERE matter_id = ? AND channel = ? ORDER BY created_at ASC, rowid ASC",
						)
						.all(matterId, channel)
				: this.db
						.prepare("SELECT * FROM matter_messages WHERE matter_id = ? ORDER BY created_at ASC, rowid ASC")
						.all(matterId)
		) as Record<string, unknown>[];

		return rows.map((row) => ({
			id: String(row.id),
			matterId: String(row.matter_id),
			channel: row.channel as MatterMessageChannel,
			senderType: row.sender_type as MatterMessageSenderType,
			senderId: String(row.sender_id),
			content: String(row.content),
			metadata: row.metadata_json ? (JSON.parse(String(row.metadata_json)) as Record<string, unknown>) : null,
			createdAt: String(row.created_at),
		}));
	}

	/**
	 * Record a deliverable and auto-increment its version within the matter+title series.
	 */
	recordDeliverable(input: {
		matterId: string;
		memberId: string;
		type: DeliverableType;
		title: string;
		summary?: string;
		contentOrPath: string;
		serviceUrl?: string | null;
	}): Deliverable {
		const maxRow = this.db
			.prepare("SELECT COALESCE(MAX(version), 0) AS max_ver FROM deliverables WHERE matter_id = ? AND title = ?")
			.get(input.matterId, input.title) as { max_ver: number };
		const version = Number(maxRow.max_ver) + 1;
		const id = `del_${randomUUID()}`;
		const timestamp = nowIso();

		this.db
			.prepare(
				`INSERT INTO deliverables (
					id, matter_id, member_id, type, title, summary, content_or_path, service_url, version, feedback, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
			)
			.run(
				id,
				input.matterId,
				input.memberId,
				input.type,
				input.title,
				input.summary ?? "",
				input.contentOrPath,
				input.serviceUrl ?? null,
				version,
				timestamp,
			);
		this.db.prepare("UPDATE matters SET updated_at = ? WHERE id = ?").run(timestamp, input.matterId);

		return {
			id,
			matterId: input.matterId,
			memberId: input.memberId,
			type: input.type,
			title: input.title,
			summary: input.summary ?? "",
			contentOrPath: input.contentOrPath,
			serviceUrl: input.serviceUrl ?? null,
			version,
			feedback: null,
			createdAt: timestamp,
		};
	}

	listDeliverables(matterId?: string): Deliverable[] {
		const rows = (
			matterId
				? this.db
						.prepare("SELECT * FROM deliverables WHERE matter_id = ? ORDER BY created_at DESC, version DESC")
						.all(matterId)
				: this.db.prepare("SELECT * FROM deliverables ORDER BY created_at DESC, version DESC").all()
		) as Record<string, unknown>[];

		return rows.map((row) => ({
			id: String(row.id),
			matterId: String(row.matter_id),
			memberId: String(row.member_id),
			type: row.type as DeliverableType,
			title: String(row.title),
			summary: String(row.summary),
			contentOrPath: String(row.content_or_path),
			serviceUrl: row.service_url ? String(row.service_url) : null,
			version: Number(row.version),
			feedback: row.feedback ? String(row.feedback) : null,
			createdAt: String(row.created_at),
		}));
	}

	addDeliverableFeedback(deliverableId: string, feedback: string): void {
		this.db.prepare("UPDATE deliverables SET feedback = ? WHERE id = ?").run(feedback, deliverableId);
	}

	recordWorkerSession(input: {
		memberId: string;
		matterId: string;
		workspaceId: string | null;
		piSessionId: string | null;
		sessionFile: string | null;
		status: "active" | "idle" | "closed";
	}): WorkerSessionRecord {
		const id = `wsess_${randomUUID()}`;
		const timestamp = nowIso();
		this.db
			.prepare(
				`INSERT INTO worker_sessions (id, member_id, matter_id, workspace_id, pi_session_id, session_file, status, last_active_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				input.memberId,
				input.matterId,
				input.workspaceId,
				input.piSessionId,
				input.sessionFile,
				input.status,
				timestamp,
			);
		return {
			id,
			memberId: input.memberId,
			matterId: input.matterId,
			workspaceId: input.workspaceId,
			piSessionId: input.piSessionId,
			sessionFile: input.sessionFile,
			status: input.status,
			lastActiveAt: timestamp,
		};
	}

	private mapMember(row: Record<string, unknown>): TeamMember {
		return {
			id: String(row.id),
			templateId: String(row.template_id),
			displayName: String(row.display_name),
			roleTitle: String(row.role_title),
			isPrimaryContact: Boolean(row.is_primary_contact),
			provider: String(row.provider),
			model: String(row.model),
			thinkingLevel: row.thinking_level as ThinkingLevel,
			keywords: JSON.parse(String(row.keywords_json)) as string[],
			createdAt: String(row.created_at),
			updatedAt: String(row.updated_at),
		};
	}

	private mapWorkspace(row: Record<string, unknown>): WorkspaceLink {
		return {
			id: String(row.id),
			name: String(row.name),
			repoPath: String(row.repo_path),
			defaultBranch: String(row.default_branch),
			description: String(row.description),
			createdAt: String(row.created_at),
		};
	}

	private mapMatter(row: Record<string, unknown>): Matter {
		return {
			id: String(row.id),
			title: String(row.title),
			summary: String(row.summary),
			status: row.status as MatterStatus,
			leadMemberId: row.lead_member_id ? String(row.lead_member_id) : null,
			workspaceId: row.workspace_id ? String(row.workspace_id) : null,
			createdAt: String(row.created_at),
			updatedAt: String(row.updated_at),
		};
	}
}
