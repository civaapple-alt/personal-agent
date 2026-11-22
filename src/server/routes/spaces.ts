import { normalizeSpaceDocumentType, type SpaceDocumentType } from "../../storage/repos/space-repo.ts";
import {
	canAccessMatter,
	canAccessOrganization,
	canAccessSpace,
	canWriteSpace,
	getActorOrgRole,
	isViewerInAllOrgsOrTarget,
} from "../acl.ts";
import { isSuperAdminActor, requireActiveActor } from "../auth.ts";
import { readJsonBody, sendError, sendJson } from "../http.ts";
import type { RouteRequest, ServerRouteContext } from "./context.ts";

export async function handleSpaceRoutes(ctx: ServerRouteContext, r: RouteRequest): Promise<boolean> {
	const { store, broadcast } = ctx;
	const { actor, req, res, method, pathname } = r;

	if (pathname === "/api/spaces") {
		if (!requireActiveActor(res, actor)) return true;
		store.spaces.ensureAllDefaultSpaces();

		if (method === "GET") {
			const spaces = store.spaces
				.listSpaces()
				.filter((space) => canAccessSpace(store, actor, space))
				.map((space) => ({
					...space,
					canWrite: canWriteSpace(store, actor, space),
				}));
			sendJson(res, 200, { spaces });
			return true;
		}

		if (method === "POST") {
			const body = await readJsonBody(req);
			const name = typeof body.name === "string" ? body.name.trim() : "";
			const description = typeof body.description === "string" ? body.description.trim() : "";
			const visibility = body.visibility === "private" ? "private" : "org";
			const rawOrgId = typeof body.orgId === "string" && body.orgId.trim() ? body.orgId.trim() : null;

			if (!name || name.length > 100) {
				sendError(res, 400, "请提供空间名称（最多 100 字）");
				return true;
			}
			if (description.length > 500) {
				sendError(res, 400, "空间描述最多 500 字");
				return true;
			}

			if (visibility === "org") {
				if (rawOrgId) {
					if (!canAccessOrganization(store, actor, rawOrgId)) {
						sendError(res, 403, "无权在该组织中创建空间");
						return true;
					}
					if (!isSuperAdminActor(actor) && getActorOrgRole(store, actor, rawOrgId) === "org_viewer") {
						sendError(res, 403, "只读成员无权创建空间");
						return true;
					}
				} else if (!isSuperAdminActor(actor) && isViewerInAllOrgsOrTarget(store, actor)) {
					sendError(res, 403, "只读成员无权创建空间");
					return true;
				}
			} else if (!actor.user && actor.authKind !== "loopback") {
				sendError(res, 403, "请登录个人账号后再创建私密空间");
				return true;
			}

			const actorId = actor.user?.id ?? actor.collaborator.id;
			const created = store.spaces.createCustomSpace({
				name,
				description,
				orgId: rawOrgId,
				ownerUserId: actor.user?.id ?? null,
				visibility,
				createdBy: actorId,
			});
			await store.spaces.git.ensureRepo(created.id);
			broadcast("space_updated", { spaceId: created.id });
			sendJson(res, 201, {
				space: {
					...created,
					canWrite: canWriteSpace(store, actor, created),
				},
			});
			return true;
		}
		return false;
	}

	if (pathname === "/api/spaces/recent" && method === "GET") {
		if (!requireActiveActor(res, actor)) return true;
		store.spaces.ensureAllDefaultSpaces();
		const accessibleSpaces = store.spaces.listSpaces().filter((space) => canAccessSpace(store, actor, space));
		const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
		const rawDocType = reqUrl.searchParams.get("docType");
		const docType: SpaceDocumentType | undefined =
			rawDocType && rawDocType !== "all" ? normalizeSpaceDocumentType(rawDocType) : undefined;
		const query = reqUrl.searchParams.get("q") ?? undefined;
		const rawLimit = Number(reqUrl.searchParams.get("limit"));
		const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(200, Math.floor(rawLimit)) : 60;
		const documents = store.spaces.listRecentDocumentsForSpaces(
			accessibleSpaces.map((s) => s.id),
			{ docType, query, limit },
		);
		sendJson(res, 200, { documents });
		return true;
	}

	const spaceDocsMatch = pathname.match(/^\/api\/spaces\/([^/]+)\/documents$/);
	if (spaceDocsMatch) {
		if (!requireActiveActor(res, actor)) return true;
		store.spaces.ensureAllDefaultSpaces();
		const spaceId = decodeURIComponent(spaceDocsMatch[1]!);
		const space = store.spaces.getSpace(spaceId);
		if (!space) {
			sendError(res, 404, "空间不存在");
			return true;
		}
		if (!canAccessSpace(store, actor, space)) {
			sendError(res, 403, "无权访问该空间");
			return true;
		}
		if (method === "GET") {
			const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
			const rawDocType = reqUrl.searchParams.get("docType");
			const docType: SpaceDocumentType | undefined =
				rawDocType && rawDocType !== "all" ? normalizeSpaceDocumentType(rawDocType) : undefined;
			const documents = store.spaces.listDocuments({ spaceId, docType });
			sendJson(res, 200, {
				space: { ...space, canWrite: canWriteSpace(store, actor, space) },
				documents,
			});
			return true;
		}
		if (method === "POST") {
			if (!canWriteSpace(store, actor, space)) {
				sendError(res, 403, "无权编辑该空间的资料");
				return true;
			}
			const body = await readJsonBody(req);
			const title = typeof body.title === "string" ? body.title.trim() : "";
			const docType = normalizeSpaceDocumentType(body.docType);
			const content = typeof body.content === "string" ? body.content : null;
			const matterId = typeof body.matterId === "string" && body.matterId.trim() ? body.matterId.trim() : null;
			const linkedOrgId =
				typeof body.linkedOrgId === "string" && body.linkedOrgId.trim() ? body.linkedOrgId.trim() : null;
			const linkedWorkspaceId =
				typeof body.linkedWorkspaceId === "string" && body.linkedWorkspaceId.trim()
					? body.linkedWorkspaceId.trim()
					: null;
			const linkedFilePath =
				typeof body.linkedFilePath === "string" && body.linkedFilePath.trim() ? body.linkedFilePath.trim() : null;
			const commitMessage = typeof body.commitMessage === "string" ? body.commitMessage.trim() : undefined;
			if (!title || title.length > 200 || content === null || content.length > 512_000) {
				sendError(res, 400, "请提供标题和正文，标题最多 200 字，正文最多 512000 字");
				return true;
			}
			if (matterId) {
				const matter = store.getMatter(matterId);
				if (!matter || !canAccessMatter(store, actor, matter)) {
					sendError(res, 403, "无权关联该事项");
					return true;
				}
			}
			const actorId = actor.user?.id ?? actor.collaborator.id;
			const actorName = actor.user?.displayName ?? actor.collaborator.name;
			const document = await store.spaces.createDocument({
				spaceId: space.id,
				matterId,
				title,
				docType,
				content,
				linkedOrgId,
				linkedWorkspaceId,
				linkedFilePath,
				actorId,
				actorName,
				commitMessage,
			});
			broadcast("space_page_updated", { spaceId: space.id, documentId: document.id, matterId });
			sendJson(res, 201, { document });
			return true;
		}
		return false;
	}

	const docCommitDetailMatch = pathname.match(/^\/api\/spaces\/documents\/([^/]+)\/commits\/([^/]+)$/);
	if (docCommitDetailMatch && method === "GET") {
		if (!requireActiveActor(res, actor)) return true;
		const docId = decodeURIComponent(docCommitDetailMatch[1]!);
		const commitHash = decodeURIComponent(docCommitDetailMatch[2]!);
		const meta = store.spaces.getDocumentMeta(docId);
		if (!meta) {
			sendError(res, 404, "资料不存在");
			return true;
		}
		const space = store.spaces.getSpace(meta.spaceId);
		if (!canAccessSpace(store, actor, space)) {
			sendError(res, 403, "无权访问该资料");
			return true;
		}
		const detail = await store.spaces.getDocumentCommitDetail(docId, commitHash);
		if (!detail) {
			sendError(res, 404, "提交记录不存在");
			return true;
		}
		sendJson(res, 200, { detail });
		return true;
	}

	const docCommitsMatch = pathname.match(/^\/api\/spaces\/documents\/([^/]+)\/commits$/);
	if (docCommitsMatch && method === "GET") {
		if (!requireActiveActor(res, actor)) return true;
		const docId = decodeURIComponent(docCommitsMatch[1]!);
		const meta = store.spaces.getDocumentMeta(docId);
		if (!meta) {
			sendError(res, 404, "资料不存在");
			return true;
		}
		const space = store.spaces.getSpace(meta.spaceId);
		if (!canAccessSpace(store, actor, space)) {
			sendError(res, 403, "无权访问该资料");
			return true;
		}
		const commits = await store.spaces.listDocumentCommits(docId);
		sendJson(res, 200, { commits });
		return true;
	}

	const docMatch = pathname.match(/^\/api\/spaces\/documents\/([^/]+)$/);
	if (docMatch) {
		if (!requireActiveActor(res, actor)) return true;
		const docId = decodeURIComponent(docMatch[1]!);
		const meta = store.spaces.getDocumentMeta(docId);
		if (!meta) {
			sendError(res, 404, "资料不存在");
			return true;
		}
		const space = store.spaces.getSpace(meta.spaceId);
		if (!space || !canAccessSpace(store, actor, space)) {
			sendError(res, 403, "无权访问该资料");
			return true;
		}
		if (method === "GET") {
			const document = await store.spaces.getDocument(docId);
			sendJson(res, 200, {
				document,
				canWrite: canWriteSpace(store, actor, space),
			});
			return true;
		}
		if (method === "PATCH") {
			if (!canWriteSpace(store, actor, space)) {
				sendError(res, 403, "无权编辑该资料");
				return true;
			}
			const body = await readJsonBody(req);
			const title = typeof body.title === "string" ? body.title.trim() : "";
			const docType = body.docType !== undefined ? normalizeSpaceDocumentType(body.docType) : undefined;
			const content = typeof body.content === "string" ? body.content : null;
			const linkedOrgId =
				body.linkedOrgId === undefined
					? undefined
					: typeof body.linkedOrgId === "string" && body.linkedOrgId.trim()
						? body.linkedOrgId.trim()
						: null;
			const linkedWorkspaceId =
				body.linkedWorkspaceId === undefined
					? undefined
					: typeof body.linkedWorkspaceId === "string" && body.linkedWorkspaceId.trim()
						? body.linkedWorkspaceId.trim()
						: null;
			const linkedFilePath =
				body.linkedFilePath === undefined
					? undefined
					: typeof body.linkedFilePath === "string" && body.linkedFilePath.trim()
						? body.linkedFilePath.trim()
						: null;
			const commitMessage = typeof body.commitMessage === "string" ? body.commitMessage.trim() : undefined;
			if (!title || title.length > 200 || content === null || content.length > 512_000) {
				sendError(res, 400, "请提供标题和正文，标题最多 200 字，正文最多 512000 字");
				return true;
			}
			const revision =
				Number.isSafeInteger(body.revision) && Number(body.revision) >= 1 ? Number(body.revision) : undefined;
			const expectedCommit = typeof body.expectedCommit === "string" ? body.expectedCommit.trim() : undefined;
			if (revision === undefined && expectedCommit === undefined) {
				sendError(res, 400, "请提供资料修订号或基线提交号");
				return true;
			}
			const actorId = actor.user?.id ?? actor.collaborator.id;
			const actorName = actor.user?.displayName ?? actor.collaborator.name;
			const updated = await store.spaces.updateDocument(docId, {
				revision,
				expectedCommit,
				title,
				docType,
				content,
				linkedOrgId,
				linkedWorkspaceId,
				linkedFilePath,
				actorId,
				actorName,
				commitMessage,
			});
			if (!updated) {
				const latest = await store.spaces.getDocument(docId);
				sendJson(res, 409, {
					error: "资料已被修改，请重新加载后再保存",
					latest,
				});
				return true;
			}
			broadcast("space_page_updated", { spaceId: space.id, documentId: updated.id, matterId: updated.matterId });
			sendJson(res, 200, { document: updated });
			return true;
		}
		return false;
	}

	return false;
}
