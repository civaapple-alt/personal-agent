import { defineWebExtension } from "@pa/extension-api/web";

export default defineWebExtension({
	name: "self-inspect",
	title: "PA 宿主自检与会话洞察技能",
	description: "宿主自检与运行洞察面板（设置 → 运行洞察）。",
	toolDisplays: {},
});
