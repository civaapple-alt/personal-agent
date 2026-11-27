import { existsSync } from "node:fs";
import type { SessionInsightBoardSignals } from "@pa/contracts/session-insights";
import { isArchitectRoleTemplate, isSoloRoleTemplate } from "../../roles/role-architect.ts";
import type { RoleTemplate } from "../../roles/types.ts";
import type { PersonalAgentStore } from "../../storage/repositories.ts";
import type { Matter } from "../../storage/types.ts";
import {
	buildSessionInsightsReport,
	redactInsightText,
	type SessionInsightBoardSignalInput,
	type SessionInsightSource,
} from "../runtime/session-insights.ts";

export interface TeamHealthEvidence {
	id: string;
	kind: "role" | "message" | "feedback" | "insight" | "skill_trust" | "board_friction";
	sourceId: string;
	matterId?: string;
	label: string;
	excerpt: string;
}

export interface BoardFrictionCollection {
	evidence: TeamHealthEvidence[];
	boardInputs: SessionInsightBoardSignalInput[];
	summary: SessionInsightBoardSignals;
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
 * Deterministically collects board collaboration friction (`verify_rework`, `escalate`, `monitor_alert`)
 * strictly from pre-filtered ACL-visible matters and maps recurring patterns to the 4 CoE asset categories.
 */
export function collectBoardFrictionSignals(
	store: PersonalAgentStore,
	scopedMatters: Matter[],
): BoardFrictionCollection {
	const reworkItems: TeamHealthEvidence[] = [];
	const escalateItems: TeamHealthEvidence[] = [];
	const monitorItems: TeamHealthEvidence[] = [];
	const boardInputs: SessionInsightBoardSignalInput[] = [];

	let totalRework = 0;
	let totalEscalate = 0;
	let totalMonitorAlerts = 0;
	const mattersWithFriction = new Set<string>();
	const reworkTargets = new Map<string, number>();
	const stalledAgents = new Map<string, number>();
	const escalateAuthors = new Map<string, number>();

	for (const matter of scopedMatters.slice(0, 24)) {
		const reworkPosts: SessionInsightBoardSignalInput["reworkPosts"] = [];
		const escalatePosts: SessionInsightBoardSignalInput["escalatePosts"] = [];
		const monitorAlerts: SessionInsightBoardSignalInput["monitorAlerts"] = [];

		const posts = store.listBoardPostSummaries(matter.id, { order: "desc", limit: 100 });
		for (const post of posts) {
			if (post.kind !== "verify_rework" && post.kind !== "escalate") continue;
			if (post.workspaceId && post.workspaceId !== matter.workspaceId) {
				const postWs = store.getWorkspace(post.workspaceId);
				if (!postWs || postWs.visibility === "restricted") continue;
			}
			const cleanSummary = redactInsightText(post.summary).replace(/\s+/g, " ").trim();
			const mentionText = post.mentions.length > 0 ? post.mentions.map((m) => `@${m}`).join(",") : "无";

			if (post.kind === "verify_rework") {
				totalRework += 1;
				mattersWithFriction.add(matter.id);
				const target = post.verification?.target?.trim() || undefined;
				const criteria = post.verification?.criteria?.trim() || undefined;
				const authorAgentId = post.verification?.authorAgentId?.trim() || undefined;
				if (target) reworkTargets.set(target, (reworkTargets.get(target) ?? 0) + 1);
				reworkPosts.push({
					postNo: post.postNo,
					authorId: post.authorId,
					mentions: post.mentions,
					summary: cleanSummary,
					...(target ? { target } : {}),
					...(criteria ? { criteria } : {}),
					...(authorAgentId ? { authorAgentId } : {}),
				});
				if (reworkItems.length < 6) {
					const verParts = [
						target ? `target=${target}` : null,
						criteria ? `criteria=${redactInsightText(criteria)}` : null,
						authorAgentId ? `author=${authorAgentId}` : null,
					].filter(Boolean);
					const verText = verParts.length > 0 ? `；验收[${verParts.join(" | ")}]` : "";
					reworkItems.push({
						id: `board_friction:rework:${matter.id}:${post.postNo}`,
						kind: "board_friction",
						sourceId: post.id,
						matterId: matter.id,
						label: `[公告板返工] ${matter.title} · #${post.postNo} (${post.authorId})`,
						excerpt:
							`post#${post.postNo} by ${post.authorId} -> ${mentionText}${verText}；摘要：${cleanSummary}`.slice(
								0,
								360,
							),
					});
				}
			} else if (post.kind === "escalate") {
				totalEscalate += 1;
				mattersWithFriction.add(matter.id);
				escalateAuthors.set(post.authorId, (escalateAuthors.get(post.authorId) ?? 0) + 1);
				escalatePosts.push({
					postNo: post.postNo,
					authorId: post.authorId,
					mentions: post.mentions,
					summary: cleanSummary,
				});
				if (escalateItems.length < 4) {
					escalateItems.push({
						id: `board_friction:escalate:${matter.id}:${post.postNo}`,
						kind: "board_friction",
						sourceId: post.id,
						matterId: matter.id,
						label: `[公告板升级] ${matter.title} · #${post.postNo} (${post.authorId})`,
						excerpt: `post#${post.postNo} by ${post.authorId} -> ${mentionText}；摘要：${cleanSummary}`.slice(
							0,
							360,
						),
					});
				}
			}
		}

		const eventsPage = store.listEvents(matter.id, { eventType: "monitor_alert", order: "desc", limit: 50 });
		for (const ev of eventsPage.events) {
			totalMonitorAlerts += 1;
			mattersWithFriction.add(matter.id);
			const targetAgentId =
				typeof ev.payload.targetAgentId === "string" && ev.payload.targetAgentId.trim()
					? ev.payload.targetAgentId.trim()
					: (ev.agentId ?? "unknown");
			const nudgeCount =
				typeof ev.payload.nudgeCount === "number" && Number.isFinite(ev.payload.nudgeCount)
					? ev.payload.nudgeCount
					: 1;
			const rawReason =
				typeof ev.payload.reason === "string" && ev.payload.reason.trim()
					? ev.payload.reason.trim()
					: typeof ev.payload.message === "string" && ev.payload.message.trim()
						? ev.payload.message.trim()
						: "monitor_alert";
			const cleanReason = redactInsightText(rawReason).replace(/\s+/g, " ").trim();
			stalledAgents.set(targetAgentId, (stalledAgents.get(targetAgentId) ?? 0) + 1);
			monitorAlerts.push({ targetAgentId, nudgeCount, reason: cleanReason });
			if (monitorItems.length < 4) {
				monitorItems.push({
					id: `board_friction:monitor:${matter.id}:${ev.id}`,
					kind: "board_friction",
					sourceId: ev.id,
					matterId: matter.id,
					label: `[停滞告警] ${matter.title} · @${targetAgentId}`,
					excerpt: `targetAgentId=${targetAgentId}，nudgeCount=${nudgeCount}，reason=${cleanReason}`.slice(0, 360),
				});
			}
		}

		if (reworkPosts.length > 0 || escalatePosts.length > 0 || monitorAlerts.length > 0) {
			boardInputs.push({
				matterId: matter.id,
				matterTitle: matter.title,
				reworkPosts,
				escalatePosts,
				monitorAlerts,
			});
		}
	}

	const summary: SessionInsightBoardSignals = {
		reworkCount: totalRework,
		escalateCount: totalEscalate,
		monitorAlertCount: totalMonitorAlerts,
		mattersWithBoardFriction: mattersWithFriction.size,
	};

	const evidence: TeamHealthEvidence[] = [];
	if (totalRework > 0 || totalEscalate > 0 || totalMonitorAlerts > 0) {
		const assetRecommendations: string[] = [];
		if (totalRework > 0) {
			const topTargets = [...reworkTargets.entries()]
				.sort((a, b) => b[1] - a[1])
				.slice(0, 2)
				.map(([t, c]) => `${t}(${c})`)
				.join("、");
			assetRecommendations.push(
				`[Execution Skills] 通过 propose_skill 沉淀执行规范与脚本${topTargets ? `（高频目标：${topTargets}）` : ""}`,
			);
			assetRecommendations.push("[Verifier checklists] 将高频返工 criteria 固化为可复用验收清单与校验脚本");
		}
		if (totalEscalate > 0 || totalRework >= 2) {
			const topEsc = [...escalateAuthors.entries()]
				.sort((a, b) => b[1] - a[1])
				.slice(0, 2)
				.map(([a, c]) => `${a}(${c})`)
				.join("、");
			assetRecommendations.push(
				`[Role-Skill bindings] 通过 propose_role 补齐动态角色模板与 Skills 关联${topEsc ? `（升级来源：${topEsc}）` : ""}`,
			);
		}
		if (totalMonitorAlerts > 0 || totalEscalate > 0) {
			const topStalled = [...stalledAgents.entries()]
				.sort((a, b) => b[1] - a[1])
				.slice(0, 2)
				.map(([a, c]) => `@${a}(${c})`)
				.join("、");
			assetRecommendations.push(
				`[Coordinator orchestration Skills] 沉淀任务切片、ownedScope 边界与授权规则${topStalled ? `（卡点成员：${topStalled}）` : ""}`,
			);
		}

		evidence.push({
			id: "board_friction:coe_summary",
			kind: "board_friction",
			sourceId: "board_coe_summary",
			label: `[CoE 沉淀信号] 公告板摩擦汇总（${mattersWithFriction.size} 个事项）`,
			excerpt:
				`返工 ${totalRework} 次、升级 ${totalEscalate} 次、停滞告警 ${totalMonitorAlerts} 次；建议沉淀：${assetRecommendations.join("；")}`.slice(
					0,
					480,
				),
		});
		evidence.push(...reworkItems, ...escalateItems, ...monitorItems);
	}

	return { evidence, boardInputs, summary };
}

/**
 * Bounded source records, separate from the model's interpretation of their cause or importance.
 * Feeds static role definitions, recent matter friction, negative space feedback, deterministic
 * Pi session-insights findings, board collaboration friction, and Four-Step Trust skill telemetry
 * into Role Architect / RSI healthchecks.
 */
export function collectTeamHealthEvidence(
	store: PersonalAgentStore,
	templates: Map<string, RoleTemplate>,
	scope?: TeamHealthScopeFilter,
): TeamHealthEvidence[] {
	const sources: TeamHealthEvidence[] = [];
	const members = filterTeamMembersForScope(store.listMembers(), scope).filter((member) => {
		const tpl = templates.get(member.templateId) ?? { id: member.id };
		return !isArchitectRoleTemplate(tpl) && !isSoloRoleTemplate(tpl);
	});
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

	// Board collaboration friction signals (verify_rework, escalate, monitor_alert) strictly from scopedMatters.
	const boardFriction = collectBoardFrictionSignals(store, scopedMatters);
	sources.push(...boardFriction.evidence);

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
		const report = buildSessionInsightsReport(insightSources, {
			boardInputs: boardFriction.boardInputs,
		});
		for (const finding of report.findings.filter((item) => item.kind !== "board_friction").slice(0, 6)) {
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

	return sources.slice(0, 64);
}

export function formatTeamHealthEvidence(sources: TeamHealthEvidence[]): string {
	return sources
		.map((source) => `- [${source.id}] ${source.label}：${source.excerpt.replace(/\s+/g, " ")}`)
		.join("\n");
}
