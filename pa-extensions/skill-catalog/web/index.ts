import { defineWebExtension } from "@pa/extension-api/web";

export default defineWebExtension({
	name: "skill-catalog",
	title: "Pi Skill 目录与内置岗位方法包",
	description: "在执行记录中呈现 Skill 检索、按需读取与 Pi 命令提交工具。",
	toolDisplays: {
		list_available_skills: {
			label: "查看可用方法",
			category: "skill",
		},
		load_available_skill: {
			label: "读取方法正文",
			category: "skill",
		},
		request_pi_command: {
			label: "提交 Pi 命令",
			category: "skill",
			successLabel: "已提交",
		},
	},
});
