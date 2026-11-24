export const PA_WORKFLOW_ROUTING_RULE = [
	"## PA workflow routing (load on demand via load_available_skill)",
	"- Before multi-role delegation, independent verification, or escalating a blocking clarification: load `pa-team-collaboration`.",
	"- Before saving or updating a formal Git Space document: load `pa-space-deliverables`.",
	"- Before proposing a reusable Skill or helper script (`propose_skill`): load `pa-trust-capture`.",
	"- When inspecting PA itself, diagnosing recurring tool failures/unused skills, or troubleshooting MCP/extensions: load `pa-self-inspection`.",
	"- When answering capability/isolation questions or inspecting external repositories/GitHub fetches: load `pa-external-repo-evidence`.",
].join("\n");

interface WorkflowBeforeStartEvent {
	systemPrompt: string;
	systemPromptOptions?: {
		appendSystemPrompt?: string;
		forceSystemPrompt?: string;
	};
}

export interface WorkflowPiExtensionApi {
	on(
		event: "before_agent_start",
		handler: (event: WorkflowBeforeStartEvent) => { systemPrompt?: string } | undefined,
	): void;
}

/**
 * Pi-native workflow routing hook (inspired by pi-thinkrail-workflow).
 * Injects the thin always-on routing rule at `before_agent_start` without duplicating it
 * if the host prompt already included the same section.
 */
export default function workflowPiExtension(pi: WorkflowPiExtensionApi): void {
	pi.on("before_agent_start", (event) => {
		const options = event.systemPromptOptions;
		const existing = options?.appendSystemPrompt ?? event.systemPrompt ?? "";
		if (existing.includes("## PA workflow routing")) return undefined;
		if (options && options.forceSystemPrompt === undefined) {
			options.appendSystemPrompt = [options.appendSystemPrompt, PA_WORKFLOW_ROUTING_RULE]
				.filter(Boolean)
				.join("\n\n");
			return undefined;
		}
		return {
			systemPrompt: `${event.systemPrompt}\n\n${PA_WORKFLOW_ROUTING_RULE}`,
		};
	});
}
