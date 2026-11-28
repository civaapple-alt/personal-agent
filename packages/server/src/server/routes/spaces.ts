import { extname } from "node:path";
import type { Hono } from "hono";
import {
	normalizeSpaceDocumentType,
	normalizeSpaceEntryKind,
	type SpaceDocumentType,
} from "../../storage/repos/space-repo.ts";
import {
	canAccessMatter,
	canAccessOrganization,
	canAccessSpace,
	canParticipateInMatter,
	canWriteSpace,
	getActorOrgRole,
	isViewerInAllOrgsOrTarget,
} from "../acl.ts";
import { isSuperAdminActor, type RequestActor, requireActiveActor } from "../auth.ts";
import { HttpRequestError } from "../http.ts";
import { type ApiRouterEnv, parseJsonBody } from "../router.ts";
import type { ServerRouteContext } from "./context.ts";

const PREVIEW_MIME_BY_EXT: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".mjs": "application/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".txt": "text/plain; charset=utf-8",
	".md": "text/markdown; charset=utf-8",
	".csv": "text/csv; charset=utf-8",
	".xml": "application/xml; charset=utf-8",
	".woff": "font/woff",
	".woff2": "font/woff2",
};

function canActorReadSpaceDoc(
	store: ServerRouteContext["store"],
	actor: RequestActor | null,
	document: { matterId: string | null },
): boolean {
	return !document.matterId || canAccessMatter(store, actor, store.getMatter(document.matterId));
}

/** Register Git space and versioned document/folder/feedback routes. */
export function registerSpaceRoutes(app: Hono<ApiRouterEnv>): void {
	app.get("/api/spaces", (c) => {
		const { store } = c.var.routeCtx;
		const actor = c.var.actor;
		const res = c.var.nodeRes!;
		if (!requireActiveActor(res, actor)) return c.body(null);
		store.spaces.ensureAllDefaultSpaces();
		const spaces = store.spaces
			.listSpaces()
			.filter((space) => canAccessSpace(store, actor, space))
			.map((space) => ({
				...space,
				documentCount: store.spaces
					.listDocuments({ spaceId: space.id })
					.filter((doc) => canActorReadSpaceDoc(store, actor, doc)).length,
				canWrite: canWriteSpace(store, actor, space),
			}));
		return c.json({ spaces });
	});

	app.post("/api/spaces", async (c) => {
		const { store, broadcast } = c.var.routeCtx;
		const actor = c.var.actor;
		const res = c.var.nodeRes!;
		if (!requireActiveActor(res, actor)) return c.body(null);
		store.spaces.ensureAllDefaultSpaces();

		const body = await parseJsonBody(c);
		const name = typeof body.name === "string" ? body.name.trim() : "";
		const description = typeof body.description === "string" ? body.description.trim() : "";
		const visibility = body.visibility === "private" ? "private" : "org";
		const rawOrgId = typeof body.orgId === "string" && body.orgId.trim() ? body.orgId.trim() : null;

		if (!name || name.length > 100) {
			throw new HttpRequestError(400, "请提供空间名称（最多 100 字）");
		}
		if (description.length > 500) {
			throw new HttpRequestError(400, "空间描述最多 500 字");
		}

		if (visibility === "org") {
			if (rawOrgId) {
				if (!canAccessOrganization(store, actor, rawOrgId)) {
					throw new HttpRequestError(403, "无权在该组织中创建空间");
				}
				if (!isSuperAdminActor(actor) && getActorOrgRole(store, actor, rawOrgId) === "org_viewer") {
					throw new HttpRequestError(403, "只读成员无权创建空间");
				}
			} else if (!isSuperAdminActor(actor) && isViewerInAllOrgsOrTarget(store, actor)) {
				throw new HttpRequestError(403, "只读成员无权创建空间");
			}
		} else if (!actor.user && actor.authKind !== "loopback") {
			throw new HttpRequestError(403, "请登录个人账号后再创建私密空间");
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
		return c.json(
			{
				space: {
					...created,
					canWrite: canWriteSpace(store, actor, created),
				},
			},
			201,
		);
	});

	app.get("/api/spaces/recent", (c) => {
		const { store } = c.var.routeCtx;
		const actor = c.var.actor;
		const res = c.var.nodeRes!;
		if (!requireActiveActor(res, actor)) return c.body(null);
		store.spaces.ensureAllDefaultSpaces();
		const accessibleSpaces = store.spaces.listSpaces().filter((space) => canAccessSpace(store, actor, space));
		const rawDocType = c.req.query("docType");
		const docType: SpaceDocumentType | undefined =
			rawDocType && rawDocType !== "all" ? normalizeSpaceDocumentType(rawDocType) : undefined;
		const query = c.req.query("q") ?? undefined;
		const rawLimit = Number(c.req.query("limit"));
		const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(200, Math.floor(rawLimit)) : 60;
		const documents = store.spaces
			.listRecentDocumentsForSpaces(
				accessibleSpaces.map((s) => s.id),
				{ docType, query, limit },
			)
			.filter((doc) => canActorReadSpaceDoc(store, actor, doc));
		return c.json({ documents });
	});

	app.get("/api/spaces/:spaceId/documents", (c) => {
		const { store } = c.var.routeCtx;
		const actor = c.var.actor;
		const res = c.var.nodeRes!;
		if (!requireActiveActor(res, actor)) return c.body(null);
		store.spaces.ensureAllDefaultSpaces();
		const spaceId = c.req.param("spaceId");
		const space = store.spaces.getSpace(spaceId);
		if (!space) {
			throw new HttpRequestError(404, "空间不存在");
		}
		if (!canAccessSpace(store, actor, space)) {
			throw new HttpRequestError(403, "无权访问该空间");
		}
		const rawDocType = c.req.query("docType");
		const docType: SpaceDocumentType | undefined =
			rawDocType && rawDocType !== "all" ? normalizeSpaceDocumentType(rawDocType) : undefined;
		const documents = store.spaces
			.listDocuments({ spaceId, docType })
			.filter((doc) => canActorReadSpaceDoc(store, actor, doc));
		return c.json({
			space: {
				...space,
				documentCount: store.spaces
					.listDocuments({ spaceId })
					.filter((doc) => canActorReadSpaceDoc(store, actor, doc)).length,
				canWrite: canWriteSpace(store, actor, space),
			},
			documents,
		});
	});

	app.post("/api/spaces/:spaceId/documents", async (c) => {
		const { store, broadcast } = c.var.routeCtx;
		const actor = c.var.actor;
		const res = c.var.nodeRes!;
		if (!requireActiveActor(res, actor)) return c.body(null);
		store.spaces.ensureAllDefaultSpaces();
		const spaceId = c.req.param("spaceId");
		const space = store.spaces.getSpace(spaceId);
		if (!space) {
			throw new HttpRequestError(404, "空间不存在");
		}
		if (!canAccessSpace(store, actor, space)) {
			throw new HttpRequestError(403, "无权访问该空间");
		}
		if (!canWriteSpace(store, actor, space)) {
			throw new HttpRequestError(403, "无权编辑该空间的资料");
		}
		const body = await parseJsonBody(c);
		const title = typeof body.title === "string" ? body.title.trim() : "";
		const docType = normalizeSpaceDocumentType(body.docType);
		const entryKind = normalizeSpaceEntryKind(body.entryKind);
		const content = typeof body.content === "string" ? body.content : null;
		const rawExtraFiles = Array.isArray(body.extraFiles) ? body.extraFiles : [];
		const extraFiles: Array<{ subPath: string; content: string }> = [];
		for (const item of rawExtraFiles) {
			if (!item || typeof item !== "object") continue;
			const subPath =
				typeof (item as { path?: unknown }).path === "string" ? (item as { path: string }).path.trim() : "";
			const fileContent =
				typeof (item as { content?: unknown }).content === "string" ? (item as { content: string }).content : "";
			if (!subPath) continue;
			if (fileContent.length > 512_000) {
				throw new HttpRequestError(400, `子文件 ${subPath} 超过 512000 字上限`);
			}
			extraFiles.push({ subPath, content: fileContent });
		}
		const matterId = typeof body.matterId === "string" && body.matterId.trim() ? body.matterId.trim() : null;
		const sourceMessageId =
			typeof body.sourceMessageId === "string" && body.sourceMessageId.trim() ? body.sourceMessageId.trim() : null;
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
			throw new HttpRequestError(400, "请提供标题和正文，标题最多 200 字，正文最多 512000 字");
		}
		if (matterId) {
			const matter = store.getMatter(matterId);
			if (!matter || !canAccessMatter(store, actor, matter)) {
				throw new HttpRequestError(403, "无权关联该事项");
			}
		}
		const actorId = actor.user?.id ?? actor.collaborator.id;
		const actorName = actor.user?.displayName ?? actor.collaborator.name;
		const document = await store.spaces.createDocument({
			spaceId: space.id,
			matterId,
			title,
			docType,
			entryKind,
			content,
			extraFiles,
			linkedOrgId,
			linkedWorkspaceId,
			linkedFilePath,
			actorId,
			actorName,
			commitMessage,
		});
		if (matterId && sourceMessageId) {
			const sourceMsg = store.listMessages(matterId, "user").find((m) => m.id === sourceMessageId);
			if (sourceMsg) {
				const existingDocs = Array.isArray(sourceMsg.metadata?.spaceDocuments)
					? (sourceMsg.metadata.spaceDocuments as Array<Record<string, unknown>>)
					: [];
				const entry = {
					id: document.id,
					spaceId: document.spaceId,
					spaceName: space.name,
					title: document.title,
					docType: document.docType,
					revision: document.revision,
					headCommit: document.headCommit,
					memberId: sourceMsg.senderId,
				};
				const nextDocs = [...existingDocs.filter((item) => item?.id !== document.id), entry];
				store.updateMessageMetadata(sourceMsg.id, {
					...(sourceMsg.metadata ?? {}),
					spaceDocuments: nextDocs,
				});
				broadcast("matter_message", { matterId });
			}
		}
		broadcast("space_page_updated", { spaceId: space.id, documentId: document.id, matterId });
		return c.json({ document }, 201);
	});

	app.get("/api/spaces/documents/:docId/feedback", (c) => {
		const { store } = c.var.routeCtx;
		const actor = c.var.actor;
		const res = c.var.nodeRes!;
		if (!requireActiveActor(res, actor)) return c.body(null);
		const docId = c.req.param("docId");
		const document = store.spaces.getDocumentMeta(docId);
		if (!document) {
			throw new HttpRequestError(404, "资料不存在");
		}
		const space = store.spaces.getSpace(document.spaceId);
		if (!space || !canAccessSpace(store, actor, space) || !canActorReadSpaceDoc(store, actor, document)) {
			throw new HttpRequestError(403, "无权访问该资料");
		}
		return c.json({ feedback: store.spaces.listDocumentFeedback(docId) });
	});

	app.post("/api/spaces/documents/:docId/feedback", async (c) => {
		const { store } = c.var.routeCtx;
		const actor = c.var.actor;
		const res = c.var.nodeRes!;
		if (!requireActiveActor(res, actor)) return c.body(null);
		const docId = c.req.param("docId");
		const document = store.spaces.getDocumentMeta(docId);
		if (!document) {
			throw new HttpRequestError(404, "资料不存在");
		}
		const space = store.spaces.getSpace(document.spaceId);
		if (!space || !canAccessSpace(store, actor, space) || !canActorReadSpaceDoc(store, actor, document)) {
			throw new HttpRequestError(403, "无权访问该资料");
		}
		const matter = document.matterId ? store.getMatter(document.matterId) : null;
		if (!canWriteSpace(store, actor, space) || (matter && !canParticipateInMatter(store, actor, matter))) {
			throw new HttpRequestError(403, "无权评价该资料");
		}
		const body = await parseJsonBody(c);
		const commitHash = typeof body.commitHash === "string" ? body.commitHash.trim() : "";
		const feedback = typeof body.feedback === "string" ? body.feedback.trim() : "";
		const rating = body.rating === undefined || body.rating === null ? null : body.rating;
		if (
			!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(commitHash) ||
			feedback.length > 5000 ||
			(rating !== null && rating !== "positive" && rating !== "negative" && rating !== "neutral") ||
			(!feedback && !rating)
		) {
			throw new HttpRequestError(400, "请提供文档提交号和评价或反馈（最多 5000 字）");
		}
		try {
			const saved = await store.spaces.saveDocumentFeedback({
				documentId: docId,
				commitHash,
				actorId: actor.user?.id ?? actor.collaborator.id,
				actorName: actor.user?.displayName ?? actor.collaborator.name,
				feedback,
				rating,
			});
			if (!saved) {
				throw new HttpRequestError(404, "资料不存在");
			}
			return c.json({ feedback: saved });
		} catch (error) {
			if (error instanceof HttpRequestError) throw error;
			throw new HttpRequestError(400, error instanceof Error ? error.message : "无法保存反馈");
		}
	});

	app.get("/api/spaces/documents/:docId/commits/:commitHash", async (c) => {
		const { store } = c.var.routeCtx;
		const actor = c.var.actor;
		const res = c.var.nodeRes!;
		if (!requireActiveActor(res, actor)) return c.body(null);
		const docId = c.req.param("docId");
		const commitHash = c.req.param("commitHash");
		const meta = store.spaces.getDocumentMeta(docId);
		if (!meta) {
			throw new HttpRequestError(404, "资料不存在");
		}
		const space = store.spaces.getSpace(meta.spaceId);
		if (!canAccessSpace(store, actor, space) || !canActorReadSpaceDoc(store, actor, meta)) {
			throw new HttpRequestError(403, "无权访问该资料");
		}
		const detail = await store.spaces.getDocumentCommitDetail(docId, commitHash);
		if (!detail) {
			throw new HttpRequestError(404, "提交记录不存在");
		}
		return c.json({ detail });
	});

	app.get("/api/spaces/documents/:docId/commits", async (c) => {
		const { store } = c.var.routeCtx;
		const actor = c.var.actor;
		const res = c.var.nodeRes!;
		if (!requireActiveActor(res, actor)) return c.body(null);
		const docId = c.req.param("docId");
		const meta = store.spaces.getDocumentMeta(docId);
		if (!meta) {
			throw new HttpRequestError(404, "资料不存在");
		}
		const space = store.spaces.getSpace(meta.spaceId);
		if (!canAccessSpace(store, actor, space) || !canActorReadSpaceDoc(store, actor, meta)) {
			throw new HttpRequestError(403, "无权访问该资料");
		}
		const commits = await store.spaces.listDocumentCommits(docId);
		return c.json({ commits });
	});

	app.post("/api/spaces/documents/:docId/promote", async (c) => {
		const { store, broadcast } = c.var.routeCtx;
		const actor = c.var.actor;
		const res = c.var.nodeRes!;
		if (!requireActiveActor(res, actor)) return c.body(null);
		const docId = c.req.param("docId");
		const meta = store.spaces.getDocumentMeta(docId);
		if (!meta) {
			throw new HttpRequestError(404, "资料不存在");
		}
		const space = store.spaces.getSpace(meta.spaceId);
		if (!space || !canWriteSpace(store, actor, space) || !canActorReadSpaceDoc(store, actor, meta)) {
			throw new HttpRequestError(403, "无权编辑该资料");
		}
		const actorId = actor.user?.id ?? actor.collaborator.id;
		const actorName = actor.user?.displayName ?? actor.collaborator.name;
		const promoted = await store.spaces.promoteDocumentToFolder(docId, { actorId, actorName });
		if (!promoted) {
			throw new HttpRequestError(404, "资料不存在");
		}
		const listed = await store.spaces.listDocumentFiles(docId);
		broadcast("space_page_updated", { spaceId: space.id, documentId: promoted.id, matterId: promoted.matterId });
		return c.json({
			document: promoted,
			files: listed?.files ?? [],
			previewEntryPath: listed?.previewEntryPath ?? null,
		});
	});

	app.get("/api/spaces/documents/:docId/preview/*", async (c) => {
		const { store } = c.var.routeCtx;
		const actor = c.var.actor;
		const res = c.var.nodeRes!;
		if (!requireActiveActor(res, actor)) return c.body(null);
		const docId = c.req.param("docId");
		const rawRest = c.req.path.replace(/^\/api\/spaces\/documents\/[^/]+\/preview\//, "");
		const rawSubPath = decodeURIComponent(rawRest || "index.html");
		const meta = store.spaces.getDocumentMeta(docId);
		if (!meta || meta.entryKind !== "folder") {
			throw new HttpRequestError(404, "目录条目不存在");
		}
		const space = store.spaces.getSpace(meta.spaceId);
		if (!space || !canAccessSpace(store, actor, space) || !canActorReadSpaceDoc(store, actor, meta)) {
			throw new HttpRequestError(403, "无权访问该空间预览");
		}
		try {
			const buf = await store.spaces.readDocumentFileRaw(docId, rawSubPath);
			if (!buf) {
				throw new HttpRequestError(404, "预览文件不存在");
			}
			const ext = extname(rawSubPath).toLowerCase();
			const mime = PREVIEW_MIME_BY_EXT[ext] ?? "application/octet-stream";
			return new Response(new Uint8Array(buf), {
				status: 200,
				headers: {
					"Content-Type": mime,
					"Content-Security-Policy":
						"sandbox allow-scripts; default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'",
					"X-Content-Type-Options": "nosniff",
					"Cache-Control": "no-store",
				},
			});
		} catch (error) {
			if (error instanceof HttpRequestError) throw error;
			throw new HttpRequestError(400, error instanceof Error ? error.message : "非法预览路径");
		}
	});

	app.get("/api/spaces/documents/:docId/files", async (c) => {
		const { store } = c.var.routeCtx;
		const actor = c.var.actor;
		const res = c.var.nodeRes!;
		if (!requireActiveActor(res, actor)) return c.body(null);
		const docId = c.req.param("docId");
		const meta = store.spaces.getDocumentMeta(docId);
		if (!meta) {
			throw new HttpRequestError(404, "资料不存在");
		}
		const space = store.spaces.getSpace(meta.spaceId);
		if (!space || !canAccessSpace(store, actor, space) || !canActorReadSpaceDoc(store, actor, meta)) {
			throw new HttpRequestError(403, "无权访问该资料");
		}
		const subPath = c.req.query("path");
		if (subPath) {
			try {
				const content = await store.spaces.readDocumentFile(docId, subPath);
				if (content === null) {
					throw new HttpRequestError(404, "子文件不存在");
				}
				return c.json({ path: subPath, content });
			} catch (error) {
				if (error instanceof HttpRequestError) throw error;
				throw new HttpRequestError(400, error instanceof Error ? error.message : "非法文件路径");
			}
		}
		const listed = await store.spaces.listDocumentFiles(docId);
		return c.json({
			files: listed?.files ?? [],
			previewEntryPath: listed?.previewEntryPath ?? null,
		});
	});

	app.put("/api/spaces/documents/:docId/files", async (c) => {
		const { store, broadcast } = c.var.routeCtx;
		const actor = c.var.actor;
		const res = c.var.nodeRes!;
		if (!requireActiveActor(res, actor)) return c.body(null);
		const docId = c.req.param("docId");
		const meta = store.spaces.getDocumentMeta(docId);
		if (!meta) {
			throw new HttpRequestError(404, "资料不存在");
		}
		const space = store.spaces.getSpace(meta.spaceId);
		if (!space || !canAccessSpace(store, actor, space) || !canActorReadSpaceDoc(store, actor, meta)) {
			throw new HttpRequestError(403, "无权访问该资料");
		}
		if (!canWriteSpace(store, actor, space)) {
			throw new HttpRequestError(403, "无权编辑该资料");
		}
		const body = await parseJsonBody(c);
		const commitMessage = typeof body.commitMessage === "string" ? body.commitMessage.trim() : undefined;
		const batchFiles: Array<{ subPath: string; content: string }> = [];
		if (Array.isArray(body.files)) {
			for (const item of body.files) {
				if (!item || typeof item !== "object") continue;
				const p =
					typeof (item as { path?: unknown }).path === "string" ? (item as { path: string }).path.trim() : "";
				const contentText =
					typeof (item as { content?: unknown }).content === "string"
						? (item as { content: string }).content
						: null;
				if (!p || contentText === null || contentText.length > 512_000) {
					throw new HttpRequestError(400, "每个子文件都需提供有效路径与正文（最多 512000 字）");
				}
				batchFiles.push({ subPath: p, content: contentText });
			}
		} else {
			const subPath = typeof body.path === "string" ? body.path.trim() : "";
			const content = typeof body.content === "string" ? body.content : null;
			if (!subPath || content === null || content.length > 512_000) {
				throw new HttpRequestError(400, "请提供子文件路径与正文（最多 512000 字）");
			}
			batchFiles.push({ subPath, content });
		}
		if (batchFiles.length === 0) {
			throw new HttpRequestError(400, "请至少提供一个子文件");
		}
		const actorId = actor.user?.id ?? actor.collaborator.id;
		const actorName = actor.user?.displayName ?? actor.collaborator.name;
		try {
			const result = await store.spaces.writeDocumentFiles(docId, {
				files: batchFiles,
				actorId,
				actorName,
				commitMessage,
			});
			if (!result) {
				throw new HttpRequestError(404, "资料不存在");
			}
			broadcast("space_page_updated", {
				spaceId: space.id,
				documentId: result.document.id,
				matterId: result.document.matterId,
			});
			return c.json(result);
		} catch (error) {
			if (error instanceof HttpRequestError) throw error;
			throw new HttpRequestError(400, error instanceof Error ? error.message : "写入子文件失败");
		}
	});

	app.delete("/api/spaces/documents/:docId/files", async (c) => {
		const { store, broadcast } = c.var.routeCtx;
		const actor = c.var.actor;
		const res = c.var.nodeRes!;
		if (!requireActiveActor(res, actor)) return c.body(null);
		const docId = c.req.param("docId");
		const meta = store.spaces.getDocumentMeta(docId);
		if (!meta) {
			throw new HttpRequestError(404, "资料不存在");
		}
		const space = store.spaces.getSpace(meta.spaceId);
		if (!space || !canAccessSpace(store, actor, space) || !canActorReadSpaceDoc(store, actor, meta)) {
			throw new HttpRequestError(403, "无权访问该资料");
		}
		if (!canWriteSpace(store, actor, space)) {
			throw new HttpRequestError(403, "无权编辑该资料");
		}
		const subPath = c.req.query("path")?.trim() ?? "";
		if (!subPath) {
			throw new HttpRequestError(400, "请指定要删除的子文件路径");
		}
		const actorId = actor.user?.id ?? actor.collaborator.id;
		const actorName = actor.user?.displayName ?? actor.collaborator.name;
		try {
			const result = await store.spaces.deleteDocumentFile(docId, { subPath, actorId, actorName });
			if (!result) {
				throw new HttpRequestError(404, "资料或子文件不存在");
			}
			broadcast("space_page_updated", {
				spaceId: space.id,
				documentId: result.document.id,
				matterId: result.document.matterId,
			});
			return c.json(result);
		} catch (error) {
			if (error instanceof HttpRequestError) throw error;
			throw new HttpRequestError(400, error instanceof Error ? error.message : "删除子文件失败");
		}
	});

	app.get("/api/spaces/documents/:docId", async (c) => {
		const { store } = c.var.routeCtx;
		const actor = c.var.actor;
		const res = c.var.nodeRes!;
		if (!requireActiveActor(res, actor)) return c.body(null);
		const docId = c.req.param("docId");
		const meta = store.spaces.getDocumentMeta(docId);
		if (!meta) {
			throw new HttpRequestError(404, "资料不存在");
		}
		const space = store.spaces.getSpace(meta.spaceId);
		if (!space || !canAccessSpace(store, actor, space) || !canActorReadSpaceDoc(store, actor, meta)) {
			throw new HttpRequestError(403, "无权访问该资料");
		}
		const document = await store.spaces.getDocument(docId);
		const listed = document?.entryKind === "folder" ? await store.spaces.listDocumentFiles(docId) : null;
		return c.json({
			document,
			canWrite: canWriteSpace(store, actor, space),
			files: listed?.files ?? [],
			previewEntryPath: listed?.previewEntryPath ?? null,
		});
	});

	app.patch("/api/spaces/documents/:docId", async (c) => {
		const { store, broadcast } = c.var.routeCtx;
		const actor = c.var.actor;
		const res = c.var.nodeRes!;
		if (!requireActiveActor(res, actor)) return c.body(null);
		const docId = c.req.param("docId");
		const meta = store.spaces.getDocumentMeta(docId);
		if (!meta) {
			throw new HttpRequestError(404, "资料不存在");
		}
		const space = store.spaces.getSpace(meta.spaceId);
		if (!space || !canAccessSpace(store, actor, space) || !canActorReadSpaceDoc(store, actor, meta)) {
			throw new HttpRequestError(403, "无权访问该资料");
		}
		if (!canWriteSpace(store, actor, space)) {
			throw new HttpRequestError(403, "无权编辑该资料");
		}
		const body = await parseJsonBody(c);
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
			throw new HttpRequestError(400, "请提供标题和正文，标题最多 200 字，正文最多 512000 字");
		}
		const revision =
			Number.isSafeInteger(body.revision) && Number(body.revision) >= 1 ? Number(body.revision) : undefined;
		const expectedCommit = typeof body.expectedCommit === "string" ? body.expectedCommit.trim() : undefined;
		if (revision === undefined && expectedCommit === undefined) {
			throw new HttpRequestError(400, "请提供资料修订号或基线提交号");
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
			return c.json(
				{
					error: "资料已被修改，请重新加载后再保存",
					latest,
				},
				409,
			);
		}
		broadcast("space_page_updated", { spaceId: space.id, documentId: updated.id, matterId: updated.matterId });
		return c.json({ document: updated });
	});
}
