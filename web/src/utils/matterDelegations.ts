import type { ActiveDelegationDto, MatterMessageDto } from "../api/matters.ts";

export interface DelegationAssignment {
	id: string;
	number: number;
	fromMemberId: string;
	toMemberId: string;
	targetLabel: string;
	parentRequestMessageId?: string;
	status: "running" | "completed" | "failed";
}

export type DelegationPost = {
	message: MatterMessageDto;
	assignment: DelegationAssignment;
	kind: "assignment" | "reply" | "failure";
};

export interface DelegationBoard {
	assignments: DelegationAssignment[];
	posts: DelegationPost[];
}

export interface MatterDelegations {
	byTurn: Map<string, DelegationBoard>;
	history: DelegationBoard;
	assignments: DelegationAssignment[];
}

export function delegationTaskText(content: string): string {
	return content.replace(/^@[^:\n：]+[:：]\s*/, "");
}

/** Project the stored handoffs into conversation rounds. Older records use only available timing evidence. */
export function buildMatterDelegations(
	userMessages: MatterMessageDto[],
	internalMessages: MatterMessageDto[],
	activeTurnId?: string,
): MatterDelegations {
	const turns = userMessages.filter((message) => message.senderType === "user");
	const turnsById = new Map(turns.map((message) => [message.id, message]));
	const lastReplyByTurn = new Map<string, string>();
	for (const message of userMessages) {
		const sourceId = message.metadata?.sourceUserMessageId;
		if (message.senderType !== "user" && typeof sourceId === "string") {
			lastReplyByTurn.set(sourceId, message.createdAt);
		}
	}
	const legacyTurns = turns.filter(
		(turn) =>
			turn.metadata?.mode !== "ai_request" && (turn.metadata?.mode !== "discussion" || lastReplyByTurn.has(turn.id)),
	);
	const legacyWindows = legacyTurns.flatMap((turn) => {
		const end = lastReplyByTurn.get(turn.id);
		return end ? [{ turn, end }] : [];
	});
	const locateTurn = (message: MatterMessageDto) => {
		const source = message.metadata?.sourceUserMessageId;
		if (typeof source === "string") return turnsById.has(source) ? source : undefined;
		if (source === null) return undefined;
		const matching = legacyWindows.filter(
			({ turn, end }) => turn.createdAt <= message.createdAt && message.createdAt <= end,
		);
		if (matching.length > 0) return matching.length === 1 ? matching[0]?.turn.id : undefined;
		const turn = legacyTurns.findLast((candidate) => candidate.createdAt <= message.createdAt);
		// A known terminal reply before this event rules out the nearest older round.
		return turn && !lastReplyByTurn.has(turn.id) ? turn.id : undefined;
	};

	const byTurn = new Map<string, DelegationBoard>();
	const history: DelegationBoard = { assignments: [], posts: [] };
	const scopes = new Map<string, { board: DelegationBoard; assignment: DelegationAssignment }>();
	const answers = new Map<string, MatterMessageDto>();
	for (const message of internalMessages) {
		const requestId = message.metadata?.requestMessageId;
		if (typeof requestId === "string") answers.set(requestId, message);
	}
	const assignments: DelegationAssignment[] = [];
	for (const message of internalMessages) {
		if (typeof message.metadata?.requestMessageId === "string") continue;
		const targetLabel = message.content.match(/^@([^:\n：]+)[:：]/)?.[1]?.trim() ?? "";
		const answer = answers.get(message.id);
		const target = message.metadata?.toMemberId;
		const toMemberId = typeof target === "string" ? target : (answer?.senderId ?? "");
		const turnId = locateTurn(message);
		let board = history;
		if (turnId) {
			board = byTurn.get(turnId) ?? { assignments: [], posts: [] };
			byTurn.set(turnId, board);
		}
		const parent = message.metadata?.parentRequestMessageId;
		const actualAssignment = Boolean(toMemberId || targetLabel);
		const number = message.metadata?.delegationNumber;
		const assignment: DelegationAssignment = {
			id: message.id,
			number: turnId && typeof number === "number" ? number : board.assignments.length + 1,
			fromMemberId: message.senderId,
			toMemberId,
			targetLabel,
			parentRequestMessageId: typeof parent === "string" ? parent : undefined,
			status: answer
				? answer.metadata?.failed || answer.senderType === "system"
					? "failed"
					: "completed"
				: actualAssignment
					? turnId && turnId === activeTurnId
						? "running"
						: "failed"
					: message.senderType === "system"
						? "failed"
						: "completed",
		};
		board.assignments.push(assignment);
		assignments.push(assignment);
		scopes.set(message.id, { board, assignment });
	}
	for (const message of internalMessages) {
		const requestId = message.metadata?.requestMessageId;
		const scope = scopes.get(typeof requestId === "string" ? requestId : message.id);
		if (scope) {
			scope.board.posts.push({
				message,
				assignment: scope.assignment,
				kind:
					typeof requestId === "string"
						? message.metadata?.failed || message.senderType === "system"
							? "failure"
							: "reply"
						: "assignment",
			});
		}
	}
	return { byTurn, history, assignments };
}

export interface DelegationEdge {
	id: string;
	number?: number;
	parentId?: string;
	from: string;
	to: string;
	status: DelegationAssignment["status"];
	stageLabel?: string;
	observer?: boolean;
}

/** Keep call IDs distinct when the same pair of roles collaborates more than once. */
export function liveDelegationEdges(
	entries: ActiveDelegationDto[],
	status: DelegationEdge["status"] = "running",
): DelegationEdge[] {
	return entries.map((entry, index) => ({
		id: entry.requestMessageId ?? `${entry.kind ?? "legacy"}:${entry.memberId}:${index}`,
		number: entry.delegationNumber,
		parentId: entry.parentRequestMessageId,
		from: entry.fromMemberName ?? "",
		to: entry.memberName,
		status,
		stageLabel: entry.stageLabel,
		observer: entry.kind === "observer",
	}));
}
