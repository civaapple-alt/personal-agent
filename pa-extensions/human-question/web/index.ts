import { defineWebExtension } from "@pa/extension-api/web";

export default defineWebExtension({
	name: "human-question",
	title: "人工澄清与决策提问",
	description: "在执行记录与决策卡中呈现人工澄清工具。",
	toolDisplays: {
		request_clarification: {
			label: "提请澄清",
			category: "decision",
		},
	},
});
