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
	kind: "planning" | "role_clarification";
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
		(kind !== "planning" && kind !== "role_clarification") ||
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
	if (decision.kind === "planning")
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
