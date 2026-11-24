import { defineWebExtension } from "@pa/extension-api/web";

export default defineWebExtension({
	name: "space",
	title: "Git 资料空间读写",
	description: "在执行记录中呈现资料空间读写操作。",
	toolDisplays: {
		read_space: {
			label: "读取资料空间",
			category: "space",
		},
		save_space_page: {
			label: "保存资料空间页面",
			category: "space",
		},
	},
});
