import { defineServerExtension } from "@pa/extension-api/server";

export const DELEGATION_TOOLS = ["delegate_to_member"] as const;

export default defineServerExtension({
	name: "delegation",
	title: "团队跨岗委托",
	description: "向具备权限的岗位暴露 delegate_to_member，经宿主编排器拉起受托同事的独立 Pi RPC 子进程。",
	kind: "host-bridge",
	tools: DELEGATION_TOOLS,
	builtinPiEntry: "pa-extensions/delegation/pi/index.ts",
});
