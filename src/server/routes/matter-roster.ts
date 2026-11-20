import type { ServerResponse } from "node:http";
import { ROLE_ARCHITECT_MEMBER_ID } from "../../roles/role-architect.ts";
import type { Matter, MatterMessage } from "../../storage/types.ts";
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

export function canTargetMatterAi(
	ctx: ServerRouteContext,
	actor: RequestActor,
	orgId: string | null,
	memberId: string,
): boolean {
	const member = ctx.store.getMember(memberId);
	return Boolean(
		member &&
			canActorUseMember(ctx.store, actor, member) &&
			(!orgId ||
				memberId === ROLE_ARCHITECT_MEMBER_ID ||
				ctx.store.resolveEffectiveOrgMembersForUser(orgId, actor.user?.id).some(({ id }) => id === memberId)),
	);
}

/** Answer explicit roster lookups from current settings instead of asking the model to infer them from chat. */
export function replyWithCurrentMatterRoster(
	ctx: ServerRouteContext,
	matter: Matter,
	question: MatterMessage,
): boolean {
	const wording = question.content
		.trim()
		.replace(/[？?。！!]$/, "")
		.trim();
	const isChinese =
		/^(?:(?:现在|当前|目前)(?:(?:这个|本)?事项)?|(?:这个|本)事项)(?:里|中)?的?(?:AI)?(?:成员(?:呢|有哪些|是谁)?|有哪些(?:AI)?(?:成员|角色)|有谁(?:在组)?)$/iu.test(
			wording.replace(/\s+/g, ""),
		);
	const isEnglish =
		/^(?:who (?:is|are) (?:on|in) (?:the|this) (?:current )?team|(?:show |list )?(?:the )?current (?:matter|team) (?:members|roster))$/i.test(
			wording,
		);
	if (!isChinese && !isEnglish) return false;

	const members = ctx.orchestrator.listSharedMatterAiMembers(matter);
	const labels = isChinese
		? { title: "当前事项的共享 AI 成员", lead: "负责人", consult: "可请教", observer: "旁听", member: "在组" }
		: {
				title: "Shared AI members in this matter",
				lead: "Lead",
				consult: "Consultable",
				observer: "Observer",
				member: "In group",
			};
	const lines = members.map((member) => {
		const name = member.displayName.replace(/\s+/g, " ").replace(/[\\`*_[\]<>]/g, "\\$&");
		const isLead = member.id === matter.leadMemberId;
		const consult = !isLead && (matter.consultMemberIds == null || matter.consultMemberIds.includes(member.id));
		const observes = matter.observersEnabled && matter.observerMemberIds.includes(member.id);
		const roles = [isLead && labels.lead, consult && labels.consult, observes && labels.observer].filter(Boolean);
		return `- ${name} · ${roles.join(" / ") || labels.member}`;
	});
	const message = ctx.store.appendMessage({
		matterId: matter.id,
		channel: "user",
		senderType: "system",
		senderId: "orchestrator",
		content: [`**${labels.title} · ${members.length}**`, ...lines].join("\n"),
		metadata: {
			matterRosterSnapshot: true,
			sourceUserMessageId: question.id,
			workspaceId: question.metadata?.workspaceId ?? null,
			repoPath: question.metadata?.repoPath,
		},
	});
	ctx.broadcast("matter_message", { matterId: matter.id, message }, { matterId: matter.id });
	return true;
}
