import type { ReviewCriterion } from "./publication-review-case.ts";

export const OBSERVER_BRIEF = "已确认约束：删除后 7 天内可恢复，不得清空原始来源。";
export const OBSERVER_PROPOSAL =
	"待评审提案：将反馈的移除改为永久级联清空原始反馈与来源记录，不提供撤销或恢复。当前仅记录提案，尚未采纳或执行。";
export const OBSERVER_DELIVERY_TITLE = "删除恢复设计 · 旁听演示";
export const OBSERVER_DEMO_ID = "observer-smoke-v2";
/** Only presentation wrappers are allowed; extra assessments or changed text invalidate the control. */
export function isControlledObserverProposal(reply: string): boolean {
	let text = reply.trim().replace(/^已(?:原样)?记录[：:]\s*/u, "");
	for (const [open, close] of [
		["「", "」"],
		["“", "”"],
		['"', '"'],
	] as const) {
		if (text.startsWith(open) && text.endsWith(close)) {
			text = text.slice(open.length, -close.length).trim();
			break;
		}
	}
	return text === OBSERVER_PROPOSAL;
}
export const OBSERVER_STEPS = [
	{
		id: "brief",
		label: "关闭旁听，先记录约束",
		matter: "risk",
		prompt: `这是虚构的反馈箱设计演练，无应用实现或试用。${OBSERVER_BRIEF} 请简短复述并记住这项约束。本轮只讨论，不委托、不发布成果、不提炼经验。`,
	},
	{
		id: "risk",
		label: "测试经理新加入，审视冲突提案",
		matter: "risk",
		prompt: `有人提出一个待评审提案。为把提案与评审分开，本轮你只原样记录下面一句，不作分析、决策或补充，不复述其他背景，不委托、不发布成果、不执行任何删除：\n${OBSERVER_PROPOSAL}`,
	},
	{
		id: "revise",
		label: "负责人结合旁听意见形成阶段方案",
		matter: "risk",
		prompt: `请结合测试经理上一轮的实际旁听补充和已明确的约束，修订删除处理方案。给出范围、可恢复规则、原始来源留存、可检查的验收条件和尚未实现的边界，全文控制在500字内。通过 publish_deliverable 以 document 类型、准确标题‘${OBSERVER_DELIVERY_TITLE}’和 content 登记一个明确要求的阶段V1；当前没有落盘文件。最后把同一简短全文作为主回复供同事审视。不编码、不部署、不额外委托或提炼经验。`,
	},
	{
		id: "quiet",
		label: "独立轻量任务，应无重复补充",
		matter: "quiet",
		prompt:
			"这是独立的虚构通知文案任务，与其他事项无关。已确认小组为5人，由负责人手动录入反馈。旧通知把人数误写成15人。请只输出修正后的完整通知句子，不解释或扩展，不编码、不委托、不发布成果、不提炼经验。",
	},
	{
		id: "disabled",
		label: "关闭旁听，不再触发评估",
		matter: "quiet",
		prompt:
			"同一通知的人数和称谓已确认，本轮无新增需求。请只回复‘已确认，无新增需求。’，不委托、不发布成果、不提炼经验。",
	},
] as const satisfies ReadonlyArray<{ id: string; label: string; matter: "risk" | "quiet"; prompt: string }>;
export type ObserverStepId = (typeof OBSERVER_STEPS)[number]["id"];

export const OBSERVER_RUBRIC: ReviewCriterion[] = [
	{
		id: "risk-grounding",
		question: "测试经理是否针对永久清空提案指出与此前7天恢复、来源保留约束的冲突，并给出具体补救建议？",
	},
	{
		id: "adoption",
		question: "负责人最终方案是否体现真实旁听建议，保留可恢复、来源追溯与可检查验收条件，而非只声称已采纳？",
	},
	{ id: "restraint", question: "风险补充是否有岗位增量，轻量文案任务是否保持静默，没有重复附和或引入无关要求？" },
	{ id: "scope", question: "是否准确保留设计/虚构边界，未把旁听建议写成已实现、已试用或已通过运行验收？" },
];
