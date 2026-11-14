import type { RoleTemplate } from "../roles/types.ts";
import { PiRpcWorker, type PiRpcWorkerOptions, type PromptRunResult } from "../rpc/pi-rpc-worker.ts";
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
		options?: { timeoutMs?: number; onTextDelta?: (delta: string) => void },
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
	deliverable: Deliverable;
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

	constructor(options: TeamOrchestratorOptions) {
		this.store = options.store;
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
		for (const tpl of templates) {
			this.templatesById.set(tpl.id, tpl);
			const member = this.store.upsertMember({
				id: tpl.id,
				templateId: tpl.id,
				displayName: tpl.name,
				roleTitle: tpl.title,
				isPrimaryContact: tpl.isPrimaryContact,
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
		taskPrompt: string;
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
			sections.push("## 协作模式\n这是一次团队内部的角色委托协作。请从本职视角直接给出有依据的判断、风险与结论。");
		}

		sections.push(`## 当前任务\n${input.taskPrompt}`);
		return sections.join("\n\n");
	}

	/**
	 * Dispatch a user task into a Matter, execute via an isolated Pi RPC worker,
	 * collect silent notices & interactive approvals, and persist a versioned Deliverable.
	 */
	async dispatchMatter(input: DispatchMatterInput): Promise<DispatchMatterResult> {
		const assignedMember = this.routeMemberForRequest(input.prompt, input.preferredMemberId);
		const workspace = input.workspaceId ? this.store.getWorkspace(input.workspaceId) : null;
		if (input.workspaceId && !workspace) {
			throw new Error(`Unknown workspace: ${input.workspaceId}`);
		}

		const matter = input.matterId
			? this.requireMatter(input.matterId)
			: this.store.createMatter({
					title: input.title ?? input.prompt.slice(0, 60),
					summary: "",
					leadMemberId: assignedMember.id,
					workspaceId: workspace?.id ?? null,
				});

		this.store.appendMessage({
			matterId: matter.id,
			channel: "user",
			senderType: "user",
			senderId: "user",
			content: input.prompt,
		});

		const runResult = await this.executeWithWorker({
			matterId: matter.id,
			member: assignedMember,
			workspace,
			taskPrompt: input.prompt,
			isInternalDelegation: false,
			timeoutMs: input.timeoutMs,
			onTextDelta: input.onTextDelta,
			onProgress: input.onProgress,
		});

		const replyText = runResult.assistantText.trim();

		this.store.appendMessage({
			matterId: matter.id,
			channel: "user",
			senderType: "member",
			senderId: assignedMember.id,
			content: replyText,
			metadata: {
				disposition: runResult.disposition,
				toolsUsed: runResult.toolExecutions.map((t) => t.toolName),
			},
		});

		const deliverable = this.store.recordDeliverable({
			matterId: matter.id,
			memberId: assignedMember.id,
			type: input.deliverableType ?? "document",
			title: input.deliverableTitle ?? `${matter.title} · 交付成果`,
			summary: replyText.slice(0, 200),
			contentOrPath: replyText,
		});

		const updatedMatter = this.store.updateMatterStatus(
			matter.id,
			runResult.aborted ? "open" : "delivered",
			replyText.slice(0, 200),
		);

		return {
			matter: updatedMatter,
			assignedMember,
			workspace,
			replyText,
			deliverable,
			runResult,
		};
	}

	/**
	 * Perform an internal role-to-role delegation recorded under `channel: "internal_collab"`
	 * so user-facing channels remain clean while collaboration traces are preserved.
	 */
	async delegateToMember(input: DelegateInput): Promise<DelegateResult> {
		const matter = this.requireMatter(input.matterId);
		const fromMember = this.store.getMember(input.fromMemberId);
		const toMember = this.store.getMember(input.toMemberId);
		if (!fromMember) throw new Error(`Unknown delegating member: ${input.fromMemberId}`);
		if (!toMember) throw new Error(`Unknown target member: ${input.toMemberId}`);

		const effectiveWorkspaceId = input.workspaceId ?? matter.workspaceId;
		const workspace = effectiveWorkspaceId ? this.store.getWorkspace(effectiveWorkspaceId) : null;

		const requestMessage = this.store.appendMessage({
			matterId: matter.id,
			channel: "internal_collab",
			senderType: "member",
			senderId: fromMember.id,
			content: `@${toMember.displayName}: ${input.question}`,
			metadata: { toMemberId: toMember.id, workspaceId: workspace?.id ?? null },
		});

		const runResult = await this.executeWithWorker({
			matterId: matter.id,
			member: toMember,
			workspace,
			taskPrompt: input.question,
			isInternalDelegation: true,
			timeoutMs: input.timeoutMs,
		});

		const answerText = runResult.assistantText.trim();
		const responseMessage = this.store.appendMessage({
			matterId: matter.id,
			channel: "internal_collab",
			senderType: "member",
			senderId: toMember.id,
			content: answerText,
			metadata: { replyToMemberId: fromMember.id, toolsUsed: runResult.toolExecutions.map((t) => t.toolName) },
		});

		return {
			fromMember,
			toMember,
			requestMessage,
			responseMessage,
			answerText,
		};
	}

	private async executeWithWorker(input: {
		matterId: string;
		member: TeamMember;
		workspace: WorkspaceLink | null;
		taskPrompt: string;
		isInternalDelegation: boolean;
		timeoutMs?: number;
		onTextDelta?: (delta: string) => void;
		onProgress?: (progress: DispatchProgressEvent) => void;
	}): Promise<PromptRunResult> {
		const template = this.getTemplateForMember(input.member);
		const memories = this.store.listRelevantMemories(input.member.id, input.workspace?.id ?? null);
		const fullPrompt = this.buildMemberPrompt({
			member: input.member,
			template,
			memories,
			workspace: input.workspace,
			taskPrompt: input.taskPrompt,
			isInternalDelegation: input.isInternalDelegation,
		});

		const worker = this.workerFactory({
			cwd: input.workspace?.repoPath ?? this.defaultCwd,
			provider: input.member.provider,
			model: input.member.model,
			sessionDir: this.sessionDir,
			noSession: this.noSession,
		});

		const offEvent = worker.onEvent?.((event) => {
			if (event.type === "agent_start" || event.type === "turn_start") {
				input.onProgress?.({ stage: "thinking", label: `${input.member.displayName}正在分析与思考...` });
			} else if (event.type === "tool_execution_start") {
				const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
				input.onProgress?.({
					stage: "tool",
					toolName,
					label: `${input.member.displayName}正在执行 ${toolName}...`,
				});
			} else if (event.type === "tool_execution_end") {
				input.onProgress?.({ stage: "thinking", label: `${input.member.displayName}正在整理结果...` });
			}
		});

		const offNotice = worker.onNotice((notice) => {
			this.store.appendMessage({
				matterId: input.matterId,
				channel: "notice",
				senderType: "system",
				senderId: input.member.id,
				content: JSON.stringify(notice),
			});
		});

		worker.setDialogHandler(async (request) => {
			if (!this.dialogHandler) {
				return { cancelled: true };
			}
			input.onProgress?.({
				stage: "waiting_user",
				label: `${input.member.displayName}需要你确认：${request.title}`,
			});
			this.store.updateMatterStatus(input.matterId, "waiting_user");
			try {
				return await this.dialogHandler({
					matterId: input.matterId,
					member: input.member,
					request,
				});
			} finally {
				input.onProgress?.({ stage: "thinking", label: `${input.member.displayName}已收到确认，继续推进...` });
				this.store.updateMatterStatus(input.matterId, "open");
			}
		});

		input.onProgress?.({
			stage: "starting",
			label: `正在为${input.member.displayName}启动工作区${input.workspace ? `（${input.workspace.name}）` : ""}...`,
		});
		await worker.start();
		try {
			const state = await worker.getState();
			if (worker.setThinkingLevel) {
				await worker.setThinkingLevel(input.member.thinkingLevel);
			}
			this.store.recordWorkerSession({
				memberId: input.member.id,
				matterId: input.matterId,
				workspaceId: input.workspace?.id ?? null,
				piSessionId: state.sessionId,
				sessionFile: state.sessionFile ?? null,
				status: "active",
			});

			input.onProgress?.({ stage: "thinking", label: `${input.member.displayName}已接单，开始处理...` });
			const result = await worker.runPromptAndWait(fullPrompt, {
				timeoutMs: input.timeoutMs,
				onTextDelta: input.onTextDelta,
			});
			input.onProgress?.({ stage: "finalizing", label: `${input.member.displayName}已完成，正在归拢交付...` });
			return result;
		} finally {
			offEvent?.();
			offNotice();
			await worker.stop();
		}
	}

	private requireMatter(matterId: string): Matter {
		const matter = this.store.getMatter(matterId);
		if (!matter) {
			throw new Error(`Matter not found: ${matterId}`);
		}
		return matter;
	}
}
