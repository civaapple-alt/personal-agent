import type { ServerResponse } from "node:http";
import { ROLE_ARCHITECT_MEMBER_ID } from "../../roles/role-architect.ts";
import { canActorUseMember } from "../acl.ts";
import type { RequestActor } from "../auth.ts";
import { sendError } from "../http.ts";
import type { ServerRouteContext } from "./context.ts";

export function ensureActorAllowedMembers(
	res: ServerResponse,
	ctx: ServerRouteContext,
	actor: RequestActor,
	memberIds: Array<string | null | undefined>,
): boolean {
	for (const memberId of memberIds) {
		if (!memberId) continue;
		const member = ctx.store.getMember(memberId);
		if (!member) {
			sendError(res, 404, `Member not found: ${memberId}`);
			return false;
		}
		if (!canActorUseMember(ctx.store, actor, member)) {
			sendError(res, 403, `无权使用或指定该 AI 角色: ${memberId}`);
			return false;
		}
	}
	return true;
}

export function ensureOrgEnabledAiRequest(
	res: ServerResponse,
	ctx: ServerRouteContext,
	actor: RequestActor,
	orgId: string | null,
	preferredMemberId: string | null | undefined,
	aiMemberIds: string[] | null | undefined,
): boolean {
	if (
		!ensureActorAllowedMembers(res, ctx, actor, [
			preferredMemberId,
			...(Array.isArray(aiMemberIds) ? aiMemberIds : []),
		])
	) {
		return false;
	}
	if (!orgId) return true;
	const allowed = new Set(ctx.store.resolveEffectiveOrgMembersForUser(orgId, actor.user?.id).map((m) => m.id));
	if (preferredMemberId && preferredMemberId !== ROLE_ARCHITECT_MEMBER_ID && !allowed.has(preferredMemberId)) {
		sendError(res, 403, `角色 ${preferredMemberId} 未在该组织中启用`);
		return false;
	}
	if (Array.isArray(aiMemberIds) && aiMemberIds.some((id) => id !== ROLE_ARCHITECT_MEMBER_ID && !allowed.has(id))) {
		sendError(res, 403, "包含未在该组织中启用的 AI 角色");
		return false;
	}
	return true;
}
