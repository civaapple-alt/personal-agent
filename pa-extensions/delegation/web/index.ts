import { defineWebExtension } from "@pa/extension-api/web";

export default defineWebExtension({
	name: "delegation",
	title: "团队跨岗委托",
	description: "在执行记录中呈现跨岗委托调用。",
	toolDisplays: {
		delegate_to_member: {
			label: "委托同事",
			category: "team",
		},
	},
});
