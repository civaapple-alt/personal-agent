import type { BoardMemberStatus, BoardPostKind } from "@pa/contracts/board";
import type { Hono } from "hono";
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
import { HttpRequestError } from "../http.ts";
import { type ApiRouterEnv, parseJsonBody } from "../router.ts";
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

function parseOptionalNonNegativeInt(raw: string | undefined, name: string): number | undefined {
	if (raw === undefined || raw === "") return undefined;
	if (!/^\d+$/.test(raw)) throw new HttpRequestError(400, `${name} must be a non-negative integer`);
	const parsed = Number(raw);
	if (!Number.isSafeInteger(parsed)) throw new HttpRequestError(400, `${name} is out of range`);
	return parsed;
}

function parseOptionalPositiveInt(raw: string | undefined, name: string): number | undefined {
	if (raw === undefined || raw === "") return undefined;
	if (!/^[1-9]\d*$/.test(raw)) throw new HttpRequestError(400, `${name} must be a positive integer`);
	const parsed = Number(raw);
	if (!Number.isSafeInteger(parsed)) throw new HttpRequestError(400, `${name} is out of range`);
	return parsed;
}

function parseOptionalOrder(raw: string | undefined): "asc" | "desc" | undefined {
	if (raw === undefined || raw === "") return undefined;
	if (raw === "asc" || raw === "desc") return raw;
	throw new HttpRequestError(400, "order must be 'asc' or 'desc'");
}

/** Register ACL-enforced endpoints for matter board summaries, full posts, member control, and paginated events. */
export function registerMatterBoardRoutes(app: Hono<ApiRouterEnv>): void {
	app.get("/api/matters/:matterId/board", (c) => {
		const { store } = c.var.routeCtx;
		const actor = c.var.actor;
		const res = c.var.nodeRes!;
		const matterId = c.req.param("matterId");
		const matter = store.getMatter(matterId);
		if (!matter) {
			throw new HttpRequestError(404, `Matter not found: ${matterId}`);
		}
		if (!requireMatterReadAccess(res, store, actor, matter)) return c.body(null);

		const afterPostNo = parseOptionalNonNegativeInt(c.req.query("afterPostNo"), "afterPostNo");
		const limit = parseOptionalPositiveInt(c.req.query("limit"), "limit");
		const order = parseOptionalOrder(c.req.query("order"));

		const meta = store.getMatterBoardMeta(matterId) ?? {
			collaborationMode: "lead" as const,
			coordinatorMemberId: null,
		};
		const members = store.listBoardMembers(matterId);
		const posts = store.listBoardPostSummaries(matterId, {
			...(afterPostNo !== undefined ? { afterPostNo } : {}),
			...(limit !== undefined ? { limit } : {}),
			...(order !== undefined ? { order } : {}),
		});
		const latestPostNo = store.getLatestBoardPostNo(matterId);
		return c.json({
			matterId,
			collaborationMode: meta.collaborationMode,
			coordinatorMemberId: meta.coordinatorMemberId,
			members,
			posts,
			latestPostNo,
		});
	});

	app.post("/api/matters/:matterId/board/posts", async (c) => {
		const ctx = c.var.routeCtx;
		const { store, orchestrator, broadcast, runDispatchInBackground } = ctx;
		const actor = c.var.actor;
		const res = c.var.nodeRes!;
		if (!requireActiveActor(res, actor)) return c.body(null);
		const matterId = c.req.param("matterId");
		const matter = store.getMatter(matterId);
		if (!matter) {
			throw new HttpRequestError(404, `Matter not found: ${matterId}`);
		}
		if (!requireMatterReadAccess(res, store, actor, matter)) return c.body(null);
		if (!canParticipateInMatter(store, actor, matter)) {
			throw new HttpRequestError(403, "只读成员（org_viewer）不能在公告板发帖");
		}
		if (matter.status === "archived") {
			throw new HttpRequestError(409, "该事项已归档，请先恢复为活跃事项后再在公告板发言");
		}
		const body = await parseJsonBody(c);
		const rawKind = typeof body.kind === "string" && body.kind.trim() ? body.kind.trim() : "clarification";
		if (!VALID_BOARD_POST_KINDS.has(rawKind as BoardPostKind)) {
			throw new HttpRequestError(400, `Unsupported board post kind: ${rawKind}`);
		}
		const rawSummary = typeof body.summary === "string" ? body.summary.trim() : "";
		const rawBody = typeof body.body === "string" ? body.body : "";
		if (!rawSummary && !rawBody.trim()) {
			throw new HttpRequestError(400, "summary or body is required");
		}
		const mentions = Array.isArray(body.mentions)
			? body.mentions
					.filter((item): item is string => typeof item === "string")
					.map((item) => item.trim().replace(/^@+/, ""))
					.filter(Boolean)
			: [];
		if (mentions.some((item) => item.toLowerCase() === "all")) {
			throw new HttpRequestError(
				400,
				"Unrestricted @all mentions are forbidden; mention specific agentId(s) explicitly.",
			);
		}
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
				authorType: post.authorType,
				authorId: post.authorId,
				mentions: post.mentions,
				summary: post.summary,
				hasBody: Boolean(post.body && post.body.length > 0),
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
			if (member.status === "blocked_human" && (mentions.length === 0 || mentions.includes(member.agentId))) {
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
			existingMembers.some((m) => mentions.includes(m.agentId)) &&
			canDispatchAiInOrg(store, actor, matter.orgId);
		if (shouldAutoResume) {
			if (!checkUserDispatchQuota(ctx, actor, res)) return c.body(null);
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
		return c.json({ post }, 201);
	});

	app.patch("/api/matters/:matterId/board/members/:agentId", async (c) => {
		const ctx = c.var.routeCtx;
		const { store, broadcast } = ctx;
		const actor = c.var.actor;
		const res = c.var.nodeRes!;
		if (!requireActiveActor(res, actor)) return c.body(null);
		const matterId = c.req.param("matterId");
		const agentId = c.req.param("agentId");
		const matter = store.getMatter(matterId);
		if (!matter) {
			throw new HttpRequestError(404, `Matter not found: ${matterId}`);
		}
		if (!canAccessMatter(store, actor, matter)) {
			throw new HttpRequestError(403, "无权访问该事项");
		}
		const canControlMember =
			isGlobalUnscopedActor(actor) ||
			isSuperAdminActor(actor) ||
			canManageOrganization(store, actor, matter.orgId) ||
			(actor.authKind === "session" && actor.user && matter.createdByUserId === actor.user.id) ||
			canDispatchAiInOrg(store, actor, matter.orgId);
		if (!canControlMember || !canParticipateInMatter(store, actor, matter)) {
			throw new HttpRequestError(403, "当前账号无权调整看板成员状态或模型");
		}
		const existingMember: BoardMemberRecord | null = store.getBoardMember(matterId, agentId);
		if (!existingMember) {
			throw new HttpRequestError(404, `Board member not found: ${agentId}`);
		}
		const body = await parseJsonBody(c);
		const hasModelOverride = Object.hasOwn(body, "modelOverride");
		if (hasModelOverride) {
			if (!canDispatchAiInOrg(store, actor, matter.orgId)) {
				throw new HttpRequestError(403, "无权调整看板成员模型");
			}
			if (existingMember.status !== "waiting") {
				throw new HttpRequestError(
					409,
					`Board member '${agentId}' can only swap model when waiting (current status: ${existingMember.status})`,
				);
			}
		}
		let nextStatus: BoardMemberStatus | undefined;
		if (body.action === "pause") {
			nextStatus = "stopped";
		} else if (body.action === "resume") {
			nextStatus = "waiting";
		} else if (Object.hasOwn(body, "status")) {
			if (body.status !== "waiting" && body.status !== "stopped" && body.status !== "retired") {
				throw new HttpRequestError(400, "status must be 'waiting', 'stopped', or 'retired'");
			}
			nextStatus = body.status;
		}
		if (existingMember.boardRole === "coordinator" && nextStatus === "retired") {
			throw new HttpRequestError(400, "Coordinator cannot be retired");
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
			throw new HttpRequestError(404, `Board member not found: ${agentId}`);
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
		return c.json({ member: updated });
	});

	app.get("/api/matters/:matterId/board/posts/:postNo", (c) => {
		const { store } = c.var.routeCtx;
		const actor = c.var.actor;
		const res = c.var.nodeRes!;
		const matterId = c.req.param("matterId");
		const rawPostNo = c.req.param("postNo");
		const matter = store.getMatter(matterId);
		if (!matter) {
			throw new HttpRequestError(404, `Matter not found: ${matterId}`);
		}
		if (!requireMatterReadAccess(res, store, actor, matter)) return c.body(null);

		const parsedPostNo = parseOptionalPositiveInt(rawPostNo, "postNo");
		if (parsedPostNo === undefined) {
			throw new HttpRequestError(400, "Invalid board post number");
		}
		const post = store.getBoardPost(matterId, parsedPostNo);
		if (!post) {
			throw new HttpRequestError(404, `Board post #${parsedPostNo} not found`);
		}
		return c.json({ post });
	});

	app.get("/api/matters/:matterId/events", (c) => {
		const { store } = c.var.routeCtx;
		const actor = c.var.actor;
		const res = c.var.nodeRes!;
		const matterId = c.req.param("matterId");
		const matter = store.getMatter(matterId);
		if (!matter) {
			throw new HttpRequestError(404, `Matter not found: ${matterId}`);
		}
		if (!requireMatterReadAccess(res, store, actor, matter)) return c.body(null);

		const cursor = c.req.query("cursor")?.trim() || undefined;
		const agentId = c.req.query("agentId")?.trim() || undefined;
		const eventType = c.req.query("eventType")?.trim() || undefined;
		const limit = parseOptionalPositiveInt(c.req.query("limit"), "limit");
		const boardPostNo = parseOptionalPositiveInt(c.req.query("boardPostNo"), "boardPostNo");
		const order = parseOptionalOrder(c.req.query("order"));

		try {
			const result = store.listEvents(matterId, {
				...(cursor ? { cursor } : {}),
				...(limit !== undefined ? { limit } : {}),
				...(agentId ? { agentId } : {}),
				...(boardPostNo !== undefined ? { boardPostNo } : {}),
				...(eventType ? { eventType } : {}),
				...(order !== undefined ? { order } : {}),
			});
			return c.json({ matterId, ...result });
		} catch (error) {
			if (error instanceof InvalidEventsCursorError) {
				throw new HttpRequestError(400, error.message);
			}
			throw error;
		}
	});
}
