import { spawn } from "node:child_process";

export type WorkerThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface WorkerModelOverride {
	provider: string;
	model: string;
	thinkingLevel?: WorkerThinkingLevel;
}

export interface SharedPiWorkerRequest {
	cwd: string;
	readOnly: boolean;
	sessionFile: string;
	prompt: string;
	extraTools?: string[];
	extensionEntries?: string[];
	modelOverride?: WorkerModelOverride;
	env: Record<string, string>;
}

export interface SharedPiWorkerResult {
	assistantText: string;
}

export function buildSharedWorkerTools(readOnly: boolean, extraTools: string[] = []): string[] {
	const shellTool = process.platform === "win32" ? "powershell" : "bash";
	const base = readOnly
		? ["read", "grep", "find", "ls", shellTool]
		: ["read", "grep", "find", "ls", shellTool, "edit", "write"];
	return Array.from(new Set([...base, ...extraTools.map((t) => t.trim()).filter(Boolean)]));
}

export function buildSharedWorkerPiArgs(req: SharedPiWorkerRequest): string[] {
	const tools = buildSharedWorkerTools(req.readOnly, req.extraTools).join(",");
	const args = ["--mode", "rpc", "--session", req.sessionFile, "--tools", tools];
	for (const entry of req.extensionEntries ?? []) {
		if (entry.trim()) {
			args.push("--extension", entry);
		}
	}
	if (req.readOnly) {
		args.push("--exclude-tools", "edit,write");
	}
	if (req.modelOverride?.provider) {
		args.push("--provider", req.modelOverride.provider);
	}
	if (req.modelOverride?.model) {
		args.push("--model", req.modelOverride.model);
	}
	if (req.modelOverride?.thinkingLevel) {
		args.push("--thinking", req.modelOverride.thinkingLevel);
	}
	return args;
}

function extractTextFromAgentMessages(messages: unknown): string {
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const msg = messages[i];
		if (!msg || typeof msg !== "object") continue;
		const rec = msg as Record<string, unknown>;
		if (rec.role !== "assistant") continue;
		const content = rec.content;
		if (typeof content === "string" && content.trim()) return content.trim();
		if (Array.isArray(content)) {
			const parts = content
				.filter((part): part is Record<string, unknown> => Boolean(part && typeof part === "object"))
				.filter((part) => part.type === "text" && typeof part.text === "string")
				.map((part) => part.text as string);
			if (parts.length > 0) return parts.join("").trim();
		}
	}
	return "";
}

export async function runSharedPiRpcWorker(
	req: SharedPiWorkerRequest,
	signal?: AbortSignal,
): Promise<SharedPiWorkerResult> {
	signal?.throwIfAborted();
	const executable = req.env.PA_PI_BIN?.trim() || process.env.PA_PI_BIN?.trim() || "pi";
	const args = buildSharedWorkerPiArgs(req);

	return await new Promise<SharedPiWorkerResult>((resolve, reject) => {
		const child = spawn(executable, args, {
			cwd: req.cwd,
			env: { ...process.env, ...req.env },
			stdio: ["pipe", "pipe", "pipe"],
		});

		let settled = false;
		let stdoutBuf = "";
		let stderrBuf = "";
		let deltaText = "";

		const cleanup = () => {
			signal?.removeEventListener("abort", onAbort);
		};

		const fail = (err: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (!child.killed) {
				child.kill("SIGTERM");
			}
			reject(err);
		};

		const finish = (assistantText: string) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (!child.killed) {
				child.kill("SIGTERM");
			}
			resolve({ assistantText });
		};

		const onAbort = () => {
			fail(signal?.reason instanceof Error ? signal.reason : new Error("Local Pi worker aborted"));
		};

		if (signal) {
			if (signal.aborted) {
				onAbort();
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}

		child.stderr?.on("data", (chunk: Buffer | string) => {
			stderrBuf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
			if (stderrBuf.length > 32768) {
				stderrBuf = stderrBuf.slice(-16384);
			}
		});

		child.on("error", (err) => {
			fail(err instanceof Error ? err : new Error(String(err)));
		});

		child.on("close", (code) => {
			if (settled) return;
			if (code === 0) {
				finish(deltaText.trim());
			} else {
				fail(
					new Error(`Local Pi RPC worker exited with code ${code ?? "null"}: ${stderrBuf.trim() || "no stderr"}`),
				);
			}
		});

		child.stdout?.on("data", (chunk: Buffer | string) => {
			stdoutBuf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
			let newline = stdoutBuf.indexOf("\n");
			while (newline !== -1) {
				const line = stdoutBuf.slice(0, newline).trim();
				stdoutBuf = stdoutBuf.slice(newline + 1);
				if (line) {
					try {
						const parsed = JSON.parse(line) as Record<string, unknown>;
						if (parsed.type === "message_update") {
							const assistantEvent = parsed.assistantMessageEvent as Record<string, unknown> | undefined;
							if (assistantEvent?.type === "text_delta" && typeof assistantEvent.delta === "string") {
								deltaText += assistantEvent.delta;
							}
						} else if (parsed.type === "response" && parsed.success === false) {
							fail(new Error(typeof parsed.error === "string" ? parsed.error : "Pi RPC prompt failed"));
							return;
						} else if (parsed.type === "agent_end" && !parsed.willRetry) {
							const fromMessages = extractTextFromAgentMessages(parsed.messages);
							finish(fromMessages || deltaText.trim());
							return;
						}
					} catch {
						// Ignore non-JSON lines emitted by CLI preambles or extensions.
					}
				}
				newline = stdoutBuf.indexOf("\n");
			}
		});

		const cmd = `${JSON.stringify({ id: "local-pi-turn", type: "prompt", message: req.prompt })}\n`;
		child.stdin?.write(cmd);
	});
}
