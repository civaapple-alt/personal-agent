/** Shared contract for the built-in guided matter. It contains no fabricated execution results. */
interface DemoStepContent {
	label: string;
	description: string;
	prompt: string;
}
export type InnerMatterStep = DemoStepContent &
	({ id: "discuss" | "collaborate" | "deliver" } | { id: "revise"; feedback: string });
export interface InnerMatterGuide {
	id: "feedback-box-v1";
	title: string;
	deliverableTitle: string;
	collaborationMemberIds: string[];
	steps: InnerMatterStep[];
}

export const INNER_MATTER_GUIDE: InnerMatterGuide = {
	id: "feedback-box-v1",
	title: "小团队反馈收集盒",
	deliverableTitle: "反馈收集盒 · 产品方案",
	collaborationMemberIds: ["engineering-manager", "qa-manager"],
	steps: [
		{
			id: "discuss",
			label: "需求讨论",
			description: "让产品经理读资料、发现疑问，先把问题说清楚。",
			prompt:
				"这是内置演示事项。请先阅读 README.md、docs/brief.md 和 docs/customer-notes.md，理解‘小团队反馈收集盒’。先概括用户问题，再向我提出最多 3 个会影响首版范围的关键问题；这一轮只讨论需求，不编码、不发布成果，也不要替我回答。",
		},
		{
			id: "collaborate",
			label: "专业协作",
			description: "回答范围问题，实际咨询研发经理与测试经理。",
			prompt:
				"我的范围确认：先给内部 5 人团队试用，由一位负责人手动录入反馈。V1 只做新增、列表和标记已处理，本机运行、不做账号权限、不接自动分类、不做去重合并。请结合前面的讨论，实际调用 delegate_to_member 分别咨询研发经理（engineering-manager）的最小技术方案和测试经理（qa-manager）的验收风险，再整合取舍与待确认点。当前仍是设计阶段，不编码、不发布正式成果。",
		},
		{
			id: "deliver",
			label: "阶段交付",
			description: "整合讨论与同事意见，形成可审阅的 V1。",
			prompt:
				"需求讨论和专业咨询已完成。请形成首个可审阅版本：包含目标用户、V1 范围与不做项、用户流程、最小技术方案、可检查的验收条件以及采用同事建议的依据。保存到 deliverables/feedback-box-v1.md，并实际调用 save_space_page，以 document 类型、准确标题‘反馈收集盒 · 产品方案’和 sourcePath='deliverables/feedback-box-v1.md' 发布，由宿主读取文件正文，不再传 content，changeNote 说明从讨论形成首版的依据。这是明确的阶段交付，不编码、不提交 Git。",
		},
		{
			id: "revise",
			label: "反馈修订",
			description: "给 V1 记录模拟使用反馈，再形成同一成果系列的 V2。",
			feedback:
				"以下是虚构使用情境的演示反馈，不代表应用已经实现或经过真实试用：V1 的基本方向认可。假设同一建议来自多个渠道时会重复处理，V2 请增加手动合并重复反馈，并将处理状态细化为待处理、处理中、已完成；说明合并后如何保留来源，以及 V1 旧状态如何迁移。仍不做账号权限与自动分类。",
			prompt:
				"请读取本事项已记录的 V1 验收反馈，结合下面的意见实际咨询研发经理与测试经理，检查合并规则、状态转换与回归风险，再修订方案。保存到 deliverables/feedback-box-v2.md，并实际调用 save_space_page，以 document 类型、同一准确标题‘反馈收集盒 · 产品方案’和 sourcePath='deliverables/feedback-box-v2.md' 发布，由宿主读取文件正文，不再传 content，changeNote 逐项说明相对 V1 的变化及反馈依据。保留 V1 文件，不编码、不提交 Git。",
		},
	],
};
