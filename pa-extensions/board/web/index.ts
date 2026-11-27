import { defineWebExtension } from "@pa/extension-api/web";

export default defineWebExtension({
	name: "board",
	title: "团队公告板协作",
	description: "在执行时间线中呈现动态组队、@mention 发帖与公告板正文拉取摘要。",
	toolDisplays: {
		spawn_board_agent: {
			label: "动态组队",
			category: "team",
			formatSummary: ({ args, summary }) => {
				if (!args) return summary;
				const agentId = typeof args.agentId === "string" ? args.agentId.trim() : "";
				const boardRole = typeof args.boardRole === "string" ? args.boardRole.trim() : "";
				if (agentId) {
					return boardRole ? `[${boardRole}] ${agentId}` : agentId;
				}
				return summary;
			},
		},
		post_to_board: {
			label: "公告板发帖",
			category: "team",
			formatSummary: ({ args, summary }) => {
				if (!args) return summary;
				const kind = typeof args.kind === "string" ? args.kind.trim() : "";
				const postSummary = typeof args.summary === "string" ? args.summary.trim().slice(0, 60) : "";
				if (kind && postSummary) return `[${kind}] ${postSummary}`;
				return postSummary || summary;
			},
		},
		read_board_post: {
			label: "读取帖子正文",
			category: "team",
			formatSummary: ({ args, summary }) => {
				if (args && typeof args.postNo === "number") {
					return `#${args.postNo}`;
				}
				return summary;
			},
		},
	},
});
