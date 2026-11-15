import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { RoleTemplate } from "../roles/types.ts";
import type { PromptRunResult } from "../rpc/pi-rpc-worker.ts";
import type { ImageContent } from "../rpc/types.ts";
import type { PersonalAgentStore } from "../storage/repositories.ts";
import type { Deliverable, Matter, MemberMemory, Organization, TeamMember, WorkspaceLink } from "../storage/types.ts";
import { delegateBetweenMembers } from "./delegation-runner.ts";
import { performDistillationPass } from "./distiller.ts";
import { validateDelivery } from "./execution-context.ts";
import { runObserversPass } from "./observer-runner.ts";
import { buildMemberSystemPrompt } from "./prompts.ts";
import {
	buildProgressSnapshot,
	type DelegateInput,
	type DelegateResult,
	type DispatchMatterInput,
	type DispatchMatterResult,
	type DispatchProgressEvent,
	type DistillExperiencesInput,
	type DistillExperiencesResult,
	defaultWorkerFactory,
	type ExecutionEffects,
	emptyAbortedResult,
	emptyEffects,
	formatAbortedReply,
	type MatterRun,
	type OrchestratorDialogHandler,
	resolveTurnTimeoutMs,
	type TeamOrchestratorOptions,
	type WorkerFactory,
} from "./types.ts";
import { type ExecuteWorkerInput, executeWithWorkerPass } from "./worker-runner.ts";

export {
	type ActiveDelegationProgress,
	buildProgressSnapshot,
	type DelegateInput,
	type DelegateResult,
	type DialogContext,
	type DispatchMatterInput,
	type DispatchMatterResult,
	type DispatchProgressEvent,
	type DistillExperiencesInput,
	type DistillExperiencesResult,
	isObserverSilentReply,
	OBSERVER_SILENT_SENTINEL,
	type OrchestratorDialogHandler,
	type ProgressActivityItem,
	type ProgressSnapshot,
	type PromptImageAttachment,
	type RpcWorkerLike,
	type TeamOrchestratorOptions,
	type WorkerFactory,
} from "./types.ts";

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
	private readonly distillations = new Map<string, Set<AbortController>>();
	private readonly distillationTasks = new Set<Promise<void>>();
	private shuttingDown = false;
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

	getDefaultCwd(): string {
		return this.defaultCwd;
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

	private resolveMatterAiMembers(matter: Matter | null): TeamMember[] {
		const all = this.store.listMembers();
		if (!matter || matter.aiMemberIds === null) return all;
		const allowed = new Set(matter.aiMemberIds);
		if (matter.leadMemberId) allowed.add(matter.leadMemberId);
		const filtered = all.filter((member) => allowed.has(member.id));
		return filtered.length > 0 ? filtered : all;
	}

	/**
	 * Route an incoming task to the most appropriate team member ("按事找人").
	 */
	routeMemberForRequest(prompt: string, preferredMemberId?: string, allowedMemberIds?: string[] | null): TeamMember {
		const allMembers = this.store.listMembers();
		if (allMembers.length === 0) {
			throw new Error("No team members registered in store");
		}
		const allowedSet = allowedMemberIds ? new Set(allowedMemberIds) : null;
		const members = allowedSet ? allMembers.filter((member) => allowedSet.has(member.id)) : allMembers;
		const pool = members.length > 0 ? members : allMembers;

		if (preferredMemberId) {
			const explicit = this.store.getMember(preferredMemberId);
			if (!explicit) {
				throw new Error(`Unknown team member: ${preferredMemberId}`);
			}
			return explicit;
		}

		const lowerPrompt = prompt.toLowerCase();
		let bestMember: TeamMember | null = null;
		let bestScore = 0;

		for (const member of pool) {
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

		const primary = this.store.getPrimaryContact();
		if (primary && (!allowedSet || allowedSet.has(primary.id))) {
			return primary;
		}
		return pool[0]!;
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
		organization?: Organization | null;
		repoGitUser?: { name: string; email: string } | null;
		taskPrompt?: string;
		isInternalDelegation?: boolean;
		sessionMode?: "lead" | "internal" | "observer";
		matterId?: string;
	}): string {
		const organization =
			input.organization !== undefined
				? input.organization
				: input.workspace?.orgId
					? this.store.getOrganization(input.workspace.orgId)
					: null;
		const matterForPrompt = input.matterId ? this.store.getMatter(input.matterId) : null;
		return buildMemberSystemPrompt({
			...input,
			organization,
			teamMembers: this.resolveMatterAiMembers(matterForPrompt),
		});
	}

	isMatterRunning(matterId: string): boolean {
		return this.runs.has(matterId) || this.store.hasLiveMatterLease(matterId);
	}

	async dispatchMatter(input: DispatchMatterInput): Promise<DispatchMatterResult> {
		if (this.shuttingDown) throw new Error("Orchestrator is shutting down");
		const existing = input.matterId ? this.requireMatter(input.matterId) : null;
		if (existing && this.isMatterRunning(existing.id)) throw new Error("Matter already has an active turn");
		const assignedMember = this.routeMemberForRequest(
			input.prompt,
			input.preferredMemberId ?? existing?.leadMemberId ?? undefined,
			existing ? existing.aiMemberIds : input.aiMemberIds,
		);
		const workspaceId = input.workspaceId ?? existing?.workspaceId;
		const workspace = workspaceId ? this.store.getWorkspace(workspaceId) : null;
		if (workspaceId && !workspace) throw new Error(`Unknown workspace: ${workspaceId}`);
		const images = (input.images ?? []).filter(
			(item) =>
				item &&
				item.type === "image" &&
				typeof item.data === "string" &&
				item.data.length > 0 &&
				typeof item.mimeType === "string" &&
				item.mimeType.length > 0,
		);
		const rpcImages: ImageContent[] = images.map(({ data, mimeType }) => ({ type: "image", data, mimeType }));
		const imageMetadataRefs = images.map((item, idx) => ({
			...(item.url ? { url: item.url } : {}),
			mimeType: item.mimeType,
			name: item.name || `image-${idx + 1}`,
		}));
		const trimmedPrompt = input.prompt.trim();
		const fallbackTitle = trimmedPrompt
			? trimmedPrompt.slice(0, 60)
			: images.length === 1
				? `图片：${images[0]?.name ?? "上传图片"}`.slice(0, 60)
				: images.length > 1
					? `上传了 ${images.length} 张图片`
					: "新事项";
		let matter =
			existing ??
			this.store.createMatter({
				title: input.title ?? fallbackTitle,
				leadMemberId: assignedMember.id,
				workspaceId: workspace?.id,
				aiMemberIds: input.aiMemberIds,
				observersEnabled: input.observersEnabled,
				observerMemberIds: input.observerMemberIds,
			});
		const ownerId = randomUUID();
		if (!this.store.acquireMatterLease(matter.id, ownerId)) throw new Error("Matter already has an active turn");
		const turnDeadlineMs = resolveTurnTimeoutMs(input.timeoutMs);
		const completion = Promise.withResolvers<void>();
		const startedAt = Date.now();
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
			effects: emptyEffects(),
			userMessageId: "",
			startedAt,
			timeoutMs: turnDeadlineMs,
			deadlineAt: turnDeadlineMs > 0 ? startedAt + turnDeadlineMs : null,
		};
		const emitDispatchProgress = (progress: DispatchProgressEvent) => {
			const normalized: DispatchProgressEvent = {
				...progress,
				activeDelegations:
					progress.activeDelegations ??
					(run.activeDelegations.size > 0 ? [...run.activeDelegations.values()] : undefined),
				recentLogs: progress.recentLogs ?? (run.recentLogs.length > 0 ? [...run.recentLogs] : undefined),
			};
			run.lastProgress = normalized;
			input.onProgress?.(normalized);
		};
		this.runs.set(matter.id, run);
		const deadline =
			turnDeadlineMs > 0
				? setTimeout(
						() =>
							run.controller.abort(
								new Error(`Matter turn timed out after ${Math.round(turnDeadlineMs / 1000)}s`),
							),
						turnDeadlineMs,
					)
				: undefined;
		try {
			if (matter.leadMemberId !== assignedMember.id) {
				matter = this.store.updateMatterLead(matter.id, assignedMember.id);
			}
			this.store.updateMatterWorkspace(matter.id, workspace?.id ?? null);
			if (existing && input.observerMemberIds !== undefined) {
				matter = this.store.updateMatterObservers(matter.id, input.observerMemberIds);
			}
			this.store.updateMatterStatus(matter.id, "open");
			if (input.author && input.author.permissionRole !== "owner") {
				this.store.addMatterCollaborator(matter.id, input.author.collaboratorId);
			}

			const message = this.store.appendMessage({
				matterId: matter.id,
				channel: "user",
				senderType: "user",
				senderId: input.author?.collaboratorId ?? "user",
				content: input.prompt,
				metadata: {
					workspaceId: workspace?.id ?? null,
					repoPath: resolve(workspace?.repoPath ?? this.defaultCwd),
					...(input.author
						? {
								authorId: input.author.collaboratorId,
								authorName: input.author.name,
								authorRole: input.author.roleTitle,
								permissionRole: input.author.permissionRole,
							}
						: {}),
					...(imageMetadataRefs.length > 0 ? { images: imageMetadataRefs } : {}),
				},
			});
			run.userMessageId = message.id;
			const effectiveTaskPrompt =
				trimmedPrompt.length > 0
					? input.prompt
					: `请查看用户随消息附带的 ${rpcImages.length} 张图片，结合图片内容理解需求并直接回复。`;
			let result: PromptRunResult;
			try {
				result = await this.executeWithWorker({
					matterId: matter.id,
					member: assignedMember,
					workspace,
					taskPrompt: effectiveTaskPrompt,
					images: rpcImages.length > 0 ? rpcImages : undefined,
					isInternalDelegation: false,
					run,
					chain: [assignedMember.id],
					signal: run.controller.signal,
					effectsTarget: run.effects,
					onTextDelta: input.onTextDelta,
					onProgress: emitDispatchProgress,
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
				run.effects.deliveries.length === 0
			) {
				run.effects.deliveries.push({
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
					run.effects.deliveries.map(async (entry) => ({
						...entry,
						draft: await validateDelivery(entry.draft, entry.cwd),
					})),
				);
				run.controller.signal.throwIfAborted();
				const outcome = this.store.recordTurnOutcome({
					deliverables: validated.map(({ memberId, draft }) => ({
						matterId: matter.id,
						memberId,
						type: draft.type,
						title: draft.title,
						contentOrPath: draft.content,
						summary: [draft.summary, `交付依据：${draft.changeNote}`].filter(Boolean).join("\n"),
						serviceUrl: draft.type === "service_url" ? draft.content : null,
					})),
					candidates: run.effects.experiences,
					applicationIds: run.effects.applicationIds,
				});
				deliveries.push(...outcome.deliverables);
				for (const memory of outcome.memories)
					this.store.appendMessage({
						matterId: matter.id,
						channel: "notice",
						senderType: "system",
						senderId: memory.memberId,
						content: JSON.stringify({
							method: "rsi_candidate_proposed",
							memoryId: memory.id,
							scope: memory.scope,
							category: memory.category,
							content: memory.content,
						}),
						metadata: {
							workspaceId: workspace?.id ?? null,
							repoPath: resolve(workspace?.repoPath ?? this.defaultCwd),
						},
					});
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
					...(aborted
						? {
								progressSnapshot: buildProgressSnapshot({
									outcome: "aborted",
									progress: run.lastProgress,
									startedAtMs: run.startedAt,
									leadMember: assignedMember,
								}),
							}
						: {}),
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
					? await runObserversPass(
							{
								store: this.store,
								defaultCwd: this.defaultCwd,
								executeWithWorker: (workerInput) => this.executeWithWorker(workerInput),
							},
							{
								matter: updatedMatter,
								assignedMember,
								workspace,
								userPrompt: input.prompt,
								userImages: rpcImages.length > 0 ? rpcImages : undefined,
								leadReply: replyText,
								leadMessageId: leadMessage.id,
								observers: observerCandidates,
								run,
								signal: run.controller.signal,
								onProgress: emitDispatchProgress,
							},
						)
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
						progressSnapshot: buildProgressSnapshot({
							outcome: "aborted",
							progress: run.lastProgress,
							startedAtMs: run.startedAt,
							leadMember: assignedMember,
						}),
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
			if (deadline) clearTimeout(deadline);
			run.controller.abort(new Error("Turn finished"));
			this.runs.delete(matter.id);
			this.store.releaseMatterLease(matter.id, ownerId);
			run.finish();
		}
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		for (const matterId of this.distillations.keys()) {
			this.abortDistillation(matterId);
		}
		const runs = [...this.runs.entries()];
		await Promise.allSettled([...this.distillationTasks, ...runs.map(([id]) => this.abortMatter(id, "shutdown"))]);
		await Promise.allSettled(runs.map(([, run]) => run.settled));
	}

	abortDistillation(matterId: string): boolean {
		const controllers = this.distillations.get(matterId);
		if (!controllers || controllers.size === 0) return false;
		for (const controller of controllers) {
			controller.abort(new Error("Experience distillation was aborted"));
		}
		return true;
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
		if (this.shuttingDown) throw new Error("Orchestrator is shutting down");
		if (this.isMatterRunning(input.matterId)) throw new Error("Use the active worker's delegation tool");
		const matter = this.requireMatter(input.matterId);
		const workspaceId = input.workspaceId ?? matter.workspaceId;
		const workspace = workspaceId ? this.store.getWorkspace(workspaceId) : null;
		if (workspaceId && !workspace) throw new Error(`Unknown workspace: ${workspaceId}`);
		const ownerId = randomUUID();
		if (!this.store.acquireMatterLease(matter.id, ownerId)) throw new Error("Matter already has an active turn");
		const turnDeadlineMs = resolveTurnTimeoutMs(input.timeoutMs);
		const completion = Promise.withResolvers<void>();
		const startedAt = Date.now();
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
			effects: emptyEffects(),
			userMessageId: "",
			startedAt,
			timeoutMs: turnDeadlineMs,
			deadlineAt: turnDeadlineMs > 0 ? startedAt + turnDeadlineMs : null,
		};
		this.runs.set(matter.id, run);
		try {
			return await this.delegate(input, run, workspace, [input.fromMemberId], run.controller.signal, run.effects);
		} finally {
			run.controller.abort();
			this.runs.delete(matter.id);
			this.store.releaseMatterLease(matter.id, ownerId);
			run.finish();
		}
	}

	private delegate(
		input: DelegateInput,
		run: MatterRun,
		workspace: WorkspaceLink | null,
		chain: string[],
		signal: AbortSignal,
		effectsTarget: ExecutionEffects,
		onProgress?: (progress: DispatchProgressEvent) => void,
	): Promise<DelegateResult> {
		return delegateBetweenMembers(
			{
				store: this.store,
				executeWithWorker: (workerInput) => this.executeWithWorker(workerInput),
			},
			input,
			run,
			workspace,
			chain,
			signal,
			effectsTarget,
			onProgress,
		);
	}

	private executeWithWorker(input: ExecuteWorkerInput): Promise<PromptRunResult> {
		return executeWithWorkerPass(
			{
				store: this.store,
				defaultCwd: this.defaultCwd,
				sessionDir: this.sessionDir,
				noSession: this.noSession,
				extensions: this.extensions,
				workerFactory: this.workerFactory,
				getDialogHandler: () => this.dialogHandler,
				getTemplateForMember: (member) => this.getTemplateForMember(member),
				resolveMatterAiMembers: (matter) => this.resolveMatterAiMembers(matter),
				requireMatter: (matterId) => this.requireMatter(matterId),
				delegate: (dInput, run, workspace, chain, signal, effectsTarget, onProgress) =>
					this.delegate(dInput, run, workspace, chain, signal, effectsTarget, onProgress),
			},
			input,
		);
	}

	private requireMatter(matterId: string): Matter {
		const matter = this.store.getMatter(matterId);
		if (!matter) throw new Error(`Matter not found: ${matterId}`);
		return matter;
	}

	/**
	 * Run an isolated RSI reflection pass over a matter / deliverable / feedback
	 * to extract bounded candidate experiences separated by scope.
	 */
	async distillExperiences(input: DistillExperiencesInput): Promise<DistillExperiencesResult> {
		if (this.shuttingDown) throw new Error("Orchestrator is shutting down");
		const controller = new AbortController();
		const completion = Promise.withResolvers<void>();
		const onCallerAbort = () => controller.abort(new Error("Experience distillation was aborted"));
		input.signal?.throwIfAborted();
		input.signal?.addEventListener("abort", onCallerAbort, { once: true });
		const controllers = this.distillations.get(input.matterId) ?? new Set<AbortController>();
		this.distillations.set(input.matterId, controllers);
		controllers.add(controller);
		this.distillationTasks.add(completion.promise);
		try {
			return await performDistillationPass(
				{
					store: this.store,
					defaultCwd: this.defaultCwd,
					workerFactory: this.workerFactory,
					requireMatter: (matterId) => this.requireMatter(matterId),
					routeMemberForRequest: (prompt, preferredMemberId) =>
						this.routeMemberForRequest(prompt, preferredMemberId),
				},
				{ ...input, signal: controller.signal },
			);
		} catch (error) {
			if (controller.signal.aborted) throw new Error("Experience distillation was aborted", { cause: error });
			throw error;
		} finally {
			input.signal?.removeEventListener("abort", onCallerAbort);
			controllers.delete(controller);
			if (!controllers.size) this.distillations.delete(input.matterId);
			this.distillationTasks.delete(completion.promise);
			completion.resolve();
		}
	}
}
