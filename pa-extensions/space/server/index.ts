import { defineServerExtension } from "@pa/extension-api/server";

export const SPACE_TOOLS = ["read_space", "save_space_page"] as const;

export default defineServerExtension({
	name: "space",
	title: "Git 资料空间读写",
	description: "向事项岗位暴露 read_space 与 save_space_page，按权限读写 Git 资料空间与版本化成果。",
	kind: "host-bridge",
	tools: SPACE_TOOLS,
	builtinPiEntry: "pa-extensions/space/pi/index.ts",
});
