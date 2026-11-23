import { isVerificationVerdict, type VerificationVerdict } from "../../../src/rpc/team-verification.ts";
import type { ActiveDelegationDto, MatterMessageDto } from "../api/matters.ts";

export interface DelegationAssignment {
	id: string;
	number: number;
	fromMemberId: string;
	toMemberId: string;
	targetLabel: string;
	parentRequestMessageId?: string;
	verification?: {
		reference: string;
		digest: string;
		kind: "commit" | "file" | "draft";
		assignmentId?: string;
		criteria?: string;
		verdict?: VerificationVerdict;
	};
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

/** Project stored handoffs into conversation rounds using explicit turn references. */
export function buildMatterDelegations(
	userMessages: MatterMessageDto[],
	internalMessages: MatterMessageDto[],
	activeTurnId?: string,
): MatterDelegations {
	const turns = userMessages.filter((message) => message.senderType === "user");
	const turnsById = new Map(turns.map((message) => [message.id, message]));
	const locateTurn = (message: MatterMessageDto) => {
		const source = message.metadata?.sourceUserMessageId;
		return typeof source === "string" && turnsById.has(source) ? source : undefined;
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
		const verification = readVerification(message.metadata?.verification, answer?.metadata?.verification);
		const actualAssignment = Boolean(toMemberId || targetLabel);
		const number = message.metadata?.delegationNumber;
		const assignment: DelegationAssignment = {
			id: message.id,
			number: turnId && typeof number === "number" ? number : board.assignments.length + 1,
			fromMemberId: message.senderId,
			toMemberId,
			targetLabel,
			parentRequestMessageId: typeof parent === "string" ? parent : undefined,
			verification,
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

function readVerification(raw: unknown, outcome: unknown): DelegationAssignment["verification"] {
	if (!raw || typeof raw !== "object" || !("target" in raw) || !raw.target || typeof raw.target !== "object") return;
	if (!("kind" in raw.target) || !("reference" in raw.target) || !("digest" in raw.target)) return;
	const { kind, reference, digest } = raw.target;
	if (
		(kind !== "commit" && kind !== "file" && kind !== "draft") ||
		typeof reference !== "string" ||
		typeof digest !== "string"
	)
		return;
	return {
		kind,
		reference,
		digest,
		assignmentId:
			"sourceAssignmentId" in raw && typeof raw.sourceAssignmentId === "string" ? raw.sourceAssignmentId : undefined,
		criteria: "criteria" in raw && typeof raw.criteria === "string" ? raw.criteria : undefined,
		verdict:
			outcome && typeof outcome === "object" && "verdict" in outcome && isVerificationVerdict(outcome.verdict)
				? outcome.verdict
				: undefined,
	};
}

export type BoardFilter = "all" | "verification" | `member:${string}` | `branch:${string}`;

export function filterDelegationBoard(assignments: DelegationAssignment[], filter: BoardFilter) {
	if (filter === "all") return assignments;
	if (filter === "verification") return assignments.filter((assignment) => assignment.verification);
	if (filter.startsWith("member:")) {
		const member = filter.slice("member:".length);
		return assignments.filter(({ fromMemberId, toMemberId }) => fromMemberId === member || toMemberId === member);
	}
	const rootId = filter.slice("branch:".length);
	const parents = new Map(
		assignments.map((assignment) => [
			assignment.id,
			assignment.parentRequestMessageId ?? assignment.verification?.assignmentId,
		]),
	);
	return assignments.filter((assignment) => {
		const seen = new Set<string>();
		for (let id: string | undefined = assignment.id; id && !seen.has(id); id = parents.get(id)) {
			if (id === rootId) return true;
			seen.add(id);
		}
		return false;
	});
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
	verification?: boolean;
	verdict?: VerificationVerdict;
}

/** Keep call IDs distinct when the same pair of roles collaborates more than once. */
export function liveDelegationEdges(
	entries: ActiveDelegationDto[],
	status: DelegationEdge["status"] = "running",
): DelegationEdge[] {
	return entries.map((entry, index) => ({
		id: entry.requestMessageId ?? `${entry.kind ?? "delegation"}:${entry.memberId}:${index}`,
		number: entry.delegationNumber,
		parentId: entry.parentRequestMessageId,
		from: entry.fromMemberName ?? "",
		to: entry.memberName,
		status,
		stageLabel: entry.stageLabel,
		observer: entry.kind === "observer",
		verification: entry.verification,
	}));
}
