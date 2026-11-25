import { defineWebExtension } from "@pa/extension-api/web";

export default defineWebExtension({
	name: "skill-catalog",
	title: "Pi Skill 目录与内置岗位方法包",
	description: "在执行记录中呈现 Skill 按需检索与正文读取工具。",
	toolDisplays: {
		list_available_skills: {
			label: "查看可用方法",
			category: "skill",
		},
		load_available_skill: {
			label: "读取方法正文",
			category: "skill",
		},
	},
});
