export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type PromptDisposition = "started" | "queued" | "handled";
export type QueuedInputDisposition = "queued" | "handled";

export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export interface RpcModel {
	id: string;
	name?: string;
	api?: string;
	provider: string;
	baseUrl?: string;
	reasoning?: boolean;
	thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
}

export interface RpcSessionState {
	model?: RpcModel;
	thinkingLevel: ThinkingLevel;
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	messageCount: number;
	pendingMessageCount: number;
}

export type RpcCommand =
	| { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "clear_queue" }
	| { id?: string; type: "new_session"; parentSession?: string }
	| { id?: string; type: "get_state" }
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "cycle_model" }
	| { id?: string; type: "get_available_models" }
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "cycle_thinking_level" }
	| { id?: string; type: "get_available_thinking_levels" }
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }
	| { id?: string; type: "bash"; command: string; excludeFromContext?: boolean }
	| { id?: string; type: "abort_bash" }
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "fork"; entryId: string }
	| { id?: string; type: "clone" }
	| { id?: string; type: "get_fork_messages" }
	| { id?: string; type: "get_entries"; since?: string }
	| { id?: string; type: "get_tree" }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "set_session_name"; name: string }
	| { id?: string; type: "get_messages" }
	| { id?: string; type: "get_commands" };

export type RpcResponse =
	| { id?: string; type: "response"; command: string; success: true; data?: unknown }
	| { id?: string; type: "response"; command: string; success: false; error: string };

export type RpcExtensionUIDialogRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string };

export type RpcExtensionUINoticeRequest =
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

export type RpcExtensionUIRequest = RpcExtensionUIDialogRequest | RpcExtensionUINoticeRequest;

export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true };

export type RpcExtensionUIResponsePayload = { value: string } | { confirmed: boolean } | { cancelled: true };

export interface AssistantContentBlock {
	type: string;
	text?: string;
	thinking?: string;
	[key: string]: unknown;
}

export interface AgentMessage {
	role: string;
	content: string | AssistantContentBlock[];
	stopReason?: string;
	errorMessage?: string;
	timestamp?: number;
	[key: string]: unknown;
}

export interface AssistantMessageDeltaEvent {
	type: string;
	contentIndex?: number;
	delta?: string;
	content?: string;
	reason?: string;
	error?: unknown;
	[key: string]: unknown;
}

export type RpcSessionEvent =
	| { type: "agent_start" }
	| { type: "agent_end"; messages?: AgentMessage[]; willRetry?: boolean }
	| { type: "agent_settled"; aborted?: boolean }
	| { type: "turn_start" }
	| { type: "turn_end"; message?: AgentMessage; toolResults?: unknown[] }
	| { type: "message_start"; message: AgentMessage }
	| { type: "message_update"; usage?: Record<string, unknown>; assistantMessageEvent: AssistantMessageDeltaEvent }
	| { type: "message_end"; message: AgentMessage }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: unknown;
			isError?: boolean;
			durationMs?: number;
	  }
	| { type: "bash_execution_update"; id?: string; [key: string]: unknown }
	| { type: string; [key: string]: unknown };
