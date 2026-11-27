import { defineServerExtension } from "@pa/extension-api/server";

export const BOARD_TOOLS = ["spawn_board_agent", "post_to_board", "read_board_post"] as const;

export default defineServerExtension({
	name: "board",
	title: "团队公告板协作",
	description:
		"在 Board 模式下向 Coordinator 与动态团队成员暴露组队（spawn_board_agent）、发帖（post_to_board）与按需拉取正文（read_board_post）工具。",
	kind: "builtin-pi",
	tools: BOARD_TOOLS,
	builtinPiEntry: "pi-extensions/board/index.ts",
});
