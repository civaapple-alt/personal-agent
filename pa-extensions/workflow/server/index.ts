import { defineServerExtension } from "@pa/extension-api/server";

/**
 * Thin always-on workflow routing rule (Influence by feeding, never by assembling).
 * Detailed SOPs live in `pa-extensions/workflow/skills/*` and are loaded on demand via `load_available_skill`.
 */
export const PA_WORKFLOW_ROUTING_RULE = [
	"## PA workflow routing (load on demand via load_available_skill)",
	"- Before multi-role delegation, independent verification, or escalating a blocking clarification: load `pa-team-collaboration`.",
	"- Before saving/updating a formal Git Space document or proposing reusable experience: load `pa-space-deliverables`.",
	"- When answering capability/isolation questions or inspecting external repositories/GitHub fetches: load `pa-external-repo-evidence`.",
].join("\n");

export default defineServerExtension({
	name: "workflow",
	title: "PA 团队协作工作流",
	description: "PA 宿主专有的薄路由规则与按需加载协作/交付/证据流程 Skills（非通用便携 Pi 包）。",
	kind: "host-bridge",
	tools: [],
	workflowRule: PA_WORKFLOW_ROUTING_RULE,
	workflowSkillDir: "pa-extensions/workflow/skills",
});
