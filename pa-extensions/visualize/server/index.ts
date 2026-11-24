import { defineServerExtension } from "@pa/extension-api/server";

export const VISUALIZE_TOOLS = ["visualize"] as const;

export default defineServerExtension({
	name: "visualize",
	title: "可视化图表与方案对比",
	description:
		"组合便携 Pi 扩展 visualize（改编自 @thinkrail/pi-visualize），在对话与执行记录中渲染 Mermaid 图表、方案对比卡与文件预览。",
	kind: "builtin-pi",
	tools: VISUALIZE_TOOLS,
	builtinPiEntry: "pi-extensions/visualize/index.ts",
});
