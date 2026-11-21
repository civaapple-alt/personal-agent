import type { WorkerSessionMode } from "../../orchestrator/types.ts";
import type { createTeamToolBridge, TeamToolCall } from "../../rpc/team-tool-bridge.ts";
import { resolveBuiltinExtensionPath } from "../builtin-paths.ts";

export const TEAM_EXTENSION_TOOLS = [
	"delegate_to_member",
	"publish_deliverable",
	"propose_experience",
] as const satisfies readonly TeamToolCall["tool"][];

export function prepareTeamExtension({
	sessionMode,
	discussionMode,
	isArchitect,
	hasConsultTargets,
}: {
	sessionMode: WorkerSessionMode;
	discussionMode: boolean;
	isArchitect: boolean;
	hasConsultTargets: boolean;
}) {
	const isLead = sessionMode === "lead";
	const isInternal = sessionMode === "internal";
	const canPublish = !isArchitect && isLead && !discussionMode;
	const canDelegate = !isArchitect && (isInternal || (isLead && hasConsultTargets));
	const canProposeExperience = canPublish || (!isArchitect && isInternal && !discussionMode);
	const tools: TeamToolCall["tool"][] = [];
	if (canDelegate) tools.push("delegate_to_member");
	if (canPublish) tools.push("publish_deliverable");
	if (canProposeExperience) tools.push("propose_experience");

	return {
		entry: resolveBuiltinExtensionPath("team-extension"),
		tools,
		canPublish,
		canDelegate,
		canProposeExperience,
		buildEnvironment({
			bridgeEnv,
			requiredTools,
			workspaceRoot,
			memberContext,
			turnContext,
		}: {
			bridgeEnv: Awaited<ReturnType<typeof createTeamToolBridge>>["env"];
			requiredTools: string[];
			workspaceRoot?: string;
			memberContext: Array<string | undefined>;
			turnContext: Array<string | undefined>;
		}) {
			return {
				...bridgeEnv,
				PA_TARGET_WORKSPACE_ROOT: workspaceRoot ?? "__none__",
				PA_CAN_PUBLISH: String(canPublish),
				PA_CAN_DELEGATE: String(canDelegate),
				PA_CAN_EXPERIENCE: String(canProposeExperience),
				PA_REQUIRED_TOOLS: JSON.stringify(requiredTools),
				PA_MEMBER_CONTEXT: memberContext.filter(Boolean).join("\n\n"),
				PA_TURN_CONTEXT: turnContext.filter(Boolean).join("\n\n"),
			};
		},
	};
}
