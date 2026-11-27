import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { SkillProposalItem } from "@pa/contracts/skill-proposal";
import { resolveBuiltinExtensionPath, resolveRepoAssetPath, resolveRepoRoot } from "../../extensions/builtin-paths.ts";
import { prepareHumanQuestion } from "../../extensions/human-question/runtime.ts";
import { prepareTeamExtension } from "../../extensions/team-extension/runtime.ts";
import { escapeWebAccessSlashCommand, prepareWebAccessForWorker } from "../../extensions/web-access/runtime.ts";
import type { WorkbenchTopic } from "../../extensions/workbench-help/catalog.ts";
import { isArchitectRoleTemplate, isSoloRoleTemplate } from "../../roles/role-architect.ts";
import type { RoleTemplate } from "../../roles/types.ts";
import type { PromptRunResult } from "../../rpc/pi-rpc-worker.ts";
import { summarizePromptUsage } from "../../rpc/prompt-usage.ts";
import { abortable, createTeamToolBridge } from "../../rpc/team-tool-bridge.ts";
import type { ImageContent } from "../../rpc/types.ts";
import { type PersonalAgentStore, resolveEffectiveGitIdentity } from "../../storage/repositories.ts";
import type { Matter, TeamMember, WorkspaceLink } from "../../storage/types.ts";
import {
	buildArchitectMatterContext,
	type MetaArchitectBlueprintProposal,
	type MetaArchitectRoleAdjustment,
} from "../architect/meta-architect.ts";
import { messageMatchesContext, scopedSpaceDocumentIds, selectMatterContext } from "../runtime/matter-context.ts";
import { applyWorkerModel, type ReadPiModels } from "../runtime/model-selection.ts";
import { buildCompactTeamCapabilities } from "../runtime/team-capabilities.ts";
import { readWorkbenchTopic } from "../runtime/workbench-context.ts";
import {
	buildAttachedFolderContextFiles,
	buildWorkspaceCustomizations,
	extractAttachedSkillPaths,
} from "../runtime/workspace-customizations.ts";
import {
	type DelegateInput,
	type DelegateResult,
	type DelegationContext,
	type DispatchProgressEvent,
	type ExecutionEffects,
	emptyEffects,
	type MatterRun,
	mergeEffects,
	type OrchestratorDialogHandler,
	type RpcWorkerLike,
	type WorkerFactory,
	type WorkerSessionMode,
} from "../types.ts";
import {
	listWorkspaceTopLevelEntries,
	resolveLocalWorkspacePiArgs,
	resolveRepoGitUserIdentity,
	resolveRoleSkills,
	resolveScopedDiscoveredSkillDirs,
	resolveScopedPiSessionDir,
	validateSavedSession,
} from "./execution-context.ts";
import {
	buildInterruptionResumeBrief,
	buildMemberPrompts,
	buildObserverContextDigest,
	formatMessageHistoryContent,
	formatMessageHistorySpeaker,
} from "./prompts.ts";
import {
	type BoardWorkerContext,
	buildBoardAssignmentPrompt,
	buildManagedSkillRoots,
	buildPendingDecisionsPrompt,
	buildTrustPolicyMap,
	resolveWorkerModelSelection,
} from "./worker-setup.ts";
import { attachWorkerTelemetry } from "./worker-telemetry.ts";
import { createWorkerToolHandler } from "./worker-tool-handler.ts";

export type { BoardWorkerContext, BoardWorkerToolCall } from "./worker-setup.ts";

export interface WorkerRunnerDeps {
	store: PersonalAgentStore;
	defaultCwd: string;
	defaultWorkspaceDir?: string;
	sessionDir: string | undefined;
	skillsDir?: string;
	noSession: boolean;
	extensions: string[];
	workerFactory: WorkerFactory;
	readPiModels: ReadPiModels;
	getDialogHandler: () => OrchestratorDialogHandler | undefined;
	getTemplateForMember: (member: TeamMember) => RoleTemplate | undefined;
	getTemplatesById?: () => Map<string, RoleTemplate>;
	resolveMatterAiMembers: (matter: Matter | null) => TeamMember[];
	listSharedMatterAiMembers: (matter: Matter) => TeamMember[];
	requireMatter: (matterId: string) => Matter;
	delegate: (
		input: DelegateInput,
		run: MatterRun,
		workspace: WorkspaceLink | null,
		chain: string[],
		signal: AbortSignal,
		effectsTarget: ExecutionEffects,
		onProgress?: (progress: DispatchProgressEvent) => void,
		options?: DelegationContext,
	) => Promise<DelegateResult>;
}

export interface ExecuteWorkerInput {
	matterId: string;
	member: TeamMember;
	workspace: WorkspaceLink | null;
	taskPrompt: string;
	workbenchHelpTopic?: WorkbenchTopic;
	images?: ImageContent[];
	isInternalDelegation?: boolean;
	delegationRequestId?: string;
	sessionMode?: WorkerSessionMode;
	discussionMode?: boolean;
	excludeMessageIds?: string[];
	boardContext?: BoardWorkerContext;
	run: MatterRun;
	chain: string[];
	signal: AbortSignal;
	effectsTarget: ExecutionEffects;
	onTextDelta?: (delta: string) => void;
	onProgress?: (progress: DispatchProgressEvent) => void;
}

/** Run an isolated Pi RPC worker turn with scoped session reuse, bridge tools, and progress notices. */
export async function executeWithWorkerPass(
	deps: WorkerRunnerDeps,
	input: ExecuteWorkerInput,
): Promise<PromptRunResult> {
	input.signal.throwIfAborted();
	const boardCtx = input.boardContext;
	const sessionMode =
		boardCtx?.boardRole === "verifier"
			? "verifier"
			: (input.sessionMode ?? (input.isInternalDelegation ? "internal" : "lead"));
	const isDiscussionMode = Boolean(input.discussionMode);
	const matter = deps.store.getMatter(input.matterId);
	const isMatterLead = !matter?.leadMemberId || input.member.id === matter.leadMemberId;
	const actorUserId = input.run.startedByUserId ?? null;
	const matterAiMembers = deps
		.resolveMatterAiMembers(matter)
		.filter((member) => member.roleScope !== "personal" || member.ownerUserId === actorUserId);
	const hasConsultTargets = matterAiMembers.some(
		(member) =>
			member.id !== input.member.id &&
			(matter?.consultMemberIds == null ||
				member.id === matter.leadMemberId ||
				matter.consultMemberIds.includes(member.id) ||
				Boolean(input.run.explicitlyMentionedMemberIds?.includes(member.id))),
	);
	const activeOrgId = input.workspace ? input.workspace.orgId : (matter?.orgId ?? null);
	const organization = activeOrgId ? deps.store.getOrganization(activeOrgId) : null;
	const cwd = resolve(input.workspace?.repoPath ?? deps.defaultWorkspaceDir ?? deps.defaultCwd);
	const template = deps.getTemplateForMember(input.member);
	const isArchitect = isArchitectRoleTemplate(template ?? { id: input.member.id });
	const isSolo = isSoloRoleTemplate(template ?? { id: input.member.id });
	const teamExtension = prepareTeamExtension({
		sessionMode,
		discussionMode: isDiscussionMode,
		isArchitect,
		isSolo,
		hasConsultTargets,
		isMatterLead,
		...(boardCtx ? { boardRole: boardCtx.boardRole, boardAgentId: boardCtx.agentId } : {}),
	});
	const { canSaveSpace, canDelegate, canCaptureSkill, canManageRoles } = teamExtension;
	const humanQuestion = prepareHumanQuestion({
		sessionMode,
		discussionMode: isDiscussionMode,
		isArchitect,
		memberId: input.member.id,
		run: input.run,
	});
	const hasPersonalContext =
		input.member.roleScope === "personal" ||
		matterAiMembers.some((member) => member.roleScope === "personal") ||
		(isArchitect &&
			deps.store
				.listMembers()
				.some((member) => member.roleScope === "personal" && member.ownerUserId === actorUserId));
	const inheritsLocalResources = input.run.inheritLocalPiResources && input.workspace?.sourceType !== "cloned";
	const contextKey = JSON.stringify([
		"v2",
		input.workspace?.id ?? null,
		cwd,
		...(boardCtx ? ["board", boardCtx.agentId, boardCtx.boardRole] : []),
		isDiscussionMode ? `discussion-${sessionMode}` : sessionMode === "lead" ? "user" : sessionMode,
		activeOrgId,
		...(inheritsLocalResources ? ["local-pi"] : []),
		// These snapshots persist in Pi history. Reuse them only for the same actor.
		...(hasPersonalContext ? ["actor", actorUserId] : []),
	]);
	const executionKey = JSON.stringify([input.member.id, contextKey]);
	if (input.run.contexts.has(executionKey)) throw new Error("Colleague is already working in this conversation");
	input.run.contexts.add(executionKey);
	const activeCall = input.delegationRequestId
		? input.run.activeDelegations.get(input.delegationRequestId)
		: undefined;
	const activity = input.run.monitor?.begin({
		memberId: input.member.id,
		memberName: input.member.displayName,
		assignmentNumber: activeCall?.kind === "delegation" ? activeCall.delegationNumber : undefined,
	});
	let worker: RpcWorkerLike | undefined;
	let sessionRecord: ReturnType<PersonalAgentStore["recordWorkerSession"]> | undefined;
	let bridge: Awaited<ReturnType<typeof createTeamToolBridge>> | undefined;
	const cleanups: Array<() => void> = [];
	const effects = emptyEffects();
	// A disconnected tool request cancels only that colleague subtree, not unrelated work.
	const controller = new AbortController();
	const signal = AbortSignal.any([input.signal, controller.signal]);
	try {
		const workspaceFolders = input.workspace ? deps.store.workspaceFolders.listFolders(input.workspace.id) : [];
		const workspaceCustomizations =
			workspaceFolders.length > 0 ? buildWorkspaceCustomizations(workspaceFolders) : null;
		const attachedContextFiles = workspaceCustomizations
			? buildAttachedFolderContextFiles(workspaceCustomizations)
			: [];
		const attachedSkillPaths = workspaceCustomizations ? extractAttachedSkillPaths(workspaceCustomizations) : [];
		const attachedFoldersPrompt =
			workspaceFolders.length > 1
				? [
						"## Attached workspace folders",
						"This workspace includes additional attached folders alongside the primary working directory:",
						...workspaceFolders
							.filter((f) => f.role === "attached")
							.map((f) => `- \`${f.label}\`: \`${f.path}\``),
					].join("\n")
				: undefined;
		const baseSkillPaths = await resolveRoleSkills(template, { skillsDir: deps.skillsDir });
		const discoveredScopedSkillDirs = isArchitect
			? []
			: resolveScopedDiscoveredSkillDirs({
					skillsDir: deps.skillsDir,
					orgId: activeOrgId,
					userId: actorUserId,
					workspaceId: input.workspace?.id ?? null,
				});
		const skillPaths = [...new Set([...baseSkillPaths, ...attachedSkillPaths, ...discoveredScopedSkillDirs])];
		const previous = deps.noSession
			? null
			: deps.store.findWorkerSession(input.matterId, input.member.id, contextKey, input.workspace?.id ?? null);
		const sessionFile = previous ? await validateSavedSession(previous, cwd) : undefined;
		// Role declarations describe responsibilities, not the runtime tool allowlist.
		const canUseWriteTools = boardCtx?.boardRole !== "verifier" && boardCtx?.boardRole !== "coordinator";
		const requestedTools = canUseWriteTools
			? ["read", process.platform === "win32" ? "powershell" : "bash", "edit", "write"]
			: ["read", process.platform === "win32" ? "powershell" : "bash"];
		const webAccess = await prepareWebAccessForWorker({
			store: deps.store,
			envFilePath: resolve(deps.defaultCwd, ".env"),
		});
		if (webAccess) requestedTools.push(...webAccess.tools);
		const requiredTools = [
			...requestedTools,
			"list_available_skills",
			"load_available_skill",
			...teamExtension.tools,
			...humanQuestion.tools,
		];
		const stagedSkillProposals: SkillProposalItem[] = [];
		const stagedRoleBlueprints: MetaArchitectBlueprintProposal[] = [];
		const stagedRoleAdjustments: MetaArchitectRoleAdjustment[] = [];
		let observedTools: string[] | undefined;
		const workbenchContext = () => {
			const current = deps.requireMatter(input.matterId);
			if (current.workspaceId !== (input.workspace?.id ?? null) || current.orgId !== activeOrgId) {
				throw new Error("The matter workspace changed during this turn");
			}
			return {
				matter: current,
				members: deps
					.resolveMatterAiMembers(current)
					.filter((member) => member.roleScope !== "personal" || member.ownerUserId === actorUserId),
				getTemplate: deps.getTemplateForMember,
				sourceUserMessageId: input.run.userMessageId,
				workspaceId: current.workspaceId,
				repoPath: cwd,
				orgId: activeOrgId,
				workspaceName: input.workspace?.name,
				runtimeMemberId: input.member.id,
				activeTools: observedTools,
			};
		};
		bridge = await createTeamToolBridge(
			createWorkerToolHandler({
				deps,
				matterId: input.matterId,
				member: input.member,
				workspace: input.workspace,
				delegationRequestId: input.delegationRequestId,
				run: input.run,
				chain: input.chain,
				onProgress: input.onProgress,
				matter,
				matterAiMembers,
				activeOrgId,
				actorUserId,
				cwd,
				sessionMode,
				isDiscussionMode,
				isArchitect,
				canSaveSpace,
				canDelegate,
				canCaptureSkill,
				canManageRoles,
				humanQuestion,
				boardCtx,
				effects,
				stagedSkillProposals,
				stagedRoleBlueprints,
				stagedRoleAdjustments,
				getWorker: () => worker,
				activity,
			}),
			signal,
		);

		// Respect ~/.pi/agent/trust.json explicit refusals; otherwise approve explicitly selected local workspaces
		// (since Pi RPC has hasUI=false and would silently skip undecided repos). Cloned repos stay isolated.
		const args = resolveLocalWorkspacePiArgs({
			inheritsLocalResources: Boolean(inheritsLocalResources),
			hasWorkspace: Boolean(input.workspace),
			cwd,
			hasDedicatedDefaultWorkspace: Boolean(deps.defaultWorkspaceDir),
		});
		for (const entry of teamExtension.entries) args.push("--extension", entry);
		args.push("--extension", resolveBuiltinExtensionPath("skill-catalog"));
		args.push("--extension", resolveBuiltinExtensionPath("role-skills"));
		if (!isArchitect) args.push("--extension", resolveBuiltinExtensionPath("visualize"));
		if (!isArchitect && sessionMode === "lead") args.push("--extension", resolveBuiltinExtensionPath("next-steps"));
		if (humanQuestion.entry) args.push("--extension", humanQuestion.entry);
		for (const extension of deps.extensions) args.push("--extension", extension);
		if (webAccess) args.push("--extension", webAccess.entry);
		args.push("--extension", "builtin:mcp");
		if (!isArchitect) {
			args.push("--extension", resolveBuiltinExtensionPath("workflow"));
			args.push("--skill", resolveRepoAssetPath("pa-extensions/workflow/skills"));
		}
		args.push("--skill", resolveRepoAssetPath("pa-extensions/self-inspect/skills"));
		for (const path of skillPaths) args.push("--skill", path);
		args.push("--tools", "*");

		const effectiveMember = activeOrgId ? deps.store.resolveMemberForOrg(activeOrgId, input.member) : input.member;
		const useRoleGitIdentity = Boolean(organization?.useRoleGitIdentity);
		const gitIdentity = resolveEffectiveGitIdentity(effectiveMember, organization);
		const repoGitUser = resolveRepoGitUserIdentity(cwd);
		const workspaceTopLevelEntries = input.workspace ? listWorkspaceTopLevelEntries(cwd) : undefined;
		const committerName = repoGitUser?.name || gitIdentity.gitName;
		const committerEmail = repoGitUser?.email || gitIdentity.gitEmail;
		const selection = await resolveWorkerModelSelection({
			store: deps.store,
			readPiModels: deps.readPiModels,
			activeOrgId,
			memberId: input.member.id,
			matter,
			sessionMode,
			isArchitect,
			isDiscussionMode,
			keepMatterLead: input.run.keepMatterLead,
			template,
			boardModelOverride: boardCtx?.modelOverride,
			signal,
		});
		const { systemPrompt, turnContext } = buildMemberPrompts({
			member: effectiveMember,
			template,
			workspace: input.workspace,
			workspaceTopLevelEntries,
			organization,
			repoGitUser,
			sessionMode,
			discussionMode: isDiscussionMode,
			leadMemberId: matter?.leadMemberId ?? null,
			consultMemberIds: matter?.consultMemberIds ?? null,
			observerMemberIds: matter?.observersEnabled ? matter.observerMemberIds : [],
			teamMembers: matterAiMembers,
			teamCapabilities:
				matter && sessionMode === "lead"
					? buildCompactTeamCapabilities({
							matter,
							members: matterAiMembers,
							messages: deps.store.listMessages(input.matterId),
							workspaceId: input.workspace?.id ?? null,
							repoPath: cwd,
							orgId: activeOrgId,
							getTemplate: deps.getTemplateForMember,
						})
					: undefined,
		});
		const architectContext =
			isArchitect && deps.getTemplatesById
				? await buildArchitectMatterContext(
						{ store: deps.store, templatesById: deps.getTemplatesById(), skillsDir: deps.skillsDir },
						{
							isMidMatterConsult: Boolean(matter?.leadMemberId && matter.leadMemberId !== input.member.id),
							orgId: matter?.orgId ?? null,
							actorUserId,
						},
					)
				: undefined;
		const pendingDecisionsPrompt = buildPendingDecisionsPrompt(deps.store, input.matterId);
		const managedSkillRoots = buildManagedSkillRoots({
			skillsDir: deps.skillsDir,
			activeOrgId,
			actorUserId,
			workspace: input.workspace,
			workspaceFolders,
		});
		const trustPolicyMap = buildTrustPolicyMap(deps.store);
		const boardAssignmentPrompt = boardCtx ? buildBoardAssignmentPrompt(boardCtx) : undefined;
		signal.throwIfAborted();
		worker = deps.workerFactory({
			cwd,
			provider: selection?.provider,
			model: selection?.model,
			sessionDir: resolveScopedPiSessionDir(deps.sessionDir, cwd),
			sessionFile,
			noSession: deps.noSession,
			args,
			env: {
				...(managedSkillRoots.length > 0 ? { PA_MANAGED_SKILL_ROOTS: JSON.stringify(managedSkillRoots) } : {}),
				...(Object.keys(trustPolicyMap).length > 0
					? { PA_SKILL_TRUST_POLICIES: JSON.stringify(trustPolicyMap) }
					: {}),
				...teamExtension.buildEnvironment({
					bridgeEnv: bridge.env,
					requiredTools,
					workspaceRoot: input.workspace ? cwd : undefined,
					paInstallRoot: resolveRepoRoot(),
					deploymentMode: input.run.inheritLocalPiResources ? "local" : "multi_tenant",
					attachedContextFiles,
					memberContext: [systemPrompt, architectContext?.systemPrompt],
					turnContext: [
						turnContext,
						attachedFoldersPrompt,
						pendingDecisionsPrompt,
						architectContext?.turnContext,
						boardAssignmentPrompt,
					],
				}),
				...humanQuestion.env,
				...webAccess?.env,
				PA_WEB_SEARCH_ENABLED: String(Boolean(webAccess)),
				...(useRoleGitIdentity
					? {
							GIT_AUTHOR_NAME: gitIdentity.gitName,
							GIT_AUTHOR_EMAIL: gitIdentity.gitEmail,
							GIT_COMMITTER_NAME: committerName,
							GIT_COMMITTER_EMAIL: committerEmail,
						}
					: {}),
				PA_MEMBER_ID: effectiveMember.id,
				PA_MEMBER_NAME: effectiveMember.displayName,
				PA_MEMBER_TITLE: effectiveMember.roleTitle,
				...(boardCtx?.ownedScope && boardCtx.ownedScope.length > 0
					? { PA_BOARD_OWNED_SCOPE: JSON.stringify(boardCtx.ownedScope) }
					: {}),
				...(organization ? { PA_ORG_ID: organization.id, PA_ORG_NAME: organization.name } : {}),
			},
		});
		input.run.workers.add(worker);
		attachWorkerTelemetry(
			{
				worker,
				store: deps.store,
				matterId: input.matterId,
				member: input.member,
				workspace: input.workspace,
				cwd,
				activeOrgId,
				run: input.run,
				sessionMode,
				boardCtx,
				onProgress: input.onProgress,
				activity,
			},
			cleanups,
		);
		worker.setDialogHandler(async (request) => {
			signal.throwIfAborted();
			if (sessionMode !== "lead" || isDiscussionMode) {
				humanQuestion.captureInternalDialog(request);
				return { cancelled: true };
			}
			const dialogHandler = deps.getDialogHandler();
			if (!dialogHandler) return { cancelled: true };
			const resumeMonitor = activity?.wait();
			deps.store.updateMatterStatus(input.matterId, "waiting_user");
			input.onProgress?.({
				stage: "waiting_user",
				label: `${input.member.displayName}需要你补充：${request.title}`,
			});
			try {
				return await abortable(
					Promise.resolve(dialogHandler({ matterId: input.matterId, member: input.member, request })),
					signal,
				);
			} finally {
				resumeMonitor?.();
				deps.store.updateMatterStatus(input.matterId, "open");
			}
		});
		input.onProgress?.({ stage: "starting", label: `正在接续${input.member.displayName}的工作` });
		await worker.start();
		signal.throwIfAborted();
		const state = await applyWorkerModel(worker, selection);
		const tools = await bridge.waitReady();
		observedTools = tools;
		const missing = requiredTools.filter((name) => !tools.includes(name));
		if (missing.length) throw new Error(`Required capabilities unavailable: ${missing.join(", ")}`);
		deps.store.appendMessage({
			matterId: input.matterId,
			channel: "notice",
			senderType: "system",
			senderId: input.member.id,
			metadata: {
				workspaceId: input.workspace?.id ?? null,
				repoPath: cwd,
				orgId: activeOrgId,
				sourceUserMessageId: input.run.userMessageId,
			},
			content: JSON.stringify({
				method: "runtime_ready",
				tools,
				sessionMode,
				discussionMode: isDiscussionMode,
				skills: skillPaths,
				resourcePolicy: inheritsLocalResources ? "local-pi" : "explicit",
				skillDiscovery: "pi-packages-and-explicit",
				model: state.model
					? { provider: state.model.provider, model: state.model.id, thinkingLevel: state.thinkingLevel }
					: selection,
				resumed: Boolean(sessionFile),
				piSessionId: state.sessionId,
			}),
		});
		const messages = deps.store.listMessages(input.matterId, "user");
		const excludeIds = new Set(input.excludeMessageIds ?? [input.run.userMessageId]);
		const afterCursor = previous?.messageCursor
			? messages.findIndex((message) => message.id === previous.messageCursor) + 1
			: 0;
		const filteredHistory = messages.slice(afterCursor).filter(
			(message) =>
				!excludeIds.has(message.id) &&
				messageMatchesContext(message, {
					workspaceId: input.workspace?.id ?? null,
					repoPath: cwd,
					orgId: activeOrgId,
				}) &&
				!(
					previous &&
					message.senderType === "member" &&
					message.senderId === input.member.id &&
					message.metadata?.aborted !== true
				),
		);
		const scopedContext = selectMatterContext({
			orgId: activeOrgId,
			messages: deps.store.listMessages(input.matterId),
			workspaceId: input.workspace?.id ?? null,
			repoPath: cwd,
		});
		const lastUserMsg = scopedContext.messages.filter((msg) => msg.channel === "user").at(-1);
		const scopedDocumentIds = scopedSpaceDocumentIds(scopedContext.messages);
		const context =
			sessionMode === "observer"
				? buildObserverContextDigest({
						matter: {
							...deps.requireMatter(input.matterId),
							title:
								scopedContext.messages
									.find((msg) => msg.channel === "user" && msg.senderType === "user")
									?.content.slice(0, 120) ?? `Matter ${input.matterId}`,
							summary: lastUserMsg ? formatMessageHistoryContent(lastUserMsg) : "",
						},
						documents: deps.store.spaces
							.listDocuments({ matterId: input.matterId })
							.filter((doc) => scopedDocumentIds.has(doc.id)),
						history: filteredHistory,
						includeMatterHeader: !previous,
					})
				: filteredHistory
						.slice(-12)
						.map((message) => `${formatMessageHistorySpeaker(message)}: ${formatMessageHistoryContent(message)}`)
						.join("\n\n")
						.slice(-20000);
		const contextHeader =
			sessionMode === "observer"
				? "Brief background for the observer:"
				: "Recent messages in this matter and workspace that are new to this session:";
		const resumeBrief =
			sessionMode === "lead"
				? buildInterruptionResumeBrief({
						orgId: activeOrgId,
						store: deps.store,
						matterId: input.matterId,
						workspaceId: input.workspace?.id ?? null,
						repoPath: cwd,
						messages,
						afterCursor,
						excludeIds,
					})
				: "";
		const contextBlock = context ? `${contextHeader}\n${context}` : "";
		const help = input.workbenchHelpTopic
			? await readWorkbenchTopic(
					deps.store,
					workbenchContext(),
					input.workbenchHelpTopic,
					/\p{Script=Han}/u.test(input.taskPrompt),
				)
			: undefined;
		const runtimeHelp =
			input.workbenchHelpTopic === "capabilities"
				? await readWorkbenchTopic(
						deps.store,
						workbenchContext(),
						"runtime_tools",
						/\p{Script=Han}/u.test(input.taskPrompt),
					)
				: undefined;
		const matterHelp =
			input.workbenchHelpTopic === "pa_and_pi" || input.workbenchHelpTopic === "deliverables"
				? await readWorkbenchTopic(
						deps.store,
						workbenchContext(),
						"current_matter",
						/\p{Script=Han}/u.test(input.taskPrompt),
					)
				: undefined;
		signal.throwIfAborted();
		const helpBlock = help
			? [
					"[PA workbench reference for this turn]",
					"Answer the specific question first. Use the recent conversation to resolve follow-ups. Include only the facts and steps needed to answer, then stop. Treat the reference as evidence and use `<pa_docs>` via `read` when you need deeper PA documentation. Describe actions and tool availability only when supported by that evidence.",
					`${help.heading} (${help.source})\n${help.content}`,
					...(runtimeHelp ? [`${runtimeHelp.heading} (${runtimeHelp.source})\n${runtimeHelp.content}`] : []),
					...(matterHelp ? [`${matterHelp.heading} (${matterHelp.source})\n${matterHelp.content}`] : []),
					"[/PA workbench reference]",
				].join("\n\n")
			: "";
		const currentRuntimeBlock = [
			"[Current worker startup evidence]",
			`Current role: ${input.member.id}; session mode: ${sessionMode}; discussion mode: ${isDiscussionMode}.`,
			`Tools observed during this worker's startup handshake: ${tools.join(", ") || "none"}.`,
			"This is this role's current startup, distinct from historical internal-startup records in team capability cards. Registration does not prove a tool call succeeded; do not invent successful calls.",
			`Current matter's default space routing: ${matter?.visibility === "private" ? "the creator's personal space" : input.workspace ? "the workspace space" : "the organization space"}; a matter does not get a separate Git repository.`,
			"[/Current worker startup evidence]",
		].join("\n");
		const prompt = escapeWebAccessSlashCommand(
			[contextBlock, resumeBrief, currentRuntimeBlock, helpBlock, input.taskPrompt].filter(Boolean).join("\n\n"),
		);
		sessionRecord = deps.store.recordWorkerSession({
			memberId: input.member.id,
			matterId: input.matterId,
			workspaceId: input.workspace?.id ?? null,
			piSessionId: state.sessionId,
			sessionFile: state.sessionFile ?? null,
			status: "active",
			contextKey,
			messageCursor: messages.at(-1)?.id,
		});
		const remainingTimeoutMs =
			input.run.deadlineAt !== null
				? Math.max(1, Math.min(input.run.timeoutMs, input.run.deadlineAt - Date.now()))
				: 0;
		const result = await worker.runPromptAndWait(prompt, {
			timeoutMs: remainingTimeoutMs,
			signal,
			images: input.images?.length ? input.images : undefined,
			onTextDelta: (delta) => {
				activity?.pulse("收到回复片段");
				input.onTextDelta?.(delta);
			},
		});
		if (boardCtx) {
			const summaryEvent = deps.store.appendEvent({
				matterId: input.matterId,
				runId: input.run.userMessageId || "board",
				agentId: boardCtx.agentId,
				eventType: "turn_summary",
				payload: {
					boardRole: boardCtx.boardRole,
					aborted: result.aborted,
					assistantTextPreview: result.assistantText.trim().slice(0, 240),
				},
			});
			boardCtx.onEventAppended?.(summaryEvent);
		}
		const usage = summarizePromptUsage(result.assistantMessages);
		if (usage) {
			deps.store.appendMessage({
				matterId: input.matterId,
				channel: "notice",
				senderType: "system",
				senderId: input.member.id,
				content: JSON.stringify({
					method: "runtime_model_usage",
					sourceUserMessageId: input.run.userMessageId,
					sessionMode,
					discussionMode: isDiscussionMode,
					resumed: Boolean(sessionFile),
					...usage,
				}),
			});
		}
		if (!result.aborted && !input.run.cancelled) {
			for (const proposal of stagedSkillProposals) {
				const existingIdx = effects.skillProposals.findIndex((item) => item.name === proposal.name);
				if (existingIdx < 0) effects.skillProposals.push(proposal);
				else effects.skillProposals[existingIdx] = proposal;
			}
			for (const blueprint of stagedRoleBlueprints) {
				const existingIdx = effects.roleBlueprints.findIndex(
					(item) => item.draft.template.id === blueprint.draft.template.id,
				);
				if (existingIdx < 0) effects.roleBlueprints.push(blueprint);
				else effects.roleBlueprints[existingIdx] = blueprint;
			}
			for (const adjustment of stagedRoleAdjustments) {
				const existingIdx = effects.roleAdjustments.findIndex((item) => item.memberId === adjustment.memberId);
				if (existingIdx < 0) effects.roleAdjustments.push(adjustment);
				else effects.roleAdjustments[existingIdx] = adjustment;
			}
			mergeEffects(input.effectsTarget, effects);
		}
		if (!result.aborted && !input.run.cancelled)
			input.onProgress?.({ stage: "finalizing", label: `${input.member.displayName}正在整理结果` });
		const { clarification } = humanQuestion;
		return !result.aborted && !input.run.cancelled && clarification ? { ...result, clarification } : result;
	} finally {
		controller.abort(new Error("Worker finished"));
		for (const cleanup of cleanups) cleanup();
		await worker?.stop().catch(() => {});
		await bridge?.close();
		if (sessionRecord)
			deps.store.finishWorkerSession(
				sessionRecord.id,
				sessionRecord.sessionFile && existsSync(sessionRecord.sessionFile) ? "idle" : "closed",
			);
		if (worker) input.run.workers.delete(worker);
		activity?.stop();
		input.run.contexts.delete(executionKey);
	}
}
