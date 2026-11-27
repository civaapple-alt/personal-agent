import type { ModelSelection } from "./model-selection.ts";

export type MatterEventType = "tool_start" | "tool_end" | "capability_ready" | "monitor_alert" | "turn_summary";

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

export type BoardVerificationVerdict = "pass" | "rework" | "pending";

export type BoardRole = "coordinator" | "builder" | "verifier";

export type BoardMemberStatus = "working" | "waiting" | "blocked_human" | "stopped" | "retired";

/** High-frequency execution event stored in `matter_events` (0.9.0 cold-hot storage split). */
export interface MatterEventDto {
	id: string;
	matterId: string;
	runId: string;
	agentId: string | null;
	boardPostNo: number | null;
	eventType: MatterEventType;
	payload: Record<string, unknown>;
	createdAt: string;
}

export interface MatterEventsPageDto {
	matterId: string;
	events: MatterEventDto[];
	nextCursor: string | null;
	hasMore: boolean;
}

export interface BoardPostFileChange {
	path: string;
	linesAdded?: number;
	linesDeleted?: number;
}

export interface BoardPostArtifacts {
	files?: BoardPostFileChange[];
	commits?: string[];
	spaceDocumentIds?: string[];
	commands?: string[];
	[key: string]: unknown;
}

export interface BoardPostVerification {
	target: string;
	criteria?: string;
	verdict: BoardVerificationVerdict;
	authorAgentId?: string;
}

/** Compact board post summary used in board list and incremental wakeups (`body` lazy-loaded). */
export interface BoardPostSummaryDto {
	id: string;
	matterId: string;
	postNo: number;
	authorType: BoardPostAuthorType;
	authorId: string;
	kind: BoardPostKind;
	mentions: string[];
	refPostNos: number[];
	summary: string;
	hasBody?: boolean;
	artifacts: BoardPostArtifacts | null;
	verification: BoardPostVerification | null;
	orgId: string | null;
	workspaceId: string | null;
	createdAt: string;
}

/** Full board post record from `matter_board_posts` including complete body. */
export interface BoardPostDto extends BoardPostSummaryDto {
	body: string;
}

export interface BoardMemberMetrics {
	linesAdded?: number;
	linesDeleted?: number;
	testsPassed?: number;
	testsTotal?: number;
	lastAction?: string;
	progressPct?: number;
}

/** Dynamic per-matter board participant stored in `matter_board_members`. */
export interface BoardMemberDto {
	matterId: string;
	agentId: string;
	sourceMemberId: string | null;
	displayName: string;
	boardRole: BoardRole;
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

export interface MatterBoardSnapshotDto {
	matterId: string;
	collaborationMode: "lead" | "board";
	coordinatorMemberId: string | null;
	members: BoardMemberDto[];
	posts: BoardPostSummaryDto[];
	latestPostNo: number;
}

export interface CreateBoardPostInput {
	kind: BoardPostKind;
	mentions: string[];
	refPostNos?: number[];
	summary: string;
	body?: string;
	artifacts?: BoardPostArtifacts | null;
	verification?: BoardPostVerification | null;
}

export interface SpawnBoardAgentInput {
	agentId: string;
	boardRole: BoardRole;
	displayName?: string;
	sourceMemberId?: string | null;
	brief: string;
	skills?: string[];
	ownedScope?: string[];
	acceptanceCriteria?: string;
	modelOverride?: ModelSelection | null;
}

export interface UpdateBoardMemberControlInput {
	action?: "pause" | "resume";
	status?: BoardMemberStatus;
	modelOverride?: ModelSelection | null;
}
