import { defineServerExtension } from "@pa/extension-api/server";

/**
 * Thin always-on workflow routing rule (Influence by feeding, never by assembling).
 * Detailed SOPs live in `pa-extensions/workflow/skills/*` and are loaded on demand via `load_available_skill`.
 */
export const PA_WORKFLOW_ROUTING_RULE = [
	"## PA workflow routing (load on demand via load_available_skill)",
	"- Before multi-role delegation, independent verification, or escalating a blocking clarification: load `pa-team-collaboration`.",
	"- Before saving or updating a formal Git Space document: load `pa-space-deliverables`.",
	"- Before proposing a reusable Skill or helper script (`propose_skill`): load `pa-trust-capture`.",
	"- When inspecting PA itself, diagnosing recurring tool failures/unused skills, or troubleshooting MCP/extensions: load `pa-self-inspection`.",
	"- When answering capability/isolation questions or inspecting external repositories/GitHub fetches: load `pa-external-repo-evidence`.",
].join("\n");

export default defineServerExtension({
	name: "workflow",
	title: "PA 团队协作工作流",
	description: "PA 宿主专有的薄路由 Hook 与按需加载协作/交付/技能沉淀/证据流程 Skills（非通用便携 Pi 包）。",
	kind: "host-bridge",
	tools: [],
	builtinPiEntry: "pa-extensions/workflow/pi/index.ts",
	workflowRule: PA_WORKFLOW_ROUTING_RULE,
	workflowSkillDir: "pa-extensions/workflow/skills",
});
