import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ThinkingLevel } from "../rpc/types.ts";
import type {
	Deliverable,
	DeliverableType,
	FeedbackRating,
	Matter,
	MatterMessage,
	MatterMessageChannel,
	MatterMessageSenderType,
	MatterStatus,
	MemberMemory,
	MemoryApplicationOutcome,
	MemoryApplicationRecord,
	MemoryScope,
	MemoryStatus,
	TeamMember,
	WorkerSessionRecord,
	WorkspaceLink,
} from "./types.ts";

function nowIso(): string {
	return new Date().toISOString();
}

function normalizeUniqueIds(ids?: string[]): string[] {
	if (!ids) return [];
	const seen = new Set<string>();
	const result: string[] = [];
	for (const id of ids) {
		const trimmed = id.trim();
		if (trimmed && !seen.has(trimmed)) {
			seen.add(trimmed);
			result.push(trimmed);
		}
	}
	return result;
}

function parseUniqueIds(raw: unknown): string[] {
	if (typeof raw !== "string" || !raw.trim()) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return normalizeUniqueIds(parsed.filter((item): item is string => typeof item === "string"));
	} catch {
		return [];
	}
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

	setPrimaryContact(memberId: string): TeamMember {
		const existing = this.getMember(memberId);
		if (!existing) {
			throw new Error(`Member not found: ${memberId}`);
		}
		const timestamp = nowIso();
		this.db.prepare("UPDATE team_members SET is_primary_contact = 0, updated_at = ?").run(timestamp);
		this.db
			.prepare("UPDATE team_members SET is_primary_contact = 1, updated_at = ? WHERE id = ?")
			.run(timestamp, memberId);
		return this.getMember(memberId)!;
	}

	addMemory(input: {
		memberId: string;
		scope: MemoryScope;
		workspaceId?: string | null;
		content: string;
		rationale?: string;
		sourceMatterId?: string | null;
		sourceDeliverableId?: string | null;
		status?: MemoryStatus;
		verified?: boolean;
		supersedesMemoryId?: string | null;
		supersededBy?: string | null;
	}): MemberMemory {
		const id = `mem_${randomUUID()}`;
		const timestamp = nowIso();
		const status: MemoryStatus = input.status ?? (input.verified ? "verified" : "candidate");
		const verified = status === "verified";
		const workspaceId = input.scope === "role_general" ? null : (input.workspaceId ?? null);
		const supersedesId = input.supersedesMemoryId ?? null;
		this.db
			.prepare(
				`INSERT INTO member_memories (
					id, member_id, scope, workspace_id, content, rationale,
					source_matter_id, source_deliverable_id, status, verified,
					superseded_by, supersedes_memory_id,
					applied_count, positive_count, negative_count, last_applied_at,
					created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, NULL, ?, ?)`,
			)
			.run(
				id,
				input.memberId,
				input.scope,
				workspaceId,
				input.content,
				input.rationale ?? "",
				input.sourceMatterId ?? null,
				input.sourceDeliverableId ?? null,
				status,
				verified ? 1 : 0,
				input.supersededBy ?? null,
				supersedesId,
				timestamp,
				timestamp,
			);
		if (verified && supersedesId && supersedesId !== id) {
			this.markMemorySuperseded(supersedesId, id, timestamp);
		}
		return this.getMemory(id)!;
	}

	getMemory(id: string): MemberMemory | null {
		const row = this.db.prepare("SELECT * FROM member_memories WHERE id = ?").get(id) as
			| Record<string, unknown>
			| undefined;
		return row ? this.mapMemory(row) : null;
	}

	findActiveDuplicateMemory(
		memberId: string,
		scope: MemoryScope,
		workspaceId: string | null,
		content: string,
	): MemberMemory | null {
		const normalized = content.replace(/\s+/g, " ").trim().toLowerCase();
		if (!normalized) return null;
		const effectiveWs = scope === "role_general" ? null : workspaceId;
		return (
			this.listMemberMemories(memberId).find(
				(memory) =>
					(memory.status === "candidate" || memory.status === "verified") &&
					memory.scope === scope &&
					memory.workspaceId === effectiveWs &&
					memory.content.replace(/\s+/g, " ").trim().toLowerCase() === normalized,
			) ?? null
		);
	}

	updateMemory(
		id: string,
		patch: {
			content?: string;
			scope?: MemoryScope;
			workspaceId?: string | null;
			status?: MemoryStatus;
			rationale?: string;
			supersededBy?: string | null;
			supersedesMemoryId?: string | null;
		},
	): MemberMemory {
		const existing = this.getMemory(id);
		if (!existing) throw new Error(`Memory not found: ${id}`);
		const timestamp = nowIso();
		const nextScope = patch.scope ?? existing.scope;
		const nextWorkspaceId =
			nextScope === "role_general"
				? null
				: patch.workspaceId !== undefined
					? patch.workspaceId
					: existing.workspaceId;
		const nextContent = patch.content !== undefined ? patch.content.trim() : existing.content;
		if (!nextContent) throw new Error("Memory content cannot be empty");
		const nextStatus = patch.status ?? existing.status;
		const nextVerified = nextStatus === "verified";
		const nextRationale = patch.rationale !== undefined ? patch.rationale : existing.rationale;
		const nextSupersededBy = patch.supersededBy !== undefined ? patch.supersededBy : existing.supersededBy;
		const nextSupersedesId =
			patch.supersedesMemoryId !== undefined ? patch.supersedesMemoryId : existing.supersedesMemoryId;

		this.db
			.prepare(
				`UPDATE member_memories
				 SET scope = ?, workspace_id = ?, content = ?, rationale = ?,
				     status = ?, verified = ?, superseded_by = ?, supersedes_memory_id = ?, updated_at = ?
				 WHERE id = ?`,
			)
			.run(
				nextScope,
				nextWorkspaceId,
				nextContent,
				nextRationale,
				nextStatus,
				nextVerified ? 1 : 0,
				nextSupersededBy,
				nextSupersedesId,
				timestamp,
				id,
			);

		if (nextVerified && nextSupersedesId && nextSupersedesId !== id) {
			this.markMemorySuperseded(nextSupersedesId, id, timestamp);
		}
		return this.getMemory(id)!;
	}

	private markMemorySuperseded(targetMemoryId: string, replacementId: string, timestamp: string): void {
		this.db
			.prepare(
				`UPDATE member_memories
				 SET status = 'superseded', verified = 0, superseded_by = ?, updated_at = ?
				 WHERE id = ? AND status IN ('candidate', 'verified')`,
			)
			.run(replacementId, timestamp, targetMemoryId);
	}

	/** Private organization facts require an explicit workspace until organization identity exists. */
	listRelevantMemories(
		memberId: string,
		workspaceId: string | null,
		options?: { includeCandidates?: boolean },
	): MemberMemory[] {
		const includeCandidates = options?.includeCandidates ?? true;
		return this.listMemberMemories(memberId)
			.filter((memory) => {
				if (memory.status === "rejected" || memory.status === "superseded") return false;
				if (!includeCandidates && memory.status !== "verified") return false;
				return memory.scope === "role_general" || (workspaceId !== null && memory.workspaceId === workspaceId);
			})
			.sort((a, b) => {
				const rankA = a.status === "verified" ? 0 : 1;
				const rankB = b.status === "verified" ? 0 : 1;
				if (rankA !== rankB) return rankA - rankB;
				return 0;
			});
	}

	listMemberMemories(memberId: string): MemberMemory[] {
		const rows = this.db
			.prepare("SELECT * FROM member_memories WHERE member_id = ? ORDER BY created_at, rowid")
			.all(memberId) as Record<string, unknown>[];
		return rows.map((row) => this.mapMemory(row));
	}

	recordMemoryApplications(input: {
		memoryIds: string[];
		matterId: string;
		memberId: string;
		deliverableId?: string | null;
		note?: string;
	}): void {
		const uniqueIds = normalizeUniqueIds(input.memoryIds);
		if (uniqueIds.length === 0) return;
		const timestamp = nowIso();
		const insert = this.db.prepare(
			`INSERT INTO memory_applications (id, memory_id, matter_id, member_id, deliverable_id, outcome, note, created_at)
			 VALUES (?, ?, ?, ?, ?, 'applied', ?, ?)`,
		);
		const updateCount = this.db.prepare(
			`UPDATE member_memories
			 SET applied_count = applied_count + 1, last_applied_at = ?, updated_at = ?
			 WHERE id = ?`,
		);
		this.db.exec("BEGIN IMMEDIATE");
		try {
			for (const memoryId of uniqueIds) {
				insert.run(
					`mapp_${randomUUID()}`,
					memoryId,
					input.matterId,
					input.memberId,
					input.deliverableId ?? null,
					input.note ?? "",
					timestamp,
				);
				updateCount.run(timestamp, timestamp, memoryId);
			}
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	evaluateMemory(input: {
		memoryId: string;
		outcome: Exclude<MemoryApplicationOutcome, "applied">;
		matterId?: string | null;
		memberId?: string | null;
		deliverableId?: string | null;
		note?: string;
	}): MemberMemory {
		const existing = this.getMemory(input.memoryId);
		if (!existing) throw new Error(`Memory not found: ${input.memoryId}`);
		if (input.deliverableId && input.matterId) {
			const duplicate = this.db
				.prepare(
					`SELECT 1 FROM memory_applications
					 WHERE memory_id = ? AND deliverable_id = ? AND outcome = ? LIMIT 1`,
				)
				.get(input.memoryId, input.deliverableId, input.outcome);
			if (duplicate) return existing;
		}
		const timestamp = nowIso();
		const isPositive = input.outcome === "feedback_positive" || input.outcome === "turn_succeeded";
		const isNegative = input.outcome === "feedback_negative" || input.outcome === "turn_failed";
		if (input.matterId) {
			this.db
				.prepare(
					`INSERT INTO memory_applications (id, memory_id, matter_id, member_id, deliverable_id, outcome, note, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					`mapp_${randomUUID()}`,
					input.memoryId,
					input.matterId,
					input.memberId ?? existing.memberId,
					input.deliverableId ?? null,
					input.outcome,
					input.note ?? "",
					timestamp,
				);
		}
		if (isPositive) {
			this.db
				.prepare("UPDATE member_memories SET positive_count = positive_count + 1, updated_at = ? WHERE id = ?")
				.run(timestamp, input.memoryId);
		} else if (isNegative) {
			this.db
				.prepare("UPDATE member_memories SET negative_count = negative_count + 1, updated_at = ? WHERE id = ?")
				.run(timestamp, input.memoryId);
		}
		return this.getMemory(input.memoryId)!;
	}

	evaluateMatterMemories(input: {
		matterId: string;
		memberId?: string | null;
		deliverableId?: string | null;
		outcome: Exclude<MemoryApplicationOutcome, "applied">;
		note?: string;
	}): MemberMemory[] {
		const rows = (
			input.memberId
				? this.db
						.prepare(
							`SELECT DISTINCT memory_id FROM memory_applications
							 WHERE matter_id = ? AND member_id = ? AND outcome = 'applied'`,
						)
						.all(input.matterId, input.memberId)
				: this.db
						.prepare(
							`SELECT DISTINCT memory_id FROM memory_applications
							 WHERE matter_id = ? AND outcome = 'applied'`,
						)
						.all(input.matterId)
		) as Array<{ memory_id: string }>;
		const updated: MemberMemory[] = [];
		for (const row of rows) {
			updated.push(
				this.evaluateMemory({
					memoryId: String(row.memory_id),
					outcome: input.outcome,
					matterId: input.matterId,
					memberId: input.memberId,
					deliverableId: input.deliverableId,
					note: input.note,
				}),
			);
		}
		return updated;
	}

	listMemoryApplications(memoryId: string, limit = 20): MemoryApplicationRecord[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM memory_applications
				 WHERE memory_id = ?
				 ORDER BY created_at DESC, rowid DESC
				 LIMIT ?`,
			)
			.all(memoryId, limit) as Record<string, unknown>[];
		return rows.map((row) => ({
			id: String(row.id),
			memoryId: String(row.memory_id),
			matterId: String(row.matter_id),
			memberId: String(row.member_id),
			deliverableId: row.deliverable_id ? String(row.deliverable_id) : null,
			outcome: row.outcome as MemoryApplicationOutcome,
			note: String(row.note ?? ""),
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
		observerMemberIds?: string[];
	}): Matter {
		const id = `mat_${randomUUID()}`;
		const timestamp = nowIso();
		const observerIds = normalizeUniqueIds(input.observerMemberIds);
		this.db
			.prepare(
				`INSERT INTO matters (id, title, summary, status, lead_member_id, workspace_id, observer_ids_json, created_at, updated_at)
				 VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				input.title,
				input.summary ?? "",
				input.leadMemberId ?? null,
				input.workspaceId ?? null,
				JSON.stringify(observerIds),
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

	updateMatterWorkspace(matterId: string, workspaceId: string | null): Matter {
		const timestamp = nowIso();
		this.db
			.prepare("UPDATE matters SET workspace_id = ?, updated_at = ? WHERE id = ?")
			.run(workspaceId, timestamp, matterId);
		return this.getMatter(matterId)!;
	}

	updateMatterObservers(matterId: string, observerMemberIds: string[]): Matter {
		const timestamp = nowIso();
		const observerIds = normalizeUniqueIds(observerMemberIds);
		this.db
			.prepare("UPDATE matters SET observer_ids_json = ?, updated_at = ? WHERE id = ?")
			.run(JSON.stringify(observerIds), timestamp, matterId);
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
			feedbackRating: null,
			createdAt: timestamp,
		};
	}

	/** Commit a turn's index entries together, including their version numbers. */
	recordDeliverables(inputs: Parameters<PersonalAgentStore["recordDeliverable"]>[0][]): Deliverable[] {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const deliveries = inputs.map((input) => this.recordDeliverable(input));
			this.db.exec("COMMIT");
			return deliveries;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	getDeliverable(id: string): Deliverable | null {
		const row = this.db.prepare("SELECT * FROM deliverables WHERE id = ?").get(id) as
			| Record<string, unknown>
			| undefined;
		return row ? this.mapDeliverable(row) : null;
	}

	listDeliverables(matterId?: string): Deliverable[] {
		const rows = (
			matterId
				? this.db
						.prepare("SELECT * FROM deliverables WHERE matter_id = ? ORDER BY created_at DESC, version DESC")
						.all(matterId)
				: this.db.prepare("SELECT * FROM deliverables ORDER BY created_at DESC, version DESC").all()
		) as Record<string, unknown>[];

		return rows.map((row) => this.mapDeliverable(row));
	}

	addDeliverableFeedback(deliverableId: string, feedback: string, rating?: FeedbackRating | null): Deliverable | null {
		if (rating !== undefined) {
			this.db
				.prepare("UPDATE deliverables SET feedback = ?, feedback_rating = ? WHERE id = ?")
				.run(feedback, rating, deliverableId);
		} else {
			this.db.prepare("UPDATE deliverables SET feedback = ? WHERE id = ?").run(feedback, deliverableId);
		}
		return this.getDeliverable(deliverableId);
	}

	recordWorkerSession(input: {
		memberId: string;
		matterId: string;
		workspaceId: string | null;
		piSessionId: string | null;
		sessionFile: string | null;
		status: "active" | "idle" | "closed";
		contextKey?: string;
		messageCursor?: string;
	}): WorkerSessionRecord {
		const id = `wsess_${randomUUID()}`;
		const timestamp = nowIso();
		this.db
			.prepare(
				`INSERT INTO worker_sessions (id, member_id, matter_id, workspace_id, pi_session_id, session_file, status, last_active_at, context_key, message_cursor)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
				input.contextKey ?? null,
				input.messageCursor ?? null,
			);
		return {
			id,
			messageCursor: input.messageCursor ?? null,
			memberId: input.memberId,
			matterId: input.matterId,
			workspaceId: input.workspaceId,
			piSessionId: input.piSessionId,
			sessionFile: input.sessionFile,
			status: input.status,
			lastActiveAt: timestamp,
		};
	}

	findWorkerSession(
		matterId: string,
		memberId: string,
		contextKey: string,
		workspaceId: string | null,
	): WorkerSessionRecord | null {
		let row = this.db
			.prepare(`SELECT * FROM worker_sessions
			WHERE matter_id = ? AND member_id = ? AND context_key = ? AND status != 'closed'
			AND session_file IS NOT NULL ORDER BY rowid DESC LIMIT 1`)
			.get(matterId, memberId, contextKey);
		if (!row)
			row = this.db
				.prepare(`SELECT * FROM worker_sessions WHERE matter_id = ? AND member_id = ?
			AND workspace_id IS ? AND context_key IS NULL AND session_file IS NOT NULL
			ORDER BY rowid DESC LIMIT 1`)
				.get(matterId, memberId, workspaceId);
		return row
			? {
					id: String(row.id),
					memberId,
					matterId,
					messageCursor: row.message_cursor ? String(row.message_cursor) : null,
					workspaceId: row.workspace_id ? String(row.workspace_id) : null,
					piSessionId: row.pi_session_id ? String(row.pi_session_id) : null,
					sessionFile: String(row.session_file),
					status: row.status === "active" ? "active" : "idle",
					lastActiveAt: String(row.last_active_at),
				}
			: null;
	}

	finishWorkerSession(id: string, status: "idle" | "closed"): void {
		this.db
			.prepare("UPDATE worker_sessions SET status = ?, last_active_at = ? WHERE id = ?")
			.run(status, nowIso(), id);
	}

	hasLiveMatterLease(matterId: string): boolean {
		const lease = this.db.prepare("SELECT owner_pid FROM matter_execution_leases WHERE matter_id = ?").get(matterId);
		if (!lease) return false;
		try {
			process.kill(Number(lease.owner_pid), 0);
			return true;
		} catch (error) {
			return !(error instanceof Error && "code" in error && error.code === "ESRCH");
		}
	}

	acquireMatterLease(matterId: string, ownerId: string): boolean {
		const prior = this.db.prepare("SELECT owner_id FROM matter_execution_leases WHERE matter_id = ?").get(matterId);
		if (prior) {
			if (this.hasLiveMatterLease(matterId)) return false;
			this.db
				.prepare("DELETE FROM matter_execution_leases WHERE matter_id = ? AND owner_id = ?")
				.run(matterId, String(prior.owner_id));
		}
		return (
			this.db
				.prepare("INSERT OR IGNORE INTO matter_execution_leases (matter_id, owner_id, owner_pid) VALUES (?, ?, ?)")
				.run(matterId, ownerId, process.pid).changes > 0
		);
	}

	releaseMatterLease(matterId: string, ownerId: string): void {
		this.db
			.prepare("DELETE FROM matter_execution_leases WHERE matter_id = ? AND owner_id = ?")
			.run(matterId, ownerId);
	}

	updateMatterLead(matterId: string, memberId: string): void {
		this.db.prepare("UPDATE matters SET lead_member_id = ? WHERE id = ?").run(memberId, matterId);
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

	private mapMemory(row: Record<string, unknown>): MemberMemory {
		const rawStatus = typeof row.status === "string" && row.status ? row.status : null;
		const status: MemoryStatus =
			rawStatus === "candidate" || rawStatus === "verified" || rawStatus === "rejected" || rawStatus === "superseded"
				? rawStatus
				: row.verified
					? "verified"
					: "candidate";
		return {
			id: String(row.id),
			memberId: String(row.member_id),
			scope: row.scope as MemoryScope,
			workspaceId: row.workspace_id ? String(row.workspace_id) : null,
			content: String(row.content),
			rationale: typeof row.rationale === "string" ? row.rationale : "",
			sourceMatterId: row.source_matter_id ? String(row.source_matter_id) : null,
			sourceDeliverableId: row.source_deliverable_id ? String(row.source_deliverable_id) : null,
			status,
			verified: status === "verified",
			supersededBy: row.superseded_by ? String(row.superseded_by) : null,
			supersedesMemoryId: row.supersedes_memory_id ? String(row.supersedes_memory_id) : null,
			appliedCount: Number(row.applied_count ?? 0),
			positiveCount: Number(row.positive_count ?? 0),
			negativeCount: Number(row.negative_count ?? 0),
			lastAppliedAt: row.last_applied_at ? String(row.last_applied_at) : null,
			createdAt: String(row.created_at),
			updatedAt: row.updated_at ? String(row.updated_at) : String(row.created_at),
		};
	}

	private mapDeliverable(row: Record<string, unknown>): Deliverable {
		const rawRating = row.feedback_rating;
		const feedbackRating: FeedbackRating | null =
			rawRating === "positive" || rawRating === "negative" || rawRating === "neutral" ? rawRating : null;
		return {
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
			feedbackRating,
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
			observerMemberIds: parseUniqueIds(row.observer_ids_json),
			createdAt: String(row.created_at),
			updatedAt: String(row.updated_at),
		};
	}
}
