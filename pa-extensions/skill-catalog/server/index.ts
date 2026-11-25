import { defineServerExtension } from "@pa/extension-api/server";

export const SKILL_CATALOG_TOOLS = ["list_available_skills", "load_available_skill"] as const;

export default defineServerExtension({
	name: "skill-catalog",
	title: "Pi Skill 目录与内置岗位方法包",
	description: "组合便携 Pi 扩展 skill-catalog 与标准 Pi Package role-skills，按自然语言按需选读方法。",
	kind: "builtin-pi",
	tools: SKILL_CATALOG_TOOLS,
	builtinPiEntry: "pi-extensions/skill-catalog/index.ts",
	builtinSkillPackage: "pi-extensions/role-skills",
});
