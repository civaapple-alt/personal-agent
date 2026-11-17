import { isArchitectRoleTemplate } from "../roles/role-architect.ts";
import type { RoleTemplate } from "../roles/types.ts";
import type { PersonalAgentStore } from "../storage/repositories.ts";

export interface TeamHealthEvidence {
	id: string;
	kind: "role" | "message" | "feedback" | "memory";
	sourceId: string;
	matterId?: string;
	label: string;
	excerpt: string;
}

/** Bounded source records, separate from the model's interpretation of their cause or importance. */
export function collectTeamHealthEvidence(
	store: PersonalAgentStore,
	templates: Map<string, RoleTemplate>,
): TeamHealthEvidence[] {
	const sources: TeamHealthEvidence[] = [];
	const members = store
		.listMembers()
		.filter((member) => !isArchitectRoleTemplate(templates.get(member.templateId) ?? { id: member.id }));
	for (const member of members.slice(0, 16)) {
		const role = templates.get(member.templateId);
		sources.push({
			id: `role:${member.id}`,
			kind: "role",
			sourceId: member.id,
			label: `${member.displayName} 当前配置`,
			excerpt: `工具 ${role?.tools.join(",") || "无"}；Skills ${role?.skills.join(",") || "无"}；${role?.sections.responsibilitiesAndBoundaries.slice(0, 260) ?? "定义缺失"}`,
		});
	}
	for (const matter of store.listMatters().slice(0, 8)) {
		const messages = store
			.listMessages(matter.id, "user")
			.filter(
				(message) =>
					message.metadata?.failed === true ||
					message.metadata?.aborted === true ||
					message.metadata?.observerIntervention === true ||
					message.senderType === "user",
			)
			.slice(-2);
		for (const message of messages)
			sources.push({
				id: `message:${message.id}`,
				kind: "message",
				sourceId: message.id,
				matterId: matter.id,
				label: `${matter.title} · ${message.createdAt}`,
				excerpt: message.content.slice(0, 360),
			});
	}
	for (const delivery of store
		.listDeliverables()
		.filter((item) => item.feedbackRating === "negative")
		.slice(0, 4)) {
		sources.push({
			id: `feedback:${delivery.id}`,
			kind: "feedback",
			sourceId: delivery.id,
			matterId: delivery.matterId,
			label: `${delivery.title} V${delivery.version} 负反馈`,
			excerpt: (delivery.feedback || "记录了负反馈，缺少文字原因").slice(0, 360),
		});
	}
	for (const member of members) {
		const corrections = store
			.listMemberMemories(member.id)
			.filter(
				(memory) =>
					memory.category === "user_correction" && memory.status !== "rejected" && memory.status !== "superseded",
			)
			.slice(0, 1);
		for (const memory of corrections)
			sources.push({
				id: `memory:${memory.id}`,
				kind: "memory",
				sourceId: memory.id,
				...(memory.sourceMatterId ? { matterId: memory.sourceMatterId } : {}),
				label: `${member.displayName} 纠偏经验（${memory.status}）`,
				excerpt: memory.content.slice(0, 300),
			});
	}
	return sources.slice(0, 40);
}

export function formatTeamHealthEvidence(sources: TeamHealthEvidence[]): string {
	return sources
		.map((source) => `- [${source.id}] ${source.label}：${source.excerpt.replace(/\s+/g, " ")}`)
		.join("\n");
}
