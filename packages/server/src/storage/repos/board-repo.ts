import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { MatterMessage } from "../types.ts";
import { normalizeUniqueIds, nowIso, parseUniqueIds } from "./helpers.ts";

export type MatterCollaborationMode = "lead" | "board";
export type MatterMessageKind = "chat" | "ai_request" | "human_decision" | "observer" | "system_summary";
export type MatterDecisionStatus = "pending" | "approved" | "dismissed" | "answered";
export type BoardPostAuthorType = "agent" | "user" | "monitor";
export type BoardPostKind =
	| "assign"
	| "progress"
	| "handoff"
	| "verify_pass"
	| "verify_rework"
	| "escalate"
	| "clarification"
	| "summary";
export type BoardMemberRole = "coordinator" | "builder" | "verifier";
export type BoardMemberStatus = "working" | "waiting" | "blocked_human" | "stopped" | "retired";

export interface MatterEventRecord {
	id: string;
	matterId: string;
	runId: string;
	agentId: string | null;
	boardPostNo: number | null;
	eventType: string;
	payload: Record<string, unknown>;
	createdAt: string;
}

export interface AppendMatterEventInput {
	id?: string;
	matterId: string;
	runId: string;
	agentId?: string | null;
	boardPostNo?: number | null;
	eventType: string;
	payload: Record<string, unknown>;
	createdAt?: string;
}

export interface ListMatterEventsOptions {
	cursor?: string | null;
	limit?: number;
	agentId?: string;
	boardPostNo?: number;
	eventType?: string;
	order?: "asc" | "desc";
}

export interface ListMatterEventsResult {
	events: MatterEventRecord[];
	nextCursor: string | null;
	hasMore: boolean;
	total: number;
}

export interface BoardPostSummaryRecord {
	id: string;
	matterId: string;
	postNo: number;
	authorType: BoardPostAuthorType;
	authorId: string;
	kind: BoardPostKind;
	mentions: string[];
	refPostNos: number[];
	summary: string;
	hasBody: boolean;
	artifacts: unknown | null;
	verification: Record<string, unknown> | null;
	orgId: string | null;
	workspaceId: string | null;
	createdAt: string;
}

export interface BoardPostRecord extends BoardPostSummaryRecord {
	body: string;
}

export interface CreateBoardPostInput {
	id?: string;
	matterId: string;
	authorType: BoardPostAuthorType;
	authorId: string;
	kind: BoardPostKind;
	mentions?: string[];
	refPostNos?: number[];
	summary: string;
	body?: string;
	artifacts?: unknown | null;
	verification?: Record<string, unknown> | null;
	orgId?: string | null;
	workspaceId?: string | null;
	createdAt?: string;
	skipMatterUpdatedAt?: boolean;
}

export interface ListBoardPostsOptions {
	afterPostNo?: number;
	limit?: number;
	order?: "asc" | "desc";
}

export interface BoardMemberRecord {
	matterId: string;
	agentId: string;
	sourceMemberId: string | null;
	displayName: string;
	boardRole: BoardMemberRole;
	brief: string;
	skills: string[];
	status: BoardMemberStatus;
	ownedScope: string[];
	acceptanceCriteria: string;
	lastReadPostNo: number;
	activePostNo: number | null;
	modelOverride: Record<string, unknown> | null;
	worktreePath: string | null;
	metrics: Record<string, unknown> | null;
	updatedAt: string;
}

export interface UpsertBoardMemberInput {
	matterId: string;
	agentId: string;
	sourceMemberId?: string | null;
	displayName: string;
	boardRole: BoardMemberRole;
	brief?: string;
	skills?: string[];
	status?: BoardMemberStatus;
	ownedScope?: string[];
	acceptanceCriteria?: string;
	lastReadPostNo?: number;
	activePostNo?: number | null;
	modelOverride?: Record<string, unknown> | null;
	worktreePath?: string | null;
	metrics?: Record<string, unknown> | null;
}

export interface UpdateBoardMemberStatePatch {
	status?: BoardMemberStatus;
	lastReadPostNo?: number;
	activePostNo?: number | null;
	modelOverride?: Record<string, unknown> | null;
	worktreePath?: string | null;
	metrics?: Record<string, unknown> | null;
	brief?: string;
	skills?: string[];
	ownedScope?: string[];
	acceptanceCriteria?: string;
}

export interface MatterBoardMeta {
	collaborationMode: MatterCollaborationMode;
	coordinatorMemberId: string | null;
}

export class InvalidEventsCursorError extends Error {
	readonly statusCode = 400;

	constructor(message = "Invalid events cursor") {
		super(message);
	}
}

const activeTransactions = new WeakSet<DatabaseSync>();
const MAX_PAYLOAD_JSON_CHARS = 32_768;
const MAX_SUMMARY_CHARS = 240;

/** Run an action inside a re-entrant `BEGIN IMMEDIATE` SQLite transaction. */
export function runInImmediateTransaction<T>(db: DatabaseSync, action: () => T): T {
	if (activeTransactions.has(db) || db.isTransaction) {
		return action();
	}
	db.exec("BEGIN IMMEDIATE");
	activeTransactions.add(db);
	try {
		const result = action();
		db.exec("COMMIT");
		return result;
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {
			// Ignore rollback failures after SQLite already aborted the transaction.
		}
		throw error;
	} finally {
		activeTransactions.delete(db);
	}
}

function parseJsonObject(raw: unknown): Record<string, unknown> | null {
	if (typeof raw !== "string" || !raw.trim()) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function parseJsonValue(raw: unknown): unknown | null {
	if (typeof raw !== "string" || !raw.trim()) return null;
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return null;
	}
}

function parsePostNos(raw: unknown): number[] {
	if (typeof raw !== "string" || !raw.trim()) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return normalizeUniquePostNos(parsed.filter((item): item is number => typeof item === "number"));
	} catch {
		return [];
	}
}

function normalizeUniquePostNos(postNos?: number[]): number[] {
	if (!postNos) return [];
	const seen = new Set<number>();
	const result: number[] = [];
	for (const item of postNos) {
		if (Number.isInteger(item) && item > 0 && !seen.has(item)) {
			seen.add(item);
			result.push(item);
		}
	}
	return result;
}

function serializeCompactPayload(payload: Record<string, unknown>): string {
	const json = JSON.stringify(payload);
	if (json.length <= MAX_PAYLOAD_JSON_CHARS) return json;
	return JSON.stringify({
		truncated: true,
		originalLength: json.length,
		preview: json.slice(0, 4000),
	});
}

function normalizeSummary(summary: string, fallbackBody = "", fallbackKind = "post"): string {
	const singleLine = (summary || fallbackBody || fallbackKind).replace(/\s+/gu, " ").trim() || fallbackKind;
	if (singleLine.length <= MAX_SUMMARY_CHARS) return singleLine;
	return `${singleLine.slice(0, MAX_SUMMARY_CHARS - 1)}…`;
}

function encodeEventCursor(createdAt: string, rowid: number): string {
	return Buffer.from(JSON.stringify({ createdAt, rowid }), "utf8").toString("base64url");
}

function decodeEventCursor(db: DatabaseSync, matterId: string, cursor: string): { createdAt: string; rowid: number } {
	try {
		const decoded: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
		if (
			decoded &&
			typeof decoded === "object" &&
			"createdAt" in decoded &&
			typeof decoded.createdAt === "string" &&
			"rowid" in decoded &&
			typeof decoded.rowid === "number" &&
			Number.isInteger(decoded.rowid) &&
			decoded.rowid > 0
		) {
			return { createdAt: decoded.createdAt, rowid: decoded.rowid };
		}
	} catch {
		// Fall through to event ID lookup so callers may also pass an event ID as cursor.
	}
	const byId = db
		.prepare("SELECT rowid, created_at FROM matter_events WHERE matter_id = ? AND id = ?")
		.get(matterId, cursor) as { rowid: number; created_at: string } | undefined;
	if (byId) {
		return { createdAt: String(byId.created_at), rowid: Number(byId.rowid) };
	}
	throw new InvalidEventsCursorError();
}

function mapEventRow(row: Record<string, unknown>): MatterEventRecord {
	const parsedPayload = parseJsonObject(row.payload_json);
	const payload = parsedPayload ?? (typeof row.payload_json === "string" ? { raw: row.payload_json } : {});
	return {
		id: String(row.id),
		matterId: String(row.matter_id),
		runId: String(row.run_id ?? ""),
		agentId: row.agent_id ? String(row.agent_id) : null,
		boardPostNo: typeof row.board_post_no === "number" ? row.board_post_no : null,
		eventType: String(row.event_type),
		payload,
		createdAt: String(row.created_at),
	};
}

function mapBoardPostSummaryRow(row: Record<string, unknown>): BoardPostSummaryRecord {
	return {
		id: String(row.id),
		matterId: String(row.matter_id),
		postNo: Number(row.post_no),
		authorType: row.author_type as BoardPostAuthorType,
		authorId: String(row.author_id),
		kind: row.kind as BoardPostKind,
		mentions: parseUniqueIds(row.mentions_json),
		refPostNos: parsePostNos(row.ref_post_nos_json),
		summary: String(row.summary),
		hasBody: Boolean(row.has_body ?? (typeof row.body === "string" && row.body.length > 0)),
		artifacts: parseJsonValue(row.artifacts_json),
		verification: parseJsonObject(row.verification_json),
		orgId: row.org_id ? String(row.org_id) : null,
		workspaceId: row.workspace_id ? String(row.workspace_id) : null,
		createdAt: String(row.created_at),
	};
}

function mapBoardPostRow(row: Record<string, unknown>): BoardPostRecord {
	return {
		...mapBoardPostSummaryRow(row),
		body: typeof row.body === "string" ? row.body : "",
	};
}

function mapBoardMemberRow(row: Record<string, unknown>): BoardMemberRecord {
	return {
		matterId: String(row.matter_id),
		agentId: String(row.agent_id),
		sourceMemberId: row.source_member_id ? String(row.source_member_id) : null,
		displayName: String(row.display_name),
		boardRole: row.board_role as BoardMemberRole,
		brief: typeof row.brief === "string" ? row.brief : "",
		skills: parseUniqueIds(row.skills_json),
		status: row.status as BoardMemberStatus,
		ownedScope: parseUniqueIds(row.owned_scope_json),
		acceptanceCriteria: typeof row.acceptance_criteria === "string" ? row.acceptance_criteria : "",
		lastReadPostNo: Number(row.last_read_post_no ?? 0),
		activePostNo: typeof row.active_post_no === "number" ? row.active_post_no : null,
		modelOverride: parseJsonObject(row.model_override_json),
		worktreePath: row.worktree_path ? String(row.worktree_path) : null,
		metrics: parseJsonObject(row.metrics_json),
		updatedAt: String(row.updated_at),
	};
}

/** Derive explicit `matter_messages` lifecycle columns from channel + metadata. */
export function deriveMessageLifecycleFields(
	channel: string,
	metadata: Record<string, unknown> | null | undefined,
): {
	kind: MatterMessageKind;
	decisionStatus: MatterDecisionStatus | null;
	boardPostNo: number | null;
} {
	const boardPostNo =
		typeof metadata?.boardPostNo === "number" && Number.isInteger(metadata.boardPostNo) && metadata.boardPostNo > 0
			? metadata.boardPostNo
			: null;
	if (channel !== "user") {
		return { kind: "chat", decisionStatus: null, boardPostNo };
	}
	if (metadata?.mode === "ai_request") {
		const rawStatus = metadata.aiRequestStatus;
		const decisionStatus =
			rawStatus === "pending" || rawStatus === "approved" || rawStatus === "dismissed" ? rawStatus : null;
		return { kind: "ai_request", decisionStatus, boardPostNo };
	}
	const humanDecision =
		metadata?.humanDecision && typeof metadata.humanDecision === "object" && !Array.isArray(metadata.humanDecision)
			? (metadata.humanDecision as Record<string, unknown>)
			: null;
	if (humanDecision) {
		const rawStatus = humanDecision.status;
		const decisionStatus = rawStatus === "pending" || rawStatus === "answered" ? rawStatus : null;
		return { kind: "human_decision", decisionStatus, boardPostNo };
	}
	if (metadata?.observerIntervention === true) {
		return { kind: "observer", decisionStatus: null, boardPostNo };
	}
	if (metadata?.systemSummary === true) {
		return { kind: "system_summary", decisionStatus: null, boardPostNo };
	}
	return { kind: "chat", decisionStatus: null, boardPostNo };
}

function deriveNoticeEventFields(message: Pick<MatterMessage, "id" | "senderId" | "content" | "metadata">): {
	runId: string;
	agentId: string | null;
	boardPostNo: number | null;
	eventType: string;
	payload: Record<string, unknown>;
} {
	const metadata = message.metadata ?? null;
	const runId =
		typeof metadata?.runId === "string" && metadata.runId.trim()
			? metadata.runId.trim()
			: typeof metadata?.sourceUserMessageId === "string" && metadata.sourceUserMessageId.trim()
				? metadata.sourceUserMessageId.trim()
				: "";
	const boardPostNo =
		typeof metadata?.boardPostNo === "number" && Number.isInteger(metadata.boardPostNo) && metadata.boardPostNo > 0
			? metadata.boardPostNo
			: null;
	const parsed = parseJsonObject(message.content);
	let eventType = "notice";
	if (parsed) {
		if (parsed.type === "tool_execution_start") eventType = "tool_start";
		else if (parsed.type === "tool_execution_end") eventType = "tool_end";
		else if (parsed.method === "runtime_ready") eventType = "capability_ready";
		else if (parsed.method === "turn_stalled") eventType = "monitor_alert";
		else if (parsed.method === "runtime_model_usage") eventType = "turn_summary";
		else if (typeof parsed.method === "string" && parsed.method.trim()) eventType = parsed.method.trim();
		else if (typeof parsed.type === "string" && parsed.type.trim()) eventType = parsed.type.trim();
	} else if (metadata?.observerFailed === true) {
		eventType = "monitor_alert";
	}
	const payload: Record<string, unknown> = parsed
		? parsed
		: {
				message: message.content.slice(0, 4000),
				...(metadata ? { metadata } : {}),
			};
	return {
		runId,
		agentId: message.senderId || null,
		boardPostNo,
		eventType,
		payload,
	};
}

function resolveRefPostNos(db: DatabaseSync, matterId: string, metadata: Record<string, unknown> | null): number[] {
	if (!metadata) return [];
	const candidates = [metadata.requestMessageId, metadata.parentRequestMessageId].filter(
		(id): id is string => typeof id === "string" && id.trim().length > 0,
	);
	const resolved: number[] = [];
	for (const refMsgId of candidates) {
		const row = db
			.prepare("SELECT board_post_no FROM matter_messages WHERE id = ? AND matter_id = ?")
			.get(refMsgId, matterId) as { board_post_no: number | null } | undefined;
		if (row && typeof row.board_post_no === "number" && row.board_post_no > 0) {
			resolved.push(row.board_post_no);
			continue;
		}
		const postRow = db
			.prepare("SELECT post_no FROM matter_board_posts WHERE id = ? AND matter_id = ?")
			.get(`bpost_${refMsgId}`, matterId) as { post_no: number } | undefined;
		if (postRow && typeof postRow.post_no === "number" && postRow.post_no > 0) {
			resolved.push(postRow.post_no);
		}
	}
	return normalizeUniquePostNos(resolved);
}

function deriveInternalCollabPostFields(
	db: DatabaseSync,
	message: Pick<MatterMessage, "id" | "matterId" | "senderType" | "senderId" | "content" | "metadata">,
): {
	authorType: BoardPostAuthorType;
	authorId: string;
	kind: BoardPostKind;
	mentions: string[];
	refPostNos: number[];
	summary: string;
	body: string;
	verification: Record<string, unknown> | null;
	orgId: string | null;
	workspaceId: string | null;
} {
	const metadata = message.metadata ?? null;
	const authorType: BoardPostAuthorType =
		message.senderType === "user"
			? "user"
			: message.senderId === "system_monitor" || message.senderId === "monitor"
				? "monitor"
				: "agent";
	const verification =
		metadata?.verification && typeof metadata.verification === "object" && !Array.isArray(metadata.verification)
			? (metadata.verification as Record<string, unknown>)
			: null;
	const verdict = typeof verification?.verdict === "string" ? verification.verdict : undefined;
	let kind: BoardPostKind = "progress";
	if (typeof metadata?.toMemberId === "string" && metadata.toMemberId.trim()) {
		kind = "assign";
	} else if (verdict === "passed" || verdict === "pass") {
		kind = "verify_pass";
	} else if (
		verdict === "changes_requested" ||
		verdict === "inconclusive" ||
		verdict === "fail" ||
		verdict === "rework"
	) {
		kind = "verify_rework";
	} else if (metadata?.clarification) {
		kind = "clarification";
	} else if (metadata?.failed === true) {
		kind = "escalate";
	} else if (typeof metadata?.replyToMemberId === "string" && metadata.replyToMemberId.trim()) {
		kind = "handoff";
	}
	const mentions = normalizeUniqueIds([
		...(typeof metadata?.toMemberId === "string" ? [metadata.toMemberId] : []),
		...(typeof metadata?.replyToMemberId === "string" ? [metadata.replyToMemberId] : []),
	]);
	const refPostNos = resolveRefPostNos(db, message.matterId, metadata);
	return {
		authorType,
		authorId: message.senderId,
		kind,
		mentions,
		refPostNos,
		summary: normalizeSummary(message.content, message.content, kind),
		body: message.content,
		verification,
		orgId: typeof metadata?.orgId === "string" ? metadata.orgId : null,
		workspaceId: typeof metadata?.workspaceId === "string" ? metadata.workspaceId : null,
	};
}

/** Mirror a `notice` `matter_messages` row into `matter_events` idempotently. */
export function mirrorNoticeMessageToEvent(
	db: DatabaseSync,
	boardRepo: BoardRepo,
	message: MatterMessage,
): MatterEventRecord {
	const eventId = `mevt_${message.id}`;
	const existing = db.prepare("SELECT * FROM matter_events WHERE id = ?").get(eventId) as
		| Record<string, unknown>
		| undefined;
	if (existing) return mapEventRow(existing);
	const derived = deriveNoticeEventFields(message);
	return boardRepo.appendEvent({
		id: eventId,
		matterId: message.matterId,
		runId: derived.runId,
		agentId: derived.agentId,
		boardPostNo: derived.boardPostNo,
		eventType: derived.eventType,
		payload: derived.payload,
		createdAt: message.createdAt,
	});
}

/** Mirror an `internal_collab` `matter_messages` row into `matter_board_posts` and record `board_post_no`. */
export function mirrorInternalCollabMessageToBoardPost(
	db: DatabaseSync,
	boardRepo: BoardRepo,
	message: MatterMessage,
	options?: { skipMatterUpdatedAt?: boolean },
): BoardPostRecord {
	const postId = `bpost_${message.id}`;
	const existing = db.prepare("SELECT * FROM matter_board_posts WHERE id = ?").get(postId) as
		| Record<string, unknown>
		| undefined;
	if (existing) {
		const mapped = mapBoardPostRow(existing);
		db.prepare("UPDATE matter_messages SET board_post_no = ? WHERE id = ? AND board_post_no IS NULL").run(
			mapped.postNo,
			message.id,
		);
		return mapped;
	}
	const derived = deriveInternalCollabPostFields(db, message);
	const created = boardRepo.createBoardPost({
		id: postId,
		matterId: message.matterId,
		authorType: derived.authorType,
		authorId: derived.authorId,
		kind: derived.kind,
		mentions: derived.mentions,
		refPostNos: derived.refPostNos,
		summary: derived.summary,
		body: derived.body,
		verification: derived.verification,
		orgId: derived.orgId,
		workspaceId: derived.workspaceId,
		createdAt: message.createdAt,
		skipMatterUpdatedAt: options?.skipMatterUpdatedAt,
	});
	db.prepare("UPDATE matter_messages SET board_post_no = ? WHERE id = ?").run(created.postNo, message.id);
	return created;
}

/** Losslessly and idempotently backfill `0.8.x` `matter_messages` rows into split tables. */
export function backfillLegacyMessagesToBoardAndEvents(db: DatabaseSync): void {
	const boardRepo = new BoardRepo(db);

	const userLifecycleRows = db
		.prepare(
			`SELECT id, channel, metadata_json
			 FROM matter_messages
			 WHERE channel = 'user' AND kind = 'chat' AND decision_status IS NULL AND metadata_json IS NOT NULL`,
		)
		.all() as Array<{ id: string; channel: string; metadata_json: string }>;
	const updateUserLifecycle = db.prepare(
		"UPDATE matter_messages SET kind = ?, decision_status = ?, board_post_no = COALESCE(board_post_no, ?) WHERE id = ?",
	);
	for (const row of userLifecycleRows) {
		const metadata = parseJsonObject(row.metadata_json);
		if (!metadata) continue;
		const lifecycle = deriveMessageLifecycleFields(row.channel, metadata);
		if (lifecycle.kind !== "chat" || lifecycle.decisionStatus !== null || lifecycle.boardPostNo !== null) {
			updateUserLifecycle.run(lifecycle.kind, lifecycle.decisionStatus, lifecycle.boardPostNo, row.id);
		}
	}

	const noticeRows = db
		.prepare(
			`SELECT m.id, m.matter_id, m.channel, m.sender_type, m.sender_id, m.content, m.metadata_json, m.created_at
			 FROM matter_messages m
			 WHERE m.channel = 'notice'
			   AND NOT EXISTS (SELECT 1 FROM matter_events e WHERE e.id = 'mevt_' || m.id)
			 ORDER BY m.created_at ASC, m.rowid ASC`,
		)
		.all() as Record<string, unknown>[];
	for (const row of noticeRows) {
		const message: MatterMessage = {
			id: String(row.id),
			matterId: String(row.matter_id),
			channel: "notice",
			senderType: row.sender_type as MatterMessage["senderType"],
			senderId: String(row.sender_id),
			content: String(row.content),
			metadata: parseJsonObject(row.metadata_json),
			createdAt: String(row.created_at),
		};
		mirrorNoticeMessageToEvent(db, boardRepo, message);
	}

	const collabRows = db
		.prepare(
			`SELECT m.id, m.matter_id, m.channel, m.sender_type, m.sender_id, m.content, m.metadata_json, m.created_at
			 FROM matter_messages m
			 WHERE m.channel = 'internal_collab'
			   AND m.board_post_no IS NULL
			   AND NOT EXISTS (SELECT 1 FROM matter_board_posts p WHERE p.id = 'bpost_' || m.id)
			 ORDER BY m.matter_id ASC, m.created_at ASC, m.rowid ASC`,
		)
		.all() as Record<string, unknown>[];
	for (const row of collabRows) {
		const message: MatterMessage = {
			id: String(row.id),
			matterId: String(row.matter_id),
			channel: "internal_collab",
			senderType: row.sender_type as MatterMessage["senderType"],
			senderId: String(row.sender_id),
			content: String(row.content),
			metadata: parseJsonObject(row.metadata_json),
			createdAt: String(row.created_at),
		};
		mirrorInternalCollabMessageToBoardPost(db, boardRepo, message, { skipMatterUpdatedAt: true });
	}
}

/** Manages split matter events, shared board posts (with lazy body loading), and dynamic board members. */
export class BoardRepo {
	private readonly db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	getMatterBoardMeta(matterId: string): MatterBoardMeta | null {
		const row = this.db
			.prepare("SELECT collaboration_mode, coordinator_member_id FROM matters WHERE id = ?")
			.get(matterId) as { collaboration_mode?: string; coordinator_member_id?: string | null } | undefined;
		if (!row) return null;
		return {
			collaborationMode: row.collaboration_mode === "board" ? "board" : "lead",
			coordinatorMemberId: row.coordinator_member_id ? String(row.coordinator_member_id) : null,
		};
	}

	appendEvent(input: AppendMatterEventInput): MatterEventRecord {
		const id = input.id ?? `mevt_${randomUUID()}`;
		const createdAt = input.createdAt ?? nowIso();
		const payloadJson = serializeCompactPayload(input.payload);
		return runInImmediateTransaction(this.db, () => {
			this.db
				.prepare(
					`INSERT INTO matter_events (id, matter_id, run_id, agent_id, board_post_no, event_type, payload_json, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					id,
					input.matterId,
					input.runId,
					input.agentId ?? null,
					input.boardPostNo ?? null,
					input.eventType,
					payloadJson,
					createdAt,
				);
			const row = this.db.prepare("SELECT * FROM matter_events WHERE id = ?").get(id) as Record<string, unknown>;
			return mapEventRow(row);
		});
	}

	listEvents(matterId: string, options?: ListMatterEventsOptions): ListMatterEventsResult {
		const order = options?.order === "asc" ? "ASC" : "DESC";
		const rawLimit = options?.limit ?? 50;
		const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 200) : 50;
		const conditions = ["matter_id = ?"];
		const filterParams: Array<string | number> = [matterId];
		if (options?.agentId) {
			conditions.push("agent_id = ?");
			filterParams.push(options.agentId);
		}
		if (typeof options?.boardPostNo === "number") {
			conditions.push("board_post_no = ?");
			filterParams.push(options.boardPostNo);
		}
		if (options?.eventType) {
			conditions.push("event_type = ?");
			filterParams.push(options.eventType);
		}
		const baseWhere = conditions.join(" AND ");
		const totalRow = this.db
			.prepare(`SELECT COUNT(*) AS count FROM matter_events WHERE ${baseWhere}`)
			.get(...filterParams) as { count: number };
		const total = Number(totalRow?.count ?? 0);

		const pageConditions = [...conditions];
		const pageParams = [...filterParams];
		if (options?.cursor) {
			const decoded = decodeEventCursor(this.db, matterId, options.cursor);
			if (order === "DESC") {
				pageConditions.push("(created_at < ? OR (created_at = ? AND rowid < ?))");
			} else {
				pageConditions.push("(created_at > ? OR (created_at = ? AND rowid > ?))");
			}
			pageParams.push(decoded.createdAt, decoded.createdAt, decoded.rowid);
		}
		const pageWhere = pageConditions.join(" AND ");
		const rows = this.db
			.prepare(
				`SELECT rowid AS _rowid, *
				 FROM matter_events
				 WHERE ${pageWhere}
				 ORDER BY created_at ${order}, rowid ${order}
				 LIMIT ?`,
			)
			.all(...pageParams, limit + 1) as Array<Record<string, unknown> & { _rowid: number }>;

		const hasMore = rows.length > limit;
		const pageRows = hasMore ? rows.slice(0, limit) : rows;
		const lastRow = pageRows.at(-1);
		const nextCursor =
			hasMore && lastRow ? encodeEventCursor(String(lastRow.created_at), Number(lastRow._rowid)) : null;
		return {
			events: pageRows.map((row) => mapEventRow(row)),
			nextCursor,
			hasMore,
			total,
		};
	}

	createBoardPost(input: CreateBoardPostInput): BoardPostRecord {
		const id = input.id ?? `bpost_${randomUUID()}`;
		const createdAt = input.createdAt ?? nowIso();
		const mentions = normalizeUniqueIds(input.mentions);
		const refPostNos = normalizeUniquePostNos(input.refPostNos);
		const body = input.body ?? "";
		const summary = normalizeSummary(input.summary, body, input.kind);
		const artifactsJson =
			input.artifacts !== undefined && input.artifacts !== null ? JSON.stringify(input.artifacts) : null;
		const verificationJson =
			input.verification !== undefined && input.verification !== null ? JSON.stringify(input.verification) : null;

		return runInImmediateTransaction(this.db, () => {
			const nextRow = this.db
				.prepare("SELECT COALESCE(MAX(post_no), 0) + 1 AS next_no FROM matter_board_posts WHERE matter_id = ?")
				.get(input.matterId) as { next_no: number };
			const postNo = Number(nextRow.next_no);
			this.db
				.prepare(
					`INSERT INTO matter_board_posts (
						id, matter_id, post_no, author_type, author_id, kind,
						mentions_json, ref_post_nos_json, summary, body,
						artifacts_json, verification_json, org_id, workspace_id, created_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					id,
					input.matterId,
					postNo,
					input.authorType,
					input.authorId,
					input.kind,
					JSON.stringify(mentions),
					JSON.stringify(refPostNos),
					summary,
					body,
					artifactsJson,
					verificationJson,
					input.orgId ?? null,
					input.workspaceId ?? null,
					createdAt,
				);
			if (!input.skipMatterUpdatedAt) {
				this.db.prepare("UPDATE matters SET updated_at = ? WHERE id = ?").run(createdAt, input.matterId);
			}
			const createdRow = this.db.prepare("SELECT * FROM matter_board_posts WHERE id = ?").get(id) as Record<
				string,
				unknown
			>;
			return mapBoardPostRow(createdRow);
		});
	}

	listBoardPostSummaries(matterId: string, options?: ListBoardPostsOptions): BoardPostSummaryRecord[] {
		const order = options?.order === "desc" ? "DESC" : "ASC";
		const conditions = ["matter_id = ?"];
		const params: Array<string | number> = [matterId];
		if (
			typeof options?.afterPostNo === "number" &&
			Number.isInteger(options.afterPostNo) &&
			options.afterPostNo >= 0
		) {
			conditions.push("post_no > ?");
			params.push(options.afterPostNo);
		}
		const hasLimit = typeof options?.limit === "number" && Number.isFinite(options.limit) && options.limit > 0;
		const limitClause = hasLimit ? "LIMIT ?" : "";
		if (hasLimit) {
			params.push(Math.min(Math.trunc(options.limit!), 500));
		}
		const rows = this.db
			.prepare(
				`SELECT
					id, matter_id, post_no, author_type, author_id, kind,
					mentions_json, ref_post_nos_json, summary,
					(length(body) > 0) AS has_body,
					artifacts_json, verification_json, org_id, workspace_id, created_at
				 FROM matter_board_posts
				 WHERE ${conditions.join(" AND ")}
				 ORDER BY post_no ${order}
				 ${limitClause}`,
			)
			.all(...params) as Record<string, unknown>[];
		return rows.map((row) => mapBoardPostSummaryRow(row));
	}

	getBoardPost(matterId: string, postNo: number): BoardPostRecord | null {
		if (!Number.isInteger(postNo) || postNo < 1) return null;
		const row = this.db
			.prepare("SELECT * FROM matter_board_posts WHERE matter_id = ? AND post_no = ?")
			.get(matterId, postNo) as Record<string, unknown> | undefined;
		return row ? mapBoardPostRow(row) : null;
	}

	upsertBoardMember(input: UpsertBoardMemberInput): BoardMemberRecord {
		const updatedAt = nowIso();
		const skills = normalizeUniqueIds(input.skills);
		const ownedScope = normalizeUniqueIds(input.ownedScope);
		const status: BoardMemberStatus = input.status ?? "waiting";
		return runInImmediateTransaction(this.db, () => {
			this.db
				.prepare(
					`INSERT INTO matter_board_members (
						matter_id, agent_id, source_member_id, display_name, board_role,
						brief, skills_json, status, owned_scope_json, acceptance_criteria,
						last_read_post_no, active_post_no, model_override_json, worktree_path, metrics_json, updated_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT(matter_id, agent_id) DO UPDATE SET
						source_member_id = excluded.source_member_id,
						display_name = excluded.display_name,
						board_role = excluded.board_role,
						brief = excluded.brief,
						skills_json = excluded.skills_json,
						status = excluded.status,
						owned_scope_json = excluded.owned_scope_json,
						acceptance_criteria = excluded.acceptance_criteria,
						last_read_post_no = excluded.last_read_post_no,
						active_post_no = excluded.active_post_no,
						model_override_json = excluded.model_override_json,
						worktree_path = excluded.worktree_path,
						metrics_json = excluded.metrics_json,
						updated_at = excluded.updated_at`,
				)
				.run(
					input.matterId,
					input.agentId,
					input.sourceMemberId ?? null,
					input.displayName,
					input.boardRole,
					input.brief ?? "",
					JSON.stringify(skills),
					status,
					JSON.stringify(ownedScope),
					input.acceptanceCriteria ?? "",
					input.lastReadPostNo ?? 0,
					input.activePostNo ?? null,
					input.modelOverride ? JSON.stringify(input.modelOverride) : null,
					input.worktreePath ?? null,
					input.metrics ? JSON.stringify(input.metrics) : null,
					updatedAt,
				);
			const row = this.db
				.prepare("SELECT * FROM matter_board_members WHERE matter_id = ? AND agent_id = ?")
				.get(input.matterId, input.agentId) as Record<string, unknown>;
			return mapBoardMemberRow(row);
		});
	}

	listBoardMembers(matterId: string): BoardMemberRecord[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM matter_board_members
				 WHERE matter_id = ?
				 ORDER BY CASE board_role WHEN 'coordinator' THEN 0 WHEN 'builder' THEN 1 ELSE 2 END, agent_id ASC`,
			)
			.all(matterId) as Record<string, unknown>[];
		return rows.map((row) => mapBoardMemberRow(row));
	}

	updateBoardMemberState(
		matterId: string,
		agentId: string,
		patch: UpdateBoardMemberStatePatch,
	): BoardMemberRecord | null {
		return runInImmediateTransaction(this.db, () => {
			const existingRow = this.db
				.prepare("SELECT * FROM matter_board_members WHERE matter_id = ? AND agent_id = ?")
				.get(matterId, agentId) as Record<string, unknown> | undefined;
			if (!existingRow) return null;
			const existing = mapBoardMemberRow(existingRow);
			const updatedAt = nowIso();
			this.db
				.prepare(
					`UPDATE matter_board_members SET
						status = ?,
						last_read_post_no = ?,
						active_post_no = ?,
						model_override_json = ?,
						worktree_path = ?,
						metrics_json = ?,
						brief = ?,
						skills_json = ?,
						owned_scope_json = ?,
						acceptance_criteria = ?,
						updated_at = ?
					 WHERE matter_id = ? AND agent_id = ?`,
				)
				.run(
					patch.status ?? existing.status,
					patch.lastReadPostNo ?? existing.lastReadPostNo,
					patch.activePostNo !== undefined ? patch.activePostNo : existing.activePostNo,
					patch.modelOverride !== undefined
						? patch.modelOverride
							? JSON.stringify(patch.modelOverride)
							: null
						: existing.modelOverride
							? JSON.stringify(existing.modelOverride)
							: null,
					patch.worktreePath !== undefined ? patch.worktreePath : existing.worktreePath,
					patch.metrics !== undefined
						? patch.metrics
							? JSON.stringify(patch.metrics)
							: null
						: existing.metrics
							? JSON.stringify(existing.metrics)
							: null,
					patch.brief !== undefined ? patch.brief : existing.brief,
					patch.skills !== undefined
						? JSON.stringify(normalizeUniqueIds(patch.skills))
						: JSON.stringify(existing.skills),
					patch.ownedScope !== undefined
						? JSON.stringify(normalizeUniqueIds(patch.ownedScope))
						: JSON.stringify(existing.ownedScope),
					patch.acceptanceCriteria !== undefined ? patch.acceptanceCriteria : existing.acceptanceCriteria,
					updatedAt,
					matterId,
					agentId,
				);
			const nextRow = this.db
				.prepare("SELECT * FROM matter_board_members WHERE matter_id = ? AND agent_id = ?")
				.get(matterId, agentId) as Record<string, unknown>;
			return mapBoardMemberRow(nextRow);
		});
	}
}
