import { isArchitectRoleTemplate } from "../../roles/role-architect.ts";
import type { RoleTemplate } from "../../roles/types.ts";
import type { PersonalAgentStore } from "../../storage/repositories.ts";

export interface TeamHealthEvidence {
	id: string;
	kind: "role" | "message" | "feedback";
	sourceId: string;
	matterId?: string;
	label: string;
	excerpt: string;
}

export interface TeamHealthScopeFilter {
	allowedMemberIds?: Set<string>;
	orgId?: string | null;
	allowedOrgIds?: Set<string>;
	actorUserId?: string | null;
}

export function filterTeamMembersForScope<
	T extends { id: string; roleScope?: string; ownerOrgId?: string | null; ownerUserId?: string | null },
>(members: T[], scope?: TeamHealthScopeFilter): T[] {
	if (!scope) return members;
	return members.filter((member) => {
		if (scope.allowedMemberIds && !scope.allowedMemberIds.has(member.id)) return false;
		const roleScope = member.roleScope ?? (member.ownerUserId ? "personal" : member.ownerOrgId ? "org" : "global");
		if (roleScope === "personal") {
			return Boolean(scope.actorUserId && member.ownerUserId === scope.actorUserId);
		}
		if (roleScope === "org") {
			if (scope.orgId) return member.ownerOrgId === scope.orgId;
			if (scope.allowedOrgIds) return Boolean(member.ownerOrgId && scope.allowedOrgIds.has(member.ownerOrgId));
		}
		return true;
	});
}

/** Team health has no per-workspace ACL, so only include organization-visible material. */
export function collectTeamHealthFeedback(store: PersonalAgentStore, scope?: TeamHealthScopeFilter) {
	return store.spaces.listDocuments({}).flatMap((document) => {
		const matter = document.matterId ? store.getMatter(document.matterId) : null;
		const space = store.spaces.getSpace(document.spaceId);
		if (!matter || matter.visibility === "private" || !space || !["org", "workspace"].includes(space.kind)) return [];
		if (scope?.orgId && matter.orgId !== scope.orgId) return [];
		if (scope?.allowedOrgIds && (!matter.orgId || !scope.allowedOrgIds.has(matter.orgId))) return [];
		const workspace = matter.workspaceId ? store.getWorkspace(matter.workspaceId) : null;
		if (matter.workspaceId && (!workspace || workspace.visibility === "restricted")) return [];
		if (document.linkedWorkspaceId && document.linkedWorkspaceId !== matter.workspaceId) return [];
		if (space.orgId !== matter.orgId || (space.kind === "workspace" && space.workspaceId !== matter.workspaceId))
			return [];
		return store.spaces
			.listDocumentFeedback(document.id)
			.filter((feedback) => feedback.rating === "negative")
			.map((feedback) => ({ document, feedback }));
	});
}

/** Bounded source records, separate from the model's interpretation of their cause or importance. */
export function collectTeamHealthEvidence(
	store: PersonalAgentStore,
	templates: Map<string, RoleTemplate>,
	scope?: TeamHealthScopeFilter,
): TeamHealthEvidence[] {
	const sources: TeamHealthEvidence[] = [];
	const members = filterTeamMembersForScope(store.listMembers(), scope).filter(
		(member) => !isArchitectRoleTemplate(templates.get(member.templateId) ?? { id: member.id }),
	);
	const scopedMatters = store.listMatters().filter((matter) => {
		if (!scope) return true;
		if (scope.orgId) return matter.orgId === scope.orgId;
		if (scope.allowedOrgIds) return !matter.orgId || scope.allowedOrgIds.has(matter.orgId);
		return true;
	});
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
	for (const matter of scopedMatters.slice(0, 8)) {
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
	for (const { document, feedback } of collectTeamHealthFeedback(store, scope).slice(0, 4)) {
		sources.push({
			id: `feedback:${document.id}:${feedback.commitHash}:${feedback.actorId}`,
			kind: "feedback",
			sourceId: document.id,
			matterId: document.matterId ?? undefined,
			label: `${document.title} · ${feedback.commitHash.slice(0, 7)} 负反馈`,
			excerpt: (feedback.feedback || "记录了负反馈，缺少文字原因").slice(0, 360),
		});
	}
	return sources.slice(0, 40);
}

export function formatTeamHealthEvidence(sources: TeamHealthEvidence[]): string {
	return sources
		.map((source) => `- [${source.id}] ${source.label}：${source.excerpt.replace(/\s+/g, " ")}`)
		.join("\n");
}
