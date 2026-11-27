import { InvalidEventsCursorError } from "../../storage/repos/board-repo.ts";
import { requireMatterReadAccess } from "../acl.ts";
import { sendError, sendJson } from "../http.ts";
import type { RouteRequest, ServerRouteContext } from "./context.ts";

function parseOptionalNonNegativeInt(raw: string | null, name: string): { value?: number; error?: string } {
	if (raw === null || raw === "") return {};
	if (!/^\d+$/.test(raw)) return { error: `${name} must be a non-negative integer` };
	const parsed = Number(raw);
	if (!Number.isSafeInteger(parsed)) return { error: `${name} is out of range` };
	return { value: parsed };
}

function parseOptionalPositiveInt(raw: string | null, name: string): { value?: number; error?: string } {
	if (raw === null || raw === "") return {};
	if (!/^[1-9]\d*$/.test(raw)) return { error: `${name} must be a positive integer` };
	const parsed = Number(raw);
	if (!Number.isSafeInteger(parsed)) return { error: `${name} is out of range` };
	return { value: parsed };
}

function parseOptionalOrder(raw: string | null): { value?: "asc" | "desc"; error?: string } {
	if (raw === null || raw === "") return {};
	if (raw === "asc" || raw === "desc") return { value: raw };
	return { error: "order must be 'asc' or 'desc'" };
}

/** Read-only ACL-enforced lazy-load endpoints for matter board summaries, full posts, and paginated events. */
export async function handleMatterBoardRoutes(ctx: ServerRouteContext, r: RouteRequest): Promise<boolean> {
	const { store } = ctx;
	const { req, res, method, pathname, actor } = r;
	if (method !== "GET") return false;

	const boardMatch = pathname.match(/^\/api\/matters\/([^/]+)\/board$/);
	if (boardMatch) {
		const matterId = decodeURIComponent(boardMatch[1]!);
		const matter = store.getMatter(matterId);
		if (!matter) {
			sendError(res, 404, `Matter not found: ${matterId}`);
			return true;
		}
		if (!requireMatterReadAccess(res, store, actor, matter)) return true;

		const searchParams = new URL(req.url ?? pathname, "http://127.0.0.1").searchParams;
		const afterPostNo = parseOptionalNonNegativeInt(searchParams.get("afterPostNo"), "afterPostNo");
		if (afterPostNo.error) {
			sendError(res, 400, afterPostNo.error);
			return true;
		}
		const limit = parseOptionalPositiveInt(searchParams.get("limit"), "limit");
		if (limit.error) {
			sendError(res, 400, limit.error);
			return true;
		}
		const order = parseOptionalOrder(searchParams.get("order"));
		if (order.error) {
			sendError(res, 400, order.error);
			return true;
		}

		const meta = store.getMatterBoardMeta(matterId) ?? {
			collaborationMode: "lead" as const,
			coordinatorMemberId: null,
		};
		const members = store.listBoardMembers(matterId);
		const posts = store.listBoardPostSummaries(matterId, {
			...(afterPostNo.value !== undefined ? { afterPostNo: afterPostNo.value } : {}),
			...(limit.value !== undefined ? { limit: limit.value } : {}),
			...(order.value !== undefined ? { order: order.value } : {}),
		});
		sendJson(res, 200, {
			matterId,
			collaborationMode: meta.collaborationMode,
			coordinatorMemberId: meta.coordinatorMemberId,
			members,
			posts,
		});
		return true;
	}

	const boardPostMatch = pathname.match(/^\/api\/matters\/([^/]+)\/board\/posts\/([^/]+)$/);
	if (boardPostMatch) {
		const matterId = decodeURIComponent(boardPostMatch[1]!);
		const rawPostNo = decodeURIComponent(boardPostMatch[2]!);
		const matter = store.getMatter(matterId);
		if (!matter) {
			sendError(res, 404, `Matter not found: ${matterId}`);
			return true;
		}
		if (!requireMatterReadAccess(res, store, actor, matter)) return true;

		const parsedPostNo = parseOptionalPositiveInt(rawPostNo, "postNo");
		if (parsedPostNo.error || parsedPostNo.value === undefined) {
			sendError(res, 400, parsedPostNo.error ?? "Invalid board post number");
			return true;
		}
		const post = store.getBoardPost(matterId, parsedPostNo.value);
		if (!post) {
			sendError(res, 404, `Board post #${parsedPostNo.value} not found`);
			return true;
		}
		sendJson(res, 200, { post });
		return true;
	}

	const eventsMatch = pathname.match(/^\/api\/matters\/([^/]+)\/events$/);
	if (eventsMatch) {
		const matterId = decodeURIComponent(eventsMatch[1]!);
		const matter = store.getMatter(matterId);
		if (!matter) {
			sendError(res, 404, `Matter not found: ${matterId}`);
			return true;
		}
		if (!requireMatterReadAccess(res, store, actor, matter)) return true;

		const searchParams = new URL(req.url ?? pathname, "http://127.0.0.1").searchParams;
		const cursor = searchParams.get("cursor")?.trim() || undefined;
		const agentId = searchParams.get("agentId")?.trim() || undefined;
		const eventType = searchParams.get("eventType")?.trim() || undefined;
		const limit = parseOptionalPositiveInt(searchParams.get("limit"), "limit");
		if (limit.error) {
			sendError(res, 400, limit.error);
			return true;
		}
		const boardPostNo = parseOptionalPositiveInt(searchParams.get("boardPostNo"), "boardPostNo");
		if (boardPostNo.error) {
			sendError(res, 400, boardPostNo.error);
			return true;
		}
		const order = parseOptionalOrder(searchParams.get("order"));
		if (order.error) {
			sendError(res, 400, order.error);
			return true;
		}

		try {
			const result = store.listEvents(matterId, {
				...(cursor ? { cursor } : {}),
				...(limit.value !== undefined ? { limit: limit.value } : {}),
				...(agentId ? { agentId } : {}),
				...(boardPostNo.value !== undefined ? { boardPostNo: boardPostNo.value } : {}),
				...(eventType ? { eventType } : {}),
				...(order.value !== undefined ? { order: order.value } : {}),
			});
			sendJson(res, 200, { matterId, ...result });
		} catch (error) {
			if (error instanceof InvalidEventsCursorError) {
				sendError(res, 400, error.message);
				return true;
			}
			throw error;
		}
		return true;
	}

	return false;
}
