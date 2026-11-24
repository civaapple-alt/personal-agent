import { defineServerExtension } from "@pa/extension-api/server";

export const NEXT_STEPS_TOOLS = ["suggest_next_steps"] as const;

export default defineServerExtension({
	name: "next-steps",
	title: "下一步快捷建议",
	description:
		"组合便携 Pi 扩展 next-steps（改编自 @thinkrail/pi-next-steps），让主责在回复结束时给出 2-4 个一键可点下一步建议。",
	kind: "builtin-pi",
	tools: NEXT_STEPS_TOOLS,
	builtinPiEntry: "pi-extensions/next-steps/index.ts",
});
