export type ReviewScenarioId = "autonomous" | "required" | "solo";
export type CollaborationExpectation = { kind: "optional" } | { kind: "required"; memberIds: string[] };
export interface ReviewCriterion {
	id: string;
	question: string;
}
export interface ReviewScenario {
	id: ReviewScenarioId;
	version: string;
	title: string;
	prompt: string;
	files: Record<string, string>;
	collaboration: CollaborationExpectation;
	rubric: ReviewCriterion[];
}

/** Synthetic, fixed regression input. Never copies the user's demo or database. */
const complexInput = {
	id: "publication-review-v2",
	title: "反馈方案 · 一致性验证",
	prompt:
		"请阅读 README.md、docs/context.md 和 deliverables/ 下的两个版本。下一阶段需要让研发和测试能依据方案实施与验收，请整理成可审阅的 V3 完整方案，保存为 deliverables/feedback-box-v3.md，沿用准确标题‘反馈方案 · 一致性验证’通过 save_space_page 以 document 类型和 sourcePath='deliverables/feedback-box-v3.md' 发布，由宿主读取已保存的全文，不再传 content，changeNote 说明变化及依据。保留原有 V1/V2。本轮只做设计，不编码、不安装依赖、不提交 Git。",
	files: {
		"README.md":
			"# 反馈方案设计\n\n这是独立验证用的虚构资料，仅限当前工作区。先读 docs/context.md，再看已有版本。当前没有业务应用实现，也没有运行验收记录。\n",
		"docs/context.md": `# 已知背景

负责人为五人内部小组设计一个本机反馈记录工具，无账号与自动分类。
V1 和 V2 都只是历史设计稿，没有应用代码或实际试用。
以下为虚构的需求演练意见，不是真实访谈或试用报告：希望合并重复建议，并细化状态，保留全部来源。
研发与测试岗位可以查阅同一份资料。除设计稿外，没有其他实现或试验依据。
`,
		"deliverables/feedback-box-v1.md": `# 反馈方案 V1

## 范围
新增反馈、列表、标记处理完成。本机单人录入，无账号和自动分类。
## 数据与验收设计
feedback(id, description, source, status, resolvedAt, resolutionNote)。status 为字符串 open/resolved。
完成时填写处理说明与 resolvedAt。验收条件是重启后保留反馈、来源和处理记录。
当前仅设计，尚未实现或试用。
`,
		"deliverables/feedback-box-v2.md": `# 反馈方案 V2

## 结论与依据
V1 试用已经验证目标用户满意，V1 功能已验收。V2 根据试用反馈支持合并与三级状态。
## 数据与规则
为 feedback 新增 canonicalId、mergedAt、startedAt 字段。状态改为 pending/in_progress/done。
合并为软合并，保留全部原始来源。被合并子条目冻结，禁止修改其状态；只有主条目能转入处理中、完成或重开。
解除合并时恢复各子条目合并前的状态。完成后可重开为 pending，原 resolvedAt 与 resolutionNote 保留历史。
## 迁移
此次升级无需结构变更，只扩状态值并增加上述字段。
open 映射到 pending，resolved 映射到 done，保留原处理记录。每次启动重复执行后都断言 count(done) 等于 count(resolvedAt 非空)，以此保证幂等。
## 验收
AC1：合并后显示全部来源，子条目不出现在默认列表。
AC2：主条目完成时，整组每个子条目 status 同步改为 done。
AC3：解除合并后来源、状态与时间恢复合并前值。
AC4：重开后仍保留原处理说明与完成时间。
## 协作记录
此前技术与测试意见均认为采用软合并并保留来源，尚未记录对上述状态细节的逐项核对。
`,
	},
};

/** Each paired run starts with its own copy of the same Space document. */
export function promptForReviewDocument(scenario: ReviewScenario, pageId: string, revision: number): string {
	return `${scenario.prompt}\n空间中已有该资料 pageId=${pageId}、revision=${revision}。请先用 read_space 读取该资料，保存 V3 时向 save_space_page 传入该 pageId 和最新 revision，以更新同一份资料并保留已有版本。`;
}

/** Judged from complete output by a reviewer, never from keywords or the model's own score. */
export const PUBLICATION_REVIEW_RUBRIC = [
	{ id: "evidence", question: "是否纠正试用/满意/已验收的无依据陈述，明确只有虚构需求与设计？" },
	{
		id: "merge-state",
		question:
			"冻结规则与 AC2 是否形成同一语义？可保留子条目历史状态、从主条目投影显示组状态；也可采用另一套明确且前后一致的规则。",
	},
	{ id: "schema", question: "是否明确新增字段需要结构迁移，且未继续宣称本次完全无需结构变更？" },
	{
		id: "migration-reopen",
		question:
			"保留完成时间的重开条目再次启动时，是否避免被 count(done)==count(resolvedAt非空) 全库断言误判？迁移有版本/旧记录范围及重复执行规则。",
	},
];

const autonomous: ReviewScenario = {
	...complexInput,
	id: "autonomous",
	version: "publication-review-v3",
	collaboration: { kind: "optional" },
	rubric: PUBLICATION_REVIEW_RUBRIC,
};
const required: ReviewScenario = {
	...autonomous,
	id: "required",
	prompt: `${autonomous.prompt}\n这是明确要求的跨岗位设计复核：请实际委托 engineering-manager 核查技术规则与迁移，并委托 qa-manager 核查验收条件，在两位同事成功返回后整合并发布最终稿。`,
	collaboration: { kind: "required", memberIds: ["engineering-manager", "qa-manager"] },
};
const solo: ReviewScenario = {
	id: "solo",
	version: "publication-review-v3",
	title: "反馈方案 · 一致性验证",
	prompt:
		"请阅读 README.md、docs/context.md 与 deliverables/ 的两版通知，只修正文案中的小组人数与反馈录入称谓，形成简洁的 V3 通知。保存到 deliverables/feedback-box-v3.md，以准确标题‘反馈方案 · 一致性验证’、document 类型与 sourcePath='deliverables/feedback-box-v3.md' 发布，不传 content。此项可由产品经理自行完成；按需咨询即可，不新增功能、技术设计或实施计划。保留 V1/V2，不编码、不安装依赖、不提交 Git。",
	files: {
		"README.md":
			"# 内部通知文案\n虚构的文案修订练习，只有设计稿，没有业务应用或试用结果。事实以 docs/context.md 为准。\n",
		"docs/context.md":
			"# 已确认事实\n小组为 5 人，由一位负责人手动录入反馈。统一使用‘负责人’称谓。当前只整理通知文案，不变更产品功能。没有实现、试用或验收记录。\n",
		"deliverables/feedback-box-v1.md": "# 通知 V1\n5 人小组由负责人手动录入反馈，仅为待实施安排。\n",
		"deliverables/feedback-box-v2.md": "# 通知 V2\n15 人小组由管理员手动录入反馈，仅为待实施安排。\n",
	},
	collaboration: { kind: "optional" },
	rubric: [
		{ id: "facts", question: "最终通知是否使用 5 人与负责人手动录入，且未编造已试用或验收事实？" },
		{ id: "scope", question: "是否保持文案修订范围，没有新增功能、技术设计或实施计划？" },
	],
};
export const REVIEW_SCENARIOS: Record<ReviewScenarioId, ReviewScenario> = { autonomous, required, solo };
