import { resolve } from "node:path";
import type { BoardRole } from "@pa/contracts/board";
import type { ModelSelection } from "@pa/contracts/model-selection";
import { skillTrustPolicyKey } from "@pa/contracts/skill-trust";
import type { RoleTemplate } from "../../roles/types.ts";
import { abortable, type TeamToolCall } from "../../rpc/team-tool-bridge.ts";
import type { MatterEventRecord } from "../../storage/repos/board-repo.ts";
import type { PersonalAgentStore } from "../../storage/repositories.ts";
import type { Matter, WorkspaceLink } from "../../storage/types.ts";
import { readHumanDecision } from "../human-decision.ts";
import { type ReadPiModels, resolveConfiguredModel } from "../runtime/model-selection.ts";
import type { WorkerSessionMode } from "../types.ts";

export type BoardWorkerToolCall = Extract<
	TeamToolCall,
	{ tool: "spawn_board_agent" | "post_to_board" | "read_board_post" }
>;

export interface BoardWorkerContext {
	agentId: string;
	boardRole: BoardRole;
	displayName: string;
	brief: string;
	skills?: string[];
	ownedScope?: string[];
	acceptanceCriteria?: string;
	modelOverride?: ModelSelection | null;
	turnPromptContext?: string;
	onToolCall: (call: BoardWorkerToolCall, signal: AbortSignal) => Promise<unknown>;
	onEventAppended?: (event: MatterEventRecord) => void;
}

export interface ManagedSkillRootEntry {
	root: string;
	scope: "global" | "org" | "personal" | "workspace";
	scopeId: string;
}

/** Collect all scoped managed skill roots visible to this worker turn. */
export function buildManagedSkillRoots(input: {
	skillsDir?: string;
	activeOrgId: string | null;
	actorUserId: string | null;
	workspace: WorkspaceLink | null;
	workspaceFolders: Array<{ path: string; loadSkills: boolean }>;
}): ManagedSkillRootEntry[] {
	const managedSkillRoots: ManagedSkillRootEntry[] = [];
	if (input.skillsDir) {
		managedSkillRoots.push({ root: resolve(input.skillsDir, "global"), scope: "global", scopeId: "" });
		if (input.activeOrgId) {
			managedSkillRoots.push({
				root: resolve(input.skillsDir, "orgs", input.activeOrgId),
				scope: "org",
				scopeId: input.activeOrgId,
			});
		}
		if (input.actorUserId) {
			managedSkillRoots.push({
				root: resolve(input.skillsDir, "users", input.actorUserId),
				scope: "personal",
				scopeId: input.actorUserId,
			});
		}
		if (input.workspace?.id) {
			managedSkillRoots.push({
				root: resolve(input.skillsDir, "workspaces", input.workspace.id),
				scope: "workspace",
				scopeId: input.workspace.id,
			});
		}
	}
	if (input.workspace) {
		const folderDirs =
			input.workspaceFolders.length > 0
				? input.workspaceFolders.filter((f) => f.loadSkills).map((f) => f.path)
				: [input.workspace.repoPath];
		const seenWsRoots = new Set(managedSkillRoots.map((entry) => entry.root));
		for (const dir of folderDirs) {
			for (const rel of [".agents/skills", ".pi/skills"]) {
				const candidate = resolve(dir, rel);
				if (!seenWsRoots.has(candidate)) {
					seenWsRoots.add(candidate);
					managedSkillRoots.push({
						root: candidate,
						scope: "workspace",
						scopeId: input.workspace.id,
					});
				}
			}
		}
	}
	return managedSkillRoots;
}

/** Build serialized skill trust policy map for Pi's tool_call script gate. */
export function buildTrustPolicyMap(store: PersonalAgentStore): Record<string, string> {
	const trustPolicyMap: Record<string, string> = {};
	for (const policy of store.skillTrust.listPolicies()) {
		trustPolicyMap[skillTrustPolicyKey(policy.scope, policy.scopeId, policy.skillName)] = policy.trustLevel;
	}
	return trustPolicyMap;
}

/** Build concise pending human-decision summary for worker turn context. */
export function buildPendingDecisionsPrompt(store: PersonalAgentStore, matterId: string): string | undefined {
	const pendingDecisions = store
		.listMessages(matterId, "user")
		.map((message) => ({ message, decision: readHumanDecision(message.metadata) }))
		.filter((entry) => entry.decision?.status === "pending");
	if (pendingDecisions.length === 0) return undefined;
	return [
		"## Pending human decisions in this matter",
		...pendingDecisions.flatMap(({ message, decision }) =>
			decision!.requests.map(
				(req) =>
					`- [${message.id}] ${req.question}${req.options?.length ? ` (options: ${req.options.join(" / ")})` : ""}`,
			),
		),
	].join("\n");
}

/** Format Board role assignment, scope boundaries, and unread board context for the worker. */
export function buildBoardAssignmentPrompt(boardCtx: BoardWorkerContext): string {
	return [
		"[Board Agent Assignment]",
		`Agent ID: ${boardCtx.agentId} (${boardCtx.displayName})`,
		`Board Role: ${boardCtx.boardRole}`,
		`Mission Brief: ${boardCtx.brief}`,
		...(boardCtx.ownedScope && boardCtx.ownedScope.length > 0
			? [`Owned Scope: ${boardCtx.ownedScope.join(", ")}`]
			: []),
		...(boardCtx.acceptanceCriteria ? [`Acceptance Criteria: ${boardCtx.acceptanceCriteria}`] : []),
		...(boardCtx.skills && boardCtx.skills.length > 0 ? [`Assigned Skills: ${boardCtx.skills.join(", ")}`] : []),
		...(boardCtx.boardRole === "verifier"
			? [
					"Verifier Boundary: read/test-only (no write/edit tools). Verify independently from author and post verify_pass or verify_rework via post_to_board.",
				]
			: boardCtx.boardRole === "coordinator"
				? [
						"Coordinator Boundary: decompose tasks, spawn dynamic agents with spawn_board_agent, post @mentions, and escalate/summarize. Do not edit files directly.",
					]
				: [
						"Builder Boundary: implement only within your ownedScope, verify locally with tests/commands, and report handoff via post_to_board.",
					]),
		...(boardCtx.turnPromptContext ? ["", boardCtx.turnPromptContext] : []),
		"[/Board Agent Assignment]",
	].join("\n");
}

/** Resolve effective model & thinking level for this worker execution. */
export async function resolveWorkerModelSelection(input: {
	store: PersonalAgentStore;
	readPiModels: ReadPiModels;
	activeOrgId: string | null;
	memberId: string;
	matter: Matter | null;
	sessionMode: WorkerSessionMode;
	isArchitect: boolean;
	isDiscussionMode: boolean;
	keepMatterLead?: boolean;
	template?: RoleTemplate;
	boardModelOverride?: ModelSelection | null;
	signal: AbortSignal;
}): Promise<ModelSelection | null> {
	const matterModel =
		input.sessionMode === "lead" &&
		(!(input.isArchitect || input.isDiscussionMode || input.keepMatterLead) ||
			input.memberId === input.matter?.leadMemberId)
			? input.matter?.modelSelection
			: null;
	const configuredModel =
		input.boardModelOverride ?? resolveConfiguredModel(input.store, input.activeOrgId, input.memberId, matterModel);
	let selection = configuredModel;
	if (!configuredModel || configuredModel.thinkingLevel === undefined) {
		const piDefault = (await abortable(input.readPiModels(configuredModel ?? undefined), input.signal)).defaultModel;
		if (
			!configuredModel ||
			(piDefault?.provider === configuredModel.provider && piDefault.model === configuredModel.model)
		) {
			selection = piDefault;
		}
		if (selection && input.template?.thinking) {
			selection = { ...selection, thinkingLevel: input.template.thinking };
		}
	}
	return selection ?? null;
}
