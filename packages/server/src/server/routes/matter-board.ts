import type { BoardMemberStatus, BoardPostKind } from "@pa/contracts/board";
import type { BoardMemberRecord } from "../../storage/repos/board-repo.ts";
import { InvalidEventsCursorError } from "../../storage/repos/board-repo.ts";
import {
	canAccessMatter,
	canDispatchAiInOrg,
	canManageOrganization,
	canParticipateInMatter,
	isGlobalUnscopedActor,
	requireMatterReadAccess,
} from "../acl.ts";
import { isSuperAdminActor, requireActiveActor, toDispatchAuthor } from "../auth.ts";
import { readJsonBody, sendError, sendJson } from "../http.ts";
import type { RouteRequest, ServerRouteContext } from "./context.ts";
import { checkUserDispatchQuota } from "./matter-messages.ts";
import { validateModelSelection } from "./model-settings.ts";

const VALID_BOARD_POST_KINDS = new Set<BoardPostKind>([
	"assign",
	"progress",
	"handoff",
	"verify_pass",
	"verify_rework",
	"escalate",
	"clarification",
	"summary",
]);

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

/** ACL-enforced endpoints for matter board summaries, full posts, member control, and paginated events. */
export async function handleMatterBoardRoutes(ctx: ServerRouteContext, r: RouteRequest): Promise<boolean> {
	const { store, orchestrator, broadcast, runDispatchInBackground } = ctx;
	const { req, res, method, pathname, actor } = r;

	const boardMatch = pathname.match(/^\/api\/matters\/([^/]+)\/board$/);
	if (method === "GET" && boardMatch) {
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
		const latestPostNo = store.getLatestBoardPostNo(matterId);
		sendJson(res, 200, {
			matterId,
			collaborationMode: meta.collaborationMode,
			coordinatorMemberId: meta.coordinatorMemberId,
			members,
			posts,
			latestPostNo,
		});
		return true;
	}

	const boardPostsCollectionMatch = pathname.match(/^\/api\/matters\/([^/]+)\/board\/posts$/);
	if (method === "POST" && boardPostsCollectionMatch) {
		if (!requireActiveActor(res, actor)) return true;
		const matterId = decodeURIComponent(boardPostsCollectionMatch[1]!);
		const matter = store.getMatter(matterId);
		if (!matter) {
			sendError(res, 404, `Matter not found: ${matterId}`);
			return true;
		}
		if (!requireMatterReadAccess(res, store, actor, matter)) return true;
		if (!canParticipateInMatter(store, actor, matter)) {
			sendError(res, 403, "只读成员（org_viewer）不能在公告板发帖");
			return true;
		}
		if (matter.status === "archived") {
			sendError(res, 409, "该事项已归档，请先恢复为活跃事项后再在公告板发言");
			return true;
		}
		const body = await readJsonBody(req);
		const rawKind = typeof body.kind === "string" && body.kind.trim() ? body.kind.trim() : "clarification";
		if (!VALID_BOARD_POST_KINDS.has(rawKind as BoardPostKind)) {
			sendError(res, 400, `Unsupported board post kind: ${rawKind}`);
			return true;
		}
		const rawSummary = typeof body.summary === "string" ? body.summary.trim() : "";
		const rawBody = typeof body.body === "string" ? body.body : "";
		if (!rawSummary && !rawBody.trim()) {
			sendError(res, 400, "summary or body is required");
			return true;
		}
		const mentions = Array.isArray(body.mentions)
			? body.mentions
					.filter((item): item is string => typeof item === "string")
					.map((item) => item.trim().replace(/^@+/, ""))
					.filter(Boolean)
			: [];
		const refPostNos = Array.isArray(body.refPostNos)
			? body.refPostNos.filter(
					(item): item is number => typeof item === "number" && Number.isInteger(item) && item > 0,
				)
			: [];
		const post = store.createBoardPost({
			matterId,
			authorType: "user",
			authorId: actor.collaborator.id,
			kind: rawKind as BoardPostKind,
			mentions,
			refPostNos,
			summary: rawSummary || rawBody.trim().slice(0, 140),
			body: rawBody,
			orgId: matter.orgId,
			workspaceId: matter.workspaceId,
		});
		broadcast(
			"board_post_created",
			{
				matterId,
				postNo: post.postNo,
				kind: post.kind,
				authorId: post.authorId,
				mentions: post.mentions,
				summary: post.summary,
				createdAt: post.createdAt,
			},
			{ matterId },
		);
		if (matter.status === "waiting_user") {
			store.updateMatterStatus(matterId, "open");
			broadcast("matter_updated", { matterId, status: "open" }, { matterId });
		}
		const existingMembers = store.listBoardMembers(matterId);
		for (const member of existingMembers) {
			if (
				member.status === "blocked_human" &&
				(mentions.length === 0 || mentions.includes(member.agentId) || mentions.includes("all"))
			) {
				const resumed = store.updateBoardMemberState(matterId, member.agentId, { status: "waiting" });
				if (resumed) {
					broadcast(
						"board_member_updated",
						{
							matterId,
							agentId: resumed.agentId,
							status: resumed.status,
							activePostNo: resumed.activePostNo,
							metrics: resumed.metrics,
							updatedAt: resumed.updatedAt,
						},
						{ matterId },
					);
				}
			}
		}
		if (!orchestrator.isMatterRunning(matterId)) {
			const settlingRun = ctx.activeRuns.get(matterId);
			if (settlingRun) {
				await settlingRun.settled.catch(() => {});
			}
		}
		const shouldAutoResume =
			body.autoResume !== false &&
			matter.collaborationMode === "board" &&
			!orchestrator.isMatterRunning(matterId) &&
			!ctx.activeRuns.has(matterId) &&
			existingMembers.some((m) => mentions.includes(m.agentId) || mentions.includes("all")) &&
			canDispatchAiInOrg(store, actor, matter.orgId);
		if (shouldAutoResume) {
			if (!checkUserDispatchQuota(ctx, actor, res)) return true;
			const coordinatorId = matter.coordinatorMemberId ?? matter.leadMemberId ?? undefined;
			runDispatchInBackground(
				{
					matterId,
					prompt: rawBody.trim() || rawSummary,
					preferredMemberId: coordinatorId,
					workspaceId: matter.workspaceId ?? undefined,
					orgId: matter.orgId,
					startedByUserId: actor.user?.id ?? null,
					author: toDispatchAuthor(actor.collaborator),
					resumeFromBoardPostNo: post.postNo,
				},
				actor,
			);
		}
		sendJson(res, 201, { post });
		return true;
	}

	const boardMemberMatch = pathname.match(/^\/api\/matters\/([^/]+)\/board\/members\/([^/]+)$/);
	if (method === "PATCH" && boardMemberMatch) {
		if (!requireActiveActor(res, actor)) return true;
		const matterId = decodeURIComponent(boardMemberMatch[1]!);
		const agentId = decodeURIComponent(boardMemberMatch[2]!);
		const matter = store.getMatter(matterId);
		if (!matter) {
			sendError(res, 404, `Matter not found: ${matterId}`);
			return true;
		}
		if (!canAccessMatter(store, actor, matter)) {
			sendError(res, 403, "无权访问该事项");
			return true;
		}
		const canControlMember =
			isGlobalUnscopedActor(actor) ||
			isSuperAdminActor(actor) ||
			canManageOrganization(store, actor, matter.orgId) ||
			(actor.authKind === "session" && actor.user && matter.createdByUserId === actor.user.id) ||
			canDispatchAiInOrg(store, actor, matter.orgId);
		if (!canControlMember || !canParticipateInMatter(store, actor, matter)) {
			sendError(res, 403, "当前账号无权调整看板成员状态或模型");
			return true;
		}
		const existingMember: BoardMemberRecord | null = store.getBoardMember(matterId, agentId);
		if (!existingMember) {
			sendError(res, 404, `Board member not found: ${agentId}`);
			return true;
		}
		const body = await readJsonBody(req);
		const hasModelOverride = Object.hasOwn(body, "modelOverride");
		if (hasModelOverride) {
			if (!canDispatchAiInOrg(store, actor, matter.orgId)) {
				sendError(res, 403, "无权调整看板成员模型");
				return true;
			}
			if (existingMember.status !== "waiting") {
				sendError(
					res,
					409,
					`Board member '${agentId}' can only swap model when waiting (current status: ${existingMember.status})`,
				);
				return true;
			}
		}
		let nextStatus: BoardMemberStatus | undefined;
		if (body.action === "pause") {
			nextStatus = "stopped";
		} else if (body.action === "resume") {
			nextStatus = "waiting";
		} else if (Object.hasOwn(body, "status")) {
			if (body.status !== "waiting" && body.status !== "stopped" && body.status !== "retired") {
				sendError(res, 400, "status must be 'waiting', 'stopped', or 'retired'");
				return true;
			}
			nextStatus = body.status;
		}
		const validatedModel = hasModelOverride
			? body.modelOverride === null
				? null
				: await validateModelSelection(ctx, body.modelOverride)
			: undefined;
		const updated = store.updateBoardMemberState(matterId, agentId, {
			...(nextStatus !== undefined ? { status: nextStatus } : {}),
			...(validatedModel !== undefined ? { modelOverride: validatedModel } : {}),
		});
		if (!updated) {
			sendError(res, 404, `Board member not found: ${agentId}`);
			return true;
		}
		broadcast(
			"board_member_updated",
			{
				matterId,
				agentId: updated.agentId,
				status: updated.status,
				activePostNo: updated.activePostNo,
				metrics: updated.metrics,
				updatedAt: updated.updatedAt,
			},
			{ matterId },
		);
		sendJson(res, 200, { member: updated });
		return true;
	}

	if (method !== "GET") return false;

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
