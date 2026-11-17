import {
	isArchitectRoleTemplate,
	type RoleInteractionStyle,
	type RoleWorkspaceScope,
} from "../roles/role-architect.ts";
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
		.split("\n")
		.filter((line) => !/(?:不负责|不做|禁止|不直接|不替代|不能)/.test(line))
		.join("\n")
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
		matchedSignals.push("具备仓库操作工具（不是职责证明）");
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
	const allMembers = input.members;
	const explicitMember = input.preferredMemberId
		? (allMembers.find((m) => m.id === input.preferredMemberId) ?? null)
		: null;
	if (
		explicitMember &&
		isArchitectRoleTemplate(
			input.templatesByRoleId.get(explicitMember.templateId) ??
				input.templatesByRoleId.get(explicitMember.id) ?? { id: explicitMember.id },
		)
	) {
		return {
			fitStatus: "matched",
			headline: `将由「${explicitMember.displayName}」负责角色规划与协作体检`,
			explanation: "角色架构师只读诊断团队结构并生成可勾选的角色提案，不会直接改动代码或业务职责文件。",
			recommendedMode: "solo",
			recommendedLeadId: explicitMember.id,
			recommendedAiMemberIds: [explicitMember.id],
			recommendedObserverIds: [],
			candidates: [],
		};
	}

	const businessMembers = allMembers.filter(
		(m) =>
			!isArchitectRoleTemplate(
				input.templatesByRoleId.get(m.templateId) ?? input.templatesByRoleId.get(m.id) ?? { id: m.id },
			),
	);
	const members = businessMembers.length > 0 ? businessMembers : allMembers;
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
			: recommendedAiMemberIds.length > 1
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
					matchedSpecialRule.patterns.some((pattern) =>
						pattern.test(
							input.templatesByRoleId
								.get(c.memberId)
								?.sections.responsibilitiesAndBoundaries.split("\n")
								.filter((line) => !/(?:不负责|不做|禁止|不直接|不替代|不能)/.test(line))
								.join("\n") ?? "",
						),
					)),
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

	const leadMember = members.find((m) => m.id === leadId) ?? primary;
	const isAmbiguous =
		!explicitMember &&
		((topCandidate?.score ?? 0) < 1.5 || (secondCandidate?.score ?? 0) >= (topCandidate?.score ?? 0) - 0.5);
	const modeLabel =
		recommendedMode === "human_first"
			? "建议人类团队先讨论对齐，拍板后再派发 AI"
			: recommendedMode === "lead_review"
				? `建议 1 位主责 + 定向旁听把关（共 ${finalAiMemberIds.length} 位 AI）`
				: recommendedMode === "lead_consult"
					? `建议主责统筹 + 指定协同（共 ${finalAiMemberIds.length} 位 AI）`
					: "建议单兵直办（仅 1 位对口 AI 独立推进）";

	const leadCandidate = candidates.find((candidate) => candidate.memberId === leadId);
	const leadReason = explicitMember
		? `主责沿用你的选择「${explicitMember.displayName}」`
		: topCandidate && topCandidate.score >= 1.5
			? `按文字线索建议「${leadMember?.displayName ?? "主联系人"}」：${leadCandidate?.matchedSignals.join("、") || "暂无额外线索"}`
			: `没有明确岗位线索，先由默认联系人「${leadMember?.displayName ?? "未设置"}」了解需求`;
	const modeReason = wantsHumanFirst
		? "命中先讨论、对齐或业务拍板线索，建议先不执行 AI"
		: recommendedObserverIds.length
			? `命中风险线索「${prompt.match(HIGH_RISK_CUES[0]!)?.[0] ?? "风险"}」，建议增加定向旁听`
			: finalAiMemberIds.length > 1
				? "匹配到其他岗位，主责可按需请教，并非全员同时执行"
				: isMultiRole
					? "存在协同线索，但暂无具体对口协同人选，先由主责澄清"
					: "未命中跨岗位或风险线索，先由一位主责处理";
	return {
		fitStatus: isAmbiguous ? "ambiguous" : "matched",
		headline: leadMember ? `建议由「${leadMember.displayName}」牵头 · ${modeLabel}` : modeLabel,
		explanation: `${leadReason}。${modeReason}。这是本地文字规则，不调用模型、不读取仓库内容或验证成员能力${input.hasImages ? "，也未识别图片内容" : ""}。`,
		recommendedMode,
		recommendedLeadId: leadId,
		recommendedAiMemberIds: finalAiMemberIds,
		recommendedObserverIds:
			recommendedMode === "solo" || recommendedMode === "human_first" ? [] : recommendedObserverIds,
		candidates,
	};
}
