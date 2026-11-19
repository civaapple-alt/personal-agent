import type { CollaborationPresetMode, TeamMemberDto, WorkspaceDto } from "../api.ts";

export interface StarterTask {
	id: string;
	roleLabel: string;
	memberId?: string;
	title: string;
	desc: string;
	prompt: string;
	suggestedMode?: "discussion" | "dispatch";
	collaborationPreset?: CollaborationPresetMode;
}

/** Legacy starter task templates retained as pure helpers and covered by unit tests. */
export function buildStarterTasks(
	members: TeamMemberDto[] | undefined,
	selectedWorkspace: WorkspaceDto | null,
): StarterTask[] {
	const wsName = selectedWorkspace?.name;
	const engMember = members?.find((m) => m.templateId === "engineering-manager");
	const pmMember = members?.find((m) => m.templateId === "product-manager");
	const qaMember = members?.find((m) => m.templateId === "qa-manager");
	const mktMember = members?.find((m) => m.templateId === "marketing-lead");
	const firstCustom = members?.find(
		(m) =>
			m.templateId !== "engineering-manager" &&
			m.templateId !== "product-manager" &&
			m.templateId !== "qa-manager" &&
			m.templateId !== "marketing-lead",
	);

	if (!wsName) {
		return [
			{
				id: "starter-human-align",
				roleLabel: "团队先对齐",
				memberId: pmMember?.id,
				title: "先由人讨论目标、约束与人员分工",
				desc: "以人类团队讨论起手，对齐决策后再明确由哪位 AI 承接",
				prompt: "我们先就这件事的目标、不可妥协约束、参与人选和最终交付物做一轮讨论对齐：",
				suggestedMode: "discussion",
				collaborationPreset: "human_first",
			},
			{
				id: "starter-mkt-solo",
				roleLabel: mktMember?.displayName ?? "市场研究",
				memberId: mktMember?.id ?? firstCustom?.id,
				title: "目标用户痛点、竞品差异与价值表达",
				desc: "单兵专注梳理用户定位与传播核心论点，不拉研发旁听",
				prompt:
					"请站在真实用户与市场竞争视角，帮我梳理当前核心目标用户群体、主要竞品差异点与最清晰的产品价值表达。",
				suggestedMode: "dispatch",
				collaborationPreset: "solo",
			},
			{
				id: "starter-pm-review",
				roleLabel: `${pmMember?.displayName ?? "产品经理"} + 旁听把关`,
				memberId: pmMember?.id,
				title: "明确方案边界、优先级与验收风险",
				desc: "主责输出范围与计划，并让指定关键角色做定向旁听把关",
				prompt:
					"我想推进一项新的业务/产品计划，请帮我澄清核心问题、明确本期不做清单（Non-Goals）、排定优先级并定义可验证验收条件。",
				suggestedMode: "dispatch",
				collaborationPreset: "lead_review",
			},
		];
	}

	return [
		{
			id: "starter-eng",
			roleLabel: engMember?.displayName ?? "研发经理",
			memberId: engMember?.id,
			title: `梳理「${wsName}」代码结构与关键入口`,
			desc: "只读分析技术栈、核心目录、模块职责与启动方式（单兵直办）",
			prompt: `请只读梳理「${wsName}」仓库的目录结构、核心模块、技术栈与本地启动方式，输出一份简明工程概览文档。`,
			suggestedMode: "dispatch",
			collaborationPreset: "solo",
		},
		{
			id: "starter-pm",
			roleLabel: pmMember?.displayName ?? "产品经理",
			memberId: pmMember?.id,
			title: `分析「${wsName}」现有功能与优化点`,
			desc: "主责汇总并按需咨询研发与市场，输出最值得优先改进的 3 件事",
			prompt: `请先阅读「${wsName}」仓库文档与主要源码，梳理当前已实现的功能清单，并给出下一步最值得优先推进的 3 个产品改进建议。`,
			suggestedMode: "dispatch",
			collaborationPreset: "lead_consult",
		},
		{
			id: "starter-qa",
			roleLabel: qaMember?.displayName ?? "测试经理",
			memberId: qaMember?.id,
			title: `检查「${wsName}」测试覆盖与验收清单`,
			desc: "单兵盘点已有测试与运行命令，输出核心链路验收建议",
			prompt: `请检查「${wsName}」仓库现有的测试文件、测试命令与覆盖范围，整理一份关键功能路径验收清单与潜在风险点。`,
			suggestedMode: "dispatch",
			collaborationPreset: "solo",
		},
	];
}
