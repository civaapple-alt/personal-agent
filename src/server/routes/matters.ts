import type { RpcExtensionUIResponsePayload } from "../../rpc/types.ts";
import { canAccessMatter, canManageOrganization, requireMatterReadAccess } from "../acl.ts";
import { isSuperAdminActor, requireActiveActor } from "../auth.ts";
import { readJsonBody, sendError, sendJson } from "../http.ts";
import { auditActorAction, type RouteRequest, type ServerRouteContext } from "./context.ts";

/** Read matters, stop active turns, and respond to worker dialogs. */
export async function handleMatterRoutes(ctx: ServerRouteContext, r: RouteRequest): Promise<boolean> {
	const { store, orchestrator, dialogBroker, activeRuns, broadcast } = ctx;
	const { req, res, method, pathname, actor } = r;

	const matterDetailMatch = pathname.match(/^\/api\/matters\/([^/]+)$/);
	if (method === "GET" && matterDetailMatch) {
		const matterId = decodeURIComponent(matterDetailMatch[1]!);
		const matter = store.getMatter(matterId);
		if (!matter) {
			sendError(res, 404, `Matter not found: ${matterId}`);
			return true;
		}
		if (!requireMatterReadAccess(res, store, actor, matter)) return true;
		const active = activeRuns.get(matterId);
		sendJson(res, 200, {
			matter,
			demoGuide: ctx.innerMatterDemo?.guideFor(matter),
			userMessages: store.listMessages(matterId, "user"),
			internalCollabMessages: store.listMessages(matterId, "internal_collab"),
			noticeMessages: store.listMessages(matterId, "notice"),
			deliverables: store.listDeliverables(matterId),
			pendingDialogs: dialogBroker.listPending(matterId),
			activeRun: active
				? {
						...active.progress,
						matterId,
						startedAt: active.startedAt,
						streamingDelta: active.accumulatedDelta,
					}
				: null,
		});
		return true;
	}

	const matterAbortMatch = pathname.match(/^\/api\/matters\/([^/]+)\/abort$/);
	if (method === "POST" && matterAbortMatch) {
		if (!requireActiveActor(res, actor)) return true;
		const matterId = decodeURIComponent(matterAbortMatch[1]!);
		const existing = store.getMatter(matterId);
		if (!existing) {
			sendError(res, 404, `Matter not found: ${matterId}`);
			return true;
		}
		const canAbort =
			isSuperAdminActor(actor) ||
			canManageOrganization(store, actor, existing.orgId) ||
			(actor.authKind === "session" && actor.user && existing.createdByUserId === actor.user.id);
		if (!canAbort) {
			sendError(res, 403, "仅所有者、组织管理员或事项发起人可中止执行");
			return true;
		}
		dialogBroker.cancelForMatter(matterId);
		const aborted = await orchestrator.abortMatter(matterId);
		auditActorAction(ctx, req, actor, {
			action: "matter.abort",
			targetType: "matter",
			targetId: matterId,
			orgId: existing.orgId,
			detail: { aborted },
		});
		broadcast("matter_aborted", { matterId, aborted }, { matterId });
		sendJson(res, 200, { ok: true, aborted });
		return true;
	}

	const dialogMatch = pathname.match(/^\/api\/dialogs\/([^/]+)\/respond$/);
	if (method === "POST" && dialogMatch) {
		if (!requireActiveActor(res, actor)) return true;
		const dialogId = decodeURIComponent(dialogMatch[1]!);
		const pending = dialogBroker.listPending().find((d) => d.id === dialogId);
		const matter = pending ? store.getMatter(pending.matterId) : null;
		const canRespond =
			isSuperAdminActor(actor) ||
			(matter &&
				canAccessMatter(store, actor, matter) &&
				(canManageOrganization(store, actor, matter.orgId) ||
					(actor.authKind === "session" && actor.user && matter.createdByUserId === actor.user.id)));
		if (!canRespond) {
			sendError(res, 403, "无权确认该交互弹窗");
			return true;
		}
		const body = await readJsonBody(req);
		let payload: RpcExtensionUIResponsePayload;
		if (body.cancelled === true) {
			payload = { cancelled: true };
		} else if (typeof body.confirmed === "boolean") {
			payload = { confirmed: body.confirmed };
		} else if (typeof body.value === "string") {
			payload = { value: body.value };
		} else {
			sendError(res, 400, "Expected confirmed, value, or cancelled");
			return true;
		}

		const matched = dialogBroker.respond(dialogId, payload);
		if (!matched) {
			sendError(res, 404, `Pending dialog not found: ${dialogId}`);
			return true;
		}
		sendJson(res, 200, { ok: true, dialogId });
		return true;
	}

	return false;
}
