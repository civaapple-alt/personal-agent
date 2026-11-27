export type BoardRole = "coordinator" | "builder" | "verifier";

export type BoardMemberStatus = "idle" | "working" | "waiting" | "blocked_human" | "stopped" | "done";

export type BoardPostKind =
	| "assign"
	| "progress"
	| "handoff"
	| "verify_pass"
	| "verify_rework"
	| "escalate"
	| "clarification"
	| "summary";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelOverride {
	provider: string;
	model: string;
	thinkingLevel?: ThinkingLevel;
}

export interface BoardMemberRecord {
	agentId: string;
	boardRole: BoardRole;
	displayName: string;
	sourceMemberId?: string;
	brief: string;
	skills: string[];
	ownedScope: string[];
	acceptanceCriteria?: string;
	modelOverride?: ModelOverride;
	status: BoardMemberStatus;
	lastReadPostNo: number;
	activePostNo?: number;
	createdAt: string;
	updatedAt: string;
}

export interface BoardPostVerification {
	target: string;
	criteria?: string;
	verdict: "pass" | "rework" | "pending";
	authorAgentId?: string;
}

export interface BoardPostRecord {
	postNo: number;
	kind: BoardPostKind;
	authorType: "agent" | "user";
	authorId: string;
	mentions: string[];
	refPostNos: number[];
	summary: string;
	body?: string;
	artifacts?: Record<string, unknown>;
	verification?: BoardPostVerification;
	createdAt: string;
}

export interface BoardPostSummary {
	postNo: number;
	kind: BoardPostKind;
	authorType: "agent" | "user";
	authorId: string;
	mentions: string[];
	refPostNos: number[];
	summary: string;
	hasBody: boolean;
	createdAt: string;
}

export interface SpawnBoardAgentArgs {
	agentId: string;
	boardRole: "builder" | "verifier";
	displayName?: string;
	sourceMemberId?: string;
	brief: string;
	skills?: string[];
	ownedScope?: string[];
	acceptanceCriteria?: string;
	modelOverride?: ModelOverride;
}

export interface PostToBoardArgs {
	kind: BoardPostKind;
	mentions: string[];
	refPostNos?: number[];
	summary: string;
	body?: string;
	artifacts?: Record<string, unknown>;
	verification?: BoardPostVerification;
}

export interface ReadBoardPostArgs {
	postNo: number;
}

export interface LocalWorkerRequest {
	cwd: string;
	agentId: string;
	boardRole: BoardRole;
	readOnly: boolean;
	sessionFile: string;
	extensionEntryPath: string;
	prompt: string;
	modelOverride?: ModelOverride;
	env: Record<string, string>;
}

export interface LocalWorkerResult {
	assistantText: string;
}

export type LocalWorkerExecutor = (req: LocalWorkerRequest, signal?: AbortSignal) => Promise<LocalWorkerResult>;

export interface BoardUiContext {
	hasUI?: boolean;
	ui?: {
		select?(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined>;
		input?(title: string, placeholder?: string, opts?: { signal?: AbortSignal }): Promise<string | undefined>;
		notify?(message: string, level?: "info" | "warning" | "error"): void;
	};
}

export interface BoardToolResult {
	content: Array<{ type: "text"; text: string }>;
	details?: unknown;
}

export interface BoardExtensionApi {
	registerTool(definition: {
		name: string;
		label: string;
		description: string;
		promptSnippet?: string;
		promptGuidelines?: string[];
		parameters: Record<string, unknown>;
		execute(
			callId: string,
			args: Record<string, unknown>,
			signal?: AbortSignal,
			onUpdate?: unknown,
			ctx?: BoardUiContext,
		): Promise<BoardToolResult>;
	}): void;
	registerCommand?(
		name: string,
		definition: {
			description: string;
			handler(args: string, ctx?: BoardUiContext): Promise<string | undefined> | string | undefined;
		},
	): void;
	sendUserMessage?(content: string): void;
	on?(
		event: "tool_call",
		handler: (
			event: { toolName: string; toolCallId?: string; input: Record<string, unknown> },
			ctx?: { cwd?: string },
		) => Promise<{ block: true; reason: string } | undefined> | { block: true; reason: string } | undefined,
	): void;
}
