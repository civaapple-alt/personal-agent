import { defineWebExtension } from "@pa/extension-api/web";

export default defineWebExtension({
	name: "delegation",
	title: "团队跨岗委托与独立验收",
	description: "在执行记录中清晰呈现跨岗委托对象、任务摘要与独立验收标识。",
	toolDisplays: {
		delegate_to_member: {
			label: "委托同事",
			category: "team",
			formatSummary: ({ args, summary }) => {
				if (!args) return summary;
				const target = typeof args.memberId === "string" ? args.memberId.trim() : "";
				const task = typeof args.task === "string" ? args.task.replace(/\s+/g, " ").trim().slice(0, 48) : "";
				const isVerify = Boolean(args.verification && typeof args.verification === "object");
				if (target) {
					const prefix = isVerify ? `[独立验收] → ${target}` : `→ ${target}`;
					return task ? `${prefix}：${task}` : prefix;
				}
				return summary;
			},
		},
	},
});
