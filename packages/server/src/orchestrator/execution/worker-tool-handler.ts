import { randomUUID } from "node:crypto";
import { relative } from "node:path";
import type { SkillProposalItem } from "@pa/contracts/skill-proposal";
import type { prepareHumanQuestion } from "../../extensions/human-question/runtime.ts";
import { assessRoleCapabilities } from "../../roles/capabilities.ts";
import { buildRoleDesignDraft, isArchitectRoleTemplate, isSoloRoleTemplate } from "../../roles/role-architect.ts";
import type { RoleScope, RoleTemplate } from "../../roles/types.ts";
import type { TeamToolCall } from "../../rpc/team-tool-bridge.ts";
import type { PersonalAgentStore } from "../../storage/repositories.ts";
import type { Matter, TeamMember, WorkspaceLink } from "../../storage/types.ts";
import {
	collectTeamFrictionDigest,
	type MetaArchitectBlueprintProposal,
	type MetaArchitectRoleAdjustment,
} from "../architect/meta-architect.ts";
import { filterTeamMembersForScope } from "../rsi/team-health.ts";
import { buildTeamCapabilities } from "../runtime/team-capabilities.ts";
import type {
	DelegateInput,
	DelegateResult,
	DelegationContext,
	DispatchProgressEvent,
	ExecutionEffects,
	MatterRun,
	RpcWorkerLike,
	WorkerSessionMode,
} from "../types.ts";
import { prepareDelivery, readWorkspaceFolder } from "./execution-context.ts";
import type { BoardWorkerContext } from "./worker-setup.ts";

export interface WorkerToolHandlerDeps {
	store: PersonalAgentStore;
	skillsDir?: string;
	requireMatter: (matterId: string) => Matter;
	getTemplateForMember: (member: TeamMember) => RoleTemplate | undefined;
	getTemplatesById?: () => Map<string, RoleTemplate>;
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

export interface WorkerToolHandlerContext {
	deps: WorkerToolHandlerDeps;
	matterId: string;
	member: TeamMember;
	workspace: WorkspaceLink | null;
	delegationRequestId?: string;
	run: MatterRun;
	chain: string[];
	onProgress?: (progress: DispatchProgressEvent) => void;
	matter: Matter | null;
	matterAiMembers: TeamMember[];
	activeOrgId: string | null;
	actorUserId: string | null;
	cwd: string;
	sessionMode: WorkerSessionMode;
	isDiscussionMode: boolean;
	isArchitect: boolean;
	canSaveSpace: boolean;
	canDelegate: boolean;
	canCaptureSkill: boolean;
	canManageRoles: boolean;
	humanQuestion: ReturnType<typeof prepareHumanQuestion>;
	boardCtx?: BoardWorkerContext;
	effects: ExecutionEffects;
	stagedSkillProposals: SkillProposalItem[];
	stagedRoleBlueprints: MetaArchitectBlueprintProposal[];
	stagedRoleAdjustments: MetaArchitectRoleAdjustment[];
	getWorker: () => RpcWorkerLike | undefined;
	activity: { wait: () => () => void } | undefined;
}

/** Create the per-turn bridge tool execution handler for a Pi RPC worker. */
export function createWorkerToolHandler(ctx: WorkerToolHandlerContext) {
	const {
		deps,
		matterId,
		member,
		workspace,
		delegationRequestId,
		run,
		chain,
		onProgress,
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
		getWorker,
		activity,
	} = ctx;

	const visibleInMatter = (document: { matterId: string | null }) => {
		if (!document.matterId || document.matterId === matterId) return true;
		return deps.store.getMatter(document.matterId)?.visibility === "org";
	};

	return async (call: TeamToolCall, toolSignal: AbortSignal): Promise<unknown> => {
		toolSignal.throwIfAborted();
		if (call.tool === "read_team_roles") {
			if (!canManageRoles) {
				throw new Error("Only the lead in non-discussion mode can read team roles for role design");
			}
			const scopeFilter = { orgId: activeOrgId, actorUserId };
			const templatesById = deps.getTemplatesById?.() ?? new Map<string, RoleTemplate>();
			const visibleMembers = filterTeamMembersForScope(deps.store.listMembers(), scopeFilter).filter((entry) => {
				const tpl = deps.getTemplateForMember(entry) ?? templatesById.get(entry.templateId) ?? { id: entry.id };
				return !isArchitectRoleTemplate(tpl) && !isSoloRoleTemplate(tpl);
			});
			const roles = visibleMembers.map((entry) => {
				const tpl = deps.getTemplateForMember(entry) ?? templatesById.get(entry.templateId);
				return {
					id: entry.id,
					name: entry.displayName,
					title: entry.roleTitle,
					roleScope: entry.roleScope ?? "global",
					isPrimaryContact: entry.isPrimaryContact,
					skills: tpl?.skills ?? [],
					mcpDependencies: tpl?.mcpDependencies ?? [],
					antiJobs: tpl?.antiJobs ?? [],
					responsibilities: tpl?.sections.responsibilitiesAndBoundaries ?? "",
				};
			});
			return {
				orgId: activeOrgId,
				roles,
				...(call.includeCapabilities && matter
					? {
							teamCapabilities: buildTeamCapabilities({
								matter,
								members: matterAiMembers,
								messages: deps.store.listMessages(matterId),
								workspaceId: workspace?.id ?? null,
								repoPath: cwd,
								orgId: activeOrgId,
								getTemplate: deps.getTemplateForMember,
							}),
						}
					: {}),
				...(call.includeHealthEvidence
					? { healthEvidenceDigest: collectTeamFrictionDigest(deps.store, templatesById, scopeFilter) }
					: {}),
			};
		}

		if (call.tool === "propose_role") {
			if (!canManageRoles) {
				throw new Error("Only the lead in non-discussion mode can propose role changes");
			}
			const scopeFilter = { orgId: activeOrgId, actorUserId };
			const visibleMembers = filterTeamMembersForScope(deps.store.listMembers(), scopeFilter);
			if (call.action === "create") {
				const roleScope: RoleScope = activeOrgId ? "org" : actorUserId ? "personal" : "global";
				const draft = buildRoleDesignDraft({
					oneJob: call.oneJob,
					antiJobs: call.antiJobs,
					quietWhen: call.quietWhen,
					interactionStyle: call.interactionStyle,
					roleScope,
					ownerOrgId: roleScope === "org" ? activeOrgId : null,
					ownerUserId: roleScope === "personal" ? actorUserId : null,
					roleId: call.id,
					roleName: call.name,
					roleTitle: call.title,
					workflowRules: call.workflowRules,
					communicationStyle: call.communicationStyle,
					verificationPlan: call.verificationPlan,
					skills: call.skills,
					mcpDependencies: call.mcpDependencies,
					suggestedNewSkills: call.newSkills?.map((skill) => ({
						...skill,
						storageScope: skill.storageScope ?? "role_local",
					})),
					existingMemberIds: deps.store.listMembers().map((m) => m.id),
				});
				draft.capabilityReport = await assessRoleCapabilities(draft.template, { skillsDir: deps.skillsDir });
				const proposal: MetaArchitectBlueprintProposal = { draft, rationale: call.rationale };
				const existingIdx = stagedRoleBlueprints.findIndex((item) => item.draft.template.id === draft.template.id);
				if (existingIdx < 0) stagedRoleBlueprints.push(proposal);
				else stagedRoleBlueprints[existingIdx] = proposal;
				return {
					staged: true,
					status: "pending_confirmation",
					action: "create",
					roleId: draft.template.id,
					roleName: draft.template.name,
					newSkillCount: draft.newSkills?.length ?? 0,
					note: "已暂存新建角色提案，本轮回复中将展示确认卡，经用户确认后生效。",
				};
			}
			const target = visibleMembers.find((entry) => entry.id === call.memberId);
			if (!target) {
				throw new Error(`Role "${call.memberId}" was not found in the current visible scope`);
			}
			const targetTemplate = deps.getTemplateForMember(target);
			const adjustment: MetaArchitectRoleAdjustment = {
				memberId: target.id,
				memberName: target.displayName,
				currentTools: targetTemplate?.tools ?? [],
				...(call.addAntiJobs?.length ? { addAntiJobs: call.addAntiJobs } : {}),
				...(call.workflowNote ? { workflowNote: call.workflowNote } : {}),
				rationale: call.rationale,
			};
			const existingIdx = stagedRoleAdjustments.findIndex((item) => item.memberId === adjustment.memberId);
			if (existingIdx < 0) stagedRoleAdjustments.push(adjustment);
			else stagedRoleAdjustments[existingIdx] = adjustment;
			return {
				staged: true,
				status: "pending_confirmation",
				action: "update",
				memberId: target.id,
				memberName: target.displayName,
				note: "已暂存角色调整提案，本轮回复中将展示确认卡，经用户确认后生效。",
			};
		}

		if (isArchitect) throw new Error("Role architect cannot execute team tools");

		if (call.tool === "read_space") {
			if (sessionMode !== "lead" && sessionMode !== "internal") {
				throw new Error("This worker cannot access space pages");
			}
			const currentMatter = deps.requireMatter(matterId);
			const targetSpace = deps.store.spaces.resolveMatterDefaultSpace(currentMatter);
			if (!call.pageId) {
				const availableSpaces = deps.store.spaces
					.listSpaces()
					.filter((space) => {
						if (space.id === targetSpace.id) return true;
						if (space.kind === "org") return space.orgId === activeOrgId;
						if (space.kind === "workspace") return space.workspaceId === currentMatter.workspaceId;
						if (space.kind === "member") return space.memberId === member.id;
						if (space.kind === "custom" && space.visibility === "org") return space.orgId === activeOrgId;
						return false;
					})
					.map((space) => ({
						id: space.id,
						name: space.name,
						kind: space.kind,
						documentCount: deps.store.spaces.listDocuments({ spaceId: space.id }).filter(visibleInMatter).length,
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
			if (!doc || doc.spaceId !== targetSpace.id || !visibleInMatter(doc)) {
				throw new Error("Space page not found in this space");
			}
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
			const importedFolder = call.sourceDir ? await readWorkspaceFolder(call.sourceDir, cwd) : null;
			toolSignal.throwIfAborted();
			const currentMatter = deps.requireMatter(matterId);
			const targetSpace = deps.store.spaces.resolveMatterDefaultSpace(currentMatter);
			const linkedFilePath =
				draft && draft.type === "document" && draft.source.kind === "workspace_file"
					? relative(cwd, draft.source.realPath).replace(/\\/g, "/")
					: importedFolder
						? importedFolder.relDir
						: null;
			const linkedOrgId = linkedFilePath ? activeOrgId : null;
			const linkedWorkspaceId = linkedFilePath ? (workspace?.id ?? null) : null;
			const staged = !call.pageId
				? effects.savedDocuments.find((entry) => entry.memberId === member.id && entry.title === call.title)
				: undefined;
			const batchFiles: Array<{ subPath: string; content: string }> = [
				...(importedFolder?.files ?? []),
				...(call.files ?? []).map((f) => ({ subPath: f.path, content: f.content })),
			];
			if (call.subPath && draft) {
				batchFiles.push({ subPath: call.subPath, content: draft.content });
			}
			if (!call.pageId && !staged) {
				const wantsFolder = call.entryKind === "folder" || batchFiles.length > 0;
				const readmeFromBatch = batchFiles.find((f) => f.subPath === "README.md");
				const initialContent =
					!call.subPath && draft ? draft.content : readmeFromBatch ? readmeFromBatch.content : `# ${call.title}\n`;
				const extraFiles = batchFiles.filter((f) => f.subPath !== "README.md");
				const doc = await deps.store.spaces.createDocument({
					spaceId: targetSpace.id,
					matterId,
					title: call.title,
					docType: call.docType,
					entryKind: wantsFolder ? "folder" : "file",
					content: initialContent,
					extraFiles,
					linkedOrgId,
					linkedWorkspaceId,
					linkedFilePath,
					actorId: member.id,
					actorName: member.displayName,
					commitMessage: call.changeNote || `Create ${call.title}`,
				});
				effects.savedDocuments.push({
					id: doc.id,
					spaceId: doc.spaceId,
					title: doc.title,
					docType: doc.docType,
					revision: doc.revision,
					headCommit: doc.headCommit,
					memberId: member.id,
					summary: (call.changeNote || call.summary || "").trim().slice(0, 240) || undefined,
				});
				onProgress?.({
					stage: "tool",
					label: `${member.displayName}保存了资料`,
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
			if (!previous || previous.spaceId !== targetSpace.id || !visibleInMatter(previous)) {
				throw new Error("Space page not found in this space");
			}
			let doc: Awaited<ReturnType<typeof deps.store.spaces.updateDocument>>;
			if (batchFiles.length > 0) {
				const allToWrite = [
					...(!call.subPath && draft ? [{ subPath: "README.md", content: draft.content }] : []),
					...batchFiles,
				];
				const written = await deps.store.spaces.writeDocumentFiles(previous.id, {
					files: allToWrite,
					actorId: member.id,
					actorName: member.displayName,
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
					actorId: member.id,
					actorName: member.displayName,
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
				memberId: member.id,
				summary: (call.changeNote || call.summary || "").trim().slice(0, 240) || undefined,
			};
			if (existingIdx < 0) effects.savedDocuments.push(savedEntry);
			else effects.savedDocuments[existingIdx] = savedEntry;
			onProgress?.({
				stage: "tool",
				label: `${member.displayName}更新了资料`,
				toolName: "save_space_page",
				collabUpdated: true,
			});
			return { page: doc };
		}

		const releaseIdle = getWorker()?.suspendIdleTimeout?.();
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
						matterId,
						fromMemberId: member.id,
						toMemberId: call.memberId,
						question: call.task,
					},
					run,
					workspace,
					chain,
					toolSignal,
					effects,
					onProgress,
					{
						discussionMode: isDiscussionMode,
						parentRequestMessageId: delegationRequestId,
						handoffDocumentIds: call.handoffDocumentIds,
						verification: call.verification,
					},
				);
				return {
					memberId: result.toMember.id,
					delegationNumber: result.delegationNumber,
					answer: result.answerText,
					...(result.clarification ? { status: "needs_clarification", clarification: result.clarification } : {}),
					...(result.verification ? { verification: result.verification } : {}),
				};
			}
			if (call.tool === "request_clarification") {
				return humanQuestion.request(call);
			}
			if (call.tool === "spawn_board_agent" || call.tool === "post_to_board" || call.tool === "read_board_post") {
				if (!boardCtx) {
					throw new Error(`Tool '${call.tool}' is only available in board collaboration mode`);
				}
				if (call.tool === "spawn_board_agent" && boardCtx.boardRole !== "coordinator") {
					throw new Error("Only the coordinator can invoke spawn_board_agent");
				}
				return await boardCtx.onToolCall(call, toolSignal);
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
				if (call.storageScope === "workspace" && !workspace) {
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
			if (call.tool === "record_skill_run" || call.tool === "promote_skill_trust") {
				const allowedScopeMatch =
					(call.scope === "global" && call.scopeId === "") ||
					(call.scope === "org" && Boolean(activeOrgId) && call.scopeId === activeOrgId) ||
					(call.scope === "personal" && Boolean(actorUserId) && call.scopeId === actorUserId) ||
					(call.scope === "workspace" && Boolean(workspace?.id) && call.scopeId === workspace?.id);
				if (!allowedScopeMatch) throw new Error("Skill trust scope does not match active worker context");
				if (call.tool === "record_skill_run") {
					const record = deps.store.skillTrust.recordExecution({
						scope: call.scope,
						scopeId: call.scopeId,
						skillName: call.skillName,
						outcome: call.outcome,
					});
					return { ok: true, runCount: record.runCount, trustLevel: record.trustLevel };
				}
				const updated = deps.store.skillTrust.upsertPolicy({
					scope: call.scope,
					scopeId: call.scopeId,
					skillName: call.skillName,
					trustLevel: call.trustLevel,
					updatedByUserId: actorUserId,
				});
				deps.store.skillTrust.recordExecution({
					scope: call.scope,
					scopeId: call.scopeId,
					skillName: call.skillName,
					outcome: `promoted_${call.trustLevel}`,
					defaultTrustLevel: call.trustLevel,
				});
				return { ok: true, policy: updated };
			}
		} finally {
			releaseIdle?.();
			resumeMonitor?.();
		}
	};
}
