import type { PersonalAgentStore } from "../storage/repositories.ts";
import type { Matter, MatterMessage, TeamMember } from "../storage/types.ts";

export function looksLikeRosterQuestion(content: string): boolean {
	const wording = content
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
	return isChinese || isEnglish;
}

export function recordRosterReply(
	store: PersonalAgentStore,
	matter: Matter,
	question: MatterMessage,
	members: TeamMember[],
): MatterMessage {
	const labels = /\p{Script=Han}/u.test(question.content)
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
	return store.appendMessage({
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
}
