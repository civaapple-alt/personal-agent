import type { BoardMemberMetrics, BoardMemberStatus, BoardPostKind, MatterEventType } from "./board.ts";

/**
 * Centralized Server-Sent Events (`/api/events`) name & payload contract shared
 * between the HTTP SSE hub (`packages/server`) and browser listeners (`apps/web`).
 */
export interface SseEventPayloadMap {
	connected: { ok: true };
	auth_revoked: { collaboratorId: string; reason: string };
	matter_started: { matterId: string };
	text_delta: { matterId: string; delta: string };
	matter_progress: { matterId: string; [key: string]: unknown };
	matter_settled: { matterId: string; [key: string]: unknown };
	matter_failed: { matterId: string; error?: string; [key: string]: unknown };
	matter_aborted: { matterId: string; aborted?: boolean; [key: string]: unknown };
	matter_message: { matterId: string; message?: unknown; matter?: unknown };
	matter_updated: { matterId: string; [key: string]: unknown };
	board_post_created: {
		matterId: string;
		postNo: number;
		kind: BoardPostKind;
		authorId: string;
		mentions: string[];
		summary: string;
		createdAt: string;
	};
	board_member_updated: {
		matterId: string;
		agentId: string;
		status: BoardMemberStatus;
		activePostNo: number | null;
		metrics: BoardMemberMetrics | null;
		updatedAt: string;
	};
	matter_event_appended: {
		matterId: string;
		runId: string;
		agentId: string | null;
		eventType: MatterEventType;
		createdAt: string;
	};
	dialog_requested: { type: "dialog_requested"; dialog: unknown };
	dialog_resolved: { type: "dialog_resolved"; dialogId: string; matterId: string; payload: unknown };
	workspace_updated: { id?: string; workspaceId?: string | null; matterId?: string; orgId?: string | null };
	organization_updated: { organization: unknown };
	team_updated: { orgId?: string | null; memberId?: string; [key: string]: unknown };
	preview_updated: object;
	space_updated: { spaceId: string };
	space_page_updated: { spaceId: string; documentId: string; matterId?: string | null; [key: string]: unknown };
	collaborator_updated: { [key: string]: unknown };
}

export type SseEventName = keyof SseEventPayloadMap;

/** Events that trigger a bootstrap/detail refresh in the workbench EventSource sync hook. */
export const SSE_SYNC_EVENT_NAMES: readonly SseEventName[] = [
	"matter_started",
	"matter_message",
	"matter_updated",
	"collaborator_updated",
	"dialog_requested",
	"dialog_resolved",
	"workspace_updated",
	"organization_updated",
	"preview_updated",
	"team_updated",
	"space_updated",
	"space_page_updated",
];
