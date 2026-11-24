import { defineServerExtension } from "@pa/extension-api/server";

export const TEAM_BRIDGE_TOOLS = [
	"read_pa_help",
	"read_space",
	"save_space_page",
	"delegate_to_member",
	"propose_experience",
] as const;

export default defineServerExtension({
	name: "team-extension",
	title: "团队协作与资料空间桥接",
	description: "PA 宿主专用桥接扩展，经 RPC 轮次令牌向岗位暴露跨岗委托、资料空间读写、经验提案与工作台速查。",
	kind: "host-bridge",
	tools: TEAM_BRIDGE_TOOLS,
	builtinPiEntry: "pi-extensions/team-extension/index.ts",
});
