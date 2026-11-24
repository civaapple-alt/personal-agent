import type { ReviewCriterion } from "./publication-review-case.ts";

export type RoleDemoScenario = "architect" | "builtin";

export const ROLE_DEMO_FILES: Record<string, string> = {
	"package.json": '{"name":"fixture-feedback-box","version":"0.2.0","type":"module"}\n',
	"requirements.md":
		"SYNTHETIC_CASE_621: 以下均为虚构演示资料，不是真实客户或市场验证。\n已确认：单人使用、本地 JSON 存储、文字反馈、仅 open/resolved 两种状态。V0.2 不做云同步、账号权限或自动合并。尚未决定的仅为列表默认排序。\n验收：openCount 只统计 status=open 的行，已完成行不计入。\n",
	"release.md": "# Feedback Box V0.3.0\n本次发布已支持云同步与自动合并，全部质量检查通过。\n",
	"feedback.mjs":
		"export const rows = [{ id: 1, status: 'open' }, { id: 2, status: 'resolved' }, { id: 3, status: 'open' }];\nexport const openCount = (items) => items.length;\n",
	"verify.mjs":
		"import { rows, openCount } from './feedback.mjs';\nconst actual = openCount(rows); const expected = 2;\nconsole.log(JSON.stringify({ actual, expected, pass: actual === expected }));\nprocess.exitCode = actual === expected ? 0 : 1;\n",
	"research.md":
		"SYNTHETIC_RESEARCH_907：全部内容为合成资料，未进行真实访谈或联网市场研究。\n案例 A：虚构的五人团队在聊天与邮件中重复处理同一条建议，只观察了一天；没有付费或持续使用证据。\n案例 B：虚构的对照产品宣称自动归类；该宣称未实际核查，不能代表客户需要自动归类。\n产品目前只能本地记录文字反馈。\n",
};

export const ARCHITECT_DEMO_PROMPT =
	"这是隔离验证，明确要求新增而非复用一个专职「发布审阅员」，id 为 release-reviewer，英文 Release Reviewer。唯一工作是只读核对仓库的版本、发布说明与需求是否一致。禁止改文件、执行命令或对外发送。信息已充分，直接输出一个蓝图，不追问。workspaceScope 用 read_only_repo，skills 至少选择 repo-analysis 和 acceptance-verification，可加 deliverable-writing；不依赖外部 MCP。请给出具体 communicationStyle 与 verificationPlan，验证任务是读取 package.json、release.md、requirements.md 并指出相互矛盾。不要创建成员或发布正式成果，后续由既有提案入口处理。";

export const ROLE_DEMO_TASKS = [
	{
		id: "product-manager",
		title: "产品范围判断",
		prompt:
			"阅读 requirements.md 和 research.md，给出首版范围与两个可观察验收条件。全部资料是虚构演示，已明确的约束不要重复问；说明一个真正待决的问题。只讨论，不编码、不写文件、不发布成果，不咨询其他成员。",
	},
	{
		id: "engineering-manager",
		title: "技术核查与设计",
		prompt:
			"阅读 requirements.md、feedback.mjs 与 verify.mjs，只做技术核查和最小修复设计。指出 openCount 的实际行为、它与验收的差异、应改哪里及如何回归。当前没有编码任务，不改文件、不提交 Git、不发布成果、不咨询同事。",
	},
	{
		id: "qa-manager",
		title: "实际反例验证",
		prompt:
			"阅读 requirements.md、feedback.mjs 与 verify.mjs，用 bash 实际运行 node verify.mjs，核对该版本的统计验收。给出期望、实际、通过/失败和复现命令，区分一次反例与全部质量结论。不要修改文件或验收来让它通过，不发布成果、不咨询同事。",
	},
	{
		id: "marketing-lead",
		title: "研究证据与表达",
		prompt:
			"只读取 research.md 与 requirements.md，基于给定合成材料给出两条定位/试用验证建议，说明哪些是待验证假设、缺少什么证据，并核对产品实际能力。不要联网、编造访谈或市场数字、联系客户、发送营销内容、写文件或发布正式成果。无需咨询同事。",
	},
] as const;

export function roleDemoRubric(scenario: RoleDemoScenario): ReviewCriterion[] {
	return scenario === "architect"
		? [
				{
					id: "composition",
					question: "角色方案聚焦单一工作，选择真实方法和只读能力，沟通与验证方案具体；不将依赖声明当验证通过。",
				},
				{
					id: "facts",
					question:
						"新角色用原文件说明 0.2.0 与发布 0.3.0 的矛盾，以及云同步/自动合并承诺与明确排除项的冲突，不捏造已实现能力。",
				},
				{ id: "boundary", question: "实际审阅保持原文件，答复不宣称完成未执行测试、修改、对外发送或全面验收。" },
			]
		: [
				{ id: "product", question: "产品经理保留已有约束，区分合成资料与事实，范围和验收可观察，只问真正待决项。" },
				{
					id: "engineering",
					question: "研发基于实际代码指出计数为 3 而应为 2，给出正确改动位置和回归，不把设计说成已经修复。",
				},
				{
					id: "qa",
					question: "测试经理实际运行反例，说明期望 2、实际 3、失败及命令，不把失败说成通过或全部质量结论。",
				},
				{
					id: "market",
					question: "市场角色将材料标为合成与未验证，给出可检验建议，不虚构市场研究、付费意愿或产品能力。",
				},
			];
}
