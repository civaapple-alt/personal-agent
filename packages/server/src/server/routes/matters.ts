import { DialogRespondSchema } from "@pa/contracts/schemas";
import type { Hono } from "hono";
import type { RpcExtensionUIResponsePayload } from "../../rpc/types.ts";
import { canAccessMatter, canAccessSpace, canManageOrganization, requireMatterReadAccess } from "../acl.ts";
import { isSuperAdminActor, requireActiveActor } from "../auth.ts";
import { HttpRequestError } from "../http.ts";
import { type ApiRouterEnv, parseJsonBody } from "../router.ts";
import { auditActorAction } from "./context.ts";

/** Register routes to read matters, stop active turns, and respond to worker dialogs. */
export function registerMatterRoutes(app: Hono<ApiRouterEnv>): void {
	app.get("/api/matters/:matterId", (c) => {
		const ctx = c.var.routeCtx;
		const { store, dialogBroker, activeRuns } = ctx;
		const actor = c.var.actor;
		const res = c.var.nodeRes!;
		const matterId = c.req.param("matterId");
		const matter = store.getMatter(matterId);
		if (!matter) {
			throw new HttpRequestError(404, `Matter not found: ${matterId}`);
		}
		if (!requireMatterReadAccess(res, store, actor, matter)) return c.body(null);
		const active = activeRuns.get(matterId);
		const defaultSpace = store.spaces.resolveMatterDefaultSpace(matter);
		const spaceDocuments = store.spaces
			.listDocuments({ matterId })
			.filter((document) => canAccessSpace(store, actor, store.spaces.getSpace(document.spaceId)));
		return c.json({
			matter,
			userMessages: store.listMessages(matterId, "user"),
			internalCollabMessages: store.listMessages(matterId, "internal_collab"),
			noticeMessages: store.listMessages(matterId, "notice"),
			defaultSpace,
			spaceDocuments,
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
	});

	app.post("/api/matters/:matterId/abort", async (c) => {
		const ctx = c.var.routeCtx;
		const { store, orchestrator, dialogBroker, broadcast } = ctx;
		const req = c.var.nodeReq!;
		const res = c.var.nodeRes!;
		const actor = c.var.actor;
		if (!requireActiveActor(res, actor)) return c.body(null);
		const matterId = c.req.param("matterId");
		const existing = store.getMatter(matterId);
		if (!existing) {
			throw new HttpRequestError(404, `Matter not found: ${matterId}`);
		}
		const canAbort =
			isSuperAdminActor(actor) ||
			canManageOrganization(store, actor, existing.orgId) ||
			(actor.authKind === "session" && actor.user && existing.createdByUserId === actor.user.id);
		if (!canAbort) {
			throw new HttpRequestError(403, "仅所有者、组织管理员或事项发起人可中止执行");
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
		return c.json({ ok: true, aborted });
	});

	app.post("/api/dialogs/:dialogId/respond", async (c) => {
		const ctx = c.var.routeCtx;
		const { store, dialogBroker } = ctx;
		const res = c.var.nodeRes!;
		const actor = c.var.actor;
		if (!requireActiveActor(res, actor)) return c.body(null);
		const dialogId = c.req.param("dialogId");
		const pending = dialogBroker.listPending().find((d) => d.id === dialogId);
		const matter = pending ? store.getMatter(pending.matterId) : null;
		const canRespond =
			isSuperAdminActor(actor) ||
			(matter &&
				canAccessMatter(store, actor, matter) &&
				(canManageOrganization(store, actor, matter.orgId) ||
					(actor.authKind === "session" && actor.user && matter.createdByUserId === actor.user.id)));
		if (!canRespond) {
			throw new HttpRequestError(403, "无权确认该交互弹窗");
		}
		const body = await parseJsonBody(c, DialogRespondSchema);
		let payload: RpcExtensionUIResponsePayload;
		if (body.cancelled === true) {
			payload = { cancelled: true };
		} else if (typeof body.confirmed === "boolean") {
			payload = { confirmed: body.confirmed };
		} else if (typeof body.value === "string") {
			payload = { value: body.value };
		} else {
			throw new HttpRequestError(400, "Expected confirmed, value, or cancelled");
		}

		const matched = dialogBroker.respond(dialogId, payload);
		if (!matched) {
			throw new HttpRequestError(404, `Pending dialog not found: ${dialogId}`);
		}
		return c.json({ ok: true, dialogId });
	});
}
