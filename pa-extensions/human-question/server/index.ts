import { defineServerExtension } from "@pa/extension-api/server";

export const HUMAN_QUESTION_TOOLS = ["request_clarification"] as const;

export default defineServerExtension({
	name: "human-question",
	title: "人工澄清与决策提问",
	description: "为正式执行的岗位装配 request_clarification，将关键澄清转交直接委托者或人类拍板。",
	kind: "builtin-pi",
	tools: HUMAN_QUESTION_TOOLS,
	builtinPiEntry: "pi-extensions/human-question/index.ts",
	interactiveTools: HUMAN_QUESTION_TOOLS,
});
