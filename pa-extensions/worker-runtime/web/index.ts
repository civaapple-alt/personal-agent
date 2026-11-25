import { defineWebExtension } from "@pa/extension-api/web";

export default defineWebExtension({
	name: "worker-runtime",
	title: "岗位运行时护栏与角色读写工具",
	description: "PA 宿主运行时护栏、能力握手与团队角色读取/提案工具。",
	toolDisplays: {
		read_team_roles: {
			label: "读取当前团队角色",
			category: "team",
			formatSummary: ({ args }) =>
				args?.includeHealthEvidence ? "读取可见团队角色与协作体检证据" : "读取当前可见团队角色名录",
		},
		propose_role: {
			label: "提议创建或调整 AI 角色",
			category: "team",
			formatSummary: ({ args }) => {
				if (args?.action === "update") {
					const target =
						typeof args.memberId === "string" && args.memberId.trim() ? args.memberId.trim() : "现有角色";
					return `提议调整角色 ${target}`;
				}
				const name = typeof args?.name === "string" && args.name.trim() ? args.name.trim() : "新角色";
				return `提议创建角色 ${name}`;
			},
		},
	},
});
