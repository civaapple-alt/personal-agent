import { defineWebExtension } from "@pa/extension-api/web";

export default defineWebExtension({
	name: "team-extension",
	title: "团队协作与资料空间桥接",
	description: "在执行记录中呈现 PA 团队协作与 Git 资料空间工具。",
	toolDisplays: {
		read_pa_help: {
			label: "查询工作台说明",
			category: "team",
		},
		read_space: {
			label: "读取资料空间",
			category: "space",
		},
		save_space_page: {
			label: "保存资料空间页面",
			category: "space",
		},
		delegate_to_member: {
			label: "委托同事",
			category: "team",
		},
		propose_experience: {
			label: "提议沉淀经验",
			category: "team",
		},
	},
});
