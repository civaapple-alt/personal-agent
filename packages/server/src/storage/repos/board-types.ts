import type { DatabaseSync } from "node:sqlite";
import type { BoardMemberMetrics, BoardPostArtifacts, BoardPostVerification } from "@pa/contracts/board";
import type { ModelSelection } from "@pa/contracts/model-selection";
import { readStoredModelSelection } from "../../rpc/model-selection.ts";
import { parseUniqueIds } from "./helpers.ts";

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
	artifacts: BoardPostArtifacts | null;
	verification: BoardPostVerification | null;
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
	artifacts?: BoardPostArtifacts | unknown | null;
	verification?: BoardPostVerification | Record<string, unknown> | null;
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
	modelOverride: ModelSelection | null;
	worktreePath: string | null;
	metrics: BoardMemberMetrics | null;
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
	modelOverride?: ModelSelection | Record<string, unknown> | null;
	worktreePath?: string | null;
	metrics?: BoardMemberMetrics | Record<string, unknown> | null;
}

export interface UpdateBoardMemberStatePatch {
	status?: BoardMemberStatus;
	lastReadPostNo?: number;
	activePostNo?: number | null;
	modelOverride?: ModelSelection | Record<string, unknown> | null;
	worktreePath?: string | null;
	metrics?: BoardMemberMetrics | Record<string, unknown> | null;
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

export function parseJsonObject(raw: unknown): Record<string, unknown> | null {
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

export function parsePostNos(raw: unknown): number[] {
	if (typeof raw !== "string" || !raw.trim()) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return normalizeUniquePostNos(parsed.filter((item): item is number => typeof item === "number"));
	} catch {
		return [];
	}
}

export function normalizeUniquePostNos(postNos?: number[]): number[] {
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

export function serializeCompactPayload(payload: Record<string, unknown>): string {
	const json = JSON.stringify(payload);
	if (json.length <= MAX_PAYLOAD_JSON_CHARS) return json;
	return JSON.stringify({
		truncated: true,
		originalLength: json.length,
		preview: json.slice(0, 4000),
	});
}

export function normalizeSummary(summary: string, fallbackBody = "", fallbackKind = "post"): string {
	const singleLine = (summary || fallbackBody || fallbackKind).replace(/\s+/gu, " ").trim() || fallbackKind;
	if (singleLine.length <= MAX_SUMMARY_CHARS) return singleLine;
	return `${singleLine.slice(0, MAX_SUMMARY_CHARS - 1)}…`;
}

export function encodeEventCursor(createdAt: string, rowid: number): string {
	return Buffer.from(JSON.stringify({ createdAt, rowid }), "utf8").toString("base64url");
}

export function decodeEventCursor(
	db: DatabaseSync,
	matterId: string,
	cursor: string,
): { createdAt: string; rowid: number } {
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

export function mapEventRow(row: Record<string, unknown>): MatterEventRecord {
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

export function mapBoardPostSummaryRow(row: Record<string, unknown>): BoardPostSummaryRecord {
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
		artifacts: parseJsonObject(row.artifacts_json) as BoardPostArtifacts | null,
		verification: parseJsonObject(row.verification_json) as BoardPostVerification | null,
		orgId: row.org_id ? String(row.org_id) : null,
		workspaceId: row.workspace_id ? String(row.workspace_id) : null,
		createdAt: String(row.created_at),
	};
}

export function mapBoardPostRow(row: Record<string, unknown>): BoardPostRecord {
	return {
		...mapBoardPostSummaryRow(row),
		body: typeof row.body === "string" ? row.body : "",
	};
}

export function mapBoardMemberRow(row: Record<string, unknown>): BoardMemberRecord {
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
		modelOverride: readStoredModelSelection(parseJsonObject(row.model_override_json)),
		worktreePath: row.worktree_path ? String(row.worktree_path) : null,
		metrics: parseJsonObject(row.metrics_json) as BoardMemberMetrics | null,
		updatedAt: String(row.updated_at),
	};
}
