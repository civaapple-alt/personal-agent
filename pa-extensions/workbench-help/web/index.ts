import { defineWebExtension } from "@pa/extension-api/web";

export default defineWebExtension({
	name: "workbench-help",
	title: "工作台说明与实时事实速查",
	description: "在执行记录中呈现工作台说明查询。",
	toolDisplays: {
		read_pa_help: {
			label: "查询工作台说明",
			category: "team",
		},
	},
});
