import { defineWebExtension } from "@pa/extension-api/web";

export default defineWebExtension({
	name: "web-access",
	title: "联网检索（pi-web-access）",
	description: "在执行记录中呈现原生 pi-web-access 检索与抓取工具。",
	toolDisplays: {
		web_search: {
			label: "联网搜索",
			category: "web",
		},
		get_search_content: {
			label: "读取搜索结果",
			category: "web",
		},
		fetch_content: {
			label: "抓取网页内容",
			category: "web",
		},
	},
});
