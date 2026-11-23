import { randomUUID } from "node:crypto";
import {
	isArchitectRoleTemplate,
	type RoleArchitectDraft,
	type RoleDesignBriefInput,
} from "../roles/role-architect.ts";
import type { RoleTemplate } from "../roles/types.ts";
import { readPiModelCatalog } from "../rpc/model-catalog.ts";
import type { ModelSelection } from "../rpc/model-selection.ts";
import type { PromptRunResult } from "../rpc/pi-rpc-worker.ts";
import type { PersonalAgentStore } from "../storage/repositories.ts";
import type { Matter, MemberMemory, Organization, TeamMember, WorkspaceLink } from "../storage/types.ts";
import { decideConversationIntent } from "./conversation-intent.ts";
import { delegateBetweenMembers } from "./delegation-runner.ts";
import { performDistillationPass } from "./distiller.ts";
import { listWorkspaceTopLevelEntries } from "./execution-context.ts";
import { dispatchMatterTurn } from "./matter-dispatch.ts";
import {
	assessMatterInitiation,
	assessMatterInitiationWithModel,
	type MatterInitiationAssessment,
} from "./matter-initiation.ts";
import { type MetaArchitectChatInput, type MetaArchitectChatResult, runMetaArchitectChat } from "./meta-architect.ts";
import { type ReadPiModels, resolveConfiguredModel } from "./model-selection.ts";
import { buildMemberPrompts } from "./prompts.ts";
import { designRoleDraftWithModel } from "./role-design-decision.ts";
import type { OrchestratorRuntimeConfig } from "./runtime-info.ts";
import type { DecisionClassifier } from "./system-one.ts";
import { filterTeamMembersForScope } from "./team-health.ts";
import {
	type DelegateInput,
	type DelegateResult,
	type DelegationContext,
	type DispatchMatterInput,
	type DispatchMatterResult,
	type DispatchProgressEvent,
	type DistillExperiencesInput,
	type DistillExperiencesResult,
	defaultWorkerFactory,
	type ExecutionEffects,
	emptyEffects,
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
	type PromptFileAttachment,
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
	private readonly skillsDir: string | undefined;
	private readonly noSession: boolean;
	private readonly workerFactory: WorkerFactory;
	private classifier: DecisionClassifier | undefined;
	private readonly readPiModels: ReadPiModels;
	private readonly piModelProbes = new Map<string, ReturnType<ReadPiModels>>();
	private dialogHandler: OrchestratorDialogHandler | undefined;
	private readonly runs = new Map<string, MatterRun>();
	private readonly distillations = new Map<string, Set<AbortController>>();
	private readonly distillationTasks = new Set<Promise<void>>();
	private readonly architectControllers = new Set<AbortController>();
	private readonly architectTasks = new Set<Promise<void>>();
	private shuttingDown = false;
	private readonly extensions: string[];
	private pstackDir: string | undefined;

	constructor(options: TeamOrchestratorOptions) {
		this.store = options.store;
		this.classifier = options.classifier;
		this.extensions = options.extensions ?? [];
		this.pstackDir = options.pstackDir;
		this.defaultCwd = options.defaultCwd ?? process.cwd();
		this.sessionDir = options.sessionDir;
		this.skillsDir = options.skillsDir;
		this.noSession = options.noSession ?? false;
		this.workerFactory = options.workerFactory ?? defaultWorkerFactory;
		this.readPiModels =
			options.readPiModels ??
			(options.workerFactory
				? async () => ({ defaultModel: null, models: [] })
				: (selection) => readPiModelCatalog(this.defaultCwd, selection));
		this.dialogHandler = options.onDialog;
		this.syncRoleTemplates(options.templates);
	}

	getPiModels(selection?: ModelSelection): ReturnType<ReadPiModels> {
		const key = selection ? JSON.stringify([selection.provider, selection.model]) : "";
		const pending = this.piModelProbes.get(key);
		if (pending) return pending;
		const probe = this.readPiModels(selection).finally(() => this.piModelProbes.delete(key));
		this.piModelProbes.set(key, probe);
		return probe;
	}

	getDefaultCwd(): string {
		return this.defaultCwd;
	}

	getRuntimeConfig(): OrchestratorRuntimeConfig {
		return {
			defaultCwd: this.defaultCwd,
			sessionDir: this.sessionDir ?? null,
			noSession: this.noSession,
			extensions: [...this.extensions],
			pstackDir: this.pstackDir ?? null,
			webSearchProvider: this.store.getPlatformSettings().webSearchProvider,
			systemOneEnabled: this.store.getPlatformSettings().systemOneEnabled,
			templates: this.listTemplates(),
		};
	}

	/** Dynamically enable or disable the configured pstack method pack directory. */
	setPstackDir(pstackDir: string | undefined): void {
		this.pstackDir = pstackDir?.trim() || undefined;
	}

	/** Dynamically update or clear the System One decision classifier. */
	setClassifier(classifier: DecisionClassifier | undefined): void {
		this.classifier = classifier;
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
		const existingPrimary = this.store.getPrimaryContact();
		const validExistingPrimaryId = existingPrimary?.roleScope === "global" ? existingPrimary.id : undefined;
		const primaryId =
			validExistingPrimaryId ??
			templates.find((template) => (template.roleScope ?? "global") === "global" && template.isPrimaryContact)?.id;
		for (const tpl of templates) {
			if (this.store.isRoleTemplateRemoved(tpl.id)) continue;
			this.templatesById.set(tpl.id, tpl);
			const roleScope = tpl.roleScope ?? "global";
			const member = this.store.upsertMember({
				id: tpl.id,
				templateId: tpl.id,
				displayName: tpl.name,
				roleTitle: tpl.title,
				isPrimaryContact: roleScope === "global" && primaryId === tpl.id,

				keywords: tpl.keywords,
				roleScope,
				ownerOrgId: tpl.ownerOrgId ?? null,
				ownerUserId: tpl.ownerUserId ?? null,
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
		const roleScope = template.roleScope ?? "global";
		const isGlobalPrimary = roleScope === "global" && template.isPrimaryContact;
		if (isGlobalPrimary) {
			for (const existing of this.templatesById.values()) {
				existing.isPrimaryContact = existing.id === template.id;
			}
		}
		const normalizedTemplate: RoleTemplate = {
			...template,
			roleScope,
			ownerOrgId: roleScope === "org" ? (template.ownerOrgId ?? null) : null,
			ownerUserId: roleScope === "personal" ? (template.ownerUserId ?? null) : null,
			isPrimaryContact: isGlobalPrimary,
		};
		this.templatesById.set(normalizedTemplate.id, normalizedTemplate);
		const member = this.store.upsertMember({
			id: normalizedTemplate.id,
			templateId: normalizedTemplate.id,
			displayName: normalizedTemplate.name,
			roleTitle: normalizedTemplate.title,
			isPrimaryContact: isGlobalPrimary,

			keywords: normalizedTemplate.keywords,
			roleScope,
			ownerOrgId: normalizedTemplate.ownerOrgId,
			ownerUserId: normalizedTemplate.ownerUserId,
		});
		if (isGlobalPrimary) {
			return this.store.setPrimaryContact(member.id);
		}
		return member;
	}

	unregisterRoleTemplate(memberId: string): TeamMember {
		if (this.runs.size > 0) {
			throw new Error("有事项正在执行中，请等待当前回合完成后再删除成员");
		}
		const deleted = this.store.deleteMember(memberId);
		this.templatesById.delete(deleted.templateId);
		this.templatesById.delete(deleted.id);
		return deleted;
	}

	private isArchitectMember(member: TeamMember | null | undefined): boolean {
		if (!member) return false;
		return isArchitectRoleTemplate(
			this.templatesById.get(member.templateId) ?? this.templatesById.get(member.id) ?? { id: member.id },
		);
	}

	private resolveMatterAiMembers(matter: Matter | null, actorUserId?: string | null): TeamMember[] {
		const orgId = matter?.orgId ?? null;
		const effectiveUserId = actorUserId === undefined ? (matter?.createdByUserId ?? null) : actorUserId;
		const sharedOrgMembers = orgId
			? this.store.resolveEffectiveOrgMembers(orgId)
			: filterTeamMembersForScope(this.store.listMembers(), { actorUserId: effectiveUserId });
		const personalMembers = effectiveUserId
			? this.store.listMembers().filter((m) => m.roleScope === "personal" && m.ownerUserId === effectiveUserId)
			: [];
		const all = orgId
			? [...sharedOrgMembers, ...personalMembers.filter((p) => !sharedOrgMembers.some((s) => s.id === p.id))]
			: sharedOrgMembers;
		if (!matter || matter.aiMemberIds === null) {
			const business = all.filter((member) => {
				if (this.isArchitectMember(member) && member.id !== matter?.leadMemberId) return false;
				if (member.roleScope === "personal" && !actorUserId && matter?.createdByUserId !== member.ownerUserId) {
					return false;
				}
				return true;
			});
			return business.length > 0 ? business : all;
		}
		const allowed = new Set(matter.aiMemberIds);
		if (matter.leadMemberId) allowed.add(matter.leadMemberId);
		const filtered = all.filter((member) => {
			if (!allowed.has(member.id)) return false;
			if (member.roleScope === "personal") {
				return Boolean(
					(actorUserId && member.ownerUserId === actorUserId) ||
						(matter.createdByUserId && member.ownerUserId === matter.createdByUserId),
				);
			}
			return true;
		});
		return filtered.length > 0 ? filtered : sharedOrgMembers;
	}

	listConversationAiMembers(matter: Matter, actorUserId: string | null): TeamMember[] {
		return this.resolveMatterAiMembers(matter, actorUserId).filter(
			(member) =>
				(member.id === matter.leadMemberId ||
					(!this.isArchitectMember(member) &&
						(matter.aiMemberIds === null || matter.aiMemberIds.includes(member.id)))) &&
				(member.roleScope !== "personal" || member.ownerUserId === actorUserId),
		);
	}

	/** Members whose participation can be described in a reply shared with the whole matter. */
	listSharedMatterAiMembers(matter: Matter): TeamMember[] {
		return this.resolveMatterAiMembers(matter, null).filter(
			(member) =>
				member.roleScope !== "personal" &&
				(member.id === matter.leadMemberId ||
					(!this.isArchitectMember(member) &&
						(matter.aiMemberIds === null || matter.aiMemberIds.includes(member.id)))),
		);
	}

	/**
	 * Evaluate a draft matter before launch for role fit, recommended team size/mode, and role gaps.
	 */
	assessInitiation(input: {
		prompt: string;
		hasImages?: boolean;
		hasWorkspace?: boolean;
		preferredMemberId?: string;
		orgId?: string | null;
		actorUserId?: string | null;
	}): MatterInitiationAssessment {
		const members = input.orgId
			? this.store.resolveEffectiveOrgMembersForUser(input.orgId, input.actorUserId)
			: filterTeamMembersForScope(this.store.listMembers(), { actorUserId: input.actorUserId });
		return assessMatterInitiation({
			...input,
			members,
			templatesByRoleId: this.templatesById,
		});
	}

	/**
	 * Route an incoming task to the most appropriate team member ("按事找人").
	 */
	routeMemberForRequest(
		prompt: string,
		preferredMemberId?: string,
		allowedMemberIds?: string[] | null,
		orgId?: string | null,
		options?: { actorUserId?: string | null },
	): TeamMember {
		const allMembers = orgId
			? this.store.resolveEffectiveOrgMembersForUser(orgId, options?.actorUserId)
			: filterTeamMembersForScope(this.store.listMembers(), { actorUserId: options?.actorUserId });
		if (allMembers.length === 0) {
			throw new Error("No team members registered in store");
		}
		if (preferredMemberId) {
			const inScope = allMembers.find((m) => m.id === preferredMemberId);
			if (inScope) return inScope;
			if (!orgId) {
				const explicit = this.store.getMember(preferredMemberId);
				if (explicit && explicit.roleScope !== "personal") return explicit;
			}
			const explicitGlobal = this.store.getMember(preferredMemberId);
			if (explicitGlobal && this.isArchitectMember(explicitGlobal)) return explicitGlobal;
			throw new Error(
				orgId
					? `Member ${preferredMemberId} is not enabled in organization ${orgId}`
					: `Unknown team member: ${preferredMemberId}`,
			);
		}

		const allowedSet = allowedMemberIds ? new Set(allowedMemberIds) : null;
		const members = allowedSet ? allMembers.filter((member) => allowedSet.has(member.id)) : allMembers;
		const basePool = members.length > 0 ? members : allMembers;
		const businessPool = basePool.filter((member) => !this.isArchitectMember(member));
		const pool = businessPool.length > 0 ? businessPool : basePool;

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

		const orgPrimary = allMembers.find((m) => m.isPrimaryContact && !this.isArchitectMember(m));
		if (orgPrimary && (!allowedSet || allowedSet.has(orgPrimary.id))) {
			return orgPrimary;
		}
		const primary = this.store.getPrimaryContact();
		if (primary && !this.isArchitectMember(primary) && (!allowedSet || allowedSet.has(primary.id))) {
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
		const workspaceTopLevelEntries = input.workspace
			? listWorkspaceTopLevelEntries(input.workspace.repoPath)
			: undefined;
		const effectiveMember = this.store.resolveMemberForOrg(organization?.id ?? matterForPrompt?.orgId, input.member);
		const { systemPrompt, turnContext } = buildMemberPrompts({
			...input,
			member: effectiveMember,
			workspaceTopLevelEntries,
			organization,
			teamMembers: this.resolveMatterAiMembers(matterForPrompt),
		});
		return [systemPrompt, turnContext, input.taskPrompt ? `## Current task\n${input.taskPrompt}` : ""]
			.filter(Boolean)
			.join("\n\n");
	}

	isMatterRunning(matterId: string): boolean {
		return this.runs.has(matterId) || this.store.hasLiveMatterLease(matterId);
	}

	/** Stop optional follow-up after the primary reply has been committed. */
	stopObserverPass(matterId: string): Promise<void> | undefined {
		const run = this.runs.get(matterId);
		if (!run?.observerPassController) return;
		run.observerPassController.abort(new Error("Observer pass interrupted"));
		return run.settled;
	}

	async dispatchMatter(input: DispatchMatterInput): Promise<DispatchMatterResult> {
		if (this.shuttingDown) throw new Error("Orchestrator is shutting down");
		return dispatchMatterTurn(
			{
				store: this.store,
				runs: this.runs,
				defaultCwd: this.defaultCwd,
				skillsDir: this.skillsDir,
				templatesById: this.templatesById,
				requireMatter: (id) => this.requireMatter(id),
				isMatterRunning: (id) => this.isMatterRunning(id),
				isArchitectMember: (member) => this.isArchitectMember(member),
				resolveMatterAiMembers: (matter, userId) => this.resolveMatterAiMembers(matter, userId),
				listSharedMatterAiMembers: (matter) => this.listSharedMatterAiMembers(matter),
				routeMemberForRequest: (prompt, memberId, allowed, orgId, options) =>
					this.routeMemberForRequest(prompt, memberId, allowed, orgId, options),
				decideConversationIntent: ({ matterId, workspace, message, memberId, ...routing }) => {
					const matter = this.requireMatter(matterId);
					const orgId = workspace ? workspace.orgId : (matter.orgId ?? null);
					const cwd = workspace?.repoPath ?? this.defaultCwd;
					const modelSelection = resolveConfiguredModel(
						this.store,
						orgId ?? null,
						memberId,
						matter.leadMemberId === memberId ? matter.modelSelection : null,
					);
					const messages = this.store.listMessages(matterId, "user");
					const currentIndex = messages.findIndex(({ id }) => id === message.id);
					return decideConversationIntent({
						...routing,
						classifier: this.classifier,
						workerFactory: this.workerFactory,
						cwd,
						modelSelection,
						prompt: message.content,
						history: currentIndex >= 0 ? messages.slice(0, currentIndex) : [],
						context: { workspaceId: workspace?.id ?? null, repoPath: cwd, orgId: orgId ?? null },
					});
				},
				executeWithWorker: (work) => this.executeWithWorker(work),
			},
			input,
		);
	}

	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		for (const matterId of this.distillations.keys()) {
			this.abortDistillation(matterId);
		}
		for (const controller of this.architectControllers) {
			controller.abort(new Error("Role architect session was aborted"));
		}
		const runs = [...this.runs.entries()];
		await Promise.allSettled([
			...this.distillationTasks,
			...this.architectTasks,
			...runs.map(([id]) => this.abortMatter(id, "shutdown")),
		]);
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
		await run.settled;
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
			draftVerifications: new Map(),
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
		options?: DelegationContext,
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
			options,
		);
	}

	private executeWithWorker(input: ExecuteWorkerInput): Promise<PromptRunResult> {
		return executeWithWorkerPass(
			{
				store: this.store,
				defaultCwd: this.defaultCwd,
				sessionDir: this.sessionDir,
				skillsDir: this.skillsDir,
				noSession: this.noSession,
				extensions: this.extensions,
				pstackDir: this.pstackDir,
				workerFactory: this.workerFactory,
				readPiModels: (selection) => this.getPiModels(selection),
				getDialogHandler: () => this.dialogHandler,
				getTemplateForMember: (member) => this.getTemplateForMember(member),
				getTemplatesById: () => this.templatesById,
				resolveMatterAiMembers: (matter) =>
					this.resolveMatterAiMembers(matter, this.runs.get(matter?.id ?? "")?.startedByUserId),
				listSharedMatterAiMembers: (matter) => this.listSharedMatterAiMembers(matter),
				requireMatter: (matterId) => this.requireMatter(matterId),
				delegate: (dInput, run, workspace, chain, signal, effectsTarget, onProgress, options) =>
					this.delegate(dInput, run, workspace, chain, signal, effectsTarget, onProgress, options),
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
					routeMemberForRequest: (prompt, preferredMemberId) => {
						const m = this.store.getMatter(input.matterId);
						return this.routeMemberForRequest(prompt, preferredMemberId, m?.aiMemberIds, m?.orgId, {
							actorUserId: m?.createdByUserId ?? null,
						});
					},
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

	private async runTrackedAuxTask<T>(
		abortMessage: string,
		callerSignal: AbortSignal | undefined,
		task: (signal: AbortSignal) => Promise<T>,
	): Promise<T> {
		if (this.shuttingDown) throw new Error("Orchestrator is shutting down");
		const controller = new AbortController();
		const completion = Promise.withResolvers<void>();
		const onCallerAbort = () => controller.abort(new Error(abortMessage));
		callerSignal?.throwIfAborted();
		callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
		this.architectControllers.add(controller);
		this.architectTasks.add(completion.promise);
		try {
			return await task(controller.signal);
		} catch (error) {
			if (controller.signal.aborted) throw new Error(abortMessage, { cause: error });
			throw error;
		} finally {
			callerSignal?.removeEventListener("abort", onCallerAbort);
			this.architectControllers.delete(controller);
			this.architectTasks.delete(completion.promise);
			completion.resolve();
		}
	}

	/** Run an isolated, schema-enforced Pi LLM decision call for matter initiation fit and team formation. */
	async assessInitiationWithModel(input: {
		prompt: string;
		hasImages?: boolean;
		workspaceId?: string | null;
		orgId?: string | null;
		actorUserId?: string | null;
		preferredMemberId?: string;
		readRepo?: boolean;
		timeoutMs?: number;
		signal?: AbortSignal;
	}): Promise<MatterInitiationAssessment> {
		const workspace = input.workspaceId ? this.store.getWorkspace(input.workspaceId) : null;
		const orgId = workspace?.orgId ?? input.orgId ?? null;
		const scopedMembers = orgId
			? this.store.resolveEffectiveOrgMembersForUser(orgId, input.actorUserId)
			: filterTeamMembersForScope(this.store.listMembers(), { actorUserId: input.actorUserId });
		return this.runTrackedAuxTask("Initiation decision was aborted", input.signal, (signal) =>
			assessMatterInitiationWithModel(
				{
					defaultCwd: this.defaultCwd,
					classifier: this.classifier,
					workerFactory: this.workerFactory,
					members: scopedMembers,
					selectModel: (memberId) => resolveConfiguredModel(this.store, orgId, memberId),
					templatesByRoleId: this.templatesById,
				},
				{
					prompt: input.prompt,
					hasImages: input.hasImages,
					workspacePath: workspace?.repoPath ?? null,
					workspaceName: workspace?.name ?? null,
					preferredMemberId: input.preferredMemberId,
					readRepo: input.readRepo,
					timeoutMs: input.timeoutMs,
					signal,
				},
			),
		);
	}

	/** Generate a structured, capability-aware role design draft using an isolated typed Pi LLM call. */
	async designRoleWithModel(
		input: RoleDesignBriefInput & { allowedOrgIds?: Set<string>; timeoutMs?: number; signal?: AbortSignal },
	): Promise<RoleArchitectDraft> {
		const scopedMembers = filterTeamMembersForScope(this.store.listMembers(), {
			orgId: input.ownerOrgId ?? undefined,
			allowedOrgIds: input.allowedOrgIds,
			actorUserId: input.ownerUserId,
		});
		return this.runTrackedAuxTask("Role design decision was aborted", input.signal, (signal) =>
			designRoleDraftWithModel(
				{
					defaultCwd: this.defaultCwd,
					skillsDir: this.skillsDir,
					workerFactory: this.workerFactory,
					members: scopedMembers,
					selectModel: (memberId) => resolveConfiguredModel(this.store, input.ownerOrgId, memberId),
					templatesByRoleId: this.templatesById,
				},
				{ ...input, signal },
			),
		);
	}

	/** Run an isolated multi-turn Role Architect conversation that proposes 1..N blueprints. */
	async chatWithRoleArchitect(input: MetaArchitectChatInput): Promise<MetaArchitectChatResult> {
		return this.runTrackedAuxTask("Role architect session was aborted", input.signal, (signal) =>
			runMetaArchitectChat(
				{
					store: this.store,
					defaultCwd: this.defaultCwd,
					skillsDir: this.skillsDir,
					extensions: this.extensions,
					pstackDir: this.pstackDir,
					workerFactory: this.workerFactory,
					templatesById: this.templatesById,
				},
				{ ...input, signal },
			),
		);
	}
}
