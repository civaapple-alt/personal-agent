import { readFile } from "node:fs/promises";

const GUIDES = {
	pa_and_pi: {
		heading: "PA 与 Pi",
		english: "PA and Pi",
		rubric: "What PA and Pi are, their roles in the current agent workbench, and how they work together.",
	},
	matters: {
		heading: "事项与派发",
		english: "Matters and dispatch",
		rubric: "How to start a PA matter, ask questions, mention a role, or stop a turn.",
	},
	starting_work: {
		heading: "工作方式与执行",
		english: "How roles work and execute",
		rubric:
			"How AI roles decide between answering directly, inspecting, executing tasks, or asking for human clarification. Includes 怎么进入正式执行轮 and 讨论与执行的区别.",
	},
	collaboration: {
		heading: "协作与旁听",
		english: "Collaboration and observers",
		rubric: "How PA lead, collaborators, delegation handoffs, and observers participate.",
	},
	decisions: {
		heading: "待你决定",
		english: "Decisions",
		rubric:
			"How to use PA's human decision card, including a request to see its usage now or a walkthrough. Includes 待你决定 and colloquial names like 由用户待定. For '怎么用' or '看一下使用', choose this topic.",
	},
	roles: {
		heading: "角色与权限",
		english: "Roles and permissions",
		rubric: "How to use Role Architect, review a draft, confirm a role, choose availability, or add it to a matter.",
	},
	deliverables: {
		heading: "成果与反馈",
		english: "Spaces and Git history",
		rubric: "How or where to publish, open, view version history for, or give feedback on PA deliverables.",
	},
	capabilities: {
		heading: "模型、仓库与已开放能力",
		english: "Models, repositories, and capabilities",
		rubric:
			"How to configure PA's model picker, repository binding, web search, pstack, or supported customizations.",
	},
	experience: {
		heading: "经验复盘",
		english: "Team experience",
		rubric: "How PA retrospectives, candidate experience, and verification work.",
	},
} as const;

export const WORKBENCH_TOPICS = {
	...Object.fromEntries(Object.entries(GUIDES).map(([key, guide]) => [key, guide.rubric])),
	current_matter: "Current matter status, lead, team participation, or bound repository as it exists now.",
	runtime_tools:
		"Which tools or extensions the current AI role can actually use in this matter. Includes '你能用哪些工具', '包含 human question 和 request_clarification 吗', and questions about whether a named tool is available. Choose capabilities only for platform setup or customization.",
	pending_decisions:
		"Only for listing the actual decision cards currently pending in this matter, such as '本事项有哪些卡片等我答复'.",
	published_deliverables:
		"Only for listing the actual deliverables already published for this matter, such as '本事项已经发布了哪些成果'.",
} as Record<WorkbenchTopic, string>;

export type WorkbenchTopic =
	| keyof typeof GUIDES
	| "current_matter"
	| "runtime_tools"
	| "pending_decisions"
	| "published_deliverables";

export function isWorkbenchTopic(topic: unknown): topic is WorkbenchTopic {
	return typeof topic === "string" && Object.hasOwn(WORKBENCH_TOPICS, topic);
}

export const WORKBENCH_HELP_PROMPT = [
	"Personal Agent help: call read_pa_help for questions about the workbench's features or current matter state. Use the business repository for questions about the project itself.",
	`Guide topics: ${Object.keys(GUIDES).join(", ")}.`,
	"Live topics: current_matter (roles and repository), runtime_tools (actual tools and extension availability), pending_decisions, published_deliverables.",
].join("\n");

export function isGuideTopic(topic: WorkbenchTopic): topic is keyof typeof GUIDES {
	return Object.hasOwn(GUIDES, topic);
}

export async function readWorkbenchGuide(topic: keyof typeof GUIDES, chinese: boolean) {
	const file = chinese ? "agent-workbench.md" : "agent-workbench.en.md";
	const heading = chinese ? GUIDES[topic].heading : GUIDES[topic].english;
	const source = `docs/guides/${file}`;
	const fileContents = await readFile(new URL(`../../../${source}`, import.meta.url), "utf8");
	const section = fileContents
		.split(/^## /m)
		.find((part) => part.startsWith(`${heading}\n`) || part.startsWith(`${heading}\r\n`));
	if (!section) throw new Error(`Workbench guide section missing: ${heading}`);
	return { source, heading, content: section.slice(heading.length).trim().slice(0, 4000) };
}
