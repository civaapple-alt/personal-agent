import { hasRoleProposalActions } from "../roles/role-proposal-state.ts";

export interface Clarification {
	question: string;
	context?: string;
	options?: string[];
}

export interface DecisionSource {
	memberId: string;
	assignmentNumber: number;
	messageId: string;
}

interface DecisionRequest {
	kind: "planning" | "role_clarification" | "execution_confirmation";
	requests: Clarification[];
	assignedUserId: string | null;
	assignedName?: string;
	source?: DecisionSource;
	revision: number;
}

export interface DecisionRespondent {
	userId: string | null;
	name: string;
	at: string;
}

export interface DecisionResponse {
	sourceMessageId: string;
	text: string;
	respondent: DecisionRespondent;
}

export type HumanDecision = DecisionRequest &
	(
		| { status: "pending" }
		| {
				status: "answered";
				answer: string;
				answeredBy: DecisionRespondent;
		  }
	);

function readRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return Object.fromEntries(Object.entries(value));
}

export function readHumanDecision(metadata: Record<string, unknown> | null | undefined): HumanDecision | null {
	const value = readRecord(metadata?.humanDecision);
	if (!value) return null;
	const { kind, status, revision, assignedUserId, assignedName } = value;
	if (
		(kind !== "planning" && kind !== "role_clarification" && kind !== "execution_confirmation") ||
		typeof revision !== "number" ||
		!Number.isSafeInteger(revision) ||
		revision < 1 ||
		(assignedUserId !== null && typeof assignedUserId !== "string") ||
		!Array.isArray(value.requests)
	)
		return null;
	const requests: Clarification[] = [];
	for (const item of value.requests) {
		const request = readRecord(item);
		if (!request || typeof request.question !== "string") return null;
		requests.push({
			question: request.question,
			context: typeof request.context === "string" ? request.context : undefined,
			options: Array.isArray(request.options)
				? request.options.filter((item): item is string => typeof item === "string")
				: undefined,
		});
	}
	if (requests.length === 0) return null;
	const from = readRecord(value.source);
	const source =
		from &&
		typeof from.memberId === "string" &&
		typeof from.messageId === "string" &&
		typeof from.assignmentNumber === "number"
			? { memberId: from.memberId, messageId: from.messageId, assignmentNumber: from.assignmentNumber }
			: undefined;
	const request: DecisionRequest = {
		kind,
		revision,
		requests,
		source,
		assignedUserId,
		assignedName: typeof assignedName === "string" ? assignedName : undefined,
	};
	if (status === "pending") return { ...request, status };
	const actor = readRecord(value.answeredBy);
	if (
		status !== "answered" ||
		typeof value.answer !== "string" ||
		!actor ||
		typeof actor.name !== "string" ||
		typeof actor.at !== "string" ||
		(actor.userId !== null && typeof actor.userId !== "string")
	)
		return null;
	return {
		...request,
		status,
		answer: value.answer,
		answeredBy: { userId: actor.userId, name: actor.name, at: actor.at },
	};
}

interface DecisionMessage {
	id: string;
	channel: string;
	senderId: string;
	senderType: string;
	metadata?: Record<string, unknown> | null;
}

export function isCurrentHumanDecision(
	message: DecisionMessage,
	decision: HumanDecision,
	matter: {
		orgId?: string | null;
		workspaceId: string | null;
		leadMemberId: string | null;
		status: string;
		aiMemberIds?: string[] | null;
	},
	laterMessages: DecisionMessage[],
): boolean {
	if (
		message.channel !== "user" ||
		message.senderType !== "member" ||
		matter.status === "archived" ||
		message.metadata?.orgId !== (matter.orgId ?? null) ||
		message.metadata?.workspaceId !== matter.workspaceId
	)
		return false;
	if (decision.kind === "planning" && !message.metadata?.conversationRouted)
		return message.senderId === matter.leadMemberId;
	if (
		decision.kind !== "role_clarification" &&
		matter.aiMemberIds &&
		message.senderId !== matter.leadMemberId &&
		!matter.aiMemberIds.includes(message.senderId)
	)
		return false;
	if (decision.kind === "execution_confirmation" || decision.kind === "planning")
		return !laterMessages.some(
			(item) =>
				item.senderType === "member" &&
				item.senderId === message.senderId &&
				readHumanDecision(item.metadata)?.kind === decision.kind,
		);
	return !laterMessages.some(
		(item) =>
			item.senderType === "member" &&
			item.senderId === message.senderId &&
			(readHumanDecision(item.metadata)?.kind === "role_clarification" ||
				hasRoleProposalActions(item.metadata?.roleProposals)),
	);
}

export function listCompletedHumanDecisions(messages: DecisionMessage[]): Set<string> {
	const attempts = new Map<string, string>();
	const completed = new Set<string>();
	for (const message of messages) {
		const metadata = message.metadata;
		if (message.senderType === "user" && typeof metadata?.humanDecisionSourceId === "string") {
			attempts.set(message.id, metadata.humanDecisionSourceId);
		}
		if (
			message.senderType === "member" &&
			!metadata?.aborted &&
			!metadata?.failed &&
			!metadata?.observerIntervention &&
			typeof metadata?.sourceUserMessageId === "string"
		) {
			const decisionId = attempts.get(metadata.sourceUserMessageId);
			if (decisionId) completed.add(decisionId);
		}
	}
	return completed;
}

/** An example of the real decision flow, without creating an actionable card. */
export function describeHumanDecision(question: string): string {
	return /\p{Script=Han}/u.test(question)
		? [
				"**「待你决定」用法示例**",
				"",
				"假设你安排 AI 做登录验收，范围还未定。AI 可以发出一张卡片，问「只验证登录，还是也验证找回密码？」",
				"",
				"1. 指定答复人选择「也验证找回密码」，点击「提交答案」。",
				"2. 卡片显示「已答复」，并记录是谁在什么时候答的。",
				"3. 事项空闲且有权限时，AI 按选定范围继续。若答案已保存但还未续跑，有权限的成员可以点「继续执行」。",
				"",
				"如果卡片问「要按这条消息开始执行吗」，「开始执行」会按原消息派工，「先讨论」会继续只读交流。这里展示的是示例流程。",
			].join("\n")
		: [
				"**Example: a decision card**",
				"",
				"Suppose you ask AI to verify sign-in, and the test scope is still open. AI can ask, “Should I include password recovery?”",
				"",
				"1. The assigned respondent selects “Include password recovery” and submits the answer.",
				"2. The card shows who answered and when.",
				"3. AI continues with the selected scope when the matter is idle and dispatch is allowed. An authorized member can resume it if the answer was saved while it was busy.",
				"",
				"If a card asks whether to start execution, **Start execution** dispatches the original request. **Discuss first** continues in read-only mode. This is an illustrative example.",
			].join("\n");
}
