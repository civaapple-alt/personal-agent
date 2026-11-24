import { spawn } from "node:child_process";

export interface BoundedCommandOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	maxOutputBytes?: number;
	signal?: AbortSignal;
}

export interface BoundedCommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export class BoundedCommandError extends Error {
	readonly command: string;
	readonly args: readonly string[];
	readonly exitCode: number | null;
	readonly timedOut: boolean;
	readonly aborted: boolean;
	readonly stdout: string;
	readonly stderr: string;

	constructor(
		message: string,
		details: {
			command: string;
			args: readonly string[];
			exitCode: number | null;
			timedOut: boolean;
			aborted: boolean;
			stdout: string;
			stderr: string;
		},
	) {
		super(message);
		this.name = "BoundedCommandError";
		this.command = details.command;
		this.args = details.args;
		this.exitCode = details.exitCode;
		this.timedOut = details.timedOut;
		this.aborted = details.aborted;
		this.stdout = details.stdout;
		this.stderr = details.stderr;
	}
}

function killProcessGroup(pid: number | undefined): void {
	if (!pid) return;
	try {
		if (process.platform !== "win32") {
			process.kill(-pid, "SIGKILL");
			return;
		}
	} catch {
		// Fall back to direct child kill when process group is already gone.
	}
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// Ignore ESRCH.
	}
}

/**
 * Execute a child command with a strict time budget, output byte cap, and process-group kill on timeout/abort.
 */
export async function runBounded(
	command: string,
	args: readonly string[],
	options: BoundedCommandOptions = {},
): Promise<BoundedCommandResult> {
	const timeoutMs = options.timeoutMs ?? 30_000;
	const maxOutputBytes = options.maxOutputBytes ?? 4 * 1024 * 1024;
	if (options.signal?.aborted) {
		throw new BoundedCommandError(`Command aborted before start: ${command}`, {
			command,
			args,
			exitCode: null,
			timedOut: false,
			aborted: true,
			stdout: "",
			stderr: "",
		});
	}

	return new Promise<BoundedCommandResult>((resolvePromise, rejectPromise) => {
		const child = spawn(command, [...args], {
			cwd: options.cwd,
			env: options.env ?? process.env,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});

		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let timedOut = false;
		let aborted = false;
		let overflowed = false;
		let settled = false;

		const appendChunk = (chunks: Buffer[], chunk: Buffer, currentBytes: number): number => {
			if (currentBytes >= maxOutputBytes) {
				overflowed = true;
				return currentBytes;
			}
			const remaining = maxOutputBytes - currentBytes;
			if (chunk.length > remaining) {
				chunks.push(chunk.subarray(0, remaining));
				overflowed = true;
				return maxOutputBytes;
			}
			chunks.push(chunk);
			return currentBytes + chunk.length;
		};

		child.stdout?.on("data", (chunk: Buffer) => {
			stdoutBytes = appendChunk(stdoutChunks, chunk, stdoutBytes);
			if (overflowed) killProcessGroup(child.pid);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderrBytes = appendChunk(stderrChunks, chunk, stderrBytes);
			if (overflowed) killProcessGroup(child.pid);
		});

		const onAbort = () => {
			aborted = true;
			killProcessGroup(child.pid);
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });

		const timer =
			timeoutMs > 0
				? setTimeout(() => {
						timedOut = true;
						killProcessGroup(child.pid);
					}, timeoutMs)
				: null;
		timer?.unref();

		const cleanup = () => {
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
		};

		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			cleanup();
			rejectPromise(
				new BoundedCommandError(`Failed to spawn ${command}: ${error.message}`, {
					command,
					args,
					exitCode: null,
					timedOut,
					aborted,
					stdout: Buffer.concat(stdoutChunks).toString("utf8"),
					stderr: Buffer.concat(stderrChunks).toString("utf8"),
				}),
			);
		});

		child.once("close", (code, signal) => {
			if (settled) return;
			settled = true;
			cleanup();
			const stdout = Buffer.concat(stdoutChunks).toString("utf8");
			const stderr = Buffer.concat(stderrChunks).toString("utf8");
			if (timedOut) {
				rejectPromise(
					new BoundedCommandError(`Command timed out after ${timeoutMs}ms: ${command}`, {
						command,
						args,
						exitCode: code,
						timedOut: true,
						aborted: false,
						stdout,
						stderr,
					}),
				);
				return;
			}
			if (aborted) {
				rejectPromise(
					new BoundedCommandError(`Command aborted: ${command}`, {
						command,
						args,
						exitCode: code,
						timedOut: false,
						aborted: true,
						stdout,
						stderr,
					}),
				);
				return;
			}
			if (overflowed) {
				rejectPromise(
					new BoundedCommandError(`Command output exceeded ${maxOutputBytes} bytes: ${command}`, {
						command,
						args,
						exitCode: code,
						timedOut: false,
						aborted: false,
						stdout,
						stderr,
					}),
				);
				return;
			}
			if (code !== 0) {
				const detail = stderr.trim() || stdout.trim() || (signal ? `killed by ${signal}` : `exit code ${code}`);
				rejectPromise(
					new BoundedCommandError(detail, {
						command,
						args,
						exitCode: code,
						timedOut: false,
						aborted: false,
						stdout,
						stderr,
					}),
				);
				return;
			}
			resolvePromise({ stdout, stderr, exitCode: 0 });
		});
	});
}
