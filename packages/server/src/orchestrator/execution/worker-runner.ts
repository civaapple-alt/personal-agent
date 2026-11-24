import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { SkillProposalItem } from "@pa/contracts/skill-proposal";
import { classifyGithubFetches } from "../../../../../pa-extensions/worker-runtime/pi/web-fetch-evidence.js";
import { resolveBuiltinExtensionPath, resolveRepoAssetPath, resolveRepoRoot } from "../../extensions/builtin-paths.ts";
import { prepareHumanQuestion } from "../../extensions/human-question/runtime.ts";
import { prepareTeamExtension } from "../../extensions/team-extension/runtime.ts";
import { escapeWebAccessSlashCommand, prepareWebAccessForWorker } from "../../extensions/web-access/runtime.ts";
import { WORKBENCH_HELP_PROMPT, type WorkbenchTopic } from "../../extensions/workbench-help/catalog.ts";
import { isArchitectRoleTemplate } from "../../roles/role-architect.ts";
import type { RoleTemplate } from "../../roles/types.ts";
import type { PromptRunResult } from "../../rpc/pi-rpc-worker.ts";
import { summarizePromptUsage } from "../../rpc/prompt-usage.ts";
import { abortable, createTeamToolBridge, type TeamToolCall } from "../../rpc/team-tool-bridge.ts";
import type { ImageContent } from "../../rpc/types.ts";
import { type PersonalAgentStore, resolveEffectiveGitIdentity } from "../../storage/repositories.ts";
import type { Matter, TeamMember, WorkspaceLink } from "../../storage/types.ts";
import { buildArchitectMatterContext } from "../architect/meta-architect.ts";
import { messageMatchesContext, scopedSpaceDocumentIds, selectMatterContext } from "../runtime/matter-context.ts";
import { applyWorkerModel, type ReadPiModels, resolveConfiguredModel } from "../runtime/model-selection.ts";
import { buildTeamCapabilities } from "../runtime/team-capabilities.ts";
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
	formatToolAction,
	type MatterRun,
	mergeEffects,
	type OrchestratorDialogHandler,
	pushRunLog,
	type RpcWorkerLike,
	summarizeToolArgs,
	type WorkerFactory,
	type WorkerSessionMode,
} from "../types.ts";
import {
	listWorkspaceTopLevelEntries,
	prepareDelivery,
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

export interface WorkerRunnerDeps {
	store: PersonalAgentStore;
	defaultCwd: string;
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
		isMatterLead,
	});
	const { canSaveSpace, canDelegate, canCaptureSkill } = teamExtension;
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
				});
		const skillPaths = [...new Set([...baseSkillPaths, ...attachedSkillPaths, ...discoveredScopedSkillDirs])];
		const previous = deps.noSession
			? null
			: deps.store.findWorkerSession(input.matterId, input.member.id, contextKey, input.workspace?.id ?? null);
		const sessionFile = previous ? await validateSavedSession(previous, cwd) : undefined;
		// Role declarations describe responsibilities, not the runtime tool allowlist.
		const requestedTools = ["read", process.platform === "win32" ? "powershell" : "bash", "edit", "write"];
		const webAccess = await prepareWebAccessForWorker({
			store: deps.store,
			envFilePath: resolve(deps.defaultCwd, ".env"),
		});
		if (webAccess) requestedTools.push(...webAccess.tools);
		const requiredTools = [
			...requestedTools,
			"list_available_skills",
			"load_available_skill",
			"list_pi_commands",
			"request_pi_command",
			...teamExtension.tools,
			...humanQuestion.tools,
		];
		const stagedSkillProposals: SkillProposalItem[] = [];
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
		bridge = await createTeamToolBridge(async (call: TeamToolCall, toolSignal) => {
			toolSignal.throwIfAborted();
			const visibleInMatter = (document: { matterId: string | null }) => {
				if (!document.matterId || document.matterId === input.matterId) return true;
				return deps.store.getMatter(document.matterId)?.visibility === "org";
			};
			if (call.tool === "read_pa_help") {
				const context = workbenchContext();
				const chinese = call.language ? call.language === "zh" : /\p{Script=Han}/u.test(input.taskPrompt);
				const topics = await Promise.all(
					call.topics.map((topic) => readWorkbenchTopic(deps.store, context, topic, chinese)),
				);
				toolSignal.throwIfAborted();
				return { topics };
			}
			if (isArchitect) throw new Error("Role architect cannot execute team tools");
			if (call.tool === "read_space") {
				if (sessionMode !== "lead" && sessionMode !== "internal")
					throw new Error("This worker cannot access space pages");
				const currentMatter = deps.requireMatter(input.matterId);
				const targetSpace = deps.store.spaces.resolveMatterDefaultSpace(currentMatter);
				if (!call.pageId) {
					const availableSpaces = deps.store.spaces
						.listSpaces()
						.filter((space) => {
							if (space.id === targetSpace.id) return true;
							if (space.kind === "org") return space.orgId === activeOrgId;
							if (space.kind === "workspace") return space.workspaceId === currentMatter.workspaceId;
							if (space.kind === "member") return space.memberId === input.member.id;
							if (space.kind === "custom" && space.visibility === "org") return space.orgId === activeOrgId;
							return false;
						})
						.map((space) => ({
							id: space.id,
							name: space.name,
							kind: space.kind,
							documentCount: deps.store.spaces.listDocuments({ spaceId: space.id }).filter(visibleInMatter)
								.length,
							isDefaultForMatter: space.id === targetSpace.id,
						}));
					return {
						space: { id: targetSpace.id, name: targetSpace.name, kind: targetSpace.kind },
						availableSpaces,
						pages: deps.store.spaces
							.listDocuments({ spaceId: targetSpace.id, docType: call.docType })
							.filter(visibleInMatter),
					};
				}
				const doc = await deps.store.spaces.getDocument(call.pageId);
				if (!doc || doc.spaceId !== targetSpace.id || !visibleInMatter(doc))
					throw new Error("Space page not found in this space");
				if (doc.entryKind === "folder") {
					const listed = await deps.store.spaces.listDocumentFiles(doc.id);
					if (call.subPath) {
						const fileContent = await deps.store.spaces.readDocumentFile(doc.id, call.subPath);
						if (fileContent === null) throw new Error(`Sub-file not found in folder entry: ${call.subPath}`);
						return {
							page: doc,
							subPath: call.subPath,
							fileContent,
							files: listed?.files ?? [],
							previewEntryPath: listed?.previewEntryPath ?? null,
						};
					}
					return {
						page: doc,
						files: listed?.files ?? [],
						previewEntryPath: listed?.previewEntryPath ?? null,
					};
				}
				return { page: doc };
			}
			if (call.tool === "save_space_page") {
				if (!canSaveSpace) throw new Error("Only the matter lead can save space pages");
				const hasMainBody = call.sourcePath !== undefined || call.content !== undefined;
				const draft = hasMainBody
					? await prepareDelivery(
							{
								tool: "save_space_page",
								callId: call.callId,
								title: call.title,
								summary: call.summary ?? "",
								changeNote: call.changeNote ?? "本轮形成的空间资料",
								...(call.sourcePath !== undefined
									? { type: "document" as const, sourcePath: call.sourcePath }
									: { type: call.type, content: call.content! }),
							},
							cwd,
						)
					: null;
				toolSignal.throwIfAborted();
				const currentMatter = deps.requireMatter(input.matterId);
				const targetSpace = deps.store.spaces.resolveMatterDefaultSpace(currentMatter);
				const linkedFilePath =
					draft && draft.type === "document" && draft.source.kind === "workspace_file"
						? relative(cwd, draft.source.realPath).replace(/\\/g, "/")
						: null;
				const linkedOrgId = linkedFilePath ? activeOrgId : null;
				const linkedWorkspaceId = linkedFilePath ? (input.workspace?.id ?? null) : null;
				const staged = !call.pageId
					? effects.savedDocuments.find(
							(entry) => entry.memberId === input.member.id && entry.title === call.title,
						)
					: undefined;
				const batchFiles: Array<{ subPath: string; content: string }> = [
					...(call.files ?? []).map((f) => ({ subPath: f.path, content: f.content })),
				];
				if (call.subPath && draft) {
					batchFiles.push({ subPath: call.subPath, content: draft.content });
				}
				if (!call.pageId && !staged) {
					const wantsFolder = call.entryKind === "folder" || batchFiles.length > 0;
					const readmeFromBatch = batchFiles.find((f) => f.subPath === "README.md");
					const initialContent =
						!call.subPath && draft
							? draft.content
							: readmeFromBatch
								? readmeFromBatch.content
								: `# ${call.title}\n`;
					const extraFiles = batchFiles.filter((f) => f.subPath !== "README.md");
					const doc = await deps.store.spaces.createDocument({
						spaceId: targetSpace.id,
						matterId: input.matterId,
						title: call.title,
						docType: call.docType,
						entryKind: wantsFolder ? "folder" : "file",
						content: initialContent,
						extraFiles,
						linkedOrgId,
						linkedWorkspaceId,
						linkedFilePath,
						actorId: input.member.id,
						actorName: input.member.displayName,
						commitMessage: call.changeNote || `Create ${call.title}`,
					});
					effects.savedDocuments.push({
						id: doc.id,
						spaceId: doc.spaceId,
						title: doc.title,
						docType: doc.docType,
						revision: doc.revision,
						headCommit: doc.headCommit,
						memberId: input.member.id,
						summary: (call.changeNote || call.summary || "").trim().slice(0, 240) || undefined,
					});
					input.onProgress?.({
						stage: "tool",
						label: `${input.member.displayName}保存了资料`,
						toolName: "save_space_page",
						collabUpdated: true,
					});
					const listed = doc.entryKind === "folder" ? await deps.store.spaces.listDocumentFiles(doc.id) : null;
					return {
						page: doc,
						...(listed ? { files: listed.files, previewEntryPath: listed.previewEntryPath } : {}),
					};
				}
				const targetDocId = call.pageId ?? staged!.id;
				const previous = deps.store.spaces.getDocumentMeta(targetDocId);
				if (!previous || previous.spaceId !== targetSpace.id || !visibleInMatter(previous))
					throw new Error("Space page not found in this space");
				let doc: Awaited<ReturnType<typeof deps.store.spaces.updateDocument>>;
				if (batchFiles.length > 0) {
					const allToWrite = [
						...(!call.subPath && draft ? [{ subPath: "README.md", content: draft.content }] : []),
						...batchFiles,
					];
					const written = await deps.store.spaces.writeDocumentFiles(previous.id, {
						files: allToWrite,
						actorId: input.member.id,
						actorName: input.member.displayName,
						commitMessage: call.changeNote || `Update files in ${call.title}`,
					});
					doc = written?.document ?? null;
				} else {
					doc = await deps.store.spaces.updateDocument(previous.id, {
						revision: call.revision ?? staged?.revision ?? previous.revision,
						title: call.title,
						docType: call.docType,
						content: draft?.content ?? "",
						...(linkedFilePath ? { linkedOrgId, linkedWorkspaceId, linkedFilePath } : {}),
						actorId: input.member.id,
						actorName: input.member.displayName,
						commitMessage: call.changeNote || `Update ${call.title}`,
					});
				}
				if (!doc) throw new Error("Space page changed. Read its latest revision before saving.");
				const existingIdx = effects.savedDocuments.findIndex((entry) => entry.id === doc.id);
				const savedEntry = {
					id: doc.id,
					spaceId: doc.spaceId,
					title: doc.title,
					docType: doc.docType,
					revision: doc.revision,
					headCommit: doc.headCommit,
					memberId: input.member.id,
					summary: (call.changeNote || call.summary || "").trim().slice(0, 240) || undefined,
				};
				if (existingIdx < 0) effects.savedDocuments.push(savedEntry);
				else effects.savedDocuments[existingIdx] = savedEntry;
				input.onProgress?.({
					stage: "tool",
					label: `${input.member.displayName}更新了资料`,
					toolName: "save_space_page",
					collabUpdated: true,
				});
				return { page: doc };
			}
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
					if (call.verification && !canSaveSpace) {
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
				if (call.tool === "propose_skill") {
					if (!canCaptureSkill && !isDiscussionMode) {
						throw new Error(
							`${sessionMode === "observer" ? "Observing" : "Verifying"} specialists cannot propose skills during peer review`,
						);
					}
					if (isDiscussionMode) {
						throw new Error("Discussion chat mode does not propose skills directly");
					}
					if (call.storageScope === "workspace" && !input.workspace) {
						throw new Error("Workspace skill proposals require a bound workspace");
					}
					if (call.storageScope === "org" && !activeOrgId) {
						throw new Error("Organization skill proposals require an active organization");
					}
					const proposal: SkillProposalItem = {
						id: `skp_${randomUUID().slice(0, 12)}`,
						name: call.name,
						description: call.description,
						body: call.body,
						...(call.scripts && call.scripts.length > 0 ? { scripts: call.scripts } : {}),
						storageScope: call.storageScope,
						rationale: call.rationale,
						status: "pending" as const,
					};
					const existingIdx = stagedSkillProposals.findIndex((item) => item.name === proposal.name);
					if (existingIdx < 0) stagedSkillProposals.push(proposal);
					else stagedSkillProposals[existingIdx] = proposal;
					return {
						staged: true,
						status: "pending_confirmation",
						proposalId: proposal.id,
						name: proposal.name,
						storageScope: proposal.storageScope,
						scriptCount: proposal.scripts?.length ?? 0,
						note: "已暂存技能提案，本轮回复中将展示确认卡，经用户确认后写入磁盘。",
					};
				}
			} finally {
				releaseIdle?.();
				resumeMonitor?.();
			}
		}, signal);

		// Use Pi's own resource and project trust rules. Without a workspace, load user resources only.
		const args = inheritsLocalResources
			? ["--offline", ...(input.workspace ? [] : ["--no-approve"])]
			: ["--no-extensions", "--no-approve"];
		for (const entry of teamExtension.entries) args.push("--extension", entry);
		args.push("--extension", resolveBuiltinExtensionPath("skill-catalog"));
		args.push("--extension", resolveBuiltinExtensionPath("role-skills"));
		if (!isArchitect) args.push("--extension", resolveBuiltinExtensionPath("visualize"));
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
			leadMemberId: matter?.leadMemberId ?? null,
			consultMemberIds: matter?.consultMemberIds ?? null,
			observerMemberIds: matter?.observersEnabled ? matter.observerMemberIds : [],
			teamMembers: matterAiMembers,
			teamCapabilities:
				matter && sessionMode === "lead"
					? buildTeamCapabilities({
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
				...teamExtension.buildEnvironment({
					bridgeEnv: bridge.env,
					requiredTools,
					workspaceRoot: input.workspace ? cwd : undefined,
					paInstallRoot: input.run.inheritLocalPiResources ? resolveRepoRoot() : undefined,
					attachedContextFiles,
					memberContext: [systemPrompt, WORKBENCH_HELP_PROMPT, architectContext?.systemPrompt],
					turnContext: [turnContext, attachedFoldersPrompt, architectContext?.turnContext],
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
				...(organization ? { PA_ORG_ID: organization.id, PA_ORG_NAME: organization.name } : {}),
			},
		});
		input.run.workers.add(worker);
		const fetchInputs = new Map<string, unknown>();
		const offEvent = worker.onEvent?.((event) => {
			if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
				const toolName = String(event.toolName ?? "tool");
				const toolCallId = String(event.toolCallId);
				if (toolName === "fetch_content" && event.type === "tool_execution_start")
					fetchInputs.set(toolCallId, event.args);
				if (event.type === "tool_execution_start") activity?.toolStarted(toolCallId, formatToolAction(toolName));
				else activity?.toolFinished(toolCallId, `已返回${formatToolAction(toolName)}`);
				const rawArgs =
					event.args && typeof event.args === "object" ? (event.args as Record<string, unknown>) : undefined;
				const compactArgs =
					event.type === "tool_execution_start" && rawArgs
						? {
								...((toolName === "load_available_skill" || toolName === "request_pi_command") &&
								typeof rawArgs.name === "string"
									? { name: rawArgs.name.slice(0, 128) }
									: {}),
								...(toolName === "load_available_skill" && typeof rawArgs.resource === "string"
									? { resource: rawArgs.resource.slice(0, 240) }
									: {}),
								...(typeof rawArgs.path === "string" ? { path: rawArgs.path.slice(0, 240) } : {}),
								...(toolName === "read" &&
								typeof rawArgs.path === "string" &&
								/(?:^|[\\/])SKILL\.md$/i.test(rawArgs.path)
									? {
											skillName: rawArgs.path
												.replace(/\\/g, "/")
												.split("/")
												.filter(Boolean)
												.at(-2)
												?.slice(0, 128),
										}
									: {}),
								...(typeof rawArgs.sourcePath === "string"
									? { sourcePath: rawArgs.sourcePath.slice(0, 240) }
									: {}),
								...(typeof rawArgs.command === "string"
									? { command: rawArgs.command.replace(/\s+/g, " ").trim().slice(0, 240) }
									: {}),
								...(typeof rawArgs.title === "string" ? { title: rawArgs.title.slice(0, 240) } : {}),
								...(toolName === "visualize"
									? {
											...(typeof rawArgs.type === "string" ? { type: rawArgs.type.slice(0, 32) } : {}),
											...(typeof rawArgs.before === "string"
												? { before: rawArgs.before.slice(0, 240) }
												: {}),
											...(typeof rawArgs.mermaid === "string"
												? { mermaid: rawArgs.mermaid.slice(0, 8000) }
												: {}),
											...(Array.isArray(rawArgs.options) ? { options: rawArgs.options.slice(0, 8) } : {}),
										}
									: {}),
								...(toolName === "propose_skill"
									? {
											...(typeof rawArgs.name === "string" ? { name: rawArgs.name.slice(0, 64) } : {}),
											...(typeof rawArgs.storageScope === "string"
												? { storageScope: rawArgs.storageScope.slice(0, 32) }
												: {}),
											...(typeof rawArgs.description === "string"
												? { description: rawArgs.description.slice(0, 240) }
												: {}),
											...(typeof rawArgs.rationale === "string"
												? { rationale: rawArgs.rationale.slice(0, 240) }
												: {}),
											...(Array.isArray(rawArgs.scripts) ? { scriptCount: rawArgs.scripts.length } : {}),
										}
									: {}),
							}
						: undefined;
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
						type: event.type,
						toolCallId: event.toolCallId,
						toolName,
						...(compactArgs && Object.keys(compactArgs).length > 0 ? { args: compactArgs } : {}),
						...(event.type === "tool_execution_end" && typeof event.isError === "boolean"
							? { isError: event.isError }
							: {}),
					}),
				});
				if (toolName === "fetch_content" && event.type === "tool_execution_end") {
					const inputArgs = fetchInputs.get(toolCallId);
					fetchInputs.delete(toolCallId);
					const result = event.result;
					const content = result && typeof result === "object" && "content" in result ? result.content : undefined;
					const structured =
						result && typeof result === "object" && "structuredContent" in result
							? result.structuredContent
							: undefined;
					for (const evidence of classifyGithubFetches(inputArgs, content, event.isError !== false, structured)) {
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
								method: "web_fetch_evidence",
								toolCallId,
								source: evidence.source,
								kind: evidence.kind,
								truncated: evidence.truncated,
							}),
						});
						const label =
							evidence.kind === "temporary_clone"
								? "已获取 GitHub 临时副本，跨轮次可能失效"
								: evidence.kind === "github_api"
									? "已获取 GitHub API 视图，未确认本地克隆"
									: "已获取 GitHub 内容，获取方式未确认";
						pushRunLog(input.run, input.member.displayName, label);
					}
				}
				const toolSummary = event.type === "tool_execution_start" ? summarizeToolArgs(event.args) : undefined;
				if (event.type === "tool_execution_start" && toolName !== "delegate_to_member") {
					pushRunLog(
						input.run,
						input.member.displayName,
						`${formatToolAction(toolName)}${toolSummary ? `：${toolSummary}` : ""}`,
						{ memberId: input.member.id, toolCallId, toolName },
					);
				}
				if (event.type === "tool_execution_end") {
					const log = input.run.recentLogs.findLast(
						(entry) => entry.memberId === input.member.id && entry.toolCallId === toolCallId,
					);
					if (log)
						log.toolStatus =
							typeof event.isError === "boolean" ? (event.isError ? "error" : "success") : "unknown";
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
					"Answer the specific question first. Use the recent conversation to resolve follow-ups. Include only the facts and steps needed to answer, then stop. Treat the reference as evidence and use read_pa_help when you need more PA facts. Describe actions and tool availability only when supported by that evidence.",
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
			"This is this role's current startup, distinct from historical internal-startup records in team capability cards. Registration does not prove a tool call succeeded. Use read_pa_help runtime_tools to check current call evidence; do not invent successful calls.",
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
			for (const proposal of stagedSkillProposals) {
				const existingIdx = effects.skillProposals.findIndex((item) => item.name === proposal.name);
				if (existingIdx < 0) effects.skillProposals.push(proposal);
				else effects.skillProposals[existingIdx] = proposal;
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
