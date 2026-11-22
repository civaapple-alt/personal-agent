import { canAccessMatter, canParticipateInMatter } from "../acl.ts";
import { requireActiveActor } from "../auth.ts";
import { readJsonBody, sendError, sendJson } from "../http.ts";
import type { RouteRequest, ServerRouteContext } from "./context.ts";

export async function handleSpacePageRoutes(ctx: ServerRouteContext, r: RouteRequest): Promise<boolean> {
	const { store, broadcast } = ctx;
	const { actor, req, res, method, pathname } = r;
	const match = pathname.match(/^\/api\/space\/pages(?:\/([^/]+))?(?:\/(revisions))?$/);
	if (!match) return false;
	if (!requireActiveActor(res, actor)) return true;
	const pageId = match[1] ? decodeURIComponent(match[1]) : null;
	const page = pageId ? store.spacePages.get(pageId) : null;
	if (pageId && !page) {
		sendError(res, 404, "资料不存在");
		return true;
	}
	if (method === "GET") {
		if (!page) {
			const pages = store.spacePages
				.list()
				.filter((item) => canAccessMatter(store, actor, store.getMatter(item.matterId)));
			sendJson(res, 200, { pages });
			return true;
		}
		if (!canAccessMatter(store, actor, store.getMatter(page.matterId))) {
			sendError(res, 403, "无权访问该资料");
			return true;
		}
		sendJson(res, 200, match[2] ? { revisions: store.spacePages.listRevisions(page.id) } : { page });
		return true;
	}
	if ((method !== "POST" || pageId) && (method !== "PATCH" || !page || match[2])) return false;
	const body = await readJsonBody(req);
	const matterId = page?.matterId ?? (typeof body.matterId === "string" ? body.matterId : "");
	const matter = store.getMatter(matterId);
	if (!matter) {
		sendError(res, 404, "事项不存在");
		return true;
	}
	if (!canParticipateInMatter(store, actor, matter)) {
		sendError(res, 403, "无权编辑该事项的资料");
		return true;
	}
	const title = typeof body.title === "string" ? body.title.trim() : "";
	const content = typeof body.content === "string" ? body.content : null;
	if (!title || title.length > 200 || content === null || content.length > 512_000) {
		sendError(res, 400, "请提供标题和正文，标题最多 200 字，正文最多 512000 字");
		return true;
	}
	const actorId = actor.user?.id ?? actor.collaborator.id;
	if (!page) {
		const created = store.spacePages.create({ matterId, title, content, actorId });
		broadcast("space_page_updated", { matterId, pageId: created.id }, { matterId });
		sendJson(res, 201, { page: created });
		return true;
	}
	if (!Number.isSafeInteger(body.revision) || Number(body.revision) < 1) {
		sendError(res, 400, "请提供资料修订号");
		return true;
	}
	const updated = store.spacePages.update(page.id, { revision: Number(body.revision), title, content, actorId });
	if (!updated) {
		sendError(res, 409, "资料已被修改，请重新加载后再保存");
		return true;
	}
	broadcast("space_page_updated", { matterId, pageId: page.id }, { matterId });
	sendJson(res, 200, { page: updated });
	return true;
}
