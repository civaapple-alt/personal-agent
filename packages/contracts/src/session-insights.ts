export type SessionInsightSeverity = "error" | "warn" | "info";

export type SessionInsightKind =
	| "failing_command"
	| "unused_skill"
	| "file_rework"
	| "repeated_tool_call"
	| "cost_outlier"
	| "unverified_claim"
	| "repeated_instruction"
	| "board_friction";

export interface SessionInsightBoardSignals {
	reworkCount: number;
	escalateCount: number;
	monitorAlertCount: number;
	mattersWithBoardFriction: number;
}

export interface SessionInsightFinding {
	id: string;
	kind: SessionInsightKind;
	severity: SessionInsightSeverity;
	title: string;
	detail: string;
	evidence?: string[];
	count?: number;
	/** True when the finding indicates a repeatable pattern worth capturing via `propose_skill`. */
	suggestSkillCapture?: boolean;
}

export interface SessionInsightModelUsage {
	model: string;
	costUsd: number;
	calls: number;
}

export interface SessionInsightToolUsage {
	tool: string;
	calls: number;
	errors: number;
}

export interface SessionInsightSessionSummary {
	sessionId: string;
	matterId?: string | null;
	memberId?: string | null;
	memberName?: string | null;
	title?: string;
	startedAt?: string;
	updatedAt?: string;
	turns: number;
	toolCalls: number;
	toolErrors: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
	models: string[];
}

export interface SessionInsightsReport {
	generatedAt: string;
	scope: {
		matterId?: string | null;
		memberId?: string | null;
		sessionCount: number;
	};
	usage: {
		sessions: number;
		turns: number;
		toolCalls: number;
		toolErrors: number;
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
		totalCostUsd: number;
		byModel: SessionInsightModelUsage[];
		byTool: SessionInsightToolUsage[];
	};
	findings: SessionInsightFinding[];
	recentSessions: SessionInsightSessionSummary[];
	boardSignals?: SessionInsightBoardSignals;
	privacyNote: string;
}
