import { defineWebExtension } from "@pa/extension-api/web";
import { VisualizationCard } from "./VisualizationCard.ts";

export { VisualizationCard };

export default defineWebExtension({
	name: "visualize",
	title: "可视化图表与方案对比",
	description: "在执行记录中渲染 Mermaid 图表、并排方案对比卡片与文件预览。",
	toolDisplays: {
		visualize: {
			label: "可视化卡片",
			category: "visual",
			formatSummary: ({ args, summary }) => {
				if (!args) return summary;
				if (typeof args.title === "string" && args.title.trim()) return args.title.trim();
				if (args.type === "comparison" && Array.isArray(args.options)) {
					return `方案对比（${args.options.length} 项）`;
				}
				if (args.type === "file" && typeof args.path === "string") {
					return typeof args.before === "string" ? `${args.before} → ${args.path}` : args.path;
				}
				if (args.type === "diagram") return "Mermaid 图表";
				return summary;
			},
		},
	},
	toolRenderers: {
		visualize: {
			renderer: VisualizationCard,
			prominence: "primary",
		},
	},
});
