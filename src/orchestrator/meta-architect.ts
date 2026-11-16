import { resolve } from "node:path";
import {
	buildRoleDesignDraft,
	type RoleArchitectDraft,
	type RoleInteractionStyle,
	type RoleWorkspaceScope,
} from "../roles/role-architect.ts";
import type { RoleTemplate } from "../roles/types.ts";
import type { PromptRunResult } from "../rpc/pi-rpc-worker.ts";
import type { PersonalAgentStore } from "../storage/repositories.ts";
import type { TeamMember } from "../storage/types.ts";
import type { CollaborationPresetMode } from "./matter-initiation.ts";
import { truncateInline, type WorkerFactory } from "./types.ts";

export interface MetaArchitectMessage {
	role: "user" | "assistant";
	content: string;
}

export interface MetaArchitectBlueprintProposal {
	draft: RoleArchitectDraft;
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
	blueprints: MetaArchitectBlueprintProposal[];
	recommendedFormation?: MetaArchitectFormationSuggestion;
	usedHealthcheck: boolean;
}

/** Collects a compact, read-only digest of recent team friction and roster coverage for Meta-Bot audits. */
export function collectTeamFrictionDigest(store: PersonalAgentStore, templatesById: Map<string, RoleTemplate>): string {
	const members = store.listMembers();
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
		`- 近 ${matters.length} 个事项观测：异常 ${failedCount} 次、中止 ${abortedCount} 次、旁听有效插话 ${observerNotes} 次、成果负反馈 ${negativeFeedback} 项`,
		candidateMemories.length > 0 ? `- 近期纠偏/协同候选信号：\n${candidateMemories.join("\n")}` : "",
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
): Omit<MetaArchitectChatResult, "usedHealthcheck"> {
	const cleaned = rawText.trim();
	const jsonBlock = cleaned
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/i, "")
		.trim();
	const start = jsonBlock.indexOf("{");
	const end = jsonBlock.lastIndexOf("}");
	if (start === -1 || end <= start) {
		return {
			reply: cleaned || "请补充说明你期望的工作流程、参与边界，或需要拆分的具体环节。",
			followUpQuestions: [],
			blueprints: [],
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonBlock.slice(start, end + 1));
	} catch {
		return {
			reply: cleaned,
			followUpQuestions: [],
			blueprints: [],
		};
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { reply: cleaned, followUpQuestions: [], blueprints: [] };
	}

	const rec = parsed as Record<string, unknown>;
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

	const validExistingIds = new Set(existingMembers.map((m) => m.id));
	let recommendedFormation: MetaArchitectFormationSuggestion | undefined;
	if (rec.recommendedFormation && typeof rec.recommendedFormation === "object") {
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
			roleName: typeof bp.name === "string" ? bp.name : undefined,
			roleTitle: typeof bp.title === "string" ? bp.title : undefined,
			keywords,
			workflowRules: typeof bp.workflowRules === "string" ? bp.workflowRules : undefined,
			constraints: typeof bp.constraints === "string" ? bp.constraints : undefined,
			existingMemberIds: reservedIds,
		});
		reservedIds.push(draft.template.id);
		blueprints.push({
			draft,
			rationale: typeof bp.rationale === "string" ? bp.rationale.trim() : "",
		});
	}

	return { reply, followUpQuestions, blueprints, recommendedFormation };
}

export interface MetaArchitectDeps {
	store: PersonalAgentStore;
	defaultCwd: string;
	workerFactory: WorkerFactory;
	templatesById: Map<string, RoleTemplate>;
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
	const members = deps.store.listMembers();
	const primary = deps.store.getPrimaryContact() ?? members[0];
	const workspace = input.workspaceId ? deps.store.getWorkspace(input.workspaceId) : null;
	const cwd = resolve(workspace?.repoPath ?? deps.defaultCwd);

	const rosterLines = members
		.map((m) => {
			const tpl = deps.templatesById.get(m.templateId) ?? deps.templatesById.get(m.id);
			const resp = truncateInline(tpl?.sections.responsibilitiesAndBoundaries ?? "", 160);
			const tools = tpl?.tools.length ? tpl.tools.join(", ") : "无工具(纯文稿)";
			const anti = tpl?.antiJobs?.length ? ` | Anti-Jobs: ${tpl.antiJobs.join("; ")}` : "";
			return `- ${m.id} | ${m.displayName} (${m.roleTitle}) | 工具: [${tools}]${anti}${resp ? ` | 职责: ${resp}` : ""}`;
		})
		.join("\n");

	const transcript = input.messages
		.slice(-12)
		.map((msg) => `${msg.role === "user" ? "用户" : "Meta-Bot 架构师"}：${truncateInline(msg.content, 1600)}`)
		.join("\n\n");

	const healthDigest = input.includeHealthcheck ? collectTeamFrictionDigest(deps.store, deps.templatesById) : "";

	const systemPrompt = [
		"你是 Personal Agent 的 **Role Architect（Meta-Bot 角色架构师）**，职责边界非常明确：",
		"- 你只负责设计、诊断、拆分或精简团队 AI 角色与人机协作阵型，绝不直接替业务岗位下场干业务活。",
		"- 不依赖泛行业大而全预设库，必须结合用户真实描述的工作流、人类拍板节点、团队现有成员来设计。",
		"",
		"## 角色设计标尺（严格遵守）",
		"1. **One Job（单核心职责）**：每个角色只干好 1 件明确的事，禁止制造大而全杂役。",
		"2. **Explicit Anti-Jobs（明确不做清单）+ 静默原则**：每个非代码/审核/旁听角色必须明确写出绝不越权做的事，以及无实质增量时何时保持静默（[SILENT]）。",
		"3. **Least-Privilege Tools（最小权限工具，不留多余工具）**：`workspaceScope` 只能选 `no_repo_docs`（纯思考文稿，零工具）、`read_only_repo`（仅只读核查）或 `read_write_code`（确需改代码跑命令才给）。",
		"4. **控制人数与避免重复造人**：优先复用现有合适成员；若确实缺 1 个或多个互补角色，可以一次在 `blueprints` 中规划 1~4 个职责互不重叠的新角色（例如起草者 + 独立风控旁听者），并说明他们和人类员工如何配合。",
		"5. **多轮追问 vs 立即给草案**：如果用户目标还缺少关键流程边界（例如：谁最终拍板、要不要改代码、需不需要有人静默把关），先提出 2~3 个短追问（`blueprints` 留空数组 `[]`）；一旦工作流清晰，或用户明确要求出草案/体检建议，直接给出 `blueprints` 与 `recommendedFormation`，等待用户勾选确认（绝不擅自创建）。",
		"",
		"## 严格输出格式（仅返回合法 JSON，不要附带其它 markdown 围栏外文本）",
		JSON.stringify(
			{
				reply: "简洁、直接的中文回复（有追问就问在点子上，有方案就点明分工理由）",
				followUpQuestions: ["可选的短回答建议1", "建议2"],
				recommendedFormation: {
					mode: "solo | lead_consult | lead_review | human_first",
					existingMemberIds: ["可复用的现有成员id"],
					observerMemberIds: ["建议定向旁听的现有成员id"],
					rationale: "一句说明参与人数与人机分工方式",
				},
				blueprints: [
					{
						name: "中文角色名",
						title: "English Role Title",
						oneJob: "唯一核心职责",
						antiJobs: ["不做事项1", "不做事项2"],
						quietWhen: "何时保持静默",
						interactionStyle: "lead_direct | consult_specialist | risk_observer | mixed",
						workspaceScope: "no_repo_docs | read_only_repo | read_write_code",
						keywords: ["关键词1", "关键词2"],
						workflowRules: "团队流程约束（可选）",
						rationale: "为什么需要这个角色以及为什么不能并入已有角色",
					},
				],
			},
			null,
			2,
		),
	].join("\n");

	const prompt = [
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

	const worker = deps.workerFactory({
		cwd,
		provider: primary?.provider ?? "kimi-coding",
		model: primary?.model ?? "kimi-for-coding",
		noSession: true,
		args: ["--no-extensions", "--no-skills", "--no-mcp", "--tools", ""],
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
	const parsed = parseMetaArchitectResponse(result.assistantText, members);
	return {
		...parsed,
		usedHealthcheck: Boolean(input.includeHealthcheck),
	};
}
