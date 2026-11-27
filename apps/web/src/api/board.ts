import type {
	BoardMemberDto,
	BoardMemberMetrics,
	BoardMemberStatus,
	BoardPostArtifacts,
	BoardPostAuthorType,
	BoardPostDto,
	BoardPostFileChange,
	BoardPostKind,
	BoardPostSummaryDto,
	BoardPostVerification,
	BoardRole,
	BoardVerificationVerdict,
	CreateBoardPostInput,
	MatterBoardSnapshotDto,
	MatterEventDto,
	MatterEventsPageDto,
	MatterEventType,
	UpdateBoardMemberControlInput,
} from "@pa/contracts/board";
import { requestJson } from "./client.ts";

export type {
	BoardMemberDto,
	BoardMemberMetrics,
	BoardMemberStatus,
	BoardPostArtifacts,
	BoardPostAuthorType,
	BoardPostDto,
	BoardPostFileChange,
	BoardPostKind,
	BoardPostSummaryDto,
	BoardPostVerification,
	BoardRole,
	BoardVerificationVerdict,
	CreateBoardPostInput,
	MatterBoardSnapshotDto,
	MatterEventDto,
	MatterEventsPageDto,
	MatterEventType,
	UpdateBoardMemberControlInput,
};

export function fetchMatterBoard(
	matterId: string,
	options?: { afterPostNo?: number; limit?: number; order?: "asc" | "desc" },
): Promise<MatterBoardSnapshotDto> {
	const params = new URLSearchParams();
	if (options?.afterPostNo !== undefined) params.set("afterPostNo", String(options.afterPostNo));
	if (options?.limit !== undefined) params.set("limit", String(options.limit));
	if (options?.order) params.set("order", options.order);
	const qs = params.toString();
	return requestJson<MatterBoardSnapshotDto>(
		`/api/matters/${encodeURIComponent(matterId)}/board${qs ? `?${qs}` : ""}`,
	);
}

export function fetchBoardPost(matterId: string, postNo: number): Promise<{ post: BoardPostDto }> {
	return requestJson<{ post: BoardPostDto }>(
		`/api/matters/${encodeURIComponent(matterId)}/board/posts/${encodeURIComponent(String(postNo))}`,
	);
}

export function createBoardPost(
	matterId: string,
	input: CreateBoardPostInput & { autoResume?: boolean },
): Promise<{ post: BoardPostDto }> {
	return requestJson<{ post: BoardPostDto }>(`/api/matters/${encodeURIComponent(matterId)}/board/posts`, {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export function updateBoardMemberControl(
	matterId: string,
	agentId: string,
	input: UpdateBoardMemberControlInput,
): Promise<{ member: BoardMemberDto }> {
	return requestJson<{ member: BoardMemberDto }>(
		`/api/matters/${encodeURIComponent(matterId)}/board/members/${encodeURIComponent(agentId)}`,
		{
			method: "PATCH",
			body: JSON.stringify(input),
		},
	);
}

export function fetchMatterEvents(
	matterId: string,
	options?: {
		cursor?: string;
		limit?: number;
		agentId?: string;
		eventType?: MatterEventType;
		boardPostNo?: number;
		order?: "asc" | "desc";
	},
): Promise<MatterEventsPageDto> {
	const params = new URLSearchParams();
	if (options?.cursor) params.set("cursor", options.cursor);
	if (options?.limit !== undefined) params.set("limit", String(options.limit));
	if (options?.agentId) params.set("agentId", options.agentId);
	if (options?.eventType) params.set("eventType", options.eventType);
	if (options?.boardPostNo !== undefined) params.set("boardPostNo", String(options.boardPostNo));
	if (options?.order) params.set("order", options.order);
	const qs = params.toString();
	return requestJson<MatterEventsPageDto>(`/api/matters/${encodeURIComponent(matterId)}/events${qs ? `?${qs}` : ""}`);
}
