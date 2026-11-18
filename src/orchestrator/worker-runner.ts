import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPstackGuidance, preparePstackRuntime } from "../roles/pstack.ts";
import { isArchitectRoleTemplate } from "../roles/role-architect.ts";
import type { RoleTemplate } from "../roles/types.ts";
import type { PromptRunResult } from "../rpc/pi-rpc-worker.ts";
import { abortable, createTeamToolBridge, type TeamToolCall } from "../rpc/team-tool-bridge.ts";
import type { ImageContent } from "../rpc/types.ts";
import { type PersonalAgentStore, resolveEffectiveGitIdentity } from "../storage/repositories.ts";
import type { Matter, MemoryCategory, MemoryScope, TeamMember, WorkspaceLink } from "../storage/types.ts";
import {
	prepareDelivery,
	resolveRepoGitUserIdentity,
	resolveRoleSkills,
	validateSavedSession,
} from "./execution-context.ts";
import { messageMatchesContext, selectMatterContext } from "./matter-context.ts";
import { buildArchitectMatterContext } from "./meta-architect.ts";
import {
	buildInterruptionResumeBrief,
	buildMemberSystemPrompt,
	buildObserverContextDigest,
	formatMessageHistoryContent,
	formatMessageHistorySpeaker,
} from "./prompts.ts";
import {
	type DelegateInput,
	type DelegateResult,
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
} from "./types.ts";

export interface WorkerRunnerDeps {
	store: PersonalAgentStore;
	defaultCwd: string;
	sessionDir: string | undefined;
	noSession: boolean;
	extensions: string[];
	pstackDir?: string;
	workerFactory: WorkerFactory;
	getDialogHandler: () => OrchestratorDialogHandler | undefined;
	getTemplateForMember: (member: TeamMember) => RoleTemplate | undefined;
	getTemplatesById?: () => Map<string, RoleTemplate>;
	resolveMatterAiMembers: (matter: Matter | null) => TeamMember[];
	requireMatter: (matterId: string) => Matter;
	delegate: (
		input: DelegateInput,
		run: MatterRun,
		workspace: WorkspaceLink | null,
		chain: string[],
		signal: AbortSignal,
		effectsTarget: ExecutionEffects,
		onProgress?: (progress: DispatchProgressEvent) => void,
	) => Promise<DelegateResult>;
}

export interface ExecuteWorkerInput {
	matterId: string;
	member: TeamMember;
	workspace: WorkspaceLink | null;
	taskPrompt: string;
	images?: ImageContent[];
	isInternalDelegation?: boolean;
	sessionMode?: "lead" | "internal" | "observer";
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
	const canPublish = sessionMode === "lead";
	const matter = deps.store.getMatter(input.matterId);
	const matterAiMembers = deps.resolveMatterAiMembers(matter);
	const isSoloMatter = sessionMode === "lead" && matterAiMembers.length <= 1;
	const canDelegate = sessionMode !== "observer" && !isSoloMatter;
	const activeOrgId = input.workspace ? input.workspace.orgId : (matter?.orgId ?? null);
	const organization = activeOrgId ? deps.store.getOrganization(activeOrgId) : null;
	const cwd = resolve(input.workspace?.repoPath ?? deps.defaultCwd);
	const contextKey = JSON.stringify([
		"v2",
		input.workspace?.id ?? null,
		cwd,
		sessionMode === "lead" ? "user" : sessionMode,
		activeOrgId,
	]);
	const executionKey = JSON.stringify([input.member.id, contextKey]);
	if (input.run.contexts.has(executionKey)) throw new Error("Colleague is already working in this conversation");
	input.run.contexts.add(executionKey);
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
		const template = deps.getTemplateForMember(input.member);
		const isArchitect = isArchitectRoleTemplate(template ?? { id: input.member.id });
		const skillPaths = await resolveRoleSkills(template);
		const pstack = deps.pstackDir ? await preparePstackRuntime(deps.pstackDir) : undefined;
		const methodTools = pstack ? ["load_pstack_skill"] : [];
		const previous = deps.noSession
			? null
			: deps.store.findWorkerSession(input.matterId, input.member.id, contextKey, input.workspace?.id ?? null);
		const sessionFile = previous ? await validateSavedSession(previous, cwd) : undefined;
		const baseTools = isArchitect
			? []
			: (template?.tools ?? ["read", "bash", "edit", "write"]).filter((tool) => tool !== "mcp");
		const requestedTools =
			sessionMode === "observer" ? baseTools.filter((tool) => tool !== "edit" && tool !== "write") : baseTools;
		const mcpDependencies = isArchitect ? [] : (template?.mcpDependencies ?? []);
		const teamTools = isArchitect
			? []
			: sessionMode === "observer"
				? []
				: sessionMode === "internal"
					? ["delegate_to_member", "propose_experience"]
					: isSoloMatter
						? ["publish_deliverable", "propose_experience"]
						: ["delegate_to_member", "publish_deliverable", "propose_experience"];
		const stagedExperiences: Array<{
			scope: MemoryScope;
			category: MemoryCategory;
			content: string;
			rationale: string;
			supersedesMemoryId?: string;
		}> = [];
		bridge = await createTeamToolBridge(async (call: TeamToolCall, toolSignal) => {
			toolSignal.throwIfAborted();
			if (isArchitect) throw new Error("Role architect cannot execute team tools");
			const releaseIdle = worker?.suspendIdleTimeout?.();
			try {
				if (call.tool === "delegate_to_member") {
					if (!canDelegate) {
						throw new Error("Observing specialists cannot delegate secondary tasks during peer review");
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
					);
					return { memberId: result.toMember.id, answer: result.answerText };
				}
				if (call.tool === "propose_experience") {
					if (sessionMode === "observer") {
						throw new Error("Observing specialists cannot propose experiences during peer review");
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
						"Internal specialists return results to the lead; only the lead publishes user deliverables",
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
		for (const extension of deps.extensions) args.push("--extension", extension);
		if (mcpDependencies.length === 0) args.push("--no-mcp");
		else args.push("--extension", "builtin:mcp");
		for (const path of skillPaths) args.push("--skill", path);
		if (pstack)
			args.push(
				"--skill",
				pstack.modePath,
				"--extension",
				fileURLToPath(
					new URL(
						import.meta.url.endsWith(".js") ? "../rpc/pstack-extension.js" : "../rpc/pstack-extension.ts",
						import.meta.url,
					),
				),
			);
		args.push(
			"--tools",
			[...requestedTools, ...teamTools, ...methodTools, ...mcpDependencies.map((name) => `mcp__${name}__*`)].join(
				",",
			),
		);

		const gitIdentity = resolveEffectiveGitIdentity(input.member, organization);
		const repoGitUser = resolveRepoGitUserIdentity(cwd);
		const committerName = repoGitUser?.name || gitIdentity.gitName;
		const committerEmail = repoGitUser?.email || gitIdentity.gitEmail;
		const relevantMemories = deps.store.listRelevantMemories(input.member.id, input.workspace?.id ?? null, {
			orgId: activeOrgId,
		});
		worker = deps.workerFactory({
			cwd,
			provider: input.member.provider,
			model: input.member.model,
			sessionDir: deps.sessionDir,
			sessionFile,
			noSession: deps.noSession,
			args,
			env: {
				...bridge.env,
				...(pstack ? { PA_PSTACK_DIR: pstack.root } : {}),
				GIT_AUTHOR_NAME: gitIdentity.gitName,
				GIT_AUTHOR_EMAIL: gitIdentity.gitEmail,
				GIT_COMMITTER_NAME: committerName,
				GIT_COMMITTER_EMAIL: committerEmail,
				PA_MEMBER_ID: input.member.id,
				PA_MEMBER_NAME: input.member.displayName,
				PA_MEMBER_TITLE: input.member.roleTitle,
				...(organization ? { PA_ORG_ID: organization.id, PA_ORG_NAME: organization.name } : {}),
				PA_CAN_PUBLISH: String(canPublish && !isArchitect),
				PA_CAN_DELEGATE: String(canDelegate && !isArchitect),
				PA_CAN_EXPERIENCE: String(sessionMode !== "observer" && !isArchitect),
				PA_REQUIRED_TOOLS: JSON.stringify([
					...requestedTools,
					...teamTools,
					...methodTools,
					...mcpDependencies.map((name) => `mcp__${name}__*`),
				]),
				PA_MEMBER_CONTEXT:
					buildMemberSystemPrompt({
						member: input.member,
						template,
						memories: relevantMemories,
						workspace: input.workspace,
						organization,
						repoGitUser,
						sessionMode,
						teamMembers: deps.resolveMatterAiMembers(matter),
						...(isArchitect && deps.getTemplatesById
							? {
									extraGuidance: await buildArchitectMatterContext(
										{ store: deps.store, templatesById: deps.getTemplatesById() },
										{
											isMidMatterConsult: Boolean(
												matter?.leadMemberId && matter.leadMemberId !== input.member.id,
											),
										},
									),
								}
							: {}),
					}) + (pstack ? `\n\n${buildPstackGuidance(pstack, sessionMode)}` : ""),
			},
		});
		input.run.workers.add(worker);
		const offEvent = worker.onEvent?.((event) => {
			if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
				const toolName = String(event.toolName ?? "tool");
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
			const dialogHandler = deps.getDialogHandler();
			if (!dialogHandler) return { cancelled: true };
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
				deps.store.updateMatterStatus(input.matterId, "open");
			}
		});
		input.onProgress?.({ stage: "starting", label: `正在接续${input.member.displayName}的工作` });
		await worker.start();
		signal.throwIfAborted();
		const state = await worker.getState();
		const tools = await bridge.waitReady();
		const missing = [...requestedTools, ...teamTools, ...methodTools].filter((name) => !tools.includes(name));
		for (const dependency of mcpDependencies)
			if (!tools.some((name) => name.startsWith(`mcp__${dependency}__`))) missing.push(`MCP:${dependency}`);
		if (missing.length) throw new Error(`Required capabilities unavailable: ${missing.join(", ")}`);
		deps.store.appendMessage({
			matterId: input.matterId,
			channel: "notice",
			senderType: "system",
			senderId: input.member.id,
			content: JSON.stringify({
				method: "runtime_ready",
				tools,
				skills: skillPaths,
				...(pstack
					? {
							pstack: {
								version: pstack.version,
								root: pstack.root,
								modeSha256: pstack.modeSha256,
								availableSkillCount: pstack.skills.length,
							},
						}
					: {}),
				resumed: Boolean(sessionFile),
				piSessionId: state.sessionId,
			}),
		});
		if (worker.setThinkingLevel) await worker.setThinkingLevel(input.member.thinkingLevel);
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
		const prompt = [contextBlock, resumeBrief, input.taskPrompt].filter(Boolean).join("\n\n");
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
			onTextDelta: input.onTextDelta,
		});
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
		return result;
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
		input.run.contexts.delete(executionKey);
	}
}
