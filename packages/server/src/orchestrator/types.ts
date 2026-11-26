import type { SkillProposalItem } from "@pa/contracts/skill-proposal";
import type { RoleTemplate } from "../roles/types.ts";
import { PiRpcWorker, type PiRpcWorkerOptions, type PromptRunResult } from "../rpc/pi-rpc-worker.ts";
import type { VerificationOutcome, VerificationRequest } from "../rpc/team-verification.ts";
import type {
	ImageContent,
	RpcExtensionUIDialogRequest,
	RpcExtensionUIResponsePayload,
	RpcModel,
	ThinkingLevel,
} from "../rpc/types.ts";
import type { PersonalAgentStore } from "../storage/repositories.ts";
import type { CollaboratorRole, Matter, MatterMessage, TeamMember, WorkspaceLink } from "../storage/types.ts";
import type { MetaArchitectBlueprintProposal, MetaArchitectRoleAdjustment } from "./architect/meta-architect.ts";
import type { DecisionClassifier } from "./architect/system-one.ts";
import type { DraftVerification } from "./execution/independent-verification.ts";
import type { StalledMember, TurnMonitor } from "./execution/turn-monitor.ts";
import type { Clarification, DecisionResponse, DecisionSource } from "./human-decision.ts";
import type { ReadPiModels } from "./runtime/model-selection.ts";

export type WorkerSessionMode = "lead" | "internal" | "observer" | "verifier";

export interface DialogContext {
	matterId: string;
	member: TeamMember;
	request: RpcExtensionUIDialogRequest;
}

export type OrchestratorDialogHandler = (
	ctx: DialogContext,
) => Promise<RpcExtensionUIResponsePayload> | RpcExtensionUIResponsePayload;

interface ActiveCollaborationMember {
	memberId: string;
	memberName: string;
	stageLabel: string;
	fromMemberId: string;
	fromMemberName: string;
}

export type ActiveDelegationProgress = ActiveCollaborationMember &
	(
		| {
				kind: "delegation";
				requestMessageId: string;
				parentRequestMessageId?: string;
				delegationNumber: number;
				verification?: true;
		  }
		| { kind: "observer" }
	);

export interface ProgressActivityItem {
	memberName: string;
	memberId?: string;
	toolCallId?: string;
	toolName?: string;
	toolStatus?: "running" | "success" | "error" | "unknown";
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
	stalledMembers?: StalledMember[];
	sourceUserMessageId?: string;
	speakerMemberId?: string;
}

export interface ProgressSnapshot {
	outcome: "completed" | "failed" | "aborted";
	stage: DispatchProgressEvent["stage"];
	label: string;
	toolName?: string;
	toolSummary?: string;
	startedAt: string;
	capturedAt: string;
	elapsedSeconds: number;
	activeDelegations?: ActiveDelegationProgress[];
	recentLogs?: ProgressActivityItem[];
	leadMemberId?: string;
	leadMemberName?: string;
}

/**
 * Freeze the most recent execution progress into a JSON-serializable snapshot attached to completed, failed, or aborted turns.
 */
export function buildProgressSnapshot(input: {
	outcome: "completed" | "failed" | "aborted";
	progress?: DispatchProgressEvent | null;
	startedAtMs: number;
	capturedAtMs?: number;
	leadMember?: { id: string; displayName: string } | null;
}): ProgressSnapshot {
	const capturedAtMs = input.capturedAtMs ?? Date.now();
	const progress = input.progress ?? {
		stage: input.outcome === "completed" ? "finalizing" : "starting",
		label:
			input.outcome === "completed"
				? "已完成回复"
				: input.outcome === "aborted"
					? "已中止执行"
					: "正在准备执行环境...",
	};
	return {
		outcome: input.outcome,
		stage: input.outcome === "completed" ? "finalizing" : progress.stage,
		label: input.outcome === "completed" ? "已完成回复" : progress.label,
		...(progress.toolName ? { toolName: progress.toolName } : {}),
		...(progress.toolSummary ? { toolSummary: progress.toolSummary } : {}),
		startedAt: new Date(input.startedAtMs).toISOString(),
		capturedAt: new Date(capturedAtMs).toISOString(),
		elapsedSeconds: Math.max(0, Math.round((capturedAtMs - input.startedAtMs) / 1000)),
		...(progress.activeDelegations?.length ? { activeDelegations: progress.activeDelegations } : {}),
		...(progress.recentLogs?.length ? { recentLogs: progress.recentLogs } : {}),
		...(input.leadMember ? { leadMemberId: input.leadMember.id, leadMemberName: input.leadMember.displayName } : {}),
	};
}

export interface RpcWorkerLike {
	start(): Promise<void>;
	stop(): Promise<void>;
	abort?(): Promise<void>;
	suspendIdleTimeout?(): () => void;
	getState(): Promise<{ sessionId: string; sessionFile?: string; model?: RpcModel; thinkingLevel?: ThinkingLevel }>;
	setModel?(provider: string, modelId: string): Promise<RpcModel>;
	getAvailableThinkingLevels?(): Promise<ThinkingLevel[]>;
	setThinkingLevel?(level: ThinkingLevel): Promise<void>;
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
		options?: {
			timeoutMs?: number;
			signal?: AbortSignal;
			images?: ImageContent[];
			onTextDelta?: (delta: string) => void;
		},
	): Promise<PromptRunResult>;
}

export type WorkerFactory = (options: PiRpcWorkerOptions) => RpcWorkerLike;

export interface TeamOrchestratorOptions {
	store: PersonalAgentStore;
	templates: RoleTemplate[];
	defaultCwd?: string;
	/** Dedicated fallback working directory for unbound matters (e.g. ~/.pa/workspaces/default). */
	defaultWorkspaceDir?: string;
	sessionDir?: string;
	skillsDir?: string;
	noSession?: boolean;
	workerFactory?: WorkerFactory;
	classifier?: DecisionClassifier;
	readPiModels?: ReadPiModels;
	onDialog?: OrchestratorDialogHandler;
	/** Operator-approved Pi extensions supplying declared custom/MCP tools. */
	extensions?: string[];
}

export interface PromptImageAttachment extends ImageContent {
	name?: string;
	url?: string;
}

export interface PromptFileAttachment {
	type: "file";
	kind: "file" | "pasted_text";
	name: string;
	mimeType: string;
	content: string;
	sizeBytes: number;
	lineCount: number;
	charCount: number;
	previewText?: string;
	url?: string;
}

export interface DispatchMatterInput {
	matterId?: string;
	title?: string;
	prompt: string;
	interactionMode?: "dispatch" | "discussion" | "conversation";
	keepMatterLead?: boolean;
	existingUserMessageId?: string;
	conversationMentionMemberIds?: string[];
	/** Recheck current server authorization after external routing, before producing a reply or running tools. */
	validateConversationAccess?: (memberId?: string) => void;
	decisionResponse?: DecisionResponse;
	images?: PromptImageAttachment[];
	files?: PromptFileAttachment[];
	preferredMemberId?: string;
	workspaceId?: string;
	orgId?: string | null;
	actorUserId?: string | null;
	/** Host-selected for local personal execution. HTTP request bodies cannot set this. */
	inheritLocalPiResources?: boolean;
	aiMemberIds?: string[] | null;
	consultMemberIds?: string[] | null;
	observersEnabled?: boolean;
	observerMemberIds?: string[];
	discussionAiEnabled?: boolean;
	author?: {
		collaboratorId: string;
		name: string;
		roleTitle: string;
		permissionRole: CollaboratorRole;
	};
	timeoutMs?: number;
	onTextDelta?: (delta: string) => void;
	onProgress?: (progress: DispatchProgressEvent) => void;
}

export interface DispatchMatterResult {
	matter: Matter;
	assignedMember: TeamMember;
	workspace: WorkspaceLink | null;
	replyText: string;
	observerMessages?: MatterMessage[];
	directReply?: MatterMessage;
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
	delegationNumber: number;
	requestMessage: MatterMessage;
	responseMessage: MatterMessage;
	answerText: string;
	clarification?: Clarification & { source?: DecisionSource };
	verification?: VerificationOutcome;
}

export interface SavedSpaceDocumentEffect {
	id: string;
	spaceId: string;
	title: string;
	revision: number;
	headCommit: string;
	docType: "plan" | "spec" | "decision" | "rule" | "note";
	memberId: string;
	summary?: string;
}

export interface ExecutionEffects {
	savedDocuments: SavedSpaceDocumentEffect[];
	skillProposals: SkillProposalItem[];
	roleBlueprints: MetaArchitectBlueprintProposal[];
	roleAdjustments: MetaArchitectRoleAdjustment[];
}

export function emptyEffects(): ExecutionEffects {
	return { savedDocuments: [], skillProposals: [], roleBlueprints: [], roleAdjustments: [] };
}

export function mergeEffects(target: ExecutionEffects, source: ExecutionEffects): void {
	for (const doc of source.savedDocuments) {
		const idx = target.savedDocuments.findIndex((existing) => existing.id === doc.id);
		if (idx < 0) target.savedDocuments.push(doc);
		else target.savedDocuments[idx] = doc;
	}
	for (const proposal of source.skillProposals) {
		const idx = target.skillProposals.findIndex((existing) => existing.name === proposal.name);
		if (idx < 0) target.skillProposals.push(proposal);
		else target.skillProposals[idx] = proposal;
	}
	for (const blueprint of source.roleBlueprints) {
		const idx = target.roleBlueprints.findIndex(
			(existing) => existing.draft.template.id === blueprint.draft.template.id,
		);
		if (idx < 0) target.roleBlueprints.push(blueprint);
		else target.roleBlueprints[idx] = blueprint;
	}
	for (const adjustment of source.roleAdjustments) {
		const idx = target.roleAdjustments.findIndex((existing) => existing.memberId === adjustment.memberId);
		if (idx < 0) target.roleAdjustments.push(adjustment);
		else target.roleAdjustments[idx] = adjustment;
	}
}

export interface MatterRun {
	settled: Promise<void>;
	finish(): void;
	controller: AbortController;
	observerPassController?: AbortController;
	cancelled: boolean;
	cancelReason?: "user" | "shutdown";
	workers: Set<RpcWorkerLike>;
	contexts: Set<string>;
	delegations: Map<string, Promise<DelegateResult>>;
	completedClarifications?: Map<number, { toDelegatorId: string; source: DecisionSource }>;
	activeDelegations: Map<string, ActiveDelegationProgress>;
	draftVerifications: Map<string, DraftVerification>;
	monitor?: TurnMonitor;
	recentLogs: ProgressActivityItem[];
	delegationCount: number;
	effects: ExecutionEffects;
	userMessageId: string;
	startedByUserId?: string | null;
	keepMatterLead?: boolean;
	inheritLocalPiResources?: boolean;
	startedAt: number;
	lastProgress?: DispatchProgressEvent;
	timeoutMs: number;
	deadlineAt: number | null;
}

export interface DelegationContext {
	discussionMode?: boolean;
	parentRequestMessageId?: string;
	handoffDocumentIds?: string[];
	verification?: VerificationRequest;
}

const TOOL_LABELS: Record<string, string> = {
	read: "读取文件",
	bash: "执行命令",
	edit: "修改文件",
	write: "写入文件",
	delegate_to_member: "委托团队成员",
	save_space_page: "保存资料",
	propose_skill: "提议沉淀 Skill 与脚本",
	read_team_roles: "读取团队角色名录",
	propose_role: "提议角色方案",
	list_available_skills: "查看可用 Skills",
	load_available_skill: "读取 Skill",
};

function parseTimeoutEnv(raw: string | undefined): number | undefined {
	if (raw === undefined || raw.trim() === "") return undefined;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function resolveTurnTimeoutMs(explicitMs?: number): number {
	if (typeof explicitMs === "number" && Number.isFinite(explicitMs) && explicitMs >= 0) {
		return explicitMs;
	}
	const turnEnvTimeout = parseTimeoutEnv(process.env.PA_TURN_TIMEOUT_MS);
	if (turnEnvTimeout !== undefined) {
		return turnEnvTimeout;
	}
	const promptEnvTimeout = parseTimeoutEnv(process.env.PA_PROMPT_TIMEOUT_MS);
	if (promptEnvTimeout !== undefined) {
		return promptEnvTimeout;
	}
	// Default to Goal/Plan mode without a fixed wall-clock turn cutoff; guarded by worker idle watchdog and explicit abort.
	return 0;
}

export function formatToolAction(toolName?: string): string {
	if (!toolName) return "处理工具";
	return TOOL_LABELS[toolName] ?? `调用 ${toolName}`;
}

export function truncateInline(text: string, maxLen = 52): string {
	const single = text.replace(/\s+/g, " ").trim();
	if (single.length <= maxLen) return single;
	return `${single.slice(0, maxLen - 1)}…`;
}

export function summarizeToolArgs(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const record = args as Record<string, unknown>;
	if (typeof record.name === "string" && record.name.trim()) {
		return truncateInline(`${record.name}${typeof record.resource === "string" ? ` / ${record.resource}` : ""}`, 52);
	}
	if (typeof record.path === "string" && record.path.trim()) {
		const parts = record.path.trim().split("/").filter(Boolean);
		const compact = parts.length > 2 ? parts.slice(-2).join("/") : record.path.trim();
		return truncateInline(compact, 48);
	}
	if (typeof record.command === "string" && record.command.trim()) {
		return truncateInline(record.command, 320);
	}
	if (typeof record.title === "string" && record.title.trim()) {
		return truncateInline(record.title, 44);
	}
	if (typeof record.content === "string" && record.content.trim()) {
		return truncateInline(record.content, 44);
	}
	if (typeof record.task === "string" && record.task.trim()) {
		return truncateInline(record.task, 40);
	}
	return "";
}

export function pushRunLog(
	run: MatterRun,
	memberName: string,
	summary: string,
	tool?: { memberId: string; toolCallId: string; toolName: string },
): void {
	const cleaned = summary.trim();
	if (!cleaned) return;
	const prev = run.recentLogs.at(-1);
	if (!tool && prev && prev.memberName === memberName && prev.summary === cleaned) return;
	run.recentLogs.push({
		memberName,
		summary: cleaned,
		at: new Date().toISOString(),
		...(tool ? { ...tool, toolStatus: "running" as const } : {}),
	});
	if (run.recentLogs.length > 60) {
		run.recentLogs.splice(0, run.recentLogs.length - 60);
	}
}

export function summarizeActiveDelegations(
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

export function summarizeObserverProgress(
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

export const OBSERVER_SILENT_SENTINEL = "[SILENT]";

export function isObserverSilentReply(rawText: string): boolean {
	const trimmed = rawText.trim();
	if (!trimmed) return true;
	const unwrapped = trimmed.replace(/^`+|`+$/g, "").trim();
	if (/^\[\s*SILENT\s*\](?:[\s\p{P}]|$)/iu.test(unwrapped)) return true;
	return /^\[?\s*(?:SILENT|PASS|NOOP|无需补充|暂无异议|无需发言)\s*\]?[.!。！]*$/iu.test(unwrapped);
}

export function mapChildStageLabel(childProgress: DispatchProgressEvent, defaultThinkingLabel = "思考分析"): string {
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

export function emptyAbortedResult(): PromptRunResult {
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

export function formatAbortedReply(rawReply: string, cancelReason?: "user" | "shutdown"): string {
	const prefix = cancelReason === "shutdown" ? "[服务重启中断]" : "[已中断执行]";
	const fallback =
		cancelReason === "shutdown"
			? "服务正在关闭或重启，本次执行已安全暂停；服务恢复后回复“继续”即可接续推进。"
			: "已按你的要求停止本次执行。";
	return rawReply ? `${prefix}\n\n${rawReply}` : fallback;
}

export function defaultWorkerFactory(options: PiRpcWorkerOptions): RpcWorkerLike {
	return new PiRpcWorker(options);
}
