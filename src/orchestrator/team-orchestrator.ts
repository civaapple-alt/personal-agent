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

export interface DispatchProgressEvent {
	stage: "starting" | "thinking" | "tool" | "waiting_user" | "finalizing";
	label: string;
	toolName?: string;
}

export interface RpcWorkerLike {
	start(): Promise<void>;
	stop(): Promise<void>;
	abort?(): Promise<void>;
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
	workers: Set<RpcWorkerLike>;
	contexts: Set<string>;
	delegations: Map<string, Promise<DelegateResult>>;
	delegationCount: number;
	deliveries: Array<{ memberId: string; cwd: string; draft: DeliveryDraft }>;
	userMessageId: string;
	timeoutMs?: number;
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
	}): string {
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

		if (input.isInternalDelegation) {
			sections.push(
				"## 协作模式\n这是一次团队内部的角色委托协作。请从本职视角直接给出有依据的判断、风险与结论。结果返回委托者，由主要负责人整合和决定正式交付；你不直接向用户登记成果。",
			);
		}

		sections.push(`## 当前团队
${this.store
	.listMembers()
	.map((member) => `- ${member.id}: ${member.displayName}，${member.roleTitle}`)
	.join("\n")}`);
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
		const matter =
			existing ??
			this.store.createMatter({
				title: input.title ?? input.prompt.slice(0, 60),
				leadMemberId: assignedMember.id,
				workspaceId: workspace?.id,
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
			delegationCount: 0,
			deliveries: [],
			userMessageId: "",
			timeoutMs: input.timeoutMs,
		};
		this.runs.set(matter.id, run);
		const envTimeout = Number(process.env.PA_PROMPT_TIMEOUT_MS);
		const deadline = setTimeout(
			() => run.controller.abort(new Error("Matter turn timed out")),
			input.timeoutMs ?? (envTimeout > 0 ? envTimeout : 1_800_000),
		);
		try {
			this.store.updateMatterLead(matter.id, assignedMember.id);
			this.store.updateMatterWorkspace(matter.id, workspace?.id ?? null);
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
				? rawReply
					? `[已中断执行]\n\n${rawReply}`
					: "已按你的要求停止本次执行。"
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
			this.store.appendMessage({
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
			return {
				matter: updatedMatter,
				assignedMember,
				workspace,
				replyText,
				deliverable: deliveries.at(-1) ?? null,
				runResult: { ...result, aborted },
			};
		} catch (error) {
			this.store.updateMatterStatus(matter.id, "open");
			if (run.cancelled) {
				const replyText = "已按你的要求停止本次执行。";
				this.store.appendMessage({
					matterId: matter.id,
					channel: "user",
					senderType: "member",
					senderId: assignedMember.id,
					content: replyText,
					metadata: {
						aborted: true,
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
		await Promise.allSettled(runs.map(([id]) => this.abortMatter(id)));
		await Promise.allSettled(runs.map(([, run]) => run.settled));
	}

	async abortMatter(matterId: string): Promise<boolean> {
		const run = this.runs.get(matterId);
		if (!run) return false;
		run.cancelled = true;
		run.controller.abort(new Error("Cancelled by user"));
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
				return { fromMember, toMember, requestMessage, responseMessage, answerText };
			} catch (error) {
				this.store.appendMessage({
					matterId: input.matterId,
					channel: "internal_collab",
					senderType: "system",
					senderId: toMember.id,
					content: `内部委托未完成：${error instanceof Error ? error.message : String(error)}`,
					metadata: { requestMessageId: requestMessage.id, failed: true },
				});
				throw error;
			}
		})();
		run.delegations.set(key, operation);
		return await operation;
	}

	private async executeWithWorker(input: {
		matterId: string;
		member: TeamMember;
		workspace: WorkspaceLink | null;
		taskPrompt: string;
		isInternalDelegation: boolean;
		run: MatterRun;
		chain: string[];
		signal: AbortSignal;
		deliveryTarget: MatterRun["deliveries"];
		onTextDelta?: (delta: string) => void;
		onProgress?: (progress: DispatchProgressEvent) => void;
	}): Promise<PromptRunResult> {
		input.signal.throwIfAborted();
		const cwd = resolve(input.workspace?.repoPath ?? this.defaultCwd);
		const contextKey = JSON.stringify([
			"v1",
			input.workspace?.id ?? null,
			cwd,
			input.isInternalDelegation ? "internal" : "user",
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
			const requestedTools = (template?.tools ?? ["read", "bash", "edit", "write"]).filter((tool) => tool !== "mcp");
			const mcpDependencies = template?.mcpDependencies ?? [];
			const teamTools = input.isInternalDelegation
				? ["delegate_to_member"]
				: ["delegate_to_member", "publish_deliverable"];
			bridge = await createTeamToolBridge(async (call: TeamToolCall, toolSignal) => {
				toolSignal.throwIfAborted();
				if (call.tool === "delegate_to_member") {
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
					);
					return { memberId: result.toMember.id, answer: result.answerText };
				}
				if (input.isInternalDelegation)
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
					PA_CAN_PUBLISH: String(!input.isInternalDelegation),
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
						isInternalDelegation: input.isInternalDelegation,
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
					input.onProgress?.({
						stage: "tool",
						label: `${input.member.displayName}正在处理任务`,
						toolName: String(event.toolName ?? "tool"),
					});
				} else if (event.type === "agent_start")
					input.onProgress?.({ stage: "thinking", label: `${input.member.displayName}正在思考` });
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
			const afterCursor = previous?.messageCursor
				? messages.findIndex((message) => message.id === previous.messageCursor) + 1
				: 0;
			const history = messages
				.slice(afterCursor)
				.filter(
					(message) =>
						message.id !== input.run.userMessageId &&
						message.metadata?.workspaceId === (input.workspace?.id ?? null) &&
						message.metadata?.repoPath === cwd &&
						!(previous && message.senderType === "member" && message.senderId === input.member.id),
				)
				.slice(-12);
			const context = history
				.map((message) => `${message.senderType}/${message.senderId}: ${message.content}`)
				.join("\n\n")
				.slice(-20000);
			const prompt = `${context ? `同事项、同工作区中尚未进入本会话的对话（有界背景）：\n${context}\n\n` : ""}${input.taskPrompt}`;
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
