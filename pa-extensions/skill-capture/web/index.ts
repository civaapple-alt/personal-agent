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
	name: "skill-capture",
	title: "技能与脚本沉淀提案",
	description: "在执行记录中呈现 Skill 与脚本沉淀提案预览。",
	toolDisplays: {
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
