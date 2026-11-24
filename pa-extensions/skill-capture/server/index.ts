import { defineServerExtension } from "@pa/extension-api/server";

export const SKILL_CAPTURE_TOOLS = ["propose_skill"] as const;

export default defineServerExtension({
	name: "skill-capture",
	title: "技能与脚本沉淀提案",
	description:
		"对应信任四步第二步（存成技能/写成脚本）：经人工确认后将 SKILL.md 与可选可执行脚本原子落盘到磁盘 Skill 目录。",
	kind: "host-bridge",
	tools: SKILL_CAPTURE_TOOLS,
	builtinPiEntry: "pa-extensions/skill-capture/pi/index.ts",
	interactiveTools: ["propose_skill"],
});
