import { existsSync } from "node:fs";
import { isArchitectRoleTemplate } from "../../roles/role-architect.ts";
import type { RoleTemplate } from "../../roles/types.ts";
import type { PersonalAgentStore } from "../../storage/repositories.ts";
import { buildSessionInsightsReport, type SessionInsightSource } from "../runtime/session-insights.ts";

export interface TeamHealthEvidence {
	id: string;
	kind: "role" | "message" | "feedback" | "insight" | "skill_trust";
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

/**
 * Bounded source records, separate from the model's interpretation of their cause or importance.
 * Feeds static role definitions, recent matter friction, negative space feedback, deterministic
 * Pi session-insights findings, and Four-Step Trust skill telemetry into Role Architect / RSI healthchecks.
 */
export function collectTeamHealthEvidence(
	store: PersonalAgentStore,
	templates: Map<string, RoleTemplate>,
	scope?: TeamHealthScopeFilter,
): TeamHealthEvidence[] {
	const sources: TeamHealthEvidence[] = [];
	const members = filterTeamMembersForScope(store.listMembers(), scope).filter(
		(member) => !isArchitectRoleTemplate(templates.get(member.templateId) ?? { id: member.id }),
	);
	const memberIds = new Set(members.map((member) => member.id));
	const memberNameById = new Map(members.map((member) => [member.id, member.displayName]));

	const scopedMatters = store.listMatters().filter((matter) => {
		if (matter.visibility === "private") return false;
		if (matter.workspaceId) {
			const ws = store.getWorkspace(matter.workspaceId);
			if (!ws || ws.visibility === "restricted") return false;
		}
		if (!scope) return true;
		if (scope.orgId) return matter.orgId === scope.orgId;
		if (scope.allowedOrgIds) return !matter.orgId || scope.allowedOrgIds.has(matter.orgId);
		return true;
	});
	const scopedMatterIds = new Set(scopedMatters.map((matter) => matter.id));

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

	// Deterministic Pi session-insights findings (zero LLM calls, strictly scoped to visible matters & members).
	const seenSessionFiles = new Set<string>();
	const insightSources: SessionInsightSource[] = [];
	for (const session of store.listWorkerSessions({ limit: 24 })) {
		if (!session.sessionFile || seenSessionFiles.has(session.sessionFile)) continue;
		if (!scopedMatterIds.has(session.matterId) || !memberIds.has(session.memberId)) continue;
		if (!existsSync(session.sessionFile)) continue;
		seenSessionFiles.add(session.sessionFile);
		insightSources.push({
			sessionFile: session.sessionFile,
			sessionId: session.piSessionId ?? session.id,
			matterId: session.matterId,
			memberId: session.memberId,
			memberName: memberNameById.get(session.memberId) ?? session.memberId,
			updatedAt: session.lastActiveAt,
		});
	}
	if (insightSources.length > 0) {
		const report = buildSessionInsightsReport(insightSources);
		for (const finding of report.findings.slice(0, 6)) {
			sources.push({
				id: `insight:${finding.kind}:${finding.id}`,
				kind: "insight",
				sourceId: finding.id,
				label: `[Pi 洞察 · ${finding.severity}] ${finding.title}`,
				excerpt:
					`${finding.detail}${finding.suggestSkillCapture ? "；建议通过 propose_skill 沉淀为可复用 Skill/脚本" : ""}`.slice(
						0,
						360,
					),
			});
		}
	}

	// Four-Step Trust skill telemetry (surfaces disabled skills & high-frequency confirm skills ready for Step 4).
	const visiblePolicies = store.skillTrust.listPolicies().filter((policy) => {
		if (!scope) return true;
		if (policy.scope === "global") return true;
		if (policy.scope === "personal") {
			return Boolean(scope.actorUserId && policy.scopeId === scope.actorUserId);
		}
		if (policy.scope === "org") {
			if (scope.orgId) return policy.scopeId === scope.orgId;
			if (scope.allowedOrgIds) return scope.allowedOrgIds.has(policy.scopeId);
			return true;
		}
		if (policy.scope === "workspace") {
			const ws = store.getWorkspace(policy.scopeId);
			if (!ws || ws.visibility === "restricted") return false;
			if (scope.orgId) return ws.orgId === scope.orgId;
			if (scope.allowedOrgIds) return !ws.orgId || scope.allowedOrgIds.has(ws.orgId);
			return true;
		}
		return false;
	});
	for (const policy of visiblePolicies.slice(0, 6)) {
		const readinessHint =
			policy.trustLevel === "confirm" && policy.runCount >= 2
				? "；高频确认稳定，可评估升级步骤 4 自主执行"
				: policy.trustLevel === "disabled"
					? "；当前已停用，需核查是否应修复或移除引用"
					: "";
		sources.push({
			id: `skill_trust:${policy.scope}:${policy.scopeId}:${policy.skillName}`,
			kind: "skill_trust",
			sourceId: policy.skillName,
			label: `Skill「${policy.skillName}」(${policy.scope} · ${policy.trustLevel})`,
			excerpt: `脚本累计运行 ${policy.runCount} 次，最近结果 ${policy.lastOutcome ?? "无"}${readinessHint}`,
		});
	}

	return sources.slice(0, 48);
}

export function formatTeamHealthEvidence(sources: TeamHealthEvidence[]): string {
	return sources
		.map((source) => `- [${source.id}] ${source.label}：${source.excerpt.replace(/\s+/g, " ")}`)
		.join("\n");
}
