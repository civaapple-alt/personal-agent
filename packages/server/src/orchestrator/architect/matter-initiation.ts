import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
	isArchitectRoleTemplate,
	type RoleInteractionStyle,
	type RoleWorkspaceScope,
} from "../../roles/role-architect.ts";
import type { RoleTemplate } from "../../roles/types.ts";
import type { ModelSelection } from "../../rpc/model-selection.ts";
import type { TeamMember } from "../../storage/types.ts";
import { truncateInline, type WorkerFactory } from "../types.ts";
import { classifyInitiation } from "./initiation-classifier.ts";
import { type PiDecisionResult, runTypedPiDecision } from "./pi-decision.ts";
import type { DecisionClassifier } from "./system-one.ts";

export type CollaborationPresetMode = "solo" | "lead_consult" | "lead_review" | "human_first";
export type RoleFitStatus = "matched" | "ambiguous" | "gap_detected";
export type InitiationAssessmentSource = "rules" | "model";
export type DecisionConfidence = "high" | "medium" | "low";

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
	recommendedConsultIds?: string[];
	recommendedObserverIds: string[];
	candidates: MatterInitiationCandidate[];
	gapSuggestion?: RoleGapSuggestion;
	assessmentSource?: InitiationAssessmentSource;
	confidence?: DecisionConfidence;
	repoReadEnabled?: boolean;
	repoReadPaths?: string[];
	usedRepoRead?: boolean;
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

function extractPositiveResponsibilityText(raw: string): string {
	return raw
		.split("\n")
		.filter((line) => !/(?:不负责|不做|禁止|不直接|不替代|不能)/.test(line))
		.join("\n");
}

function responsibilityRoutingText(template: RoleTemplate | undefined): string {
	return (
		template?.responsibilityKeywords?.join(" ") ??
		extractPositiveResponsibilityText(template?.sections.responsibilitiesAndBoundaries ?? "")
	);
}

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

	const respTokens = responsibilityRoutingText(template)
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
			assessmentSource: "rules",
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
						pattern.test(responsibilityRoutingText(input.templatesByRoleId.get(c.memberId))),
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
			assessmentSource: "rules",
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
		recommendedConsultIds: recommendedMode === "solo" || recommendedMode === "human_first" ? [] : consultIds,
		recommendedObserverIds:
			recommendedMode === "solo" || recommendedMode === "human_first" ? [] : recommendedObserverIds,
		candidates,
		assessmentSource: "rules",
	};
}

const VALID_FIT_STATUSES = new Set<RoleFitStatus>(["matched", "ambiguous", "gap_detected"]);
const VALID_PRESET_MODES = new Set<CollaborationPresetMode>(["solo", "lead_consult", "lead_review", "human_first"]);
const VALID_CONFIDENCES = new Set<DecisionConfidence>(["high", "medium", "low"]);
const VALID_STYLES = new Set<RoleInteractionStyle>(["lead_direct", "consult_specialist", "risk_observer", "mixed"]);
const VALID_SCOPES = new Set<RoleWorkspaceScope>(["no_repo_docs", "read_only_repo", "read_write_code"]);

interface ValidatedInitiationDecision {
	fitStatus: RoleFitStatus;
	recommendedMode: CollaborationPresetMode;
	recommendedLeadId: string | null;
	recommendedConsultIds: string[];
	recommendedObserverIds: string[];
	confidence: DecisionConfidence;
	headline: string;
	reasoning: string;
	gapSuggestion?: RoleGapSuggestion;
}

/** Validates raw JSON from the Pi decision model against strict enum contracts and live business member IDs. */
export function validateInitiationModelDecision(
	raw: Record<string, unknown>,
	context: {
		members: TeamMember[];
		primaryId: string | null;
		explicitMemberId: string | null;
		hasWorkspace: boolean;
	},
): ValidatedInitiationDecision | null {
	const fitStatusRaw = typeof raw.fitStatus === "string" ? raw.fitStatus.trim() : "";
	const modeRaw = typeof raw.recommendedMode === "string" ? raw.recommendedMode.trim() : "";
	if (
		!VALID_FIT_STATUSES.has(fitStatusRaw as RoleFitStatus) ||
		!VALID_PRESET_MODES.has(modeRaw as CollaborationPresetMode)
	) {
		return null;
	}
	const fitStatus = fitStatusRaw as RoleFitStatus;
	let recommendedMode = modeRaw as CollaborationPresetMode;

	const headline = typeof raw.headline === "string" ? raw.headline.trim() : "";
	const reasoning = typeof raw.reasoning === "string" ? raw.reasoning.trim() : "";
	if (!headline || !reasoning) return null;

	const confidenceRaw = typeof raw.confidence === "string" ? raw.confidence.trim() : "medium";
	const confidence: DecisionConfidence = VALID_CONFIDENCES.has(confidenceRaw as DecisionConfidence)
		? (confidenceRaw as DecisionConfidence)
		: "medium";

	const validIds = new Set(context.members.map((m) => m.id));
	let recommendedLeadId = context.explicitMemberId;
	if (!recommendedLeadId) {
		const rawLead = typeof raw.recommendedLeadId === "string" ? raw.recommendedLeadId.trim() : "";
		if (rawLead) {
			// Reject hallucinated member IDs rather than silently accepting invalid roster pointers.
			if (!validIds.has(rawLead)) return null;
			recommendedLeadId = rawLead;
		} else {
			recommendedLeadId = context.primaryId;
		}
	}

	const filterValidIds = (value: unknown): string[] => {
		if (!Array.isArray(value)) return [];
		const seen = new Set<string>();
		const out: string[] = [];
		for (const item of value) {
			const id = typeof item === "string" ? item.trim() : "";
			if (!id || id === recommendedLeadId || !validIds.has(id) || seen.has(id)) continue;
			seen.add(id);
			out.push(id);
		}
		return out;
	};

	let consultIds = filterValidIds(raw.recommendedConsultIds);
	let observerIds = filterValidIds(raw.recommendedObserverIds);

	if (recommendedMode === "solo" || recommendedMode === "human_first") {
		consultIds = [];
		observerIds = [];
	} else if (observerIds.length > 0) {
		recommendedMode = "lead_review";
	} else if (consultIds.length > 0) {
		recommendedMode = "lead_consult";
	} else {
		recommendedMode = "solo";
	}

	let gapSuggestion: RoleGapSuggestion | undefined;
	if (fitStatus === "gap_detected" && raw.gapSuggestion && typeof raw.gapSuggestion === "object") {
		const gap = raw.gapSuggestion as Record<string, unknown>;
		const title = typeof gap.missingRoleTitle === "string" ? gap.missingRoleTitle.trim() : "";
		const job = typeof gap.suggestedJob === "string" ? gap.suggestedJob.trim() : "";
		const reason = typeof gap.reason === "string" ? gap.reason.trim() : "";
		if (title && job) {
			const antiJobs = Array.isArray(gap.suggestedAntiJobs)
				? gap.suggestedAntiJobs
						.map((s) => (typeof s === "string" ? s.trim() : ""))
						.filter(Boolean)
						.slice(0, 4)
				: [];
			const styleRaw = typeof gap.suggestedInteractionStyle === "string" ? gap.suggestedInteractionStyle.trim() : "";
			const scopeRaw = typeof gap.suggestedWorkspaceScope === "string" ? gap.suggestedWorkspaceScope.trim() : "";
			gapSuggestion = {
				missingRoleTitle: title,
				suggestedJob: job,
				suggestedAntiJobs: antiJobs.length > 0 ? antiJobs : ["不越权替团队拍板最终业务决策"],
				suggestedInteractionStyle: VALID_STYLES.has(styleRaw as RoleInteractionStyle)
					? (styleRaw as RoleInteractionStyle)
					: "consult_specialist",
				suggestedWorkspaceScope: VALID_SCOPES.has(scopeRaw as RoleWorkspaceScope)
					? (scopeRaw as RoleWorkspaceScope)
					: context.hasWorkspace
						? "read_only_repo"
						: "no_repo_docs",
				reason: reason || reasoning,
			};
		}
	}

	return {
		fitStatus,
		recommendedMode,
		recommendedLeadId,
		recommendedConsultIds: consultIds,
		recommendedObserverIds: observerIds,
		confidence,
		headline,
		reasoning,
		...(gapSuggestion ? { gapSuggestion } : {}),
	};
}

/**
 * Evaluates a draft matter using an isolated, schema-enforced Pi LLM decision call (typesafe-ai style),
 * returning validated team member IDs, formation mode, confidence, and optional repo-grounded reasoning.
 */
export async function assessMatterInitiationWithModel(
	deps: {
		defaultCwd: string;
		classifier?: DecisionClassifier;
		workerFactory: WorkerFactory;
		selectModel?: (memberId?: string) => ModelSelection | null;
		members: TeamMember[];
		templatesByRoleId: Map<string, RoleTemplate>;
	},
	input: {
		prompt: string;
		hasImages?: boolean;
		workspacePath?: string | null;
		workspaceName?: string | null;
		preferredMemberId?: string;
		readRepo?: boolean;
		timeoutMs?: number;
		signal: AbortSignal;
	},
): Promise<MatterInitiationAssessment> {
	const prompt = input.prompt.trim();
	if (!prompt) {
		throw new Error("Prompt is required for model-based initiation decision");
	}
	const explicitMember = input.preferredMemberId
		? (deps.members.find((m) => m.id === input.preferredMemberId) ?? null)
		: null;
	if (
		explicitMember &&
		isArchitectRoleTemplate(
			deps.templatesByRoleId.get(explicitMember.templateId) ??
				deps.templatesByRoleId.get(explicitMember.id) ?? { id: explicitMember.id },
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
			assessmentSource: "model",
			confidence: "high",
			usedRepoRead: false,
		};
	}

	const businessMembers = deps.members.filter(
		(m) =>
			!isArchitectRoleTemplate(
				deps.templatesByRoleId.get(m.templateId) ?? deps.templatesByRoleId.get(m.id) ?? { id: m.id },
			),
	);
	const pool = businessMembers.length > 0 ? businessMembers : deps.members;
	const primary = pool.find((m) => m.isPrimaryContact) ?? pool[0] ?? null;
	const explicitBusinessId = explicitMember && pool.some((m) => m.id === explicitMember.id) ? explicitMember.id : null;
	const hasWorkspace = Boolean(input.workspacePath);
	const useRepoRead = Boolean(input.readRepo && input.workspacePath);

	const rosterDescription = pool
		.map((m) => {
			const tpl = deps.templatesByRoleId.get(m.templateId) ?? deps.templatesByRoleId.get(m.id);
			const positiveResp = truncateInline(
				extractPositiveResponsibilityText(tpl?.sections.responsibilitiesAndBoundaries ?? ""),
				180,
			);
			const antiJobs = tpl?.antiJobs?.length ? tpl.antiJobs.join("; ") : "";
			const tools = tpl?.tools?.length ? tpl.tools.join(", ") : "无工具(纯思考文稿)";
			return [
				`- memberId: "${m.id}" | 显示名: ${m.displayName} (${m.roleTitle})${m.isPrimaryContact ? " [默认主联系人]" : ""}`,
				`  工具权限: [${tools}] | 关键词: [${m.keywords.join(", ")}]`,
				positiveResp ? `  核心职责: ${positiveResp}` : "",
				antiJobs ? `  明确不做边界: ${antiJobs}` : "",
			]
				.filter(Boolean)
				.join("\n");
		})
		.join("\n");

	const allowedIdList = pool.map((m) => `"${m.id}"`).join(", ");
	const systemPrompt = [
		"你是 Personal Agent 的**立项阵型决策模型（Typed Initiation Decision Engine）**。",
		"你的任务是根据用户需求和现有 AI 团队成员职责/边界，输出最精准、精简的立项参与阵型决策。",
		"",
		"## 核心判断原则",
		"1. **优先最小人数与最低摩擦**：单人能清晰完成时优先 `solo`；仅在确实需要另一角色提供输入或跨岗把关时才选 `lead_consult` 或 `lead_review`；需要团队先拍板或讨论开放方向时选 `human_first`。",
		"2. **严禁忽略不做边界**：仔细阅读每个角色的「明确不做边界」；某个角色声明不做某事时，绝不能仅仅因为关键词出现就把它当成胜任者。",
		"3. **真实岗位缺口识别**：仅当现有成员核心职责都无法覆盖、且确属专业空白（如法务/财务/安全等专岗或完全超出已有分工）时才设为 `gap_detected` 并填写 `gapSuggestion`；如果现有团队能胜任，设 `matched` 或 `ambiguous`。",
		explicitBusinessId
			? `4. **主责约束**：用户已指定主责成员 \`${explicitBusinessId}\`，\`recommendedLeadId\` 必须保持为 \`${explicitBusinessId}\`。`
			: "4. 从候选池中挑选最契合的主责成员。",
		useRepoRead
			? "5. 当前允许使用只读 `read` 工具：如有必要，可快速查看 1~2 个关键入口文件（如 README.md / package.json）辅助判断技术栈与涉及岗位，但不得过度探索。"
			: "5. 当前为纯决策推理模式（无工具），不得假设或编造仓库内未展示的具体文件实现。",
		"",
		"## 严格输出格式（仅返回单个合法 JSON 对象，不要包含解释性前缀或 Markdown 外文本）",
		`允许的 memberId 枚举仅有：[${allowedIdList}]`,
		JSON.stringify(
			{
				fitStatus: "matched | ambiguous | gap_detected",
				recommendedMode: "solo | lead_consult | lead_review | human_first",
				recommendedLeadId: "必须是上述枚举之一",
				recommendedConsultIds: ["按需请教的非主责 memberId（solo/human_first 时为 []）"],
				recommendedObserverIds: ["仅 lead_review 时填写需定向旁听把关的 memberId（否则 []）"],
				confidence: "high | medium | low",
				headline: "一句话简洁中文建议（例如：建议由「产品经理」牵头 · 单兵直办）",
				reasoning: "2~3 句说明主责、阵型或岗位缺口的判断依据，直接指出贴合的职责或边界原因",
				gapSuggestion: null,
			},
			null,
			2,
		),
		'（当 `fitStatus` 为 `"gap_detected"` 时，`gapSuggestion` 填 `{ "missingRoleTitle": "...", "suggestedJob": "...", "suggestedAntiJobs": ["..."], "suggestedInteractionStyle": "lead_direct | consult_specialist | risk_observer | mixed", "suggestedWorkspaceScope": "no_repo_docs | read_only_repo | read_write_code", "reason": "..." }`，否则填 `null`。）',
	].join("\n");

	const userPrompt = [
		`## 当前团队业务成员（共 ${pool.length} 位）\n${rosterDescription || "（暂无成员）"}`,
		hasWorkspace
			? `## 关联项目工作区\n- 名称：${input.workspaceName ?? "当前仓库"}（路径：${input.workspacePath}）`
			: "## 关联项目工作区\n- 未绑定代码仓库（通用讨论/文稿场景）",
		`## 用户需求草稿\n${truncateInline(prompt, 2000)}${input.hasImages ? "\n（注：附带了图片，当前决策阶段不直接解析图片像素细节）" : ""}`,
	].join("\n\n");

	const validationContext = {
		members: pool,
		primaryId: primary?.id ?? null,
		explicitMemberId: explicitBusinessId,
		hasWorkspace,
	};
	const cutoff = Date.now() + (input.timeoutMs ?? (useRepoRead ? 60_000 : 10_000));
	let decision: ValidatedInitiationDecision | null = null;
	let toolExecutions: PiDecisionResult<ValidatedInitiationDecision>["toolExecutions"] = [];
	if (deps.classifier && !useRepoRead) {
		try {
			const candidate = await classifyInitiation(deps.classifier, {
				prompt,
				rosterDescription,
				pool,
				explicitLead: explicitBusinessId,
				hasWorkspace,
				hasAttachments: Boolean(input.hasImages),
				signal: input.signal,
			});
			if (candidate) decision = validateInitiationModelDecision(candidate, validationContext);
		} catch {
			input.signal.throwIfAborted();
		}
	}
	if (!decision) {
		const timeout = Math.max(1, cutoff - Date.now());
		const deadline = AbortSignal.any([input.signal, AbortSignal.timeout(timeout)]);
		try {
			({ decision, toolExecutions } = await runTypedPiDecision(
				{
					cwd: input.workspacePath ?? deps.defaultCwd,
					modelSelection: deps.selectModel?.(primary?.id),
					workerFactory: deps.workerFactory,
				},
				{
					name: "matter_initiation_decision",
					systemPrompt,
					userPrompt,
					tools: useRepoRead ? ["read"] : [],
					validate: (raw) =>
						validateInitiationModelDecision(raw, {
							members: pool,
							primaryId: primary?.id ?? null,
							explicitMemberId: explicitBusinessId,
							hasWorkspace,
						}),
				},
				{
					timeoutMs: timeout,
					signal: deadline,
				},
			));
		} catch {
			input.signal.throwIfAborted();
			return assessMatterInitiation({
				...input,
				hasWorkspace,
				members: deps.members,
				templatesByRoleId: deps.templatesByRoleId,
			});
		}
	}
	input.signal.throwIfAborted();
	// Tool availability is not read evidence. Only retain completed successful reads whose
	// resolved files are inside the selected workspace (including symlink resolution).
	const repoReadPaths = new Set<string>();
	if (useRepoRead && input.workspacePath) {
		const root = await realpath(input.workspacePath);
		for (const execution of toolExecutions) {
			if (execution.toolName !== "read" || execution.isError || execution.result === undefined) continue;
			const args = execution.args;
			if (!args || typeof args !== "object" || !("path" in args) || typeof args.path !== "string") continue;
			const target = await realpath(resolve(root, args.path)).catch(() => null);
			if (!target) continue;
			const path = relative(root, target);
			if (!path || isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) continue;
			repoReadPaths.add(path.split(sep).join("/"));
		}
	}
	input.signal.throwIfAborted();

	const selectedAiSet = new Set<string>([
		...(decision.recommendedLeadId ? [decision.recommendedLeadId] : []),
		...decision.recommendedConsultIds,
		...decision.recommendedObserverIds,
	]);
	const candidates: MatterInitiationCandidate[] = pool
		.map((member) => {
			const lead = member.id === decision.recommendedLeadId;
			const observe = decision.recommendedObserverIds.includes(member.id);
			const consult = decision.recommendedConsultIds.includes(member.id);
			return {
				memberId: member.id,
				displayName: member.displayName,
				roleTitle: member.roleTitle,
				tools: deps.templatesByRoleId.get(member.templateId)?.tools ?? [],
				score: lead ? 10 : observe || consult ? 6 : 0,
				matchedSignals: lead ? ["主责"] : observe ? ["旁听把关"] : consult ? ["按需请教"] : [],
			};
		})
		.sort((a, b) => b.score - a.score);

	return {
		fitStatus: decision.fitStatus,
		headline: decision.headline,
		explanation: decision.reasoning,
		recommendedMode: decision.recommendedMode,
		recommendedLeadId: decision.recommendedLeadId,
		recommendedAiMemberIds: Array.from(selectedAiSet),
		recommendedConsultIds: decision.recommendedConsultIds,
		recommendedObserverIds: decision.recommendedObserverIds,
		candidates,
		...(decision.gapSuggestion ? { gapSuggestion: decision.gapSuggestion } : {}),
		assessmentSource: "model",
		confidence: decision.confidence,
		repoReadEnabled: useRepoRead,
		repoReadPaths: [...repoReadPaths],
		usedRepoRead: repoReadPaths.size > 0,
	};
}
