import type { DeliverableDto, MatterMessageDto, MatterProgressDto, TeamMemberDto, WorkspaceDto } from "./api.ts";

export const STATUS_LABELS: Record<string, string> = {
	open: "推进中",
	waiting_user: "待你确认",
	delivered: "已交付",
	archived: "已归档",
};

export const STAGE_ORDER: MatterProgressDto["stage"][] = ["starting", "thinking", "tool", "waiting_user", "finalizing"];

export const STAGE_LABELS: Record<MatterProgressDto["stage"], string> = {
	starting: "准备中",
	thinking: "思考规划",
	tool: "查看/执行",
	waiting_user: "待你确认",
	finalizing: "整理交付",
};

export const MEMORY_SCOPE_LABELS: Record<string, string> = {
	role_general: "角色通用经验",
	company_private: "个人私有经验",
	project_private: "当前项目规范",
};

export const BOT_PALETTE = [
	{ bg: "#35b49b", tilt: "0deg" },
	{ bg: "#4e6df5", tilt: "-7deg" },
	{ bg: "#8b5cf6", tilt: "6deg" },
	{ bg: "#ec6a2c", tilt: "-4deg" },
	{ bg: "#0891b2", tilt: "5deg" },
];

export function getBotTheme(index: number): { bg: string; tilt: string } {
	return BOT_PALETTE[index % BOT_PALETTE.length] ?? { bg: "#35b49b", tilt: "0deg" };
}

export function splitTagsInput(raw: string): string[] {
	return raw
		.split(/[,，、\n]/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

export function formatClockTime(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

export interface StarterTask {
	id: string;
	roleLabel: string;
	memberId?: string;
	title: string;
	desc: string;
	prompt: string;
}

export function buildStarterTasks(
	members: TeamMemberDto[] | undefined,
	selectedWorkspace: WorkspaceDto | null,
): StarterTask[] {
	const wsName = selectedWorkspace?.name;
	const engMember = members?.find((m) => m.templateId === "engineering-manager");
	const pmMember = members?.find((m) => m.templateId === "product-manager");
	const qaMember = members?.find((m) => m.templateId === "qa-manager");

	return [
		{
			id: "starter-eng",
			roleLabel: engMember?.displayName ?? "研发经理",
			memberId: engMember?.id,
			title: wsName ? `梳理「${wsName}」代码结构与关键入口` : "规划项目目录结构与模块边界",
			desc: wsName ? "只读分析技术栈、核心目录、模块职责与启动方式" : "输出清晰的工程架构与核心模块划分",
			prompt: wsName
				? `请只读梳理「${wsName}」仓库的目录结构、核心模块、技术栈与本地启动方式，输出一份简明工程概览文档。`
				: "请帮我设计一个 TypeScript 全栈项目的目录结构与核心模块划分方案，说明各目录职责与关键边界。",
		},
		{
			id: "starter-pm",
			roleLabel: pmMember?.displayName ?? "产品经理",
			memberId: pmMember?.id,
			title: wsName ? `分析「${wsName}」现有功能与优化点` : "梳理 MVP 产品方案与优先级",
			desc: wsName ? "总结当前已实现的能力与最值得优先改进的 3 件事" : "拆解首期核心流程、页面结构与验收目标",
			prompt: wsName
				? `请先阅读「${wsName}」仓库文档与主要源码，梳理当前已实现的功能清单，并给出下一步最值得优先推进的 3 个产品改进建议。`
				: "我想做一个面向个人团队的 AI 协作工作台，请帮我梳理 MVP 核心使用流程、关键页面与首期优先级。",
		},
		{
			id: "starter-qa",
			roleLabel: qaMember?.displayName ?? "测试经理",
			memberId: qaMember?.id,
			title: wsName ? `检查「${wsName}」测试覆盖与验收清单` : "制定上线验收清单与测试策略",
			desc: wsName ? "盘点已有测试与运行命令，输出核心链路验收建议" : "涵盖主流程验证、边界条件与回归测试方案",
			prompt: wsName
				? `请检查「${wsName}」仓库现有的测试文件、测试命令与覆盖范围，整理一份关键功能路径验收清单与潜在风险点。`
				: "请帮我制定一套精简可执行的功能上线验收清单，覆盖核心流程、异常恢复与自动化回归检查。",
		},
	];
}

export function mapDeliverablesToMessages(
	userMessages: MatterMessageDto[],
	deliverables: DeliverableDto[],
): { byMessageId: Map<string, DeliverableDto[]>; unattached: DeliverableDto[] } {
	const byMessageId = new Map<string, DeliverableDto[]>();
	const unattached: DeliverableDto[] = [];
	const memberMessages = userMessages.filter((m) => m.senderType === "member");
	const orderedDeliverables = [...deliverables].sort(
		(a, b) => a.createdAt.localeCompare(b.createdAt) || a.version - b.version,
	);
	const matchedMessageIds = new Set<string>();

	const attach = (msgId: string, deliv: DeliverableDto) => {
		const list = byMessageId.get(msgId);
		if (list) {
			list.push(deliv);
		} else {
			byMessageId.set(msgId, [deliv]);
		}
	};

	for (const deliv of orderedDeliverables) {
		const exactMatch = memberMessages.find(
			(msg) =>
				!matchedMessageIds.has(msg.id) && msg.senderId === deliv.memberId && msg.content === deliv.contentOrPath,
		);
		if (exactMatch) {
			matchedMessageIds.add(exactMatch.id);
			attach(exactMatch.id, deliv);
			continue;
		}

		// Fall back to the nearest earlier member reply in the turn when contentOrPath differs (e.g. artifact path).
		let fallbackMsg: MatterMessageDto | undefined;
		for (const msg of memberMessages) {
			if (!matchedMessageIds.has(msg.id) && msg.createdAt <= deliv.createdAt) {
				fallbackMsg = msg;
			}
		}
		if (fallbackMsg) {
			matchedMessageIds.add(fallbackMsg.id);
			attach(fallbackMsg.id, deliv);
		} else {
			unattached.push(deliv);
		}
	}

	return { byMessageId, unattached };
}

export interface DelegationSummaryItem {
	id: string;
	fromMemberId: string;
	toMemberId: string;
	targetLabel: string;
	question: string;
	answer?: string;
	status: "running" | "completed" | "failed";
	createdAt: string;
}

function stripMentionPrefix(text: string): { targetLabel: string; body: string } {
	const match = text.match(/^@([^:\n：]+)[:：]\s*([\s\S]*)$/);
	if (match) {
		return { targetLabel: match[1]!.trim(), body: match[2]!.trim() };
	}
	return { targetLabel: "", body: text.trim() };
}

export function buildDelegationItems(
	internalCollabMessages: MatterMessageDto[],
	isTurnRunning = false,
): DelegationSummaryItem[] {
	const responsesByRequestId = new Map<string, MatterMessageDto>();
	const orphanMessages: MatterMessageDto[] = [];

	for (const msg of internalCollabMessages) {
		const reqId = typeof msg.metadata?.requestMessageId === "string" ? msg.metadata.requestMessageId : null;
		if (reqId) {
			responsesByRequestId.set(reqId, msg);
		}
	}

	const items: DelegationSummaryItem[] = [];
	const sorted = [...internalCollabMessages].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

	for (const msg of sorted) {
		const isResponse = typeof msg.metadata?.requestMessageId === "string";
		if (isResponse) continue;
		const parsed = stripMentionPrefix(msg.content);
		const toMemberId = typeof msg.metadata?.toMemberId === "string" ? msg.metadata.toMemberId : "";
		if (!toMemberId && !parsed.targetLabel) {
			orphanMessages.push(msg);
			continue;
		}
		const reply = responsesByRequestId.get(msg.id);
		const isFailed = Boolean(reply?.metadata?.failed || reply?.senderType === "system");
		const status: DelegationSummaryItem["status"] = reply
			? isFailed
				? "failed"
				: "completed"
			: isTurnRunning
				? "running"
				: "failed";
		items.push({
			id: msg.id,
			fromMemberId: msg.senderId,
			toMemberId: toMemberId || (reply?.senderId ?? ""),
			targetLabel: parsed.targetLabel,
			question: parsed.body || msg.content,
			answer: reply?.content,
			status,
			createdAt: msg.createdAt,
		});
	}

	for (const orphan of orphanMessages) {
		items.push({
			id: orphan.id,
			fromMemberId: orphan.senderId,
			toMemberId: "",
			targetLabel: "",
			question: orphan.content,
			status: orphan.senderType === "system" ? "failed" : "completed",
			createdAt: orphan.createdAt,
		});
	}

	return items;
}

export function mapDelegationsToMessages(
	userMessages: MatterMessageDto[],
	internalCollabMessages: MatterMessageDto[],
	isTurnRunning: boolean,
): {
	byMessageId: Map<string, DelegationSummaryItem[]>;
	unattached: DelegationSummaryItem[];
	all: DelegationSummaryItem[];
} {
	const items = buildDelegationItems(internalCollabMessages, isTurnRunning);
	const byMessageId = new Map<string, DelegationSummaryItem[]>();
	const unattached: DelegationSummaryItem[] = [];
	if (items.length === 0) return { byMessageId, unattached, all: items };

	const userTurns = userMessages.filter((m) => m.senderType === "user");
	const pushTo = (msgId: string, item: DelegationSummaryItem) => {
		const list = byMessageId.get(msgId);
		if (list) list.push(item);
		else byMessageId.set(msgId, [item]);
	};

	for (const item of items) {
		let turnIndex = -1;
		for (let i = 0; i < userTurns.length; i += 1) {
			if (userTurns[i]!.createdAt <= item.createdAt) {
				turnIndex = i;
			}
		}
		const turnStart = turnIndex >= 0 ? userTurns[turnIndex]!.createdAt : "";
		const nextTurnStart =
			turnIndex >= 0 && turnIndex + 1 < userTurns.length ? userTurns[turnIndex + 1]!.createdAt : null;
		const turnReplies = userMessages.filter(
			(m) =>
				m.senderType !== "user" &&
				m.createdAt >= turnStart &&
				(nextTurnStart === null || m.createdAt < nextTurnStart),
		);
		const anchorMsg = turnReplies.at(-1) ?? (turnIndex >= 0 ? userTurns[turnIndex] : undefined);
		if (anchorMsg) {
			pushTo(anchorMsg.id, item);
		} else {
			unattached.push(item);
		}
	}

	return { byMessageId, unattached, all: items };
}

export function formatNoticeEventLine(rawContent: string): string {
	try {
		const parsed = JSON.parse(rawContent) as {
			type?: string;
			method?: string;
			toolName?: string;
			isError?: boolean;
			message?: string;
			tools?: string[];
		};
		if (parsed.type === "tool_execution_start") {
			return `开始工具 ${parsed.toolName ?? "tool"}`;
		}
		if (parsed.type === "tool_execution_end") {
			return `结束工具 ${parsed.toolName ?? "tool"}${parsed.isError ? "（失败）" : ""}`;
		}
		if (parsed.method === "runtime_ready") {
			return `工作进程就绪（${parsed.tools?.join(", ") ?? "标准工具"}）`;
		}
		if (parsed.method === "error" && parsed.message) {
			return `执行异常：${parsed.message}`;
		}
		if (parsed.message) return parsed.message;
	} catch {
		// Fall back to raw text when notice is plain string.
	}
	return rawContent;
}
