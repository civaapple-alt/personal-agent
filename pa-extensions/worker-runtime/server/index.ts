import { defineServerExtension } from "@pa/extension-api/server";

export default defineServerExtension({
	name: "worker-runtime",
	title: "岗位运行时护栏与能力握手",
	description:
		"PA 宿主专用运行时护栏：隔离目标工作区 AGENTS.md、注入成员与轮次上下文、核查工具握手并标注外部检索证据。",
	kind: "host-bridge",
	tools: [],
	builtinPiEntry: "pa-extensions/worker-runtime/pi/index.ts",
});
