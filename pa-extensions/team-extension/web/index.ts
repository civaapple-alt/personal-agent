import { defineWebExtension, type PaToolRenderProps } from "@pa/extension-api/web";
import { createElement as h } from "react";

const SCOPE_LABELS: Record<string, string> = {
	workspace: "工作区 .agents/skills",
	personal: "个人 Skill",
	org: "组织共享",
	global: "全局共享",
};

function ProposeSkillToolCard({ args }: PaToolRenderProps) {
	const name = typeof args.name === "string" ? args.name : "";
	const scope = typeof args.storageScope === "string" ? (SCOPE_LABELS[args.storageScope] ?? args.storageScope) : "";
	const description = typeof args.description === "string" ? args.description : "";
	const scriptCount = typeof args.scriptCount === "number" ? args.scriptCount : 0;
	if (!name) return null;
	return h(
		"div",
		{ className: "pa-viz-file" },
		h("span", { className: "pa-viz-badge" }, "Skill 提案"),
		h("strong", { className: "pa-viz-title" }, name),
		scope ? h("span", { className: "pa-viz-option-desc" }, `· ${scope}`) : null,
		scriptCount > 0 ? h("span", { className: "pa-viz-option-desc" }, `· 含 ${scriptCount} 个脚本`) : null,
		description ? h("span", { className: "pa-viz-option-desc" }, `— ${description}`) : null,
	);
}

export default defineWebExtension({
	name: "team-extension",
	title: "团队协作与资料空间桥接",
	description: "在执行记录中呈现 PA 团队协作、技能提案与 Git 资料空间工具。",
	toolDisplays: {
		read_pa_help: {
			label: "查询工作台说明",
			category: "team",
		},
		read_space: {
			label: "读取资料空间",
			category: "space",
		},
		save_space_page: {
			label: "保存资料空间页面",
			category: "space",
		},
		delegate_to_member: {
			label: "委托同事",
			category: "team",
		},
		propose_experience: {
			label: "提议沉淀经验",
			category: "team",
		},
		propose_skill: {
			label: "提议沉淀 Skill",
			category: "skill",
			successLabel: "待确认",
			formatSummary: ({ args, summary }) => {
				if (!args || typeof args.name !== "string") return summary;
				const scope = typeof args.storageScope === "string" ? SCOPE_LABELS[args.storageScope] : undefined;
				const count =
					typeof args.scriptCount === "number" && args.scriptCount > 0 ? ` + ${args.scriptCount} 脚本` : "";
				return `${args.name}${scope ? ` (${scope})` : ""}${count}`;
			},
		},
	},
	toolRenderers: {
		propose_skill: {
			renderer: ProposeSkillToolCard,
			prominence: "primary",
		},
	},
});
