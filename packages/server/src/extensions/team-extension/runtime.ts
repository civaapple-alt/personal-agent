import type { WorkerSessionMode } from "../../orchestrator/types.ts";
import type { createTeamToolBridge, TeamToolCall } from "../../rpc/team-tool-bridge.ts";
import { resolveBuiltinExtensionPath } from "../builtin-paths.ts";

export const TEAM_EXTENSION_TOOLS = [
	"read_space",
	"save_space_page",
	"delegate_to_member",
	"propose_skill",
	"read_team_roles",
	"propose_role",
] as const satisfies readonly TeamToolCall["tool"][];

export function prepareTeamExtension({
	sessionMode,
	discussionMode,
	isArchitect,
	isSolo = false,
	hasConsultTargets,
	isMatterLead = true,
}: {
	sessionMode: WorkerSessionMode;
	discussionMode: boolean;
	isArchitect: boolean;
	isSolo?: boolean;
	hasConsultTargets: boolean;
	isMatterLead?: boolean;
}) {
	const isLead = sessionMode === "lead";
	const isInternal = sessionMode === "internal";
	const canReadSpace = !isArchitect && (isLead || isInternal);
	const canSaveSpace = !isArchitect && isLead && isMatterLead && !discussionMode;
	const canDelegate = !isArchitect && !isSolo && (isInternal || (isLead && hasConsultTargets));
	const canCaptureSkill = !isArchitect && !discussionMode && (isLead || isInternal);
	const canManageRoles = isLead && !discussionMode;

	const entries: string[] = [resolveBuiltinExtensionPath("worker-runtime")];
	const tools: TeamToolCall["tool"][] = [];
	if (canManageRoles) {
		tools.push("read_team_roles", "propose_role");
	}
	if (canReadSpace) {
		entries.push(resolveBuiltinExtensionPath("space"));
		tools.push("read_space");
		if (canSaveSpace) tools.push("save_space_page");
	}
	if (canDelegate) {
		entries.push(resolveBuiltinExtensionPath("delegation"));
		tools.push("delegate_to_member");
	}
	if (canCaptureSkill) {
		entries.push(resolveBuiltinExtensionPath("skill-capture"));
		tools.push("propose_skill");
	}

	return {
		entries,
		tools,
		canReadSpace,
		canSaveSpace,
		canDelegate,
		canCaptureSkill,
		canManageRoles,
		buildEnvironment({
			bridgeEnv,
			requiredTools,
			workspaceRoot,
			paInstallRoot,
			deploymentMode,
			attachedContextFiles,
			memberContext,
			turnContext,
		}: {
			bridgeEnv: Awaited<ReturnType<typeof createTeamToolBridge>>["env"];
			requiredTools: string[];
			workspaceRoot?: string;
			paInstallRoot?: string;
			deploymentMode?: "local" | "multi_tenant";
			attachedContextFiles?: Array<{ path: string; content: string }>;
			memberContext: Array<string | undefined>;
			turnContext: Array<string | undefined>;
		}) {
			return {
				...bridgeEnv,
				PA_TARGET_WORKSPACE_ROOT: workspaceRoot ?? "__none__",
				...(paInstallRoot ? { PA_INSTALL_ROOT: paInstallRoot } : {}),
				...(deploymentMode ? { PA_DEPLOYMENT_MODE: deploymentMode } : {}),
				...(attachedContextFiles && attachedContextFiles.length > 0
					? { PA_ATTACHED_CONTEXT_FILES_JSON: JSON.stringify(attachedContextFiles) }
					: {}),
				PA_CAN_SAVE_SPACE: String(canSaveSpace),
				PA_CAN_MANAGE_ROLES: String(canManageRoles),
				PA_REQUIRED_TOOLS: JSON.stringify(requiredTools),
				PA_MEMBER_CONTEXT: memberContext.filter(Boolean).join("\n\n"),
				PA_TURN_CONTEXT: turnContext.filter(Boolean).join("\n\n"),
			};
		},
	};
}
