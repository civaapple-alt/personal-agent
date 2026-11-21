import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { prepareHumanQuestion } from "../pa-extensions/human-question/runtime.ts";
import { preparePstackForWorker } from "../pa-extensions/pstack-methods/runtime.ts";
import { prepareTeamExtension } from "../pa-extensions/team-extension/runtime.ts";
import {
	escapeWebAccessSlashCommand,
	isPiWebAccessTool,
	prepareWebAccessForWorker,
} from "../pa-extensions/web-access/runtime.ts";
import { WORKBENCH_HELP_PROMPT } from "../pa-extensions/workbench-help/catalog.ts";
import { isArchitectRoleTemplate } from "../roles/role-architect.ts";
import type { RoleTemplate } from "../roles/types.ts";
import type { PromptRunResult } from "../rpc/pi-rpc-worker.ts";
import { summarizePromptUsage } from "../rpc/prompt-usage.ts";
import { abortable, createTeamToolBridge, type TeamToolCall } from "../rpc/team-tool-bridge.ts";
import type { ImageContent } from "../rpc/types.ts";
import { type PersonalAgentStore, resolveEffectiveGitIdentity } from "../storage/repositories.ts";
import type { Matter, MemoryCategory, MemoryScope, TeamMember, WorkspaceLink } from "../storage/types.ts";
import {
	listWorkspaceTopLevelEntries,
	prepareDelivery,
	resolveRepoGitUserIdentity,
	resolveRoleSkills,
	validateSavedSession,
} from "./execution-context.ts";
import { messageMatchesContext, selectMatterContext } from "./matter-context.ts";
import { buildArchitectMatterContext } from "./meta-architect.ts";
import { applyWorkerModel, type ReadPiModels, resolveConfiguredModel } from "./model-selection.ts";
import {
	buildInterruptionResumeBrief,
	buildMemberPrompts,
	buildObserverContextDigest,
	formatMessageHistoryContent,
	formatMessageHistorySpeaker,
} from "./prompts.ts";
import {
	type DelegateInput,
	type DelegateResult,
	type DelegationContext,
	type DispatchProgressEvent,
	type ExecutionEffects,
	emptyEffects,
	formatToolAction,
	type MatterRun,
	mergeEffects,
	type OrchestratorDialogHandler,
	pushRunLog,
	type RpcWorkerLike,
	summarizeToolArgs,
	type WorkerFactory,
	type WorkerSessionMode,
} from "./types.ts";
import { readWorkbenchTopic } from "./workbench-context.ts";

export interface WorkerRunnerDeps {
	store: PersonalAgentStore;
	defaultCwd: string;
	sessionDir: string | undefined;
	skillsDir?: string;
	noSession: boolean;
	extensions: string[];
	pstackDir?: string;
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
	images?: ImageContent[];
	isInternalDelegation?: boolean;
	delegationRequestId?: string;
	sessionMode?: WorkerSessionMode;
	discussionMode?: boolean;
	excludeMessageIds?: string[];
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
	const sessionMode = input.sessionMode ?? (input.isInternalDelegation ? "internal" : "lead");
	const isDiscussionMode = Boolean(input.discussionMode);
	const isConversationReply = Boolean(input.run.conversationDiscussion);
	const isVerifier = sessionMode === "verifier";
	const matter = deps.store.getMatter(input.matterId);
	const actorUserId = input.run.startedByUserId ?? null;
	const matterAiMembers = deps
		.resolveMatterAiMembers(matter)
		.filter((member) => member.roleScope !== "personal" || member.ownerUserId === actorUserId);
	const hasConsultTargets = matterAiMembers.some(
		(member) =>
			member.id !== input.member.id &&
			(matter?.consultMemberIds == null ||
				member.id === matter.leadMemberId ||
				matter.consultMemberIds.includes(member.id)),
	);
	const activeOrgId = input.workspace ? input.workspace.orgId : (matter?.orgId ?? null);
	const organization = activeOrgId ? deps.store.getOrganization(activeOrgId) : null;
	const cwd = resolve(input.workspace?.repoPath ?? deps.defaultCwd);
	const template = deps.getTemplateForMember(input.member);
	const isArchitect = isArchitectRoleTemplate(template ?? { id: input.member.id });
	const teamExtension = prepareTeamExtension({
		sessionMode,
		discussionMode: isDiscussionMode,
		isArchitect,
		hasConsultTargets,
	});
	const { canPublish, canDelegate, canProposeExperience } = teamExtension;
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
	const inheritsLocalResources =
		input.run.inheritLocalPiResources &&
		!isArchitect &&
		!isDiscussionMode &&
		!isVerifier &&
		sessionMode !== "observer" &&
		input.workspace?.sourceType !== "cloned";
	const contextKey = JSON.stringify([
		"v2",
		input.workspace?.id ?? null,
		cwd,
		isConversationReply
			? `conversation-${sessionMode}`
			: isDiscussionMode
				? `discussion-${sessionMode}`
				: sessionMode === "lead"
					? "user"
					: sessionMode,
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
	const deliveries = effects.deliveries;
	// A disconnected tool request cancels only that colleague subtree, not unrelated work.
	const controller = new AbortController();
	const signal = AbortSignal.any([input.signal, controller.signal]);
	try {
		const skillPaths = isVerifier ? [] : await resolveRoleSkills(template, { skillsDir: deps.skillsDir });
		const pstack = await preparePstackForWorker(deps.pstackDir, sessionMode);
		const previous = deps.noSession
			? null
			: deps.store.findWorkerSession(input.matterId, input.member.id, contextKey, input.workspace?.id ?? null);
		const sessionFile = previous ? await validateSavedSession(previous, cwd) : undefined;
		const baseTools = isArchitect
			? []
			: (template?.tools ?? ["read", "bash", "edit", "write"]).filter(
					(tool) => tool !== "mcp" && !isPiWebAccessTool(tool),
				);
		const requestedTools = isConversationReply
			? baseTools.filter((tool) => ["read", "grep", "find", "ls"].includes(tool))
			: isVerifier
				? baseTools.filter((tool) => tool === "read" || tool === "bash")
				: sessionMode === "observer"
					? baseTools.filter((tool) => tool !== "edit" && tool !== "write")
					: baseTools;
		const webAccess = await prepareWebAccessForWorker({
			store: deps.store,
			member: input.member,
			template,
			sessionMode,
		});
		if (webAccess) requestedTools.push(...webAccess.tools);
		const mcpDependencies = isArchitect || isVerifier || isConversationReply ? [] : (template?.mcpDependencies ?? []);
		const requiredTools = [
			...requestedTools,
			...teamExtension.tools,
			...humanQuestion.tools,
			...(pstack?.tools ?? []),
		];
		const toolPatterns = [...requiredTools, ...mcpDependencies.map((name) => `mcp__${name}__*`)];
		const stagedExperiences: Array<{
			scope: MemoryScope;
			category: MemoryCategory;
			content: string;
			rationale: string;
			supersedesMemoryId?: string;
		}> = [];
		let observedTools: string[] | undefined;
		bridge = await createTeamToolBridge(async (call: TeamToolCall, toolSignal) => {
			toolSignal.throwIfAborted();
			if (call.tool === "read_pa_help") {
				const current = deps.requireMatter(input.matterId);
				if (current.workspaceId !== (input.workspace?.id ?? null) || current.orgId !== activeOrgId) {
					throw new Error("The matter workspace changed during this turn");
				}
				const context = {
					matter: current,
					members: deps.listSharedMatterAiMembers(current),
					workspaceId: current.workspaceId,
					repoPath: cwd,
					orgId: activeOrgId,
					workspaceName: input.workspace?.name,
					runtimeMemberId: input.member.id,
					activeTools: observedTools,
				};
				const chinese = call.language ? call.language === "zh" : /\p{Script=Han}/u.test(input.taskPrompt);
				const topics = await Promise.all(
					call.topics.map((topic) => readWorkbenchTopic(deps.store, context, topic, chinese)),
				);
				toolSignal.throwIfAborted();
				return { topics };
			}
			if (isArchitect) throw new Error("Role architect cannot execute team tools");
			const releaseIdle = worker?.suspendIdleTimeout?.();
			const resumeMonitor = activity?.wait();
			try {
				if (call.tool === "delegate_to_member") {
					if (!canDelegate) {
						throw new Error(
							sessionMode === "observer"
								? "Observing specialists cannot delegate secondary tasks during peer review"
								: "This member cannot delegate secondary tasks",
						);
					}
					if (call.verification && !canPublish) {
						throw new Error("Only the lead of an authorized work turn can request independent verification");
					}
					const result = await deps.delegate(
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
						effects,
						input.onProgress,
						{
							discussionMode: isDiscussionMode,
							parentRequestMessageId: input.delegationRequestId,
							verification: call.verification,
						},
					);
					return {
						memberId: result.toMember.id,
						delegationNumber: result.delegationNumber,
						answer: result.answerText,
						...(result.clarification
							? { status: "needs_clarification", clarification: result.clarification }
							: {}),
						...(result.verification ? { verification: result.verification } : {}),
					};
				}
				if (call.tool === "request_clarification") {
					return humanQuestion.request(call);
				}
				if (call.tool === "propose_experience") {
					if (!canProposeExperience && !isDiscussionMode) {
						throw new Error(
							`${sessionMode === "observer" ? "Observing" : "Verifying"} specialists cannot propose experiences during peer review`,
						);
					}
					if (isDiscussionMode) {
						throw new Error("Discussion chat mode does not propose experiences directly");
					}
					if (call.scope === "project_private" && !input.workspace) {
						throw new Error(
							"Project experiences require a bound workspace; private facts must not be reclassified as role_general",
						);
					}
					if (call.scope === "company_private" && !input.workspace && !activeOrgId) {
						throw new Error(
							"Private company or project experiences require a bound workspace or organization; private facts must not be reclassified as role_general",
						);
					}
					if (call.supersedesMemoryId) {
						const target = deps.store.getMemory(call.supersedesMemoryId);
						if (!target || target.memberId !== input.member.id) {
							throw new Error("Cannot supersede missing or foreign member memory");
						}
						const orgId = call.scope === "company_private" ? activeOrgId : null;
						const targetWorkspaceId =
							call.scope === "role_general" ? null : orgId ? null : (input.workspace?.id ?? null);
						deps.store.validateMemoryReplacement(
							{
								memberId: input.member.id,
								scope: call.scope,
								orgId,
								workspaceId: targetWorkspaceId,
							},
							target.id,
						);
					}
					const normContent = call.content.replace(/\s+/g, " ").trim().toLowerCase();
					if (
						!stagedExperiences.some(
							(item) =>
								item.scope === call.scope &&
								item.content.replace(/\s+/g, " ").trim().toLowerCase() === normContent,
						)
					) {
						stagedExperiences.push({
							scope: call.scope,
							category: call.category,
							content: call.content,
							rationale: call.rationale,
							supersedesMemoryId: call.supersedesMemoryId,
						});
					}
					return { staged: true, status: "candidate", scope: call.scope, note: "本轮完成后记为待验证经验" };
				}
				if (!canPublish)
					throw new Error(
						isDiscussionMode
							? "Chat discussion mode does not publish formal deliverables; switch to「给 AI 安排事项」to publish"
							: "Internal specialists return results to the lead; only the lead publishes user deliverables",
					);
				const draft = await prepareDelivery(call, cwd);
				toolSignal.throwIfAborted();
				const previousDocument = deliveries.findIndex(
					(entry) =>
						entry.memberId === input.member.id &&
						entry.draft.type === "document" &&
						draft.type === "document" &&
						entry.draft.title === draft.title,
				);
				if (previousDocument >= 0) deliveries[previousDocument] = { memberId: input.member.id, cwd, draft };
				else if (
					!deliveries.some(
						(entry) =>
							entry.memberId === input.member.id &&
							entry.draft.title === draft.title &&
							entry.draft.content === draft.content,
					)
				)
					deliveries.push({ memberId: input.member.id, cwd, draft });
				return {
					staged: true,
					title: draft.title,
					...(draft.type === "document" && draft.source.kind === "workspace_file"
						? { sourcePath: draft.source.path, contentSha256: draft.source.sha256 }
						: {}),
					note: "本轮成功结束后归档；如修改来源文件，须重新发布最终文件以更新草稿快照",
				};
			} finally {
				releaseIdle?.();
				resumeMonitor?.();
			}
		}, signal);

		// Use Pi's own resource and project trust rules. Without a workspace, load user resources only.
		const args = inheritsLocalResources
			? ["--offline", ...(input.workspace ? [] : ["--no-approve"])]
			: ["--no-extensions", "--no-skills"];
		args.push("--extension", teamExtension.entry);
		if (humanQuestion.entry) args.push("--extension", humanQuestion.entry);
		if (!isVerifier && !isConversationReply)
			for (const extension of deps.extensions) args.push("--extension", extension);
		if (webAccess) args.push("--extension", webAccess.entry);
		if (mcpDependencies.length === 0) args.push("--no-mcp");
		else args.push("--extension", "builtin:mcp");
		for (const path of skillPaths) args.push("--skill", path);
		if (pstack) args.push(...pstack.args);
		args.push("--tools", toolPatterns.join(","));

		const effectiveMember = activeOrgId ? deps.store.resolveMemberForOrg(activeOrgId, input.member) : input.member;
		const useRoleGitIdentity = Boolean(organization?.useRoleGitIdentity);
		const gitIdentity = resolveEffectiveGitIdentity(effectiveMember, organization);
		const repoGitUser = resolveRepoGitUserIdentity(cwd);
		const workspaceTopLevelEntries = input.workspace ? listWorkspaceTopLevelEntries(cwd) : undefined;
		const committerName = repoGitUser?.name || gitIdentity.gitName;
		const committerEmail = repoGitUser?.email || gitIdentity.gitEmail;
		const relevantMemories = deps.store.listRelevantMemories(effectiveMember.id, input.workspace?.id ?? null, {
			orgId: activeOrgId,
		});
		const matterModel =
			sessionMode === "lead" &&
			(!(isArchitect || isDiscussionMode || input.run.keepMatterLead) || input.member.id === matter?.leadMemberId)
				? matter?.modelSelection
				: null;
		const configuredModel = resolveConfiguredModel(deps.store, activeOrgId, input.member.id, matterModel);
		let selection = configuredModel;
		if (!configuredModel || configuredModel.thinkingLevel === undefined) {
			const piDefault = (await abortable(deps.readPiModels(configuredModel ?? undefined), signal)).defaultModel;
			if (
				!configuredModel ||
				(piDefault?.provider === configuredModel.provider && piDefault.model === configuredModel.model)
			) {
				selection = piDefault;
			}
		}
		const { systemPrompt, turnContext } = buildMemberPrompts({
			member: effectiveMember,
			template,
			memories: relevantMemories,
			workspace: input.workspace,
			workspaceTopLevelEntries,
			organization,
			repoGitUser,
			sessionMode,
			discussionMode: isDiscussionMode,
			conversationReply: isConversationReply,
			leadMemberId: matter?.leadMemberId ?? null,
			consultMemberIds: matter?.consultMemberIds ?? null,
			observerMemberIds: matter?.observerMemberIds ?? [],
			teamMembers: matterAiMembers,
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
		signal.throwIfAborted();
		worker = deps.workerFactory({
			cwd,
			provider: selection?.provider,
			model: selection?.model,
			sessionDir: deps.sessionDir,
			sessionFile,
			noSession: deps.noSession,
			args,
			env: {
				...teamExtension.buildEnvironment({
					bridgeEnv: bridge.env,
					requiredTools: toolPatterns,
					workspaceRoot: input.workspace ? cwd : undefined,
					memberContext: [
						systemPrompt,
						WORKBENCH_HELP_PROMPT,
						architectContext?.systemPrompt,
						pstack?.systemPrompt,
					],
					turnContext: [turnContext, architectContext?.turnContext],
				}),
				...pstack?.env,
				...humanQuestion.env,
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
				...(organization ? { PA_ORG_ID: organization.id, PA_ORG_NAME: organization.name } : {}),
			},
		});
		input.run.workers.add(worker);
		const offEvent = worker.onEvent?.((event) => {
			if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
				const toolName = String(event.toolName ?? "tool");
				const toolCallId = String(event.toolCallId);
				if (event.type === "tool_execution_start") activity?.toolStarted(toolCallId, formatToolAction(toolName));
				else activity?.toolFinished(toolCallId, `已返回${formatToolAction(toolName)}`);
				const rawArgs =
					event.args && typeof event.args === "object" ? (event.args as Record<string, unknown>) : undefined;
				const compactArgs =
					event.type === "tool_execution_start" && rawArgs
						? {
								...(toolName === "load_pstack_skill" && typeof rawArgs.name === "string"
									? { name: rawArgs.name.slice(0, 128) }
									: {}),
								...(toolName === "load_pstack_skill" && typeof rawArgs.resource === "string"
									? { resource: rawArgs.resource.slice(0, 240) }
									: {}),
								...(typeof rawArgs.path === "string" ? { path: rawArgs.path.slice(0, 240) } : {}),
								...(typeof rawArgs.sourcePath === "string"
									? { sourcePath: rawArgs.sourcePath.slice(0, 240) }
									: {}),
								...(typeof rawArgs.command === "string"
									? { command: rawArgs.command.replace(/\s+/g, " ").trim().slice(0, 240) }
									: {}),
								...(typeof rawArgs.title === "string" ? { title: rawArgs.title.slice(0, 240) } : {}),
							}
						: undefined;
				deps.store.appendMessage({
					matterId: input.matterId,
					channel: "notice",
					senderType: "system",
					senderId: input.member.id,
					content: JSON.stringify({
						type: event.type,
						toolCallId: event.toolCallId,
						toolName,
						...(compactArgs && Object.keys(compactArgs).length > 0 ? { args: compactArgs } : {}),
						...(event.type === "tool_execution_end" ? { isError: Boolean(event.isError) } : {}),
					}),
				});
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
				activity?.pulse("开始生成回复");
				if (sessionMode === "lead" && input.run.activeDelegations.size > 0) {
					return;
				}
				input.onProgress?.({
					stage: "thinking",
					label: `${input.member.displayName}正在思考`,
					recentLogs: [...input.run.recentLogs],
				});
			} else activity?.pulse();
		});
		if (offEvent) cleanups.push(offEvent);
		cleanups.push(
			worker.onNotice((notice) => {
				activity?.pulse();
				deps.store.appendMessage({
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
		for (const dependency of mcpDependencies)
			if (!tools.some((name) => name.startsWith(`mcp__${dependency}__`))) missing.push(`MCP:${dependency}`);
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
				...(pstack ? { pstack: pstack.readyDetails } : {}),
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
			deliverables: deps.store.listDeliverables(input.matterId),
			workspaceId: input.workspace?.id ?? null,
			repoPath: cwd,
		});
		const lastUserMsg = scopedContext.messages.filter((msg) => msg.channel === "user").at(-1);
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
						deliverables: scopedContext.deliverables,
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
		const prompt = escapeWebAccessSlashCommand(
			[contextBlock, resumeBrief, input.taskPrompt].filter(Boolean).join("\n\n"),
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
		if (relevantMemories.length > 0) {
			effects.applicationIds.push(
				...deps.store.recordMemoryApplications({
					memoryIds: relevantMemories.map((memory) => memory.id),
					matterId: input.matterId,
					memberId: input.member.id,
				}),
			);
		}
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
			for (const item of stagedExperiences) {
				const orgId = item.scope === "company_private" ? activeOrgId : null;
				const workspaceId = item.scope === "role_general" ? null : orgId ? null : (input.workspace?.id ?? null);
				effects.experiences.push({
					...item,
					memberId: input.member.id,
					orgId,
					workspaceId,
					sourceMatterId: input.matterId,
					status: "candidate",
					verified: false,
				});
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
