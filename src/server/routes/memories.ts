import { DistillationMemberAccessError } from "../../orchestrator/distiller.ts";
import type { PersonalAgentStore } from "../../storage/repositories.ts";
import { normalizeMemoryCategory } from "../../storage/repositories.ts";
import type { FeedbackRating, MemoryCategory, MemoryScope, MemoryStatus, TeamMember } from "../../storage/types.ts";
import {
	canAccessMatter,
	canAccessOrganization,
	canAccessSpace,
	canAccessWorkspace,
	canActorAccessMemory,
	canActorManageMember,
	canActorUseMember,
	canDistillMatter,
	canManageOrganization,
	isGlobalUnscopedActor,
} from "../acl.ts";
import { isSuperAdminActor, type RequestActor, requireActiveActor } from "../auth.ts";
import { HttpRequestError, readJsonBody, responseCancellation, sendError, sendJson } from "../http.ts";
import { broadcastMemoryUpdates, MEMORY_CATEGORIES, type RouteRequest, type ServerRouteContext } from "./context.ts";

function canActorManageMemoryEntry(
	store: PersonalAgentStore,
	actor: RequestActor,
	input: {
		member: Pick<TeamMember, "roleScope" | "ownerOrgId" | "ownerUserId"> | null | undefined;
		scope: MemoryScope;
		orgId?: string | null;
		workspaceId?: string | null;
	},
): boolean {
	if (isGlobalUnscopedActor(actor) || isSuperAdminActor(actor)) return true;
	if (!input.member) return false;
	if (input.member.roleScope === "personal") {
		return canActorManageMember(store, actor, input.member);
	}
	if (input.scope === "role_general") {
		return (
			input.member.roleScope === "org" &&
			Boolean(input.member.ownerOrgId && canManageOrganization(store, actor, input.member.ownerOrgId))
		);
	}
	if (input.scope === "company_private") {
		return Boolean(input.orgId && canManageOrganization(store, actor, input.orgId));
	}
	const ws = input.workspaceId ? store.getWorkspace(input.workspaceId) : null;
	return Boolean(ws?.orgId && canManageOrganization(store, actor, ws.orgId));
}

/** Handle experience curation, provenance, and distillation. */
export async function handleMemoryRoutes(ctx: ServerRouteContext, r: RouteRequest): Promise<boolean> {
	const { store, orchestrator, broadcast } = ctx;
	const { req, res, method, pathname, actor } = r;

	if (method === "POST" && pathname === "/api/memories") {
		if (!requireActiveActor(res, actor)) return true;
		const body = await readJsonBody(req);
		const memberId = typeof body.memberId === "string" ? body.memberId.trim() : "";
		const content = typeof body.content === "string" ? body.content.trim() : "";
		const scope = (typeof body.scope === "string" ? body.scope : "role_general") as MemoryScope;
		if (!memberId || !content) {
			sendError(res, 400, "memberId and content are required");
			return true;
		}
		const targetMember = store.getMember(memberId);
		if (!targetMember) {
			sendError(res, 404, `Member not found: ${memberId}`);
			return true;
		}
		if (scope !== "role_general" && scope !== "company_private" && scope !== "project_private") {
			sendError(res, 400, `Unsupported memory scope: ${scope}`);
			return true;
		}
		const category =
			body.category === undefined
				? "general"
				: typeof body.category === "string" && MEMORY_CATEGORIES.has(body.category as MemoryCategory)
					? normalizeMemoryCategory(body.category)
					: null;
		if (!category) {
			sendError(res, 400, `Unsupported memory category: ${String(body.category)}`);
			return true;
		}
		const orgId =
			scope === "company_private" && typeof body.orgId === "string" && body.orgId.trim() ? body.orgId.trim() : null;
		if (orgId && !store.getOrganization(orgId)) {
			sendError(res, 404, `Organization not found: ${orgId}`);
			return true;
		}
		const workspaceId =
			scope === "role_general" || orgId
				? null
				: typeof body.workspaceId === "string" && body.workspaceId
					? body.workspaceId
					: null;
		if (workspaceId && !store.getWorkspace(workspaceId)) {
			sendError(res, 404, `Workspace not found: ${workspaceId}`);
			return true;
		}
		if (
			(orgId && !canAccessOrganization(store, actor, orgId)) ||
			(workspaceId && !canAccessWorkspace(store, actor, store.getWorkspace(workspaceId))) ||
			!canActorManageMemoryEntry(store, actor, { member: targetMember, scope, orgId, workspaceId })
		) {
			sendError(res, 403, "仅所有者或对应组织管理员可为该范围沉淀经验");
			return true;
		}
		const rawStatus = body.status;
		const status: MemoryStatus =
			rawStatus === "candidate" || rawStatus === "verified" || rawStatus === "rejected" || rawStatus === "superseded"
				? rawStatus
				: body.verified === false
					? "candidate"
					: "verified";
		const memory = store.addMemory({
			memberId,
			scope,
			category,
			orgId,
			workspaceId,
			content,
			rationale: typeof body.rationale === "string" ? body.rationale.trim() : "",
			sourceMatterId: typeof body.sourceMatterId === "string" && body.sourceMatterId ? body.sourceMatterId : null,
			sourceDeliverableId:
				typeof body.sourceDeliverableId === "string" && body.sourceDeliverableId ? body.sourceDeliverableId : null,
			status,
			verified: status === "verified",
			supersedesMemoryId:
				typeof body.supersedesMemoryId === "string" && body.supersedesMemoryId ? body.supersedesMemoryId : null,
		});
		broadcastMemoryUpdates(broadcast, [memory]);
		sendJson(res, 201, { memory });
		return true;
	}

	const memoryAppsMatch = pathname.match(/^\/api\/memories\/([^/]+)\/applications$/);
	if (method === "GET" && memoryAppsMatch) {
		if (!requireActiveActor(res, actor)) return true;
		const memoryId = decodeURIComponent(memoryAppsMatch[1]!);
		const memory = store.getMemory(memoryId);
		if (!memory) {
			sendError(res, 404, `Memory not found: ${memoryId}`);
			return true;
		}
		if (!canActorAccessMemory(store, actor, memory)) {
			sendError(res, 403, "无权查看该经验的使用溯源");
			return true;
		}
		const apps = store.listMemoryApplications(memoryId).filter((app) => {
			const matter = store.getMatter(app.matterId);
			return Boolean(matter && canAccessMatter(store, actor, matter));
		});
		sendJson(res, 200, { memory, applications: apps });
		return true;
	}

	const memoryEvalMatch = pathname.match(/^\/api\/memories\/([^/]+)\/evaluate$/);
	if (method === "POST" && memoryEvalMatch) {
		if (!requireActiveActor(res, actor)) return true;
		const memoryId = decodeURIComponent(memoryEvalMatch[1]!);
		const existing = store.getMemory(memoryId);
		if (!existing) {
			sendError(res, 404, `Memory not found: ${memoryId}`);
			return true;
		}
		const existingMember = store.getMember(existing.memberId);
		if (
			!canActorAccessMemory(store, actor, existing) ||
			!canActorManageMemoryEntry(store, actor, {
				member: existingMember,
				scope: existing.scope,
				orgId: existing.orgId,
				workspaceId: existing.workspaceId,
			})
		) {
			sendError(res, 403, "无权评价该经验");
			return true;
		}
		const body = await readJsonBody(req);
		if (body.outcome !== "positive" && body.outcome !== "negative") {
			sendError(res, 400, "outcome must be positive or negative");
			return true;
		}
		const memory = store.evaluateMemory({
			memoryId,
			outcome: body.outcome === "positive" ? "feedback_positive" : "feedback_negative",
			matterId: typeof body.matterId === "string" && body.matterId ? body.matterId : existing.sourceMatterId,
			memberId: existing.memberId,
			note: typeof body.note === "string" ? body.note.trim() : "",
		});
		broadcastMemoryUpdates(broadcast, [memory]);
		sendJson(res, 200, { memory });
		return true;
	}

	const memoryPatchMatch = pathname.match(/^\/api\/memories\/([^/]+)$/);
	if (method === "PATCH" && memoryPatchMatch) {
		if (!requireActiveActor(res, actor)) return true;
		const memoryId = decodeURIComponent(memoryPatchMatch[1]!);
		const existing = store.getMemory(memoryId);
		if (!existing) {
			sendError(res, 404, `Memory not found: ${memoryId}`);
			return true;
		}
		const existingMember = store.getMember(existing.memberId);
		if (
			!canActorAccessMemory(store, actor, existing) ||
			!canActorManageMemoryEntry(store, actor, {
				member: existingMember,
				scope: existing.scope,
				orgId: existing.orgId,
				workspaceId: existing.workspaceId,
			})
		) {
			sendError(res, 403, "无权修改该经验");
			return true;
		}
		const body = await readJsonBody(req);
		const memberId = typeof body.memberId === "string" && body.memberId.trim() ? body.memberId.trim() : undefined;
		if (memberId && !store.getMember(memberId)) {
			sendError(res, 404, `Member not found: ${memberId}`);
			return true;
		}
		const scope = typeof body.scope === "string" ? (body.scope as MemoryScope) : undefined;
		if (scope && scope !== "role_general" && scope !== "company_private" && scope !== "project_private") {
			sendError(res, 400, `Unsupported memory scope: ${scope}`);
			return true;
		}
		const category =
			body.category === undefined
				? undefined
				: typeof body.category === "string" && MEMORY_CATEGORIES.has(body.category as MemoryCategory)
					? (body.category as MemoryCategory)
					: null;
		if (category === null) {
			sendError(res, 400, `Unsupported memory category: ${String(body.category)}`);
			return true;
		}
		const orgId =
			body.orgId === null
				? null
				: typeof body.orgId === "string" && body.orgId.trim()
					? body.orgId.trim()
					: undefined;
		if (orgId && !store.getOrganization(orgId)) {
			sendError(res, 404, `Organization not found: ${orgId}`);
			return true;
		}
		const workspaceId =
			body.workspaceId === null
				? null
				: typeof body.workspaceId === "string" && body.workspaceId
					? body.workspaceId
					: undefined;
		if (workspaceId && !store.getWorkspace(workspaceId)) {
			sendError(res, 404, `Workspace not found: ${workspaceId}`);
			return true;
		}
		const nextMemberId = memberId ?? existing.memberId;
		const nextScope = scope ?? existing.scope;
		const nextOrgId = orgId === undefined ? existing.orgId : orgId;
		const nextWorkspaceId = workspaceId === undefined ? existing.workspaceId : workspaceId;
		const nextMember = store.getMember(nextMemberId);
		if (
			!canActorAccessMemory(store, actor, {
				memberId: nextMemberId,
				scope: nextScope,
				orgId: nextOrgId,
				workspaceId: nextWorkspaceId,
			}) ||
			!canActorManageMemoryEntry(store, actor, {
				member: nextMember,
				scope: nextScope,
				orgId: nextOrgId,
				workspaceId: nextWorkspaceId,
			})
		) {
			sendError(res, 403, "无权将经验移至该角色或作用域");
			return true;
		}
		const status = typeof body.status === "string" ? (body.status as MemoryStatus) : undefined;
		if (
			status &&
			status !== "candidate" &&
			status !== "verified" &&
			status !== "rejected" &&
			status !== "superseded"
		) {
			sendError(res, 400, `Unsupported memory status: ${status}`);
			return true;
		}
		const memory = store.updateMemory(memoryId, {
			memberId,
			content: typeof body.content === "string" ? body.content : undefined,
			scope,
			category,
			orgId,
			workspaceId,
			status,
			rationale: typeof body.rationale === "string" ? body.rationale : undefined,
			supersedesMemoryId:
				body.supersedesMemoryId === null
					? null
					: typeof body.supersedesMemoryId === "string"
						? body.supersedesMemoryId
						: undefined,
		});
		if (
			existing.memberId !== memory.memberId ||
			existing.scope !== memory.scope ||
			existing.orgId !== memory.orgId ||
			existing.workspaceId !== memory.workspaceId
		) {
			broadcast("memory_updated", {}, { memory: existing });
		}
		broadcastMemoryUpdates(broadcast, [memory]);
		sendJson(res, 200, { memory });
		return true;
	}

	if (method === "POST" && pathname === "/api/rsi/distill/abort") {
		if (!requireActiveActor(res, actor)) return true;
		const body = await readJsonBody(req);
		const matterId = typeof body.matterId === "string" ? body.matterId.trim() : "";
		if (!matterId) {
			sendError(res, 400, "matterId is required");
			return true;
		}
		const matter = store.getMatter(matterId);
		if (!matter) {
			sendError(res, 404, `Matter not found: ${matterId}`);
			return true;
		}
		if (!canDistillMatter(store, actor, matter)) {
			sendError(res, 403, "仅所有者或对应组织管理员可中止该事项经验复盘");
			return true;
		}
		const aborted = orchestrator.abortDistillation(matterId);
		sendJson(res, 200, { ok: true, aborted });
		return true;
	}

	if (method === "POST" && pathname === "/api/rsi/distill") {
		if (!requireActiveActor(res, actor)) return true;
		const body = await readJsonBody(req);
		const matterId = typeof body.matterId === "string" ? body.matterId.trim() : "";
		if (!matterId) {
			sendError(res, 400, "matterId is required");
			return true;
		}
		const matter = store.getMatter(matterId);
		if (!matter) {
			sendError(res, 404, `Matter not found: ${matterId}`);
			return true;
		}
		if (!canDistillMatter(store, actor, matter)) {
			sendError(res, 403, "仅所有者或对应组织管理员可在该事项触发团队经验复盘");
			return true;
		}
		const memberId = typeof body.memberId === "string" && body.memberId.trim() ? body.memberId.trim() : undefined;
		const feedback = typeof body.feedback === "string" && body.feedback.trim() ? body.feedback.trim() : undefined;
		const rating: FeedbackRating | undefined =
			body.rating === "positive" || body.rating === "negative" || body.rating === "neutral"
				? body.rating
				: undefined;
		const scopeMode = body.scopeMode === "single" || body.scopeMode === "team" ? body.scopeMode : undefined;
		const cancellation = responseCancellation(res);
		try {
			const result = await orchestrator.distillExperiences({
				matterId,
				memberId,
				feedback,
				rating,
				scopeMode,
				signal: cancellation.signal,
				canReviewMember: (member) => canActorUseMember(store, actor, member),
				canReadSpace: (spaceId) => canAccessSpace(store, actor, store.spaces.getSpace(spaceId)),
			});
			broadcastMemoryUpdates(broadcast, result.createdMemories);
			sendJson(res, 200, {
				ok: true,
				...result,
				createdMemories: result.createdMemories.filter((memory) => canActorAccessMemory(store, actor, memory)),
			});
		} catch (err) {
			if (err instanceof DistillationMemberAccessError) throw new HttpRequestError(403, err.message);
			if (
				cancellation.signal.aborted ||
				(err instanceof Error && err.message === "Experience distillation was aborted")
			) {
				if (!res.writableEnded && !res.destroyed) {
					sendJson(res, 200, {
						ok: false,
						aborted: true,
						createdMemories: [],
						skippedDuplicates: 0,
						summary: "已取消 AI 经验复盘",
					});
				}
				return true;
			}
			throw err;
		} finally {
			cancellation.dispose();
		}
		return true;
	}

	return false;
}
