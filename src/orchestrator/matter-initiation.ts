import type { RoleInteractionStyle, RoleWorkspaceScope } from "../roles/role-architect.ts";
import type { RoleTemplate } from "../roles/types.ts";
import type { TeamMember } from "../storage/types.ts";

export type CollaborationPresetMode = "solo" | "lead_consult" | "lead_review" | "human_first";
export type RoleFitStatus = "matched" | "ambiguous" | "gap_detected";

export interface MatterInitiationCandidate {
	memberId: string;
	displayName: string;
	roleTitle: string;
	score: number;
	matchedSignals: string[];
	tools: string[];
}

export interface RoleGapSuggestion {
	missingRoleTitle: string;
	suggestedJob: string;
	suggestedAntiJobs: string[];
	suggestedInteractionStyle: RoleInteractionStyle;
	suggestedWorkspaceScope: RoleWorkspaceScope;
	reason: string;
}

export interface MatterInitiationAssessment {
	fitStatus: RoleFitStatus;
	headline: string;
	explanation: string;
	recommendedMode: CollaborationPresetMode;
	recommendedLeadId: string | null;
	recommendedAiMemberIds: string[];
	recommendedObserverIds: string[];
	candidates: MatterInitiationCandidate[];
	gapSuggestion?: RoleGapSuggestion;
}

interface DomainSignalRule {
	label: string;
	patterns: RegExp[];
	suggestedRoleTitle: string;
	suggestedJob: string;
	suggestedAntiJobs: string[];
	interactionStyle: RoleInteractionStyle;
	workspaceScope: RoleWorkspaceScope;
}

const SPECIALIZED_DOMAIN_RULES: DomainSignalRule[] = [
	{
		label: "法务与合规审核",
		patterns: [/(?:合同|法务|条款|合规|知识产权|版权|隐私协议|免责声明|法律风险)/i],
		suggestedRoleTitle: "法务合规审阅",
		suggestedJob: "只审查合同、协议条款、合规边界与潜在法律风险，并给出具体修订条文建议。",
		suggestedAntiJobs: ["不替代团队拍板商业合作条款", "不直接对外发送正式法律文本", "未发现明确风险时保持精简提示"],
		interactionStyle: "risk_observer",
		workspaceScope: "no_repo_docs",
	},
	{
		label: "财务测算与预算分析",
		patterns: [/(?:财务|预算|现金流|毛利|成本核算|税务|发票|roi测算|盈亏平衡|报价单)/i],
		suggestedRoleTitle: "财务与经营分析",
		suggestedJob: "围绕成本结构、预算投入、定价回本周期与财务假设开展量化核算与风险提示。",
		suggestedAntiJobs: ["不编造未提供来源的财务数据", "不直接决定产品功能排期或修改代码"],
		interactionStyle: "consult_specialist",
		workspaceScope: "no_repo_docs",
	},
	{
		label: "视觉交互与设计规范",
		patterns: [/(?:视觉设计|品牌vi|logo|插画|版式|色彩体系|figma|ui规范|设计系统|动效细节)/i],
		suggestedRoleTitle: "体验与视觉设计师",
		suggestedJob: "负责页面信息层级、交互流程、视觉一致性与可用性走查，产出可执行设计约束。",
		suggestedAntiJobs: ["不直接重写后端架构或绕过研发改动生产逻辑", "不做脱离使用场景的纯装饰性方案"],
		interactionStyle: "consult_specialist",
		workspaceScope: "read_only_repo",
	},
	{
		label: "组织与人员流程管理",
		patterns: [/(?:绩效考核|okr|招聘jd|面试题|员工激励|组织架构|团队周会制度|晋升答辩)/i],
		suggestedRoleTitle: "团队流程与人才顾问",
		suggestedJob: "围绕团队分工机制、协作节奏、招聘评估或绩效口径提供可落地的流程方案。",
		suggestedAntiJobs: ["不脱离实际业务约束空谈管理理论", "不替代管理者作最终人事决定"],
		interactionStyle: "consult_specialist",
		workspaceScope: "no_repo_docs",
	},
	{
		label: "客服售后与工单流转",
		patterns: [/(?:客服话术|客诉|退换货|售后工单|sla响应|服务标准|客户回访)/i],
		suggestedRoleTitle: "客户支持与服务专员",
		suggestedJob: "梳理客户投诉根因、安抚话术、SLA 升级条件与可复用的售后处理标准。",
		suggestedAntiJobs: ["不私自承诺超出权限的退款或赔偿", "不直接篡改线上业务代码"],
		interactionStyle: "lead_direct",
		workspaceScope: "no_repo_docs",
	},
];

const HIGH_RISK_CUES = [/(?:重构|迁移|兼容|上线|发布|生产|数据库|权限|认证|安全|并发|回滚|不可逆|评审|对照)/i];
const COLLAB_CUES = [/(?:全链路|跨团队|协同|联合|技术方案|prd|立项|发布计划|竞品.*功能|需求.*实现)/i];
const ALIGNMENT_CUES = [/(?:大家先讨论|先对齐|先聊聊|拿不准|两种方案|怎么定|讨论一下|拍板|方向选择|团队共识)/i];
const CODING_CUES = [/(?:代码|仓库|源码|bug|修复|重构|接口|函数|组件|构建|类型|单元测试|sql|rpc)/i];

function scoreMember(
	member: TeamMember,
	template: RoleTemplate | undefined,
	lowerPrompt: string,
	hasWorkspace: boolean,
): MatterInitiationCandidate {
	let score = 0;
	const matchedSignals: string[] = [];

	if (lowerPrompt.includes(member.displayName.toLowerCase())) {
		score += 4;
		matchedSignals.push(`点名「${member.displayName}」`);
	}

	for (const kw of member.keywords) {
		const normalized = kw.trim().toLowerCase();
		if (normalized.length >= 2 && lowerPrompt.includes(normalized)) {
			score += 2;
			if (matchedSignals.length < 4) matchedSignals.push(`关键词:${kw}`);
		}
	}

	const respTokens = (template?.sections.responsibilitiesAndBoundaries ?? "")
		.split(/[\s,，、。；：\-*]+/)
		.map((token) => token.trim().toLowerCase())
		.filter((token) => token.length >= 2 && token.length <= 8);
	const uniqueRespHits = new Set<string>();
	for (const token of respTokens) {
		if (lowerPrompt.includes(token) && !uniqueRespHits.has(token)) {
			uniqueRespHits.add(token);
			score += 1;
			if (uniqueRespHits.size <= 2 && matchedSignals.length < 4) {
				matchedSignals.push(`职责:${token}`);
			}
		}
	}

	const tools = template?.tools ?? [];
	const promptNeedsCoding = CODING_CUES.some((re) => re.test(lowerPrompt));
	if (
		promptNeedsCoding &&
		hasWorkspace &&
		(tools.includes("edit") || tools.includes("write") || tools.includes("bash"))
	) {
		score += 1;
		matchedSignals.push("具备代码读写能力");
	}
	if (!hasWorkspace && !promptNeedsCoding && !tools.includes("edit") && !tools.includes("write")) {
		score += 0.5;
	}

	return {
		memberId: member.id,
		displayName: member.displayName,
		roleTitle: member.roleTitle,
		score: Math.round(score * 10) / 10,
		matchedSignals,
		tools,
	};
}

function findQaOrRiskObserver(members: TeamMember[], excludeId: string | null): string | null {
	const candidate = members.find(
		(m) =>
			m.id !== excludeId &&
			(m.templateId === "qa-manager" ||
				/测试|验收|质量|风控|法务|审计|review|qa/i.test(`${m.displayName} ${m.roleTitle} ${m.keywords.join(" ")}`)),
	);
	return candidate?.id ?? null;
}

/**
 * Evaluates a draft matter before dispatch to surface AI fit, recommended team size & participation mode,
 * and role gaps rather than silently falling back to an unrelated default role.
 */
export function assessMatterInitiation(input: {
	prompt: string;
	hasImages?: boolean;
	hasWorkspace?: boolean;
	preferredMemberId?: string;
	members: TeamMember[];
	templatesByRoleId: Map<string, RoleTemplate>;
}): MatterInitiationAssessment {
	const prompt = input.prompt.trim();
	const lowerPrompt = prompt.toLowerCase();
	const members = input.members;
	const primary = members.find((m) => m.isPrimaryContact) ?? members[0] ?? null;

	const candidates = members
		.map((member) =>
			scoreMember(
				member,
				input.templatesByRoleId.get(member.templateId) ?? input.templatesByRoleId.get(member.id),
				lowerPrompt,
				Boolean(input.hasWorkspace),
			),
		)
		.sort((a, b) => b.score - a.score);

	const explicitMember = input.preferredMemberId
		? (members.find((m) => m.id === input.preferredMemberId) ?? null)
		: null;
	const topCandidate = candidates[0] ?? null;
	const secondCandidate = candidates[1] ?? null;
	const leadId =
		explicitMember?.id ?? (topCandidate && topCandidate.score >= 1.5 ? topCandidate.memberId : (primary?.id ?? null));

	const wantsHumanFirst = ALIGNMENT_CUES.some((re) => re.test(prompt));
	const isHighRisk = HIGH_RISK_CUES.some((re) => re.test(prompt));
	const isMultiRole =
		COLLAB_CUES.some((re) => re.test(prompt)) ||
		((topCandidate?.score ?? 0) >= 2 && (secondCandidate?.score ?? 0) >= 2);

	const recommendedObserverIds: string[] = [];
	if (isHighRisk) {
		const obsId = findQaOrRiskObserver(members, leadId);
		if (obsId) recommendedObserverIds.push(obsId);
	}

	const consultIds = candidates
		.filter((c) => c.memberId !== leadId && !recommendedObserverIds.includes(c.memberId) && c.score >= 1.5)
		.slice(0, 2)
		.map((c) => c.memberId);

	const recommendedAiMemberIds = leadId ? Array.from(new Set([leadId, ...consultIds, ...recommendedObserverIds])) : [];

	const recommendedMode: CollaborationPresetMode = wantsHumanFirst
		? "human_first"
		: recommendedObserverIds.length > 0
			? "lead_review"
			: recommendedAiMemberIds.length > 1 || isMultiRole
				? "lead_consult"
				: "solo";

	const finalAiMemberIds =
		recommendedMode === "solo" && leadId
			? [leadId]
			: recommendedAiMemberIds.length > 0
				? recommendedAiMemberIds
				: leadId
					? [leadId]
					: [];

	const matchedSpecialRule = SPECIALIZED_DOMAIN_RULES.find((rule) =>
		rule.patterns.some((pattern) => pattern.test(prompt)),
	);
	const domainAlreadyCovered =
		matchedSpecialRule &&
		candidates.some(
			(c) =>
				c.score >= 3 &&
				(matchedSpecialRule.patterns.some((p) => p.test(`${c.displayName} ${c.roleTitle}`)) ||
					c.matchedSignals.some((s) => s.startsWith("关键词:"))),
		);

	if (matchedSpecialRule && !domainAlreadyCovered && !explicitMember) {
		return {
			fitStatus: "gap_detected",
			headline: `当前团队可能缺少「${matchedSpecialRule.label}」专职角色`,
			explanation: `现有成员偏向现有已建岗位，对「${matchedSpecialRule.label}」相关职责与约束覆盖较弱；可先通过角色设计向导补充该专才，或先指定现有主联系人拆解边界。`,
			recommendedMode: wantsHumanFirst ? "human_first" : "solo",
			recommendedLeadId: leadId,
			recommendedAiMemberIds: leadId ? [leadId] : [],
			recommendedObserverIds: [],
			candidates,
			gapSuggestion: {
				missingRoleTitle: matchedSpecialRule.suggestedRoleTitle,
				suggestedJob: matchedSpecialRule.suggestedJob,
				suggestedAntiJobs: matchedSpecialRule.suggestedAntiJobs,
				suggestedInteractionStyle: matchedSpecialRule.interactionStyle,
				suggestedWorkspaceScope: matchedSpecialRule.workspaceScope,
				reason: `识别到任务涉及「${matchedSpecialRule.label}」，但现有团队成员缺少对应的职责定义与专门边界。`,
			},
		};
	}

	const strongestKeywordScore = candidates.reduce((max, item) => {
		const keywordHits = item.matchedSignals.filter((s) => !s.startsWith("具备") && !s.startsWith("职责:")).length;
		return Math.max(max, keywordHits);
	}, 0);

	if (!explicitMember && prompt.length >= 16 && strongestKeywordScore === 0 && (topCandidate?.score ?? 0) < 2) {
		return {
			fitStatus: "gap_detected",
			headline: "当前团队暂无明显对口的专职 AI 角色",
			explanation:
				"这段需求未命中现有成员的核心关键词与职责范围；如果你们经常处理此类事务，建议按团队工作方式先设计一个专职角色，或先切到「人类先讨论」定调。",
			recommendedMode: wantsHumanFirst ? "human_first" : "solo",
			recommendedLeadId: leadId,
			recommendedAiMemberIds: leadId ? [leadId] : [],
			recommendedObserverIds: [],
			candidates,
			gapSuggestion: {
				missingRoleTitle: "专项协作顾问",
				suggestedJob: `围绕「${prompt.slice(0, 36)}」这类需求承担清晰单一的梳理、分析或把关职责。`,
				suggestedAntiJobs: ["不越权替团队做最终业务拍板", "不在无依据时自行改动无关文件"],
				suggestedInteractionStyle: "lead_direct",
				suggestedWorkspaceScope: input.hasWorkspace ? "read_only_repo" : "no_repo_docs",
				reason: "现有团队成员关键词与职责说明均未明确匹配当前任务场景。",
			},
		};
	}

	const leadMember = members.find((m) => m.id === leadId) ?? primary;
	const isAmbiguous =
		!explicitMember &&
		(topCandidate?.score ?? 0) > 0 &&
		(secondCandidate?.score ?? 0) >= (topCandidate?.score ?? 0) - 0.5;
	const modeLabel =
		recommendedMode === "human_first"
			? "建议人类团队先讨论对齐，拍板后再派发 AI"
			: recommendedMode === "lead_review"
				? `建议 1 位主责 + 定向旁听把关（共 ${finalAiMemberIds.length} 位 AI）`
				: recommendedMode === "lead_consult"
					? `建议主责统筹 + 指定协同（共 ${finalAiMemberIds.length} 位 AI）`
					: "建议单兵直办（仅 1 位对口 AI 独立推进）";

	return {
		fitStatus: isAmbiguous ? "ambiguous" : "matched",
		headline: leadMember ? `匹配「${leadMember.displayName}」牵头 · ${modeLabel}` : modeLabel,
		explanation:
			topCandidate && topCandidate.matchedSignals.length > 0
				? `匹配依据：${topCandidate.matchedSignals.join("、")}。你可在下方微调参与人数或把特定成员设为旁听把关。`
				: "当前团队可直接承接；可按需收窄为单兵直办，或勾选特定旁听成员。",
		recommendedMode,
		recommendedLeadId: leadId,
		recommendedAiMemberIds: finalAiMemberIds,
		recommendedObserverIds:
			recommendedMode === "solo" || recommendedMode === "human_first" ? [] : recommendedObserverIds,
		candidates,
	};
}
