import { defineWebExtension } from "@pa/extension-api/web";

export default defineWebExtension({
	name: "next-steps",
	title: "下一步快捷建议",
	description: "在执行记录中展示模型生成的下一步建议，并在输入框上方呈现一键快捷选项。",
	toolDisplays: {
		suggest_next_steps: {
			label: "建议下一步",
			category: "team",
			formatSummary: ({ args, summary }) => {
				if (args && Array.isArray(args.suggestions)) {
					return `给出 ${args.suggestions.length} 个下一步建议`;
				}
				return summary;
			},
		},
	},
});
