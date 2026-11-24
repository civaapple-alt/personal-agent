import { defineServerExtension } from "@pa/extension-api/server";

export const WORKBENCH_HELP_TOOLS = ["read_pa_help"] as const;

export default defineServerExtension({
	name: "workbench-help",
	title: "工作台说明与实时事实速查",
	description: "向岗位暴露只读的 read_pa_help 工具，按主题读取安装版指南与当前事项运行事实。",
	kind: "host-bridge",
	tools: WORKBENCH_HELP_TOOLS,
	builtinPiEntry: "pa-extensions/workbench-help/pi/index.ts",
});
