import { type ChildProcess, spawn } from "node:child_process";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import type {
	AgentMessage,
	AssistantMessageDeltaEvent,
	ImageContent,
	PromptDisposition,
	QueuedInputDisposition,
	RpcCommand,
	RpcExtensionUIDialogRequest,
	RpcExtensionUINoticeRequest,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcExtensionUIResponsePayload,
	RpcModel,
	RpcResponse,
	RpcSessionEvent,
	RpcSessionState,
	ThinkingLevel,
} from "./types.ts";

export type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
export type RpcCommandBody = DistributiveOmit<RpcCommand, "id">;

export type ExtensionUiDialogHandler = (
	request: RpcExtensionUIDialogRequest,
) => Promise<RpcExtensionUIResponsePayload> | RpcExtensionUIResponsePayload;

export type ExtensionUiNoticeListener = (notice: RpcExtensionUINoticeRequest) => void;
export type SessionEventListener = (event: RpcSessionEvent) => void;

export interface PiRpcWorkerOptions {
	/** CLI binary name or path (defaults to `"pi"`). */
	executable?: string;
	/** Arguments prepended before `--mode rpc` (useful for script runners or tests). */
	leadingArgs?: string[];
	/** Working directory for the worker (defaults to `process.cwd()`). */
	cwd?: string;
	/** Extra environment variables merged over `process.env`. */
	env?: Record<string, string | undefined>;
	/** Provider passed via `--provider` (e.g. `"kimi-coding"`). */
	provider?: string;
	/** Model ID passed via `--model` (e.g. `"kimi-for-coding"`). */
	model?: string;
	/** Disable persisted session files (`--no-session`). */
	noSession?: boolean;
	/** Explicit session storage directory (`--session-dir`). */
	sessionDir?: string;
	/** Exact Pi session file to reopen. Never use --continue across matters. */
	sessionFile?: string;
	/** Additional CLI flags appended after standard RPC options. */
	args?: string[];
	/** Timeout for individual RPC command responses in milliseconds (default: 30000). */
	commandTimeoutMs?: number;
	/** Default graceful shutdown wait before SIGTERM/SIGKILL in milliseconds (default: 2000). */
	shutdownGraceMs?: number;
	/** Optional interactive handler for blocking Extension UI dialogs. */
	onDialog?: ExtensionUiDialogHandler;
}

export interface ToolExecutionRecord {
	toolCallId: string;
	toolName: string;
	args: unknown;
	result?: unknown;
	isError: boolean;
	durationMs?: number;
}

export interface DialogInteractionRecord {
	request: RpcExtensionUIDialogRequest;
	response: RpcExtensionUIResponsePayload;
}

export interface PromptRunResult {
	disposition: PromptDisposition;
	aborted: boolean;
	assistantText: string;
	assistantMessages: AgentMessage[];
	toolExecutions: ToolExecutionRecord[];
	notices: RpcExtensionUINoticeRequest[];
	dialogs: DialogInteractionRecord[];
	events: RpcSessionEvent[];
}

export interface RunPromptOptions {
	signal?: AbortSignal;
	images?: ImageContent[];
	streamingBehavior?: "steer" | "followUp";
	/**
	 * Hard overall timeout for `agent_settled` in milliseconds.
	 * Use `0` to disable the wall-clock cutoff (default: `PA_PROMPT_TIMEOUT_MS` or `0`).
	 */
	timeoutMs?: number;
	/**
	 * Inactivity timeout with no RPC events or notices in milliseconds.
	 * Use `0` to disable (default: `PA_IDLE_TIMEOUT_MS` or `900000` = 15 min, capped by positive `timeoutMs`).
	 */
	idleTimeoutMs?: number;
	/** Optional per-run streaming delta callback. */
	onTextDelta?: (delta: string) => void;
}

const DIALOG_METHODS = new Set<RpcExtensionUIDialogRequest["method"]>(["select", "confirm", "input", "editor"]);

function isDialogRequest(request: RpcExtensionUIRequest): request is RpcExtensionUIDialogRequest {
	return DIALOG_METHODS.has(request.method as RpcExtensionUIDialogRequest["method"]);
}

export function extractMessageText(message: AgentMessage): string {
	if (typeof message.content === "string") {
		return message.content;
	}
	if (!Array.isArray(message.content)) {
		return "";
	}
	return message.content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text ?? "")
		.join("");
}

/**
 * Process-isolated worker wrapping `pi --mode rpc` over strict LF-delimited JSONL.
 *
 * Bridges the gap between Pi's standard `RpcClient` and Personal Agent's dual-track
 * requirements: non-blocking UI notices are routed to observers, while blocking
 * `extension_ui_request` dialogs can be resolved asynchronously and written back
 * as `extension_ui_response` records on stdin.
 */
export class PiRpcWorker {
	private readonly options: PiRpcWorkerOptions;
	private readonly eventListeners = new Set<SessionEventListener>();
	private readonly noticeListeners = new Set<ExtensionUiNoticeListener>();
	private readonly idleStateListeners = new Set<() => void>();
	private readonly pendingRequests = new Map<
		string,
		{ resolve: (response: RpcResponse) => void; reject: (error: Error) => void }
	>();

	private child: ChildProcess | null = null;
	private stopping: Promise<void> | undefined;
	private stopReadingStdout: (() => void) | null = null;
	private requestSeq = 0;
	private stderrBuffer = "";
	private terminalError: Error | null = null;
	private externalIdleSuspendCount = 0;
	private dialogHandler: ExtensionUiDialogHandler | undefined;

	constructor(options: PiRpcWorkerOptions = {}) {
		this.options = options;
		this.dialogHandler = options.onDialog;
	}

	get isRunning(): boolean {
		return this.child !== null && this.child.exitCode === null && this.terminalError === null;
	}

	getStderr(): string {
		return this.stderrBuffer;
	}

	setDialogHandler(handler: ExtensionUiDialogHandler | undefined): void {
		this.dialogHandler = handler;
	}

	/**
	 * Temporarily suspend the inactivity watchdog while the host awaits an external
	 * operation (e.g. a delegated colleague worker) that keeps Pi blocked on a bridge tool.
	 * The overall turn `timeoutMs` remains active.
	 */
	suspendIdleTimeout(): () => void {
		this.externalIdleSuspendCount += 1;
		for (const listener of this.idleStateListeners) listener();
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.externalIdleSuspendCount = Math.max(0, this.externalIdleSuspendCount - 1);
			for (const listener of this.idleStateListeners) listener();
		};
	}

	onEvent(listener: SessionEventListener): () => void {
		this.eventListeners.add(listener);
		return () => {
			this.eventListeners.delete(listener);
		};
	}

	onNotice(listener: ExtensionUiNoticeListener): () => void {
		this.noticeListeners.add(listener);
		return () => {
			this.noticeListeners.delete(listener);
		};
	}

	async start(): Promise<void> {
		if (this.child) {
			throw new Error("PiRpcWorker is already started");
		}

		this.stopping = undefined;
		this.terminalError = null;
		this.stderrBuffer = "";

		const executable = this.options.executable ?? "pi";
		const args: string[] = [...(this.options.leadingArgs ?? []), "--mode", "rpc"];

		if (this.options.noSession) {
			args.push("--no-session");
		}
		if (this.options.sessionDir) {
			args.push("--session-dir", this.options.sessionDir);
		}
		if (this.options.sessionFile) {
			args.push("--session", this.options.sessionFile);
		}
		if (this.options.provider) {
			args.push("--provider", this.options.provider);
		}
		if (this.options.model) {
			args.push("--model", this.options.model);
		}
		if (this.options.args) {
			args.push(...this.options.args);
		}

		const child = spawn(executable, args, {
			cwd: this.options.cwd ?? process.cwd(),
			env: this.options.env ? { ...process.env, ...this.options.env } : process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});

		this.child = child;

		child.stderr?.on("data", (chunk: Buffer | string) => {
			this.stderrBuffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
			// Keep stderr bounded to avoid unbounded growth in long-lived workers.
			if (this.stderrBuffer.length > 65536) {
				this.stderrBuffer = this.stderrBuffer.slice(-32768);
			}
		});

		if (child.stdout) {
			this.stopReadingStdout = attachJsonlLineReader(child.stdout, (line) => {
				this.handleStdoutLine(line);
			});
		}

		await new Promise<void>((resolve, reject) => {
			let settled = false;

			const onSpawn = () => {
				if (settled) return;
				settled = true;
				cleanupStartupListeners();
				resolve();
			};

			const onError = (error: Error) => {
				const wrapped = new Error(`Failed to start Pi RPC worker (${executable}): ${error.message}`);
				this.terminalError = wrapped;
				this.rejectAllPending(wrapped);
				if (!settled) {
					settled = true;
					cleanupStartupListeners();
					this.child = null;
					reject(wrapped);
				}
			};

			const onEarlyExit = (code: number | null, signal: NodeJS.Signals | null) => {
				const error = this.buildExitError(code, signal);
				this.terminalError = error;
				this.rejectAllPending(error);
				if (!settled) {
					settled = true;
					cleanupStartupListeners();
					this.child = null;
					reject(error);
				}
			};

			const cleanupStartupListeners = () => {
				child.off("spawn", onSpawn);
				child.off("error", onError);
				child.off("exit", onEarlyExit);
			};

			child.once("spawn", onSpawn);
			child.once("error", onError);
			child.once("exit", onEarlyExit);
		});

		// Install persistent lifecycle handlers after startup completes.
		child.once("exit", (code, signal) => {
			if (this.child !== child) return;
			const error = this.buildExitError(code, signal);
			this.terminalError = error;
			this.rejectAllPending(error);
		});

		child.once("error", (error) => {
			if (this.child !== child) return;
			const processError = new Error(`Pi RPC worker error: ${error.message}. Stderr: ${this.stderrBuffer}`);
			this.terminalError = processError;
			this.rejectAllPending(processError);
		});

		child.stdin?.on("error", (error) => {
			if (this.child !== child) return;
			const stdinError =
				this.terminalError ??
				new Error(`Pi RPC worker stdin error: ${error.message}. Stderr: ${this.stderrBuffer}`);
			this.terminalError = stdinError;
			this.rejectAllPending(stdinError);
		});
	}

	/**
	 * Request an orderly shutdown via stdin EOF, falling back to SIGTERM then SIGKILL.
	 */
	stop(): Promise<void> {
		this.stopping ??= this.stopProcess();
		return this.stopping;
	}

	private async stopProcess(): Promise<void> {
		const child = this.child;
		if (!child) return;

		const graceMs = this.options.shutdownGraceMs ?? 2000;

		if (child.exitCode === null) {
			await new Promise<void>((resolve) => {
				let finished = false;
				let termTimer: NodeJS.Timeout | undefined;
				let killTimer: NodeJS.Timeout | undefined;

				const done = () => {
					if (finished) return;
					finished = true;
					if (termTimer) clearTimeout(termTimer);
					if (killTimer) clearTimeout(killTimer);
					resolve();
				};

				child.once("exit", done);

				try {
					if (child.stdin && !child.stdin.destroyed && child.stdin.writable) {
						child.stdin.end();
					} else {
						child.kill("SIGTERM");
					}
				} catch {
					child.kill("SIGTERM");
				}

				termTimer = setTimeout(() => {
					if (child.exitCode === null) {
						child.kill("SIGTERM");
					}
					killTimer = setTimeout(() => {
						if (child.exitCode === null) {
							child.kill("SIGKILL");
						}
						done();
					}, 1000);
				}, graceMs);
			});
		}

		this.stopReadingStdout?.();
		this.stopReadingStdout = null;
		this.child = null;
		this.pendingRequests.clear();
	}

	async getState(): Promise<RpcSessionState> {
		const response = await this.sendCommand({ type: "get_state" });
		return this.unwrapData<RpcSessionState>(response);
	}

	async getAvailableModels(): Promise<RpcModel[]> {
		const response = await this.sendCommand({ type: "get_available_models" });
		return this.unwrapData<{ models: RpcModel[] }>(response).models;
	}

	async setModel(provider: string, modelId: string): Promise<RpcModel> {
		const response = await this.sendCommand({ type: "set_model", provider, modelId });
		return this.unwrapData<RpcModel>(response);
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		const response = await this.sendCommand({ type: "set_thinking_level", level });
		this.unwrapData(response);
	}

	async getLastAssistantText(): Promise<string | null> {
		const response = await this.sendCommand({ type: "get_last_assistant_text" });
		return this.unwrapData<{ text: string | null }>(response).text;
	}

	async prompt(
		message: string,
		images?: ImageContent[],
		streamingBehavior?: "steer" | "followUp",
	): Promise<PromptDisposition> {
		const response = await this.sendCommand({ type: "prompt", message, images, streamingBehavior });
		return this.unwrapData<{ disposition: PromptDisposition }>(response).disposition;
	}

	async steer(message: string, images?: ImageContent[]): Promise<QueuedInputDisposition> {
		const response = await this.sendCommand({ type: "steer", message, images });
		return this.unwrapData<{ disposition: QueuedInputDisposition }>(response).disposition;
	}

	async followUp(message: string, images?: ImageContent[]): Promise<QueuedInputDisposition> {
		const response = await this.sendCommand({ type: "follow_up", message, images });
		return this.unwrapData<{ disposition: QueuedInputDisposition }>(response).disposition;
	}

	async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
		const response = await this.sendCommand({ type: "clear_queue" });
		return this.unwrapData(response);
	}

	async abort(): Promise<void> {
		const response = await this.sendCommand({ type: "abort" });
		this.unwrapData(response);
	}

	/**
	 * Send a prompt, handle extension UI requests, and wait until `agent_settled`.
	 * If the prompt returns `disposition: "handled"`, returns immediately without
	 * waiting for `agent_settled` as required by the Pi RPC specification.
	 */
	async runPromptAndWait(message: string, options: RunPromptOptions = {}): Promise<PromptRunResult> {
		options.signal?.throwIfAborted();
		const parseNonNegativeMs = (raw: string | undefined, fallback: number): number => {
			if (raw === undefined || raw.trim() === "") return fallback;
			const parsed = Number(raw);
			return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
		};
		const timeoutMs =
			options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs >= 0
				? options.timeoutMs
				: parseNonNegativeMs(process.env.PA_PROMPT_TIMEOUT_MS, 0);
		const configuredIdleMs =
			options.idleTimeoutMs !== undefined && Number.isFinite(options.idleTimeoutMs) && options.idleTimeoutMs >= 0
				? options.idleTimeoutMs
				: parseNonNegativeMs(process.env.PA_IDLE_TIMEOUT_MS, 900_000);
		const idleTimeoutMs = timeoutMs > 0 ? Math.min(timeoutMs, configuredIdleMs) : configuredIdleMs;
		const events: RpcSessionEvent[] = [];
		const notices: RpcExtensionUINoticeRequest[] = [];
		const dialogs: DialogInteractionRecord[] = [];
		const assistantMessages: AgentMessage[] = [];
		const activeTools = new Map<string, ToolExecutionRecord>();
		const toolExecutions: ToolExecutionRecord[] = [];

		let resolveSettled!: (aborted: boolean) => void;
		let rejectSettled!: (error: Error) => void;
		let settledDone = false;
		const settledPromise = new Promise<boolean>((resolve, reject) => {
			resolveSettled = (aborted) => {
				if (settledDone) return;
				settledDone = true;
				resolve(aborted);
			};
			rejectSettled = (err) => {
				if (settledDone) return;
				settledDone = true;
				reject(err);
			};
		});
		// Prevent unhandled rejection if `prompt()` rejects before `settledPromise` is awaited.
		settledPromise.catch(() => {});

		let hardTimer: NodeJS.Timeout | undefined;
		let idleTimer: NodeJS.Timeout | undefined;
		let inDialog = false;

		const resetIdleTimer = () => {
			if (idleTimer) clearTimeout(idleTimer);
			idleTimer = undefined;
			if (
				settledDone ||
				inDialog ||
				this.externalIdleSuspendCount > 0 ||
				idleTimeoutMs <= 0 ||
				(timeoutMs > 0 && idleTimeoutMs >= timeoutMs)
			) {
				return;
			}
			idleTimer = setTimeout(() => {
				rejectSettled(new Error(`Timed out after ${idleTimeoutMs}ms of inactivity waiting for agent_settled`));
			}, idleTimeoutMs);
		};

		this.idleStateListeners.add(resetIdleTimer);
		if (timeoutMs > 0) {
			hardTimer = setTimeout(() => {
				rejectSettled(new Error(`Timed out after ${timeoutMs}ms waiting for agent_settled`));
			}, timeoutMs);
		}
		resetIdleTimer();

		const offEvent = this.onEvent((event) => {
			events.push(event);
			resetIdleTimer();

			if (
				event.type === "message_update" &&
				event.assistantMessageEvent &&
				typeof event.assistantMessageEvent === "object"
			) {
				const deltaEvent = event.assistantMessageEvent as AssistantMessageDeltaEvent;
				if (deltaEvent.type === "text_delta" && typeof deltaEvent.delta === "string") {
					options.onTextDelta?.(deltaEvent.delta);
				}
			} else if (event.type === "message_end" && event.message) {
				const msg = event.message as AgentMessage;
				if (msg.role === "assistant") {
					assistantMessages.push(msg);
				}
			} else if (event.type === "tool_execution_start") {
				const rec: ToolExecutionRecord = {
					toolCallId: String(event.toolCallId),
					toolName: String(event.toolName),
					args: event.args,
					isError: false,
				};
				activeTools.set(rec.toolCallId, rec);
				toolExecutions.push(rec);
			} else if (event.type === "tool_execution_end") {
				const id = String(event.toolCallId);
				const rec = activeTools.get(id);
				if (rec) {
					rec.result = event.result;
					rec.isError = Boolean(event.isError);
					if (typeof event.durationMs === "number") {
						rec.durationMs = event.durationMs;
					}
					activeTools.delete(id);
				}
			} else if (event.type === "agent_settled") {
				resolveSettled(Boolean(event.aborted));
			}
		});

		const offNotice = this.onNotice((notice) => {
			notices.push(notice);
			resetIdleTimer();
		});

		const previousHandler = this.dialogHandler;
		if (previousHandler) {
			this.dialogHandler = async (request) => {
				inDialog = true;
				if (idleTimer) clearTimeout(idleTimer);
				try {
					const response = await previousHandler(request);
					dialogs.push({ request, response });
					return response;
				} finally {
					inDialog = false;
					resetIdleTimer();
				}
			};
		}

		const onAbort = () => rejectSettled(new Error("Prompt cancelled", { cause: options.signal?.reason }));
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.signal?.aborted) onAbort();

		// Monitor unexpected child exit while waiting for agent_settled.
		const child = this.child;
		const onChildExit = (code: number | null, signal: NodeJS.Signals | null) => {
			rejectSettled(this.buildExitError(code, signal));
		};
		child?.once("exit", onChildExit);

		try {
			const disposition = await this.prompt(message, options.images, options.streamingBehavior);
			if (disposition === "handled") {
				return {
					disposition,
					aborted: false,
					assistantText: "",
					assistantMessages,
					toolExecutions,
					notices,
					dialogs,
					events,
				};
			}

			const aborted = await settledPromise;
			const lastMessage = assistantMessages.at(-1);
			if (!aborted && lastMessage?.stopReason === "error") {
				throw new Error(`Pi model failed: ${String(lastMessage.errorMessage ?? "unknown provider error")}`);
			}
			const nonEmptyText = [...assistantMessages]
				.reverse()
				.map((msg) => extractMessageText(msg))
				.find((txt) => txt.trim().length > 0);
			return {
				disposition,
				aborted,
				assistantText: nonEmptyText ?? "",
				assistantMessages,
				toolExecutions,
				notices,
				dialogs,
				events,
			};
		} finally {
			settledDone = true;
			this.idleStateListeners.delete(resetIdleTimer);
			options.signal?.removeEventListener("abort", onAbort);
			if (hardTimer) clearTimeout(hardTimer);
			if (idleTimer) clearTimeout(idleTimer);
			offEvent();
			offNotice();
			child?.off("exit", onChildExit);
			if (previousHandler) {
				this.dialogHandler = previousHandler;
			}
		}
	}

	sendExtensionUiResponse(id: string, payload: RpcExtensionUIResponsePayload): void {
		const fullResponse: RpcExtensionUIResponse = {
			type: "extension_ui_response",
			id,
			...payload,
		};
		this.writeLine(fullResponse);
	}

	private handleStdoutLine(line: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return;
		}

		if (!parsed || typeof parsed !== "object") {
			return;
		}

		const record = parsed as Record<string, unknown>;

		if (record.type === "response") {
			const id = typeof record.id === "string" ? record.id : undefined;
			if (id && this.pendingRequests.has(id)) {
				const pending = this.pendingRequests.get(id)!;
				this.pendingRequests.delete(id);
				pending.resolve(record as RpcResponse);
			}
			return;
		}

		if (record.type === "extension_ui_request") {
			const request = record as unknown as RpcExtensionUIRequest;
			if (isDialogRequest(request)) {
				void this.handleDialogRequest(request);
			} else {
				for (const listener of [...this.noticeListeners]) {
					listener(request);
				}
			}
			return;
		}

		for (const listener of [...this.eventListeners]) {
			listener(record as RpcSessionEvent);
		}
	}

	private async handleDialogRequest(request: RpcExtensionUIDialogRequest): Promise<void> {
		if (!this.dialogHandler) {
			this.safeSendUiResponse(request.id, { cancelled: true });
			return;
		}

		try {
			const payload = await this.dialogHandler(request);
			this.safeSendUiResponse(request.id, payload);
		} catch {
			this.safeSendUiResponse(request.id, { cancelled: true });
		}
	}

	private safeSendUiResponse(id: string, payload: RpcExtensionUIResponsePayload): void {
		if (!this.child || this.child.exitCode !== null || !this.child.stdin || this.child.stdin.destroyed) {
			return;
		}
		this.sendExtensionUiResponse(id, payload);
	}

	private sendCommand(command: RpcCommandBody): Promise<RpcResponse> {
		const child = this.child;
		const stdin = child?.stdin;
		if (!child || !stdin) {
			return Promise.reject(new Error("PiRpcWorker is not started"));
		}
		if (this.terminalError) {
			return Promise.reject(this.terminalError);
		}
		if (child.exitCode !== null) {
			const err = this.buildExitError(child.exitCode, child.signalCode);
			this.terminalError = err;
			return Promise.reject(err);
		}
		if (stdin.destroyed || !stdin.writable) {
			const err = new Error(`Pi RPC worker stdin is not writable. Stderr: ${this.stderrBuffer}`);
			this.terminalError = err;
			return Promise.reject(err);
		}

		const id = `req_${++this.requestSeq}`;
		const fullCommand = { ...command, id } as RpcCommand;
		const timeoutMs = this.options.commandTimeoutMs ?? 30_000;

		return new Promise<RpcResponse>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`Timeout after ${timeoutMs}ms waiting for ${command.type}. Stderr: ${this.stderrBuffer}`));
			}, timeoutMs);

			this.pendingRequests.set(id, {
				resolve: (response) => {
					clearTimeout(timeout);
					resolve(response);
				},
				reject: (error) => {
					clearTimeout(timeout);
					reject(error);
				},
			});

			try {
				this.writeLine(fullCommand);
			} catch (error: unknown) {
				clearTimeout(timeout);
				this.pendingRequests.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	private writeLine(payload: unknown): void {
		const stdin = this.child?.stdin;
		if (!stdin || stdin.destroyed || !stdin.writable) {
			throw new Error("Cannot write to Pi RPC worker stdin");
		}
		stdin.write(serializeJsonLine(payload));
	}

	private unwrapData<T>(response: RpcResponse): T {
		if (!response.success) {
			throw new Error(response.error);
		}
		return response.data as T;
	}

	private buildExitError(code: number | null, signal: NodeJS.Signals | null): Error {
		return new Error(`Pi RPC worker exited (code=${code}, signal=${signal}). Stderr: ${this.stderrBuffer}`);
	}

	private rejectAllPending(error: Error): void {
		for (const pending of this.pendingRequests.values()) {
			pending.reject(error);
		}
		this.pendingRequests.clear();
	}
}
