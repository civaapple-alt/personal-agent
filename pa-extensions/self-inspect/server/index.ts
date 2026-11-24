import { defineServerExtension } from "@pa/extension-api/server";

export default defineServerExtension({
	name: "self-inspect",
	title: "PA 宿主自检与会话洞察技能",
	description: "PA 宿主专有的渐进式自检 Skill 与离线只读会话洞察脚本（session-insights.mjs），替代单一静态帮助文档。",
	kind: "host-bridge",
	tools: [],
	workflowSkillDir: "pa-extensions/self-inspect/skills",
});
