import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assessRoleCapabilities, listRoleSkillCatalog } from "../roles/capabilities.ts";
import {
	BUILTIN_ROLE_ARCHITECT_TEMPLATE,
	buildRoleDesignDraft,
	isArchitectRoleTemplate,
	normalizeRoleTools,
	normalizeRoleVerificationPlan,
	type RoleArchitectDraft,
	type RoleInteractionStyle,
	type RoleWorkspaceScope,
} from "../roles/role-architect.ts";
import type { RoleTemplate } from "../roles/types.ts";
import type { PromptRunResult } from "../rpc/pi-rpc-worker.ts";
import type { PersonalAgentStore } from "../storage/repositories.ts";
import type { TeamMember } from "../storage/types.ts";
import { resolveRoleSkills } from "./execution-context.ts";
import type { CollaborationPresetMode } from "./matter-initiation.ts";
import { extractJsonObject } from "./pi-decision.ts";
import { collectTeamHealthEvidence, formatTeamHealthEvidence, type TeamHealthEvidence } from "./team-health.ts";
import { truncateInline, type WorkerFactory } from "./types.ts";

export interface MetaArchitectMessage {
	role: "user" | "assistant";
	content: string;
}

export interface MetaArchitectBlueprintProposal {
	draft: RoleArchitectDraft;
	rationale: string;
}

export interface MetaArchitectHealthFinding {
	status: "ok" | "warn";
	title: string;
	detail: string;
	evidence?: TeamHealthEvidence[];
}

export interface MetaArchitectRoleAdjustment {
	memberId: string;
	memberName: string;
	currentTools: string[];
	suggestedTools?: string[];
	addAntiJobs?: string[];
	workflowNote?: string;
	rationale: string;
}

export interface MetaArchitectFormationSuggestion {
	mode: CollaborationPresetMode;
	existingMemberIds: string[];
	observerMemberIds: string[];
	rationale: string;
}

export interface MetaArchitectChatInput {
	messages: MetaArchitectMessage[];
	matterPrompt?: string;
	workspaceId?: string | null;
	includeHealthcheck?: boolean;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface MetaArchitectChatResult {
	reply: string;
	followUpQuestions: string[];
	healthFindings?: MetaArchitectHealthFinding[];
	roleAdjustments?: MetaArchitectRoleAdjustment[];
	blueprints: MetaArchitectBlueprintProposal[];
	recommendedFormation?: MetaArchitectFormationSuggestion;
	usedHealthcheck: boolean;
}

export interface RoleProposalPayload {
	status: "pending" | "applied" | "dismissed";
	reply?: string;
	followUpQuestions: string[];
	healthFindings?: MetaArchitectHealthFinding[];
	roleAdjustments?: MetaArchitectRoleAdjustment[];
	blueprints: MetaArchitectBlueprintProposal[];
	recommendedFormation?: MetaArchitectFormationSuggestion;
	isMidMatterConsult?: boolean;
	appliedMemberIds?: string[];
	appliedAdjustmentIds?: string[];
}

async function enrichBlueprintCapabilities(result: Pick<MetaArchitectChatResult, "blueprints">): Promise<void> {
	await Promise.all(
		result.blueprints.map(async ({ draft }) => {
			draft.capabilityReport = await assessRoleCapabilities(draft.template);
		}),
	);
}

async function architectMethodText(): Promise<string> {
	const paths = await resolveRoleSkills(BUILTIN_ROLE_ARCHITECT_TEMPLATE);
	return (await Promise.all(paths.map((path) => readFile(path, "utf8")))).join("\n\n");
}

function listBusinessMembers(store: PersonalAgentStore, templatesById: Map<string, RoleTemplate>): TeamMember[] {
	return store
		.listMembers()
		.filter(
			(m) => !isArchitectRoleTemplate(templatesById.get(m.templateId) ?? templatesById.get(m.id) ?? { id: m.id }),
		);
}

/** Collects a compact, read-only digest of recent team friction and roster coverage for Meta-Bot audits. */
export function collectTeamFrictionDigest(store: PersonalAgentStore, templatesById: Map<string, RoleTemplate>): string {
	const members = listBusinessMembers(store, templatesById);
	const matters = store.listMatters().slice(0, 12);
	const deliverables = store.listDeliverables();
	let abortedCount = 0;
	let failedCount = 0;
	let observerNotes = 0;
	let negativeFeedback = 0;

	for (const deliv of deliverables) {
		if (deliv.feedbackRating === "negative") negativeFeedback += 1;
	}
	for (const matter of matters) {
		for (const msg of store.listMessages(matter.id, "user")) {
			if (msg.metadata?.aborted === true) abortedCount += 1;
			if (msg.metadata?.failed === true) failedCount += 1;
			if (msg.metadata?.observerIntervention === true) observerNotes += 1;
		}
	}
	const candidateMemories = members
		.flatMap((m) => store.listMemberMemories(m.id))
		.filter(
			(mem) => mem.status === "candidate" || mem.category === "user_correction" || mem.category === "collaboration",
		)
		.slice(-8)
		.map((mem) => `- [${mem.memberId} · ${mem.category}] ${truncateInline(mem.content, 120)}`);

	return [
		`- 现有 AI 角色（${members.length} 位）：${members
			.map((m) => {
				const tpl = templatesById.get(m.templateId) ?? templatesById.get(m.id);
				const tools = tpl?.tools.length ? tpl.tools.join("/") : "纯文稿";
				const antiCount = tpl?.antiJobs?.length ?? 0;
				return `${m.id}(${m.displayName}, 工具:${tools}${antiCount > 0 ? `, 边界:${antiCount}` : ""})`;
			})
			.join("、")}`,
		`- 近 ${matters.length} 个事项观测：异常 ${failedCount} 次、中止 ${abortedCount} 次、旁听发言 ${observerNotes} 次；全部成果中的负反馈 ${negativeFeedback} 项。次数仅为线索，不代表原因或效果。`,
		candidateMemories.length > 0 ? `- 近期纠偏/协同候选信号：\n${candidateMemories.join("\n")}` : "",
		`- 可引用案例与配置（只代表已记录内容，不能据此认定因果）：\n${formatTeamHealthEvidence(collectTeamHealthEvidence(store, templatesById))}`,
	]
		.filter(Boolean)
		.join("\n");
}

function normalizeStyle(raw: unknown): RoleInteractionStyle {
	return raw === "lead_direct" || raw === "consult_specialist" || raw === "risk_observer" || raw === "mixed"
		? raw
		: "consult_specialist";
}

function normalizeScope(raw: unknown): RoleWorkspaceScope {
	return raw === "read_write_code" || raw === "read_only_repo" || raw === "no_repo_docs" ? raw : "read_only_repo";
}

function normalizePresetMode(raw: unknown): CollaborationPresetMode {
	return raw === "solo" || raw === "lead_consult" || raw === "lead_review" || raw === "human_first"
		? raw
		: "lead_consult";
}

/** Parses Meta-Bot output JSON into validated, least-privilege RoleArchitect drafts (never auto-creating them). */
export function parseMetaArchitectResponse(
	rawText: string,
	existingMembers: TeamMember[],
	options?: {
		templatesById?: Map<string, RoleTemplate>;
		isHealthcheck?: boolean;
		healthEvidence?: TeamHealthEvidence[];
	},
): Omit<MetaArchitectChatResult, "usedHealthcheck"> {
	const cleaned = rawText.trim();
	const parsed = extractJsonObject(rawText);
	if (!parsed) {
		return {
			reply: cleaned || "请补充说明你期望的工作流程、参与边界，或需要拆分的具体环节。",
			followUpQuestions: [],
			blueprints: [],
		};
	}

	const rec = parsed;
	const reply =
		typeof rec.reply === "string" && rec.reply.trim()
			? rec.reply.trim()
			: "我已整理出初步建议，请核对下方追问或角色草案。";
	const followUpQuestions = Array.isArray(rec.followUpQuestions)
		? rec.followUpQuestions
				.map((q) => (typeof q === "string" ? q.trim() : ""))
				.filter(Boolean)
				.slice(0, 3)
		: [];

	const businessExisting = options?.templatesById
		? existingMembers.filter(
				(m) =>
					!isArchitectRoleTemplate(
						options.templatesById!.get(m.templateId) ?? options.templatesById!.get(m.id) ?? { id: m.id },
					),
			)
		: existingMembers.filter((m) => m.id !== "role-architect");
	const memberById = new Map(businessExisting.map((m) => [m.id, m]));
	const validExistingIds = new Set(businessExisting.map((m) => m.id));
	let recommendedFormation: MetaArchitectFormationSuggestion | undefined;
	if (!options?.isHealthcheck && rec.recommendedFormation && typeof rec.recommendedFormation === "object") {
		const fm = rec.recommendedFormation as Record<string, unknown>;
		const existingIds = Array.isArray(fm.existingMemberIds)
			? fm.existingMemberIds.map(String).filter((id) => validExistingIds.has(id))
			: [];
		const observerIds = Array.isArray(fm.observerMemberIds)
			? fm.observerMemberIds.map(String).filter((id) => validExistingIds.has(id))
			: [];
		const rationale = typeof fm.rationale === "string" ? fm.rationale.trim() : "";
		if (rationale || existingIds.length > 0 || observerIds.length > 0) {
			recommendedFormation = {
				mode: normalizePresetMode(fm.mode),
				existingMemberIds: Array.from(new Set(existingIds)),
				observerMemberIds: Array.from(new Set(observerIds)),
				rationale,
			};
		}
	}

	const healthFindings: MetaArchitectHealthFinding[] = Array.isArray(rec.healthFindings)
		? rec.healthFindings
				.slice(0, 5)
				.map((item): MetaArchitectHealthFinding | null => {
					if (!item || typeof item !== "object") return null;
					const entry = item as Record<string, unknown>;
					const title = typeof entry.title === "string" ? entry.title.trim() : "";
					const detail = typeof entry.detail === "string" ? entry.detail.trim() : "";
					if (!title && !detail) return null;
					return {
						status: entry.status === "ok" ? "ok" : "warn",
						title: title || "检查项",
						detail: detail || title,
						evidence: (options?.healthEvidence ?? []).filter(
							(source) => Array.isArray(entry.evidenceIds) && entry.evidenceIds.includes(source.id),
						),
					};
				})
				.filter((item): item is MetaArchitectHealthFinding => item !== null)
		: [];

	const roleAdjustments: MetaArchitectRoleAdjustment[] = Array.isArray(rec.roleAdjustments)
		? rec.roleAdjustments
				.slice(0, 8)
				.map((item): MetaArchitectRoleAdjustment | null => {
					if (!item || typeof item !== "object") return null;
					const entry = item as Record<string, unknown>;
					const memberId = typeof entry.memberId === "string" ? entry.memberId.trim() : "";
					const member = memberById.get(memberId);
					if (!member) return null;
					const tpl = options?.templatesById?.get(member.templateId) ?? options?.templatesById?.get(member.id);
					const currentTools = tpl?.tools ?? [];
					const suggestedTools = Array.isArray(entry.suggestedTools)
						? normalizeRoleTools(entry.suggestedTools.map(String))
						: undefined;
					const addAntiJobs = Array.isArray(entry.addAntiJobs)
						? entry.addAntiJobs.map((s) => String(s).trim()).filter(Boolean)
						: undefined;
					const workflowNote =
						typeof entry.workflowNote === "string" && entry.workflowNote.trim()
							? entry.workflowNote.trim()
							: undefined;
					const rationale = typeof entry.rationale === "string" ? entry.rationale.trim() : "";
					if (suggestedTools === undefined && (!addAntiJobs || addAntiJobs.length === 0) && !workflowNote) {
						return null;
					}
					return {
						memberId: member.id,
						memberName: member.displayName,
						currentTools,
						...(suggestedTools !== undefined ? { suggestedTools } : {}),
						...(addAntiJobs && addAntiJobs.length > 0 ? { addAntiJobs } : {}),
						...(workflowNote ? { workflowNote } : {}),
						rationale,
					};
				})
				.filter((item): item is MetaArchitectRoleAdjustment => item !== null)
		: [];

	const rawBlueprints = Array.isArray(rec.blueprints) ? rec.blueprints.slice(0, 4) : [];
	const reservedIds = existingMembers.map((m) => m.id);
	const blueprints: MetaArchitectBlueprintProposal[] = [];

	for (const item of rawBlueprints) {
		if (!item || typeof item !== "object") continue;
		const bp = item as Record<string, unknown>;
		const oneJob = typeof bp.oneJob === "string" ? bp.oneJob.trim() : "";
		if (!oneJob) continue;
		const antiJobs = Array.isArray(bp.antiJobs)
			? bp.antiJobs.map((s) => String(s).trim()).filter(Boolean)
			: undefined;
		const keywords = Array.isArray(bp.keywords)
			? bp.keywords.map((s) => String(s).trim()).filter(Boolean)
			: undefined;
		const draft = buildRoleDesignDraft({
			oneJob,
			antiJobs,
			quietWhen: typeof bp.quietWhen === "string" ? bp.quietWhen : undefined,
			interactionStyle: normalizeStyle(bp.interactionStyle),
			workspaceScope: normalizeScope(bp.workspaceScope),
			roleId: typeof bp.id === "string" ? bp.id : undefined,
			roleName:
				typeof bp.name === "string"
					? bp.name
					: typeof bp.roleName === "string"
						? bp.roleName
						: typeof bp.displayName === "string"
							? bp.displayName
							: undefined,
			roleTitle:
				typeof bp.title === "string" ? bp.title : typeof bp.roleTitle === "string" ? bp.roleTitle : undefined,
			keywords,
			workflowRules: typeof bp.workflowRules === "string" ? bp.workflowRules : undefined,
			constraints: typeof bp.constraints === "string" ? bp.constraints : undefined,
			skills: Array.isArray(bp.skills)
				? bp.skills.filter((value): value is string => typeof value === "string")
				: [],
			mcpDependencies: Array.isArray(bp.mcpDependencies)
				? bp.mcpDependencies.filter((value): value is string => typeof value === "string")
				: [],
			communicationStyle: typeof bp.communicationStyle === "string" ? bp.communicationStyle : undefined,
			verificationPlan: normalizeRoleVerificationPlan(bp.verificationPlan),
			existingMemberIds: reservedIds,
		});
		reservedIds.push(draft.template.id);
		blueprints.push({
			draft,
			rationale: typeof bp.rationale === "string" ? bp.rationale.trim() : "",
		});
	}

	return {
		reply,
		followUpQuestions,
		...(healthFindings.length > 0 ? { healthFindings } : {}),
		...(roleAdjustments.length > 0 ? { roleAdjustments } : {}),
		blueprints,
		recommendedFormation,
	};
}

export interface MetaArchitectDeps {
	store: PersonalAgentStore;
	defaultCwd: string;
	workerFactory: WorkerFactory;
	templatesById: Map<string, RoleTemplate>;
}

export const ARCHITECT_SYSTEM_INSTRUCTIONS = [
	"你是 Personal Agent 的 **Role Architect（Meta-Bot 角色架构师）**，职责边界非常明确：",
	"- 你只负责设计、诊断、拆分或精简团队 AI 角色与人机协作阵型，绝不直接替业务岗位下场干业务活。",
	"- 不依赖泛行业大而全预设库，必须结合用户真实描述的工作流、人类拍板节点、团队现有成员来设计。",
	"",
	"## 角色设计标尺（严格遵守）",
	"1. **One Job（单核心职责）**：每个角色只干好 1 件明确的事，禁止制造大而全杂役。",
	"2. **Explicit Anti-Jobs（明确不做清单）+ 静默原则**：每个非代码/审核/旁听角色必须明确写出绝不越权做的事，以及无实质增量时何时保持静默（[SILENT]）。",
	"3. **Least-Privilege Tools（最小权限工具，不留多余工具）**：`workspaceScope` 只能选 `no_repo_docs`（纯思考文稿，零工具）、`read_only_repo`（仅只读核查）或 `read_write_code`（确需改代码跑命令才给）。",
	"4. **控制人数与避免重复造人**：优先复用现有合适成员；若确实缺 1 个或多个互补角色，可以一次在 `blueprints` 中规划 1~4 个职责互不重叠的新角色（例如起草者 + 独立风控旁听者），并说明他们和人类员工如何配合。",
	"5. 仅追问会改变工作目标、能力或验收的缺口，最多三个；已明确的内容不重复问，信息足够时直接给最小方案。蓝图可携带 skills、mcpDependencies、communicationStyle 和 verificationPlan。选择适用的已安装 Skill；缺少依赖明确说明，不编造集成已可用。",
	"- 创建后的验证计划要有真实小任务、结果标准和职责边界；没有实际运行不得声称角色已验证。具体设计方法见显式加载的 role-design Skill。",
	"  verificationPlan 可为简短文本，或完整对象 { task, successCriteria, boundaryCheck }，三个字段均为非空文本；没有验证计划时明确说明缺口。",
	"6. **团队协作体检专项规则**：当用户在做团队协作体检（查看现有分工重叠、工具过宽、运行摩擦）时：",
	"   - `reply` 只保留 1 句简明总结，**严禁把 ①②③④ 塞成一整段密文字**；",
	'   - 把各维度检查结果拆成清晰的 `healthFindings` 数组（每项标注 `status: "ok" | "warn"`、简短 `title` 与 1 句 `detail`）；',
	"   - 如需收窄已有成员的 `tools` 或追加 `antiJobs` / `workflowNote`，必须放入 `roleAdjustments`（供用户勾选确认后自动修改对应角色），**不要只在话术里写“确认收窄”而不给结构化提案**；",
	"   - 纯团队体检时 `recommendedFormation` 必须置为 `null`（不要输出假造的“几人参与体检复盘”事项阵型）。",
	"   - 每条发现用 evidenceIds 引用宿主给出的配置或案例 ID，不编造来源。次数和候选经验只提供线索，不自动表示能力不足；没有具体问题时允许 healthFindings/roleAdjustments 均为空。",
	"",
	"## 严格输出格式（仅返回合法 JSON，不要附带其它 markdown 围栏外文本）",
	JSON.stringify(
		{
			reply: "1~2 句简洁中文总评或追问",
			followUpQuestions: ["可选短回复1", "短回复2"],
			healthFindings: [
				{
					status: "ok | warn",
					title: "检查维度简短标题（例如：职责重叠度 / 工具权限过宽）",
					detail: "一句具体依据与结论",
					evidenceIds: ["role:product-manager 或宿主提供的实际案例 ID"],
				},
			],
			roleAdjustments: [
				{
					memberId: "已有成员id（例如 product-manager）",
					suggestedTools: ["read"],
					addAntiJobs: ["仅梳理范围与验收，不执行命令行脚本"],
					workflowNote: "重发委托时需附带清晰背景简报（可选）",
					rationale: "一句说明为什么要做此收窄或补充边界",
				},
			],
			recommendedFormation: null,
			blueprints: [],
		},
		null,
		2,
	),
	'（说明：如果是按新工作流规划新角色而非团队体检，可省略 `healthFindings` / `roleAdjustments`，改填 `recommendedFormation: { mode, existingMemberIds, observerMemberIds, rationale }` 与 `blueprints: [{ id: "英文kebab-id如ux-designer", name: "2~6字中文短角色名如交互设计师", title: "English Title如UX Designer", oneJob: "一句话唯一核心职责", antiJobs: ["明确不做边界1"], interactionStyle: "consult_specialist | risk_observer | lead_direct", workspaceScope: "read_only_repo | no_repo_docs | read_write_code", rationale: "定位理由" }]`。务必给每个 blueprint 提供简短中文 `name` 与英文 `id`/`title`，切勿把长句职责填进 `name`。）',
].join("\n");

/** Builds read-only live roster, health digest, and JSON proposal contract for an in-matter Role Architect turn. */
export async function buildArchitectMatterContext(
	deps: { store: PersonalAgentStore; templatesById: Map<string, RoleTemplate> },
	options?: { isMidMatterConsult?: boolean },
): Promise<string> {
	const businessMembers = listBusinessMembers(deps.store, deps.templatesById);
	const rosterLines = businessMembers
		.map((m) => {
			const tpl = deps.templatesById.get(m.templateId) ?? deps.templatesById.get(m.id);
			const resp = truncateInline(tpl?.sections.responsibilitiesAndBoundaries ?? "", 160);
			const tools = tpl?.tools.length ? tpl.tools.join(", ") : "无工具(纯文稿)";
			const anti = tpl?.antiJobs?.length ? ` | Anti-Jobs: ${tpl.antiJobs.join("; ")}` : "";
			return `- ${m.id} | ${m.displayName} (${m.roleTitle}) | 工具: [${tools}] | Skills: [${tpl?.skills.join(",") ?? ""}] | MCP声明（未核验）: [${tpl?.mcpDependencies.join(",") ?? ""}]${anti}${resp ? ` | 职责: ${resp}` : ""}`;
		})
		.join("\n");
	const healthDigest = collectTeamFrictionDigest(deps.store, deps.templatesById);
	const midMatterHint = options?.isMidMatterConsult
		? "\n> 当前模式：你正在一个**已进行中的业务事项中被中途请入**。请结合此前对话卡点，给出精简诊断、必要的 `blueprints`（可一键新建并加入当前事项）或 `roleAdjustments`（收窄/补充边界），不接管原主负责人的日常业务推进。"
		: "";

	return [
		ARCHITECT_SYSTEM_INSTRUCTIONS + midMatterHint,
		`## 岗位设计方法\n${await architectMethodText()}`,
		`## 已安装方法目录（文件存在不代表任务效果已验证）\n${JSON.stringify(await listRoleSkillCatalog())}`,
		`## 当前已有业务 AI 成员（共 ${businessMembers.length} 位）\n${rosterLines || "（暂无业务成员）"}`,
		`## 团队近期运行摩擦与健康摘要\n${healthDigest}`,
	].join("\n\n");
}

/** Parses an in-matter Role Architect turn output into clean prose + interactive inline proposal metadata. */
export async function buildArchitectMessageProposals(
	rawText: string,
	store: PersonalAgentStore,
	templatesById: Map<string, RoleTemplate>,
	options?: { promptText?: string; isMidMatterConsult?: boolean },
): Promise<{ replyText: string; roleProposals?: RoleProposalPayload }> {
	const existingMembers = store.listMembers();
	const isHealthcheck = /(?:体检|诊断|重叠|收窄|冗余|权限过宽|摩擦)/i.test(options?.promptText ?? "");
	const parsed = parseMetaArchitectResponse(rawText, existingMembers, {
		templatesById,
		isHealthcheck,
		healthEvidence: collectTeamHealthEvidence(store, templatesById),
	});
	await enrichBlueprintCapabilities(parsed);
	const hasStructured =
		parsed.followUpQuestions.length > 0 ||
		(parsed.healthFindings && parsed.healthFindings.length > 0) ||
		(parsed.roleAdjustments && parsed.roleAdjustments.length > 0) ||
		parsed.blueprints.length > 0 ||
		Boolean(parsed.recommendedFormation);
	if (!hasStructured) {
		return { replyText: parsed.reply };
	}
	return {
		replyText: parsed.reply,
		roleProposals: {
			status: "pending",
			followUpQuestions: parsed.followUpQuestions,
			...(parsed.healthFindings ? { healthFindings: parsed.healthFindings } : {}),
			...(parsed.roleAdjustments ? { roleAdjustments: parsed.roleAdjustments } : {}),
			blueprints: parsed.blueprints,
			...(parsed.recommendedFormation ? { recommendedFormation: parsed.recommendedFormation } : {}),
			...(options?.isMidMatterConsult ? { isMidMatterConsult: true } : {}),
		},
	};
}

/**
 * Conversational Meta-Bot (`dr-eggbot-v2` style Role Architect):
 * runs read-only without tools/extensions, interviews user preferences, audits team friction,
 * and proposes 1..N tightly-scoped role blueprints that require explicit user confirmation to materialize.
 */
export async function runMetaArchitectChat(
	deps: MetaArchitectDeps,
	input: MetaArchitectChatInput & { signal: AbortSignal },
): Promise<MetaArchitectChatResult> {
	if (input.messages.length === 0) {
		throw new Error("At least one user message is required");
	}
	const allMembers = deps.store.listMembers();
	const members = listBusinessMembers(deps.store, deps.templatesById);
	const primary =
		members.find((m) => m.isPrimaryContact) ?? members[0] ?? deps.store.getPrimaryContact() ?? allMembers[0];
	const workspace = input.workspaceId ? deps.store.getWorkspace(input.workspaceId) : null;
	const cwd = resolve(workspace?.repoPath ?? deps.defaultCwd);

	const rosterLines = members
		.map((m) => {
			const tpl = deps.templatesById.get(m.templateId) ?? deps.templatesById.get(m.id);
			const resp = truncateInline(tpl?.sections.responsibilitiesAndBoundaries ?? "", 160);
			const tools = tpl?.tools.length ? tpl.tools.join(", ") : "无工具(纯文稿)";
			const anti = tpl?.antiJobs?.length ? ` | Anti-Jobs: ${tpl.antiJobs.join("; ")}` : "";
			return `- ${m.id} | ${m.displayName} (${m.roleTitle}) | 工具: [${tools}] | Skills: [${tpl?.skills.join(",") ?? ""}] | MCP声明（未核验）: [${tpl?.mcpDependencies.join(",") ?? ""}]${anti}${resp ? ` | 职责: ${resp}` : ""}`;
		})
		.join("\n");

	const transcript = input.messages
		.slice(-12)
		.map((msg) => `${msg.role === "user" ? "用户" : "Meta-Bot 架构师"}：${truncateInline(msg.content, 1600)}`)
		.join("\n\n");

	const healthDigest = input.includeHealthcheck ? collectTeamFrictionDigest(deps.store, deps.templatesById) : "";

	const systemPrompt = `${ARCHITECT_SYSTEM_INSTRUCTIONS}\n\n## 岗位设计方法\n${await architectMethodText()}`;

	const prompt = [
		`## 已安装方法目录（文件存在，不代表履职效果）\n${JSON.stringify(await listRoleSkillCatalog())}`,
		`## 当前已有团队成员（共 ${members.length} 位）\n${rosterLines || "（暂无）"}`,
		workspace
			? `## 当前关联工作区\n- ${workspace.name} (${workspace.repoPath})`
			: "## 当前关联工作区\n- 通用工作区（未绑定代码仓库）",
		input.matterPrompt ? `## 用户正在发起的事项草稿\n${truncateInline(input.matterPrompt, 1200)}` : "",
		healthDigest ? `## 团队近期运行摩擦与健康摘要\n${healthDigest}` : "",
		`## 对话历史\n${transcript}`,
	]
		.filter(Boolean)
		.join("\n\n");

	const methodPaths = await resolveRoleSkills(BUILTIN_ROLE_ARCHITECT_TEMPLATE);
	const worker = deps.workerFactory({
		cwd,
		provider: primary?.provider ?? "kimi-coding",
		model: primary?.model ?? "kimi-for-coding",
		noSession: true,
		args: [
			"--no-extensions",
			"--no-skills",
			"--no-mcp",
			...methodPaths.flatMap((path) => ["--skill", path]),
			"--tools",
			"",
		],
		env: { PA_META_ARCHITECT_SYSTEM: systemPrompt },
	});
	const onAbortWorker = () => {
		void worker.abort?.().catch(() => {});
		void worker.stop().catch(() => {});
	};
	input.signal.addEventListener("abort", onAbortWorker, { once: true });

	let result: PromptRunResult;
	try {
		await worker.start();
		input.signal.throwIfAborted();
		result = await worker.runPromptAndWait(`${systemPrompt}\n\n---\n\n${prompt}`, {
			timeoutMs: input.timeoutMs ?? 120_000,
			signal: input.signal,
		});
	} finally {
		input.signal.removeEventListener("abort", onAbortWorker);
		await worker.stop().catch(() => {});
	}
	if (result.aborted || input.signal.aborted) {
		throw new Error("Role architect session was aborted");
	}
	const parsed = parseMetaArchitectResponse(result.assistantText, allMembers, {
		templatesById: deps.templatesById,
		isHealthcheck: Boolean(input.includeHealthcheck),
		healthEvidence: collectTeamHealthEvidence(deps.store, deps.templatesById),
	});
	await enrichBlueprintCapabilities(parsed);
	return {
		...parsed,
		usedHealthcheck: Boolean(input.includeHealthcheck),
	};
}
