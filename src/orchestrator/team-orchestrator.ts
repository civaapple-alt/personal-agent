import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RoleTemplate } from "../roles/types.ts";
import { PiRpcWorker, type PiRpcWorkerOptions, type PromptRunResult } from "../rpc/pi-rpc-worker.ts";
import { abortable, createTeamToolBridge, type TeamToolCall } from "../rpc/team-tool-bridge.ts";
import type { RpcExtensionUIDialogRequest, RpcExtensionUIResponsePayload } from "../rpc/types.ts";
import type { PersonalAgentStore } from "../storage/repositories.ts";
import type {
	Deliverable,
	DeliverableType,
	Matter,
	MatterMessage,
	MemberMemory,
	TeamMember,
	WorkspaceLink,
} from "../storage/types.ts";
import { type DeliveryDraft, resolveRoleSkills, validateDelivery, validateSavedSession } from "./execution-context.ts";

export interface DialogContext {
	matterId: string;
	member: TeamMember;
	request: RpcExtensionUIDialogRequest;
}

export type OrchestratorDialogHandler = (
	ctx: DialogContext,
) => Promise<RpcExtensionUIResponsePayload> | RpcExtensionUIResponsePayload;

export interface ActiveDelegationProgress {
	memberId: string;
	memberName: string;
	stageLabel: string;
}

export interface ProgressActivityItem {
	memberName: string;
	summary: string;
	at: string;
}

export interface DispatchProgressEvent {
	stage: "starting" | "thinking" | "tool" | "waiting_user" | "finalizing";
	label: string;
	toolName?: string;
	toolSummary?: string;
	activeDelegations?: ActiveDelegationProgress[];
	recentLogs?: ProgressActivityItem[];
	collabUpdated?: boolean;
}

export interface RpcWorkerLike {
	start(): Promise<void>;
	stop(): Promise<void>;
	abort?(): Promise<void>;
	suspendIdleTimeout?(): () => void;
	getState(): Promise<{ sessionId: string; sessionFile?: string }>;
	setThinkingLevel?(level: TeamMember["thinkingLevel"]): Promise<void>;
	onEvent?(listener: (event: { type: string; [key: string]: unknown }) => void): () => void;
	onNotice(listener: (notice: { method: string; [key: string]: unknown }) => void): () => void;
	setDialogHandler(
		handler:
			| ((
					req: RpcExtensionUIDialogRequest,
			  ) => Promise<RpcExtensionUIResponsePayload> | RpcExtensionUIResponsePayload)
			| undefined,
	): void;
	runPromptAndWait(
		message: string,
		options?: { timeoutMs?: number; signal?: AbortSignal; onTextDelta?: (delta: string) => void },
	): Promise<PromptRunResult>;
}

export type WorkerFactory = (options: PiRpcWorkerOptions) => RpcWorkerLike;

export interface TeamOrchestratorOptions {
	store: PersonalAgentStore;
	templates: RoleTemplate[];
	defaultCwd?: string;
	sessionDir?: string;
	noSession?: boolean;
	workerFactory?: WorkerFactory;
	onDialog?: OrchestratorDialogHandler;
	/** Operator-approved Pi extensions supplying declared custom/MCP tools. */
	extensions?: string[];
}

export interface DispatchMatterInput {
	matterId?: string;
	title?: string;
	prompt: string;
	preferredMemberId?: string;
	workspaceId?: string;
	observerMemberIds?: string[];
	deliverableType?: DeliverableType;
	deliverableTitle?: string;
	timeoutMs?: number;
	onTextDelta?: (delta: string) => void;
	onProgress?: (progress: DispatchProgressEvent) => void;
}

export interface DispatchMatterResult {
	matter: Matter;
	assignedMember: TeamMember;
	workspace: WorkspaceLink | null;
	replyText: string;
	deliverable: Deliverable | null;
	observerMessages?: MatterMessage[];
	runResult: PromptRunResult;
}

export interface DelegateInput {
	matterId: string;
	fromMemberId: string;
	toMemberId: string;
	question: string;
	workspaceId?: string;
	timeoutMs?: number;
}

export interface DelegateResult {
	fromMember: TeamMember;
	toMember: TeamMember;
	requestMessage: MatterMessage;
	responseMessage: MatterMessage;
	answerText: string;
}

interface MatterRun {
	settled: Promise<void>;
	finish(): void;
	controller: AbortController;
	cancelled: boolean;
	cancelReason?: "user" | "shutdown";
	workers: Set<RpcWorkerLike>;
	contexts: Set<string>;
	delegations: Map<string, Promise<DelegateResult>>;
	activeDelegations: Map<string, ActiveDelegationProgress>;
	recentLogs: ProgressActivityItem[];
	delegationCount: number;
	deliveries: Array<{ memberId: string; cwd: string; draft: DeliveryDraft }>;
	userMessageId: string;
	timeoutMs?: number;
}

const TOOL_LABELS: Record<string, string> = {
	read: "读取文件",
	bash: "执行命令",
	edit: "修改文件",
	write: "写入文件",
	delegate_to_member: "委托团队成员",
	publish_deliverable: "提交成果",
};

function formatToolAction(toolName?: string): string {
	if (!toolName) return "处理工具";
	return TOOL_LABELS[toolName] ?? `调用 ${toolName}`;
}

function truncateInline(text: string, maxLen = 52): string {
	const single = text.replace(/\s+/g, " ").trim();
	if (single.length <= maxLen) return single;
	return `${single.slice(0, maxLen - 1)}…`;
}

function summarizeToolArgs(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const record = args as Record<string, unknown>;
	if (typeof record.path === "string" && record.path.trim()) {
		const parts = record.path.trim().split("/").filter(Boolean);
		const compact = parts.length > 2 ? parts.slice(-2).join("/") : record.path.trim();
		return truncateInline(compact, 48);
	}
	if (typeof record.command === "string" && record.command.trim()) {
		return truncateInline(record.command, 52);
	}
	if (typeof record.title === "string" && record.title.trim()) {
		return truncateInline(record.title, 44);
	}
	if (typeof record.task === "string" && record.task.trim()) {
		return truncateInline(record.task, 40);
	}
	return "";
}

function pushRunLog(run: MatterRun, memberName: string, summary: string): void {
	const cleaned = summary.trim();
	if (!cleaned) return;
	const prev = run.recentLogs.at(-1);
	if (prev && prev.memberName === memberName && prev.summary === cleaned) return;
	run.recentLogs.push({ memberName, summary: cleaned, at: new Date().toISOString() });
	if (run.recentLogs.length > 6) {
		run.recentLogs.splice(0, run.recentLogs.length - 6);
	}
}

function summarizeActiveDelegations(
	activeDelegations: Map<string, ActiveDelegationProgress>,
	focusMemberName?: string,
	focusStageLabel?: string,
): string {
	const list = [...activeDelegations.values()];
	if (list.length === 0) return "";
	const names = list.map((entry) => entry.memberName).join("、");
	const latest =
		focusMemberName && focusStageLabel ? `${focusMemberName}：${focusStageLabel}` : list.at(-1)!.stageLabel;
	return list.length === 1 ? `已委托${names}（${latest}）` : `正在协同 ${names}（${latest}）`;
}

export const OBSERVER_SILENT_SENTINEL = "[SILENT]";

export function isObserverSilentReply(rawText: string): boolean {
	const trimmed = rawText.trim();
	if (!trimmed) return true;
	const unwrapped = trimmed.replace(/^`+|`+$/g, "").trim();
	if (/^\[\s*SILENT\s*\](?:[\s\p{P}]|$)/iu.test(unwrapped)) return true;
	return /^\[?\s*(?:SILENT|PASS|NOOP|无需补充|暂无异议|无需发言)\s*\]?[.!。！]*$/iu.test(unwrapped);
}

function mapChildStageLabel(childProgress: DispatchProgressEvent, defaultThinkingLabel = "思考分析"): string {
	if (childProgress.stage === "tool" && childProgress.toolName) {
		return childProgress.toolSummary
			? `${formatToolAction(childProgress.toolName)} ${truncateInline(childProgress.toolSummary, 24)}`
			: formatToolAction(childProgress.toolName);
	}
	if (childProgress.stage === "waiting_user") return childProgress.label;
	if (childProgress.stage === "finalizing") return "整理结论";
	if (childProgress.stage === "starting") return "启动中";
	return defaultThinkingLabel;
}

function summarizeObserverProgress(
	activeDelegations: Map<string, ActiveDelegationProgress>,
	focusMemberName?: string,
	focusStageLabel?: string,
): string {
	const list = [...activeDelegations.values()];
	if (list.length === 0) return "旁听成员已评估完毕";
	const names = list.map((entry) => entry.memberName).join("、");
	const latest =
		focusMemberName && focusStageLabel ? `${focusMemberName}：${focusStageLabel}` : list.at(-1)!.stageLabel;
	return `团队旁听 ${names}（${latest}）`;
}

function buildObserverTaskPrompt(input: { leadMember: TeamMember; userPrompt: string; leadReply: string }): string {
	const userPart = truncateInline(input.userPrompt.trim(), 2000);
	const leadPart = input.leadReply.trim().slice(0, 6000);
	return [
		"请从你的本职岗位视角快速审视本轮讨论，判断是否需要主动插话补充：",
		"",
		`【用户发言】\n${userPart}`,
		"",
		`【主负责人 ${input.leadMember.displayName}（${input.leadMember.roleTitle}）的最新回复】\n${leadPart}`,
		"",
		`如果有重要风险、关键遗漏或必须提前纠正/补充的专业建议，请直接面向用户给出简洁具体的发言；如果已妥当或暂无需要补充的实质内容，请仅回复 ${OBSERVER_SILENT_SENTINEL}。`,
	].join("\n");
}

function buildObserverContextDigest(input: {
	matter: Matter | null;
	deliverables: Deliverable[];
	history: MatterMessage[];
	includeMatterHeader: boolean;
}): string {
	const parts: string[] = [];
	if (input.includeMatterHeader && input.matter) {
		if (input.matter.title) parts.push(`事项主题：${truncateInline(input.matter.title, 120)}`);
		if (input.matter.summary) parts.push(`阶段摘要：${truncateInline(input.matter.summary, 280)}`);
		if (input.deliverables.length > 0) {
			const latestByTitle = new Map<string, Deliverable>();
			for (const item of input.deliverables) {
				const prev = latestByTitle.get(item.title);
				if (!prev || item.version > prev.version) latestByTitle.set(item.title, item);
			}
			const list = [...latestByTitle.values()].map((d) => `${d.title} (V${d.version})`).join("、");
			if (list) parts.push(`已归档成果：${truncateInline(list, 240)}`);
		}
	}
	if (input.history.length > 0) {
		const lines = input.history
			.slice(-16)
			.map((message) => `- ${message.senderType}/${message.senderId}: ${truncateInline(message.content, 400)}`);
		const headerLen = parts.join("\n").length;
		const remainingBudget = Math.max(1200, 6000 - headerLen - 32);
		const kept: string[] = [];
		let used = 0;
		for (let i = lines.length - 1; i >= 0; i -= 1) {
			const line = lines[i]!;
			if (used + line.length + 1 > remainingBudget && kept.length > 0) break;
			kept.unshift(line);
			used += line.length + 1;
		}
		parts.push(`此前最近对话摘录：\n${kept.join("\n")}`);
	}
	return parts.join("\n");
}

function emptyAbortedResult(): PromptRunResult {
	return {
		disposition: "started",
		aborted: true,
		assistantText: "",
		assistantMessages: [],
		toolExecutions: [],
		notices: [],
		dialogs: [],
		events: [],
	};
}

function formatAbortedReply(rawReply: string, cancelReason?: "user" | "shutdown"): string {
	const prefix = cancelReason === "shutdown" ? "[服务重启中断]" : "[已中断执行]";
	const fallback =
		cancelReason === "shutdown"
			? "服务正在关闭或重启，本次执行已安全暂停；服务恢复后回复“继续”即可接续推进。"
			: "已按你的要求停止本次执行。";
	return rawReply ? `${prefix}\n\n${rawReply}` : fallback;
}

function defaultWorkerFactory(options: PiRpcWorkerOptions): RpcWorkerLike {
	return new PiRpcWorker(options);
}

/**
 * Upper-layer orchestrator coordinating cross-project team members, scoped private
 * memories, internal role-to-role delegation, and isolated Pi RPC execution.
 */
export class TeamOrchestrator {
	private readonly store: PersonalAgentStore;
	private readonly templatesById = new Map<string, RoleTemplate>();
	private readonly defaultCwd: string;
	private readonly sessionDir: string | undefined;
	private readonly noSession: boolean;
	private readonly workerFactory: WorkerFactory;
	private dialogHandler: OrchestratorDialogHandler | undefined;
	private readonly runs = new Map<string, MatterRun>();
	private readonly extensions: string[];

	constructor(options: TeamOrchestratorOptions) {
		this.store = options.store;
		this.extensions = options.extensions ?? [];
		this.defaultCwd = options.defaultCwd ?? process.cwd();
		this.sessionDir = options.sessionDir;
		this.noSession = options.noSession ?? false;
		this.workerFactory = options.workerFactory ?? defaultWorkerFactory;
		this.dialogHandler = options.onDialog;
		this.syncRoleTemplates(options.templates);
	}

	setDialogHandler(handler: OrchestratorDialogHandler | undefined): void {
		this.dialogHandler = handler;
	}

	/**
	 * Sync shareable RoleTemplates into local TeamMember instances without overwriting
	 * any accumulated private memories or runtime history.
	 */
	syncRoleTemplates(templates: RoleTemplate[]): TeamMember[] {
		const synced: TeamMember[] = [];
		const primaryId =
			this.store.getPrimaryContact()?.id ?? templates.find((template) => template.isPrimaryContact)?.id;
		for (const tpl of templates) {
			this.templatesById.set(tpl.id, tpl);
			const member = this.store.upsertMember({
				id: tpl.id,
				templateId: tpl.id,
				displayName: tpl.name,
				roleTitle: tpl.title,
				isPrimaryContact: primaryId === tpl.id,
				provider: tpl.defaultProvider,
				model: tpl.defaultModel,
				thinkingLevel: tpl.thinkingLevel,
				keywords: tpl.keywords,
			});
			synced.push(member);
		}
		return synced;
	}

	getTemplateForMember(member: TeamMember): RoleTemplate | undefined {
		return this.templatesById.get(member.templateId);
	}

	listTemplates(): RoleTemplate[] {
		return [...this.templatesById.values()];
	}

	registerRoleTemplate(template: RoleTemplate): TeamMember {
		if (template.isPrimaryContact) {
			for (const existing of this.templatesById.values()) {
				existing.isPrimaryContact = existing.id === template.id;
			}
		}
		this.templatesById.set(template.id, template);
		const member = this.store.upsertMember({
			id: template.id,
			templateId: template.id,
			displayName: template.name,
			roleTitle: template.title,
			isPrimaryContact: template.isPrimaryContact,
			provider: template.defaultProvider,
			model: template.defaultModel,
			thinkingLevel: template.thinkingLevel,
			keywords: template.keywords,
		});
		if (template.isPrimaryContact) {
			return this.store.setPrimaryContact(member.id);
		}
		return member;
	}

	/**
	 * Route an incoming task to the most appropriate team member ("按事找人").
	 */
	routeMemberForRequest(prompt: string, preferredMemberId?: string): TeamMember {
		if (preferredMemberId) {
			const explicit = this.store.getMember(preferredMemberId);
			if (!explicit) {
				throw new Error(`Unknown team member: ${preferredMemberId}`);
			}
			return explicit;
		}

		const members = this.store.listMembers();
		if (members.length === 0) {
			throw new Error("No team members registered in store");
		}

		const lowerPrompt = prompt.toLowerCase();
		let bestMember: TeamMember | null = null;
		let bestScore = 0;

		for (const member of members) {
			let score = 0;
			for (const keyword of member.keywords) {
				if (lowerPrompt.includes(keyword.toLowerCase())) {
					score += 1;
				}
			}
			if (score > bestScore) {
				bestScore = score;
				bestMember = member;
			}
		}

		if (bestMember && bestScore > 0) {
			return bestMember;
		}

		return this.store.getPrimaryContact() ?? members[0]!;
	}

	/**
	 * Compose the effective prompt combining shareable role rules, scoped private
	 * memories, target workspace constraints, and the task instruction.
	 */
	buildMemberPrompt(input: {
		member: TeamMember;
		template?: RoleTemplate;
		memories: MemberMemory[];
		workspace: WorkspaceLink | null;
		taskPrompt?: string;
		isInternalDelegation?: boolean;
		sessionMode?: "lead" | "internal" | "observer";
	}): string {
		const mode = input.sessionMode ?? (input.isInternalDelegation ? "internal" : "lead");
		const sections: string[] = [
			`你当前担任 Personal Agent 团队中的【${input.member.displayName} (${input.member.roleTitle})】。`,
		];

		if (input.template) {
			if (input.template.sections.responsibilitiesAndBoundaries) {
				sections.push(`## 岗位职责与边界\n${input.template.sections.responsibilitiesAndBoundaries}`);
			}
			if (input.template.sections.skillsAndMethods) {
				sections.push(`## 工作方法\n${input.template.sections.skillsAndMethods}`);
			}
			if (input.template.sections.toolsAndEnvironment) {
				sections.push(`## 工具与环境依赖\n${input.template.sections.toolsAndEnvironment}`);
			}
			if (input.template.sections.collaborationConventions) {
				sections.push(`## 协作和沟通约定\n${input.template.sections.collaborationConventions}`);
			}
			if (input.template.sections.deliveryAndVerification) {
				sections.push(`## 交付与验收标准\n${input.template.sections.deliveryAndVerification}`);
			}
		}

		if (input.memories.length > 0) {
			const memoryLines = input.memories.map((m) => `- [${m.scope}] ${m.content}`).join("\n");
			sections.push(`## 个人与组织积累经验（私有记忆）\n${memoryLines}`);
		}

		if (input.workspace) {
			sections.push(
				`## 目标工作区约束\n- 项目：${input.workspace.name}\n- 本地路径：${input.workspace.repoPath}\n- 默认分支：${input.workspace.defaultBranch}\n- 原则：仓库自身维护的信息，以目标工作区实际文件与 Git 状态为准。`,
			);
		}

		if (mode === "internal") {
			sections.push(
				"## 协作模式\n这是一次团队内部的角色委托协作。请从本职视角直接给出有依据的判断、风险与结论。结果返回委托者，由主要负责人整合和决定正式交付；你不直接向用户登记成果。",
			);
		} else if (mode === "observer") {
			sections.push(
				`## 旁听与主动发言规则\n你当前作为旁听同事列席主负责人与用户的实时讨论会议。\n- 仅当从你的本职专业视角发现关键技术/测试/业务风险、可行性冲突、重要前提遗漏，或能给出主负责人尚未覆盖的关键建议时，才直接面向用户发表简洁、有依据的补充。\n- 若主负责人已妥当回应、当前属于普通澄清/闲聊或无实质增量，请仅输出 ${OBSERVER_SILENT_SENTINEL}（不要客套、附和、复述或解释原因）。\n- 只有主负责人保留正式交付归档权，你不得代为调用 publish_deliverable，也不自行发起二次团队委托。`,
			);
		}

		sections.push(`## 当前团队
${this.store
	.listMembers()
	.map((member) => `- ${member.id}: ${member.displayName}，${member.roleTitle}`)
	.join("\n")}`);
		if (mode !== "observer")
			sections.push(
				"## 自主协作与真实成果\n你负责持续推进本轮任务。需要其他岗位的专业工作时调用 delegate_to_member，提供目标、必要事实与约束，并将同事的依据整合为用户需要的结论。内部过程不向用户逐条汇报。只有缺少信息或业务判断时询问用户。不要仅声称已咨询。\n只有负责用户交流的主成员在形成可审阅的阶段成果、用户指定版本或实质变化时，才调用 publish_deliverable。提供完整文档、实际文件或服务链接，标题保持稳定以形成版本，用 changeNote 说明本次版本的变化及依据。普通回复、需求澄清、过程进度和细小讨论调整只保留对话，不按回复长度或轮数决定交付，也不逐次要求用户批准归档。登记后必须在本轮完成必要验证。",
			);
		if (input.taskPrompt) sections.push(`## 当前任务\n${input.taskPrompt}`);
		return sections.join("\n\n");
	}

	isMatterRunning(matterId: string): boolean {
		return this.runs.has(matterId) || this.store.hasLiveMatterLease(matterId);
	}

	async dispatchMatter(input: DispatchMatterInput): Promise<DispatchMatterResult> {
		const existing = input.matterId ? this.requireMatter(input.matterId) : null;
		if (existing && this.isMatterRunning(existing.id)) throw new Error("Matter already has an active turn");
		const assignedMember = this.routeMemberForRequest(
			input.prompt,
			input.preferredMemberId ?? existing?.leadMemberId ?? undefined,
		);
		const workspaceId = input.workspaceId ?? existing?.workspaceId;
		const workspace = workspaceId ? this.store.getWorkspace(workspaceId) : null;
		if (workspaceId && !workspace) throw new Error(`Unknown workspace: ${workspaceId}`);
		let matter =
			existing ??
			this.store.createMatter({
				title: input.title ?? input.prompt.slice(0, 60),
				leadMemberId: assignedMember.id,
				workspaceId: workspace?.id,
				observerMemberIds: input.observerMemberIds,
			});
		const ownerId = randomUUID();
		if (!this.store.acquireMatterLease(matter.id, ownerId)) throw new Error("Matter already has an active turn");
		const completion = Promise.withResolvers<void>();
		const run: MatterRun = {
			settled: completion.promise,
			finish: () => completion.resolve(),
			controller: new AbortController(),
			cancelled: false,
			workers: new Set(),
			contexts: new Set(),
			delegations: new Map(),
			activeDelegations: new Map(),
			recentLogs: [],
			delegationCount: 0,
			deliveries: [],
			userMessageId: "",
			timeoutMs: input.timeoutMs,
		};
		this.runs.set(matter.id, run);
		const turnEnvTimeout = Number(process.env.PA_TURN_TIMEOUT_MS);
		const promptEnvTimeout = Number(process.env.PA_PROMPT_TIMEOUT_MS);
		const turnDeadlineMs =
			input.timeoutMs ?? (turnEnvTimeout > 0 ? turnEnvTimeout : promptEnvTimeout > 0 ? promptEnvTimeout : 5_400_000);
		const deadline = setTimeout(
			() => run.controller.abort(new Error(`Matter turn timed out after ${Math.round(turnDeadlineMs / 1000)}s`)),
			turnDeadlineMs,
		);
		try {
			this.store.updateMatterLead(matter.id, assignedMember.id);
			this.store.updateMatterWorkspace(matter.id, workspace?.id ?? null);
			if (existing && input.observerMemberIds !== undefined) {
				matter = this.store.updateMatterObservers(matter.id, input.observerMemberIds);
			}
			this.store.updateMatterStatus(matter.id, "open");
			const message = this.store.appendMessage({
				matterId: matter.id,
				channel: "user",
				senderType: "user",
				senderId: "user",
				content: input.prompt,
				metadata: { workspaceId: workspace?.id ?? null, repoPath: resolve(workspace?.repoPath ?? this.defaultCwd) },
			});
			run.userMessageId = message.id;
			let result: PromptRunResult;
			try {
				result = await this.executeWithWorker({
					matterId: matter.id,
					member: assignedMember,
					workspace,
					taskPrompt: input.prompt,
					isInternalDelegation: false,
					run,
					chain: [assignedMember.id],
					signal: run.controller.signal,
					deliveryTarget: run.deliveries,
					onTextDelta: input.onTextDelta,
					onProgress: input.onProgress,
				});
			} catch (error) {
				if (!run.cancelled) throw error;
				result = emptyAbortedResult();
			}
			const aborted = result.aborted || run.cancelled;
			if (!aborted) run.controller.signal.throwIfAborted();
			const rawReply = result.assistantText.trim();
			const replyText = aborted
				? formatAbortedReply(rawReply, run.cancelReason)
				: rawReply || "本轮未返回正文，请继续追问；执行记录保留在协作过程中。";
			// Keep explicit document exports supported by API callers. Chat has no implicit export.
			if (
				!aborted &&
				rawReply &&
				input.deliverableTitle &&
				(!input.deliverableType || input.deliverableType === "document") &&
				run.deliveries.length === 0
			) {
				run.deliveries.push({
					memberId: assignedMember.id,
					cwd: workspace?.repoPath ?? this.defaultCwd,
					draft: {
						tool: "publish_deliverable",
						callId: "explicit-export",
						changeNote: "API 调用方明确指定文档交付标题",
						type: "document",
						title: input.deliverableTitle,
						content: rawReply,
						summary: rawReply.slice(0, 200),
					},
				});
			}
			const deliveries: Deliverable[] = [];
			if (!aborted) {
				// Recheck all paths before writing any index entry. Failed/cancelled turns publish nothing.
				const validated = await Promise.all(
					run.deliveries.map(async (entry) => ({
						...entry,
						draft: await validateDelivery(entry.draft, entry.cwd),
					})),
				);
				run.controller.signal.throwIfAborted();
				deliveries.push(
					...this.store.recordDeliverables(
						validated.map(({ memberId, draft }) => ({
							matterId: matter.id,
							memberId,
							type: draft.type,
							title: draft.title,
							contentOrPath: draft.content,
							summary: [draft.summary, `交付依据：${draft.changeNote}`].filter(Boolean).join("\n"),
							serviceUrl: draft.type === "service_url" ? draft.content : null,
						})),
					),
				);
			}
			const leadMessage = this.store.appendMessage({
				matterId: matter.id,
				channel: "user",
				senderType: "member",
				senderId: assignedMember.id,
				content: replyText,
				metadata: {
					disposition: result.disposition,
					aborted,
					toolsUsed: result.toolExecutions.map((tool) => tool.toolName),
					deliverableIds: deliveries.map((delivery) => delivery.id),
					sourceUserMessageId: run.userMessageId,
					workspaceId: workspace?.id ?? null,
					repoPath: resolve(workspace?.repoPath ?? this.defaultCwd),
				},
			});
			const updatedMatter = this.store.updateMatterStatus(
				matter.id,
				deliveries.length ? "delivered" : "open",
				replyText.slice(0, 200),
			);
			const observerCandidates =
				!aborted && !run.cancelled
					? updatedMatter.observerMemberIds
							.filter((id, idx, arr) => id !== assignedMember.id && arr.indexOf(id) === idx)
							.map((id) => this.store.getMember(id))
							.filter((member): member is TeamMember => member !== null)
					: [];
			const observerMessages =
				observerCandidates.length > 0
					? await this.runObservers({
							matter: updatedMatter,
							assignedMember,
							workspace,
							userPrompt: input.prompt,
							leadReply: replyText,
							leadMessageId: leadMessage.id,
							observers: observerCandidates,
							run,
							signal: run.controller.signal,
							onProgress: input.onProgress,
						})
					: [];
			return {
				matter: updatedMatter,
				assignedMember,
				workspace,
				replyText,
				deliverable: deliveries.at(-1) ?? null,
				observerMessages,
				runResult: { ...result, aborted },
			};
		} catch (error) {
			this.store.updateMatterStatus(matter.id, "open");
			if (run.cancelled) {
				const replyText = formatAbortedReply("", run.cancelReason);
				this.store.appendMessage({
					matterId: matter.id,
					channel: "user",
					senderType: "member",
					senderId: assignedMember.id,
					content: replyText,
					metadata: {
						aborted: true,
						cancelReason: run.cancelReason ?? "user",
						workspaceId: workspace?.id ?? null,
						repoPath: resolve(workspace?.repoPath ?? this.defaultCwd),
					},
				});
				return {
					matter: this.store.updateMatterStatus(matter.id, "open"),
					assignedMember,
					workspace,
					replyText,
					deliverable: null,
					runResult: emptyAbortedResult(),
				};
			}
			if (run.controller.signal.aborted) throw run.controller.signal.reason;
			throw error;
		} finally {
			clearTimeout(deadline);
			run.controller.abort(new Error("Turn finished"));
			this.runs.delete(matter.id);
			this.store.releaseMatterLease(matter.id, ownerId);
			run.finish();
		}
	}

	async shutdown(): Promise<void> {
		const runs = [...this.runs.entries()];
		await Promise.allSettled(runs.map(([id]) => this.abortMatter(id, "shutdown")));
		await Promise.allSettled(runs.map(([, run]) => run.settled));
	}

	async abortMatter(matterId: string, reason: "user" | "shutdown" = "user"): Promise<boolean> {
		const run = this.runs.get(matterId);
		if (!run) return false;
		run.cancelled = true;
		run.cancelReason = reason;
		run.controller.abort(new Error(reason === "shutdown" ? "Server shutting down" : "Cancelled by user"));
		await Promise.allSettled(
			[...run.workers].map(async (worker) => {
				let timer: NodeJS.Timeout | undefined;
				try {
					await Promise.race([
						worker.abort?.(),
						new Promise<void>((resolve) => {
							timer = setTimeout(resolve, 1000);
						}),
					]);
				} finally {
					if (timer) clearTimeout(timer);
					await worker.stop();
				}
			}),
		);
		return true;
	}

	/** The same production path used by delegate_to_member. External callers cannot join an active turn. */
	async delegateToMember(input: DelegateInput): Promise<DelegateResult> {
		if (this.isMatterRunning(input.matterId)) throw new Error("Use the active worker's delegation tool");
		const matter = this.requireMatter(input.matterId);
		const workspaceId = input.workspaceId ?? matter.workspaceId;
		const workspace = workspaceId ? this.store.getWorkspace(workspaceId) : null;
		if (workspaceId && !workspace) throw new Error(`Unknown workspace: ${workspaceId}`);
		const ownerId = randomUUID();
		if (!this.store.acquireMatterLease(matter.id, ownerId)) throw new Error("Matter already has an active turn");
		const completion = Promise.withResolvers<void>();
		const run: MatterRun = {
			settled: completion.promise,
			finish: () => completion.resolve(),
			controller: new AbortController(),
			cancelled: false,
			workers: new Set(),
			contexts: new Set(),
			delegations: new Map(),
			activeDelegations: new Map(),
			recentLogs: [],
			delegationCount: 0,
			deliveries: [],
			userMessageId: "",
			timeoutMs: input.timeoutMs,
		};
		this.runs.set(matter.id, run);
		try {
			return await this.delegate(input, run, workspace, [input.fromMemberId], run.controller.signal, run.deliveries);
		} finally {
			run.controller.abort();
			this.runs.delete(matter.id);
			this.store.releaseMatterLease(matter.id, ownerId);
			run.finish();
		}
	}

	private async delegate(
		input: DelegateInput,
		run: MatterRun,
		workspace: WorkspaceLink | null,
		chain: string[],
		signal: AbortSignal,
		deliveryTarget: MatterRun["deliveries"],
		onProgress?: (progress: DispatchProgressEvent) => void,
	): Promise<DelegateResult> {
		signal.throwIfAborted();
		const fromMember = this.store.getMember(input.fromMemberId);
		const toMember = this.store.getMember(input.toMemberId);
		if (!fromMember || !toMember) throw new Error("Delegation requires existing team members");
		if (chain.includes(toMember.id)) throw new Error("Delegation cycle: cannot call yourself or an ancestor");
		if (chain.length >= 3) throw new Error("Delegation depth limit reached (3 members)");
		const key = JSON.stringify([fromMember.id, toMember.id, input.question.trim()]);
		const cached = run.delegations.get(key);
		if (cached) return await cached;
		if (run.delegationCount >= 8) throw new Error("Delegation limit reached (8 per user turn)");
		run.delegationCount += 1;
		const operation = (async () => {
			const requestMessage = this.store.appendMessage({
				matterId: input.matterId,
				channel: "internal_collab",
				senderType: "member",
				senderId: fromMember.id,
				content: `@${toMember.displayName}: ${input.question}`,
				metadata: { toMemberId: toMember.id, workspaceId: workspace?.id ?? null },
			});
			const delegationKey = requestMessage.id;
			pushRunLog(run, fromMember.displayName, `委托${toMember.displayName}：${truncateInline(input.question, 44)}`);
			run.activeDelegations.set(delegationKey, {
				memberId: toMember.id,
				memberName: toMember.displayName,
				stageLabel: "已接入任务",
			});
			onProgress?.({
				stage: "tool",
				label: summarizeActiveDelegations(run.activeDelegations, toMember.displayName, "已接入任务"),
				toolName: "delegate_to_member",
				activeDelegations: [...run.activeDelegations.values()],
				recentLogs: [...run.recentLogs],
				collabUpdated: true,
			});
			let childTextBuf = "";
			let lastStreamBroadcastAt = 0;
			try {
				const drafts: MatterRun["deliveries"] = [];
				const result = await this.executeWithWorker({
					deliveryTarget: drafts,
					matterId: input.matterId,
					member: toMember,
					workspace,
					taskPrompt: `来自 ${fromMember.displayName} 的内部委托：\n${input.question}`,
					isInternalDelegation: true,
					run,
					chain: [...chain, toMember.id],
					signal,
					onTextDelta: (delta) => {
						childTextBuf += delta;
						const now = Date.now();
						if (now - lastStreamBroadcastAt < 1200) return;
						const lines = childTextBuf
							.split(/\r?\n/)
							.map((line) => line.replace(/^[#*\-\s>`]+/, "").trim())
							.filter(Boolean);
						const snippet = lines.at(-1);
						if (!snippet) return;
						lastStreamBroadcastAt = now;
						const label = `撰写结论：${truncateInline(snippet, 28)}`;
						run.activeDelegations.set(delegationKey, {
							memberId: toMember.id,
							memberName: toMember.displayName,
							stageLabel: label,
						});
						onProgress?.({
							stage: "tool",
							label: summarizeActiveDelegations(run.activeDelegations, toMember.displayName, label),
							toolName: "delegate_to_member",
							activeDelegations: [...run.activeDelegations.values()],
							recentLogs: [...run.recentLogs],
						});
					},
					onProgress: (childProgress) => {
						const stageLabel = mapChildStageLabel(childProgress);
						run.activeDelegations.set(delegationKey, {
							memberId: toMember.id,
							memberName: toMember.displayName,
							stageLabel,
						});
						onProgress?.({
							stage: childProgress.stage === "waiting_user" ? "waiting_user" : "tool",
							label:
								childProgress.stage === "waiting_user"
									? childProgress.label
									: summarizeActiveDelegations(run.activeDelegations, toMember.displayName, stageLabel),
							toolName: childProgress.toolName ?? "delegate_to_member",
							activeDelegations: [...run.activeDelegations.values()],
							recentLogs: [...run.recentLogs],
						});
					},
				});
				signal.throwIfAborted();
				if (result.aborted) throw new Error("Colleague execution was aborted");
				const answerText = result.assistantText.trim();
				if (!answerText) throw new Error("Colleague returned no answer");
				deliveryTarget.push(...drafts);
				const responseMessage = this.store.appendMessage({
					matterId: input.matterId,
					channel: "internal_collab",
					senderType: "member",
					senderId: toMember.id,
					content: answerText,
					metadata: {
						replyToMemberId: fromMember.id,
						requestMessageId: requestMessage.id,
						workspaceId: workspace?.id ?? null,
					},
				});
				run.activeDelegations.delete(delegationKey);
				pushRunLog(run, toMember.displayName, "已完成委托并返回结论");
				const remaining = [...run.activeDelegations.values()];
				onProgress?.({
					stage: remaining.length > 0 ? "tool" : "thinking",
					label:
						remaining.length > 0
							? summarizeActiveDelegations(run.activeDelegations)
							: `${toMember.displayName}已返回结果，${fromMember.displayName}正在整合`,
					toolName: remaining.length > 0 ? "delegate_to_member" : undefined,
					activeDelegations: remaining,
					recentLogs: [...run.recentLogs],
					collabUpdated: true,
				});
				return { fromMember, toMember, requestMessage, responseMessage, answerText };
			} catch (error) {
				run.delegations.delete(key);
				this.store.appendMessage({
					matterId: input.matterId,
					channel: "internal_collab",
					senderType: "system",
					senderId: toMember.id,
					content: `内部委托未完成：${error instanceof Error ? error.message : String(error)}`,
					metadata: { requestMessageId: requestMessage.id, failed: true },
				});
				run.activeDelegations.delete(delegationKey);
				pushRunLog(
					run,
					toMember.displayName,
					`委托未完成：${truncateInline(error instanceof Error ? error.message : String(error), 36)}`,
				);
				const remaining = [...run.activeDelegations.values()];
				onProgress?.({
					stage: remaining.length > 0 ? "tool" : "thinking",
					label:
						remaining.length > 0
							? summarizeActiveDelegations(run.activeDelegations)
							: `${toMember.displayName}未完成委托，${fromMember.displayName}正在处理`,
					toolName: remaining.length > 0 ? "delegate_to_member" : undefined,
					activeDelegations: remaining,
					recentLogs: [...run.recentLogs],
					collabUpdated: true,
				});
				throw error;
			}
		})();
		run.delegations.set(key, operation);
		return await operation;
	}

	private async runObservers(input: {
		matter: Matter;
		assignedMember: TeamMember;
		workspace: WorkspaceLink | null;
		userPrompt: string;
		leadReply: string;
		leadMessageId: string;
		observers: TeamMember[];
		run: MatterRun;
		signal: AbortSignal;
		onProgress?: (progress: DispatchProgressEvent) => void;
	}): Promise<MatterMessage[]> {
		const createdMessages: MatterMessage[] = [];
		const taskPrompt = buildObserverTaskPrompt({
			leadMember: input.assignedMember,
			userPrompt: input.userPrompt,
			leadReply: input.leadReply,
		});
		const observerNames = input.observers.map((member) => member.displayName).join("、");
		pushRunLog(input.run, "旁听席", `${observerNames}正在审视本轮讨论`);
		for (const observer of input.observers) {
			input.run.activeDelegations.set(`obs:${observer.id}`, {
				memberId: observer.id,
				memberName: observer.displayName,
				stageLabel: "旁听审视中",
			});
		}
		input.onProgress?.({
			stage: "thinking",
			label: summarizeObserverProgress(input.run.activeDelegations),
			activeDelegations: [...input.run.activeDelegations.values()],
			recentLogs: [...input.run.recentLogs],
			collabUpdated: true,
		});

		await Promise.allSettled(
			input.observers.map(async (observer) => {
				const observerKey = `obs:${observer.id}`;
				try {
					if (input.signal.aborted || input.run.cancelled) return;
					const result = await this.executeWithWorker({
						matterId: input.matter.id,
						member: observer,
						workspace: input.workspace,
						taskPrompt,
						sessionMode: "observer",
						excludeMessageIds: [input.run.userMessageId, input.leadMessageId],
						run: input.run,
						chain: [input.assignedMember.id, observer.id],
						signal: input.signal,
						deliveryTarget: [],
						onProgress: (childProgress) => {
							const stageLabel = mapChildStageLabel(childProgress, "旁听审视中");
							input.run.activeDelegations.set(observerKey, {
								memberId: observer.id,
								memberName: observer.displayName,
								stageLabel,
							});
							input.onProgress?.({
								stage: childProgress.stage === "waiting_user" ? "waiting_user" : "thinking",
								label:
									childProgress.stage === "waiting_user"
										? childProgress.label
										: summarizeObserverProgress(
												input.run.activeDelegations,
												observer.displayName,
												stageLabel,
											),
								toolName: childProgress.toolName,
								activeDelegations: [...input.run.activeDelegations.values()],
								recentLogs: [...input.run.recentLogs],
							});
						},
					});
					input.run.activeDelegations.delete(observerKey);
					if (result.aborted || input.run.cancelled || input.signal.aborted) return;
					const text = result.assistantText.trim();
					if (isObserverSilentReply(text)) {
						pushRunLog(input.run, observer.displayName, "旁听已阅，暂无补充");
						input.onProgress?.({
							stage: "thinking",
							label: summarizeObserverProgress(input.run.activeDelegations),
							activeDelegations: [...input.run.activeDelegations.values()],
							recentLogs: [...input.run.recentLogs],
						});
						return;
					}
					const msg = this.store.appendMessage({
						matterId: input.matter.id,
						channel: "user",
						senderType: "member",
						senderId: observer.id,
						content: text,
						metadata: {
							observerIntervention: true,
							inReplyToUserMessageId: input.run.userMessageId,
							leadMemberId: input.assignedMember.id,
							toolsUsed: result.toolExecutions.map((tool) => tool.toolName),
							workspaceId: input.workspace?.id ?? null,
							repoPath: resolve(input.workspace?.repoPath ?? this.defaultCwd),
						},
					});
					createdMessages.push(msg);
					pushRunLog(input.run, observer.displayName, `旁听补充：${truncateInline(text, 44)}`);
					input.onProgress?.({
						stage: "finalizing",
						label: `${observer.displayName}补充了意见`,
						activeDelegations: [...input.run.activeDelegations.values()],
						recentLogs: [...input.run.recentLogs],
						collabUpdated: true,
					});
				} catch (error) {
					input.run.activeDelegations.delete(observerKey);
					if (input.run.cancelled || input.signal.aborted) return;
					const msg = error instanceof Error ? error.message : String(error);
					pushRunLog(input.run, observer.displayName, `旁听跳过：${truncateInline(msg, 36)}`);
					this.store.appendMessage({
						matterId: input.matter.id,
						channel: "notice",
						senderType: "system",
						senderId: observer.id,
						content: `旁听评估未完成：${msg}`,
						metadata: { observerFailed: true, leadMemberId: input.assignedMember.id },
					});
					input.onProgress?.({
						stage: "thinking",
						label: summarizeObserverProgress(input.run.activeDelegations),
						activeDelegations: [...input.run.activeDelegations.values()],
						recentLogs: [...input.run.recentLogs],
					});
				}
			}),
		);
		return createdMessages;
	}

	private async executeWithWorker(input: {
		matterId: string;
		member: TeamMember;
		workspace: WorkspaceLink | null;
		taskPrompt: string;
		isInternalDelegation?: boolean;
		sessionMode?: "lead" | "internal" | "observer";
		excludeMessageIds?: string[];
		run: MatterRun;
		chain: string[];
		signal: AbortSignal;
		deliveryTarget: MatterRun["deliveries"];
		onTextDelta?: (delta: string) => void;
		onProgress?: (progress: DispatchProgressEvent) => void;
	}): Promise<PromptRunResult> {
		input.signal.throwIfAborted();
		const sessionMode = input.sessionMode ?? (input.isInternalDelegation ? "internal" : "lead");
		const canPublish = sessionMode === "lead";
		const canDelegate = sessionMode !== "observer";
		const cwd = resolve(input.workspace?.repoPath ?? this.defaultCwd);
		const contextKey = JSON.stringify([
			"v1",
			input.workspace?.id ?? null,
			cwd,
			sessionMode === "lead" ? "user" : sessionMode,
		]);
		const executionKey = JSON.stringify([input.member.id, contextKey]);
		if (input.run.contexts.has(executionKey)) throw new Error("Colleague is already working in this conversation");
		input.run.contexts.add(executionKey);
		let worker: RpcWorkerLike | undefined;
		let sessionRecord: ReturnType<PersonalAgentStore["recordWorkerSession"]> | undefined;
		let bridge: Awaited<ReturnType<typeof createTeamToolBridge>> | undefined;
		const cleanups: Array<() => void> = [];
		const deliveries: MatterRun["deliveries"] = [];
		// A disconnected tool request cancels only that colleague subtree, not unrelated work.
		const controller = new AbortController();
		const signal = AbortSignal.any([input.signal, controller.signal]);
		try {
			const template = this.getTemplateForMember(input.member);
			const skillPaths = await resolveRoleSkills(template);
			const previous = this.noSession
				? null
				: this.store.findWorkerSession(input.matterId, input.member.id, contextKey, input.workspace?.id ?? null);
			const sessionFile = previous ? await validateSavedSession(previous, cwd) : undefined;
			const baseTools = (template?.tools ?? ["read", "bash", "edit", "write"]).filter((tool) => tool !== "mcp");
			const requestedTools =
				sessionMode === "observer" ? baseTools.filter((tool) => tool !== "edit" && tool !== "write") : baseTools;
			const mcpDependencies = template?.mcpDependencies ?? [];
			const teamTools =
				sessionMode === "observer"
					? []
					: sessionMode === "internal"
						? ["delegate_to_member"]
						: ["delegate_to_member", "publish_deliverable"];
			bridge = await createTeamToolBridge(async (call: TeamToolCall, toolSignal) => {
				toolSignal.throwIfAborted();
				const releaseIdle = worker?.suspendIdleTimeout?.();
				try {
					if (call.tool === "delegate_to_member") {
						if (!canDelegate) {
							throw new Error("Observing specialists cannot delegate secondary tasks during peer review");
						}
						const result = await this.delegate(
							{
								matterId: input.matterId,
								fromMemberId: input.member.id,
								toMemberId: call.memberId,
								question: call.task,
							},
							input.run,
							input.workspace,
							input.chain,
							toolSignal,
							deliveries,
							input.onProgress,
						);
						return { memberId: result.toMember.id, answer: result.answerText };
					}
					if (!canPublish)
						throw new Error(
							"Internal specialists return results to the lead; only the lead publishes user deliverables",
						);
					const draft = await validateDelivery(call, cwd);
					toolSignal.throwIfAborted();
					if (
						!deliveries.some(
							(entry) =>
								entry.memberId === input.member.id &&
								entry.draft.title === draft.title &&
								entry.draft.content === draft.content,
						)
					)
						deliveries.push({ memberId: input.member.id, cwd, draft });
					return { staged: true, title: draft.title, note: "本轮成功结束后归档" };
				} finally {
					releaseIdle?.();
				}
			}, signal);
			const args = [
				"--no-extensions",
				"--no-skills",
				"--extension",
				fileURLToPath(
					new URL(
						import.meta.url.endsWith(".js") ? "../rpc/team-extension.js" : "../rpc/team-extension.ts",
						import.meta.url,
					),
				),
			];
			for (const extension of this.extensions) args.push("--extension", extension);
			if (mcpDependencies.length === 0) args.push("--no-mcp");
			else args.push("--extension", "builtin:mcp");
			for (const path of skillPaths) args.push("--skill", path);
			args.push(
				"--tools",
				[...requestedTools, ...teamTools, ...mcpDependencies.map((name) => `mcp__${name}__*`)].join(","),
			);
			worker = this.workerFactory({
				cwd,
				provider: input.member.provider,
				model: input.member.model,
				sessionDir: this.sessionDir,
				sessionFile,
				noSession: this.noSession,
				args,
				env: {
					...bridge.env,
					PA_CAN_PUBLISH: String(canPublish),
					PA_CAN_DELEGATE: String(canDelegate),
					PA_REQUIRED_TOOLS: JSON.stringify([
						...requestedTools,
						...teamTools,
						...mcpDependencies.map((name) => `mcp__${name}__*`),
					]),
					PA_MEMBER_CONTEXT: this.buildMemberPrompt({
						member: input.member,
						template,
						memories: this.store.listRelevantMemories(input.member.id, input.workspace?.id ?? null),
						workspace: input.workspace,
						sessionMode,
					}),
				},
			});
			input.run.workers.add(worker);
			const offEvent = worker.onEvent?.((event) => {
				if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
					this.store.appendMessage({
						matterId: input.matterId,
						channel: "notice",
						senderType: "system",
						senderId: input.member.id,
						content: JSON.stringify(event).slice(0, 16000),
					});
					const toolName = String(event.toolName ?? "tool");
					const toolSummary = event.type === "tool_execution_start" ? summarizeToolArgs(event.args) : undefined;
					if (event.type === "tool_execution_start" && toolName !== "delegate_to_member") {
						pushRunLog(
							input.run,
							input.member.displayName,
							`${formatToolAction(toolName)}${toolSummary ? `：${toolSummary}` : ""}`,
						);
					}
					if (sessionMode === "lead" && input.run.activeDelegations.size > 0) {
						return;
					}
					if (event.type === "tool_execution_start") {
						input.onProgress?.({
							stage: "tool",
							label: `${input.member.displayName}：${formatToolAction(toolName)}${toolSummary ? `（${toolSummary}）` : ""}`,
							toolName,
							toolSummary,
							recentLogs: [...input.run.recentLogs],
						});
					} else {
						input.onProgress?.({
							stage: "thinking",
							label: `${input.member.displayName}正在分析结果`,
							toolName,
							recentLogs: [...input.run.recentLogs],
						});
					}
				} else if (event.type === "agent_start") {
					if (sessionMode === "lead" && input.run.activeDelegations.size > 0) {
						return;
					}
					input.onProgress?.({
						stage: "thinking",
						label: `${input.member.displayName}正在思考`,
						recentLogs: [...input.run.recentLogs],
					});
				}
			});
			if (offEvent) cleanups.push(offEvent);
			cleanups.push(
				worker.onNotice((notice) => {
					this.store.appendMessage({
						matterId: input.matterId,
						channel: "notice",
						senderType: "system",
						senderId: input.member.id,
						content: JSON.stringify(notice),
					});
				}),
			);
			worker.setDialogHandler(async (request) => {
				signal.throwIfAborted();
				if (!this.dialogHandler) return { cancelled: true };
				this.store.updateMatterStatus(input.matterId, "waiting_user");
				input.onProgress?.({
					stage: "waiting_user",
					label: `${input.member.displayName}需要你补充：${request.title}`,
				});
				try {
					return await abortable(
						Promise.resolve(this.dialogHandler({ matterId: input.matterId, member: input.member, request })),
						signal,
					);
				} finally {
					this.store.updateMatterStatus(input.matterId, "open");
				}
			});
			input.onProgress?.({ stage: "starting", label: `正在接续${input.member.displayName}的工作` });
			await worker.start();
			signal.throwIfAborted();
			const state = await worker.getState();
			const tools = await bridge.waitReady();
			const missing = [...requestedTools, ...teamTools].filter((name) => !tools.includes(name));
			for (const dependency of mcpDependencies)
				if (!tools.some((name) => name.startsWith(`mcp__${dependency}__`))) missing.push(`MCP:${dependency}`);
			if (missing.length) throw new Error(`Required capabilities unavailable: ${missing.join(", ")}`);
			this.store.appendMessage({
				matterId: input.matterId,
				channel: "notice",
				senderType: "system",
				senderId: input.member.id,
				content: JSON.stringify({
					method: "runtime_ready",
					tools,
					skills: skillPaths,
					resumed: Boolean(sessionFile),
					piSessionId: state.sessionId,
				}),
			});
			if (worker.setThinkingLevel) await worker.setThinkingLevel(input.member.thinkingLevel);
			const messages = this.store.listMessages(input.matterId, "user");
			const excludeIds = new Set(input.excludeMessageIds ?? [input.run.userMessageId]);
			const afterCursor = previous?.messageCursor
				? messages.findIndex((message) => message.id === previous.messageCursor) + 1
				: 0;
			const filteredHistory = messages
				.slice(afterCursor)
				.filter(
					(message) =>
						!excludeIds.has(message.id) &&
						message.metadata?.workspaceId === (input.workspace?.id ?? null) &&
						message.metadata?.repoPath === cwd &&
						!(previous && message.senderType === "member" && message.senderId === input.member.id),
				);
			const context =
				sessionMode === "observer"
					? buildObserverContextDigest({
							matter: this.store.getMatter(input.matterId),
							deliverables: this.store.listDeliverables(input.matterId),
							history: filteredHistory,
							includeMatterHeader: !previous,
						})
					: filteredHistory
							.slice(-12)
							.map((message) => `${message.senderType}/${message.senderId}: ${message.content}`)
							.join("\n\n")
							.slice(-20000);
			const contextHeader =
				sessionMode === "observer"
					? "会前背景摘要（精简回顾）："
					: "同事项、同工作区中尚未进入本会话的对话（有界背景）：";
			const prompt = `${context ? `${contextHeader}\n${context}\n\n` : ""}${input.taskPrompt}`;
			sessionRecord = this.store.recordWorkerSession({
				memberId: input.member.id,
				matterId: input.matterId,
				workspaceId: input.workspace?.id ?? null,
				piSessionId: state.sessionId,
				sessionFile: state.sessionFile ?? null,
				status: "active",
				contextKey,
				messageCursor: messages.at(-1)?.id,
			});
			const result = await worker.runPromptAndWait(prompt, {
				timeoutMs: input.run.timeoutMs,
				signal,
				onTextDelta: input.onTextDelta,
			});
			if (!result.aborted && !input.run.cancelled) input.deliveryTarget.push(...deliveries);
			if (!result.aborted && !input.run.cancelled)
				input.onProgress?.({ stage: "finalizing", label: `${input.member.displayName}正在整理结果` });
			return result;
		} finally {
			controller.abort(new Error("Worker finished"));
			for (const cleanup of cleanups) cleanup();
			await worker?.stop().catch(() => {});
			await bridge?.close();
			if (sessionRecord)
				this.store.finishWorkerSession(
					sessionRecord.id,
					sessionRecord.sessionFile && existsSync(sessionRecord.sessionFile) ? "idle" : "closed",
				);
			if (worker) input.run.workers.delete(worker);
			input.run.contexts.delete(executionKey);
		}
	}

	private requireMatter(matterId: string): Matter {
		const matter = this.store.getMatter(matterId);
		if (!matter) throw new Error(`Matter not found: ${matterId}`);
		return matter;
	}
}
