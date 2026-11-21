import { isGuideTopic, readWorkbenchGuide, type WorkbenchTopic } from "../pa-extensions/workbench-help/catalog.ts";
import type { PersonalAgentStore } from "../storage/repositories.ts";
import type { Matter, TeamMember } from "../storage/types.ts";
import { isCurrentHumanDecision, readHumanDecision } from "./human-decision.ts";
import { selectMatterContext, type WorkspaceContext } from "./matter-context.ts";

export interface WorkbenchContext extends WorkspaceContext {
	matter: Matter;
	members: TeamMember[];
	workspaceName?: string;
	activeTools?: string[];
}

const MATTER_STATUS_LABELS = {
	open: "开放",
	waiting_user: "等待用户答复",
	delivered: "已交付",
	archived: "已归档",
} satisfies Record<Matter["status"], string>;

function plainText(value: string): string {
	return value
		.replace(/\s+/gu, " ")
		.slice(0, 280)
		.replace(/[\\`*_[\]<>]/gu, "\\$&");
}

export async function readWorkbenchTopic(
	store: PersonalAgentStore,
	context: WorkbenchContext,
	topic: WorkbenchTopic,
	chinese: boolean,
) {
	if (isGuideTopic(topic)) return readWorkbenchGuide(topic, chinese);

	const { matter, members, workspaceName, activeTools } = context;
	if (topic === "current_matter") {
		const status = chinese ? MATTER_STATUS_LABELS[matter.status] : matter.status;
		const lead = members.find(({ id }) => id === matter.leadMemberId);
		const roster = members.map(({ id, displayName }) => {
			const labels = [
				id === matter.leadMemberId ? (chinese ? "负责人" : "lead") : false,
				id !== matter.leadMemberId && (matter.consultMemberIds == null || matter.consultMemberIds.includes(id))
					? chinese
						? "可请教"
						: "consultable"
					: false,
				matter.observersEnabled && matter.observerMemberIds.includes(id) ? (chinese ? "旁听" : "observer") : false,
			].filter(Boolean);
			return `- ${plainText(displayName)}${labels.length ? ` · ${labels.join(" / ")}` : ""}`;
		});
		return {
			source: "current_matter",
			heading: chinese ? "当前事项" : "Current matter",
			content: [
				chinese
					? `状态：${status}。负责人：${lead ? plainText(lead.displayName) : "未指定或不可见"}。`
					: `Status: ${status}. Lead: ${lead ? plainText(lead.displayName) : "unassigned or not visible"}.`,
				chinese
					? `仓库：${workspaceName ? plainText(workspaceName) : "未绑定"}。主动回应：${matter.discussionAiEnabled ? "开启" : "关闭"}。`
					: `Repository: ${workspaceName ? plainText(workspaceName) : "none"}. Proactive replies: ${matter.discussionAiEnabled ? "on" : "off"}.`,
				...roster.slice(0, 40),
				...(roster.length > 40
					? [
							chinese
								? `共 ${roster.length} 位可见 AI 成员，此处显示前 40 位。`
								: `${roster.length} visible roles, showing the first 40.`,
						]
					: []),
				...(activeTools
					? [
							`\n${chinese ? "本轮启动时可用工具" : "Tools available at the start of this turn"}: ${activeTools.map(plainText).join(", ")}`,
						]
					: []),
			].join("\n"),
		};
	}

	const { messages, deliverables } = selectMatterContext({
		...context,
		messages: store.listMessages(matter.id, "user"),
		deliverables: topic === "published_deliverables" ? store.listDeliverables(matter.id) : [],
	});
	const heading =
		topic === "pending_decisions"
			? chinese
				? "当前等待答复的决定"
				: "Pending decisions"
			: chinese
				? "当前工作区的已发布成果"
				: "Published deliverables in this workspace";
	const rows =
		topic === "pending_decisions"
			? messages.flatMap((message, index) => {
					const decision = readHumanDecision(message.metadata);
					if (
						decision?.status !== "pending" ||
						!isCurrentHumanDecision(message, decision, matter, messages.slice(index + 1))
					)
						return [];
					const assignee = decision.assignedName
						? plainText(decision.assignedName)
						: chinese
							? "事项管理者"
							: "matter manager";
					return [
						`- ${decision.requests.map(({ question }) => plainText(question)).join(" / ")} · ${chinese ? "等待" : "Waiting for"} ${assignee}`,
					];
				})
			: deliverables.map((item) => `- ${plainText(item.title)} · v${item.version}`);
	return {
		source: topic,
		heading,
		content: [
			chinese ? `共 ${rows.length} 条。` : `${rows.length} records.`,
			...rows.slice(0, 15),
			...(rows.length > 15 ? [chinese ? "显示前 15 条。" : "Showing the first 15."] : []),
		].join("\n"),
	};
}
