import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface StructuredLogger {
	debug(message: string, fields?: Record<string, unknown>): void;
	info(message: string, fields?: Record<string, unknown>): void;
	warn(message: string, fields?: Record<string, unknown>): void;
	error(message: string, fields?: Record<string, unknown>): void;
}

export interface LoggingOptions {
	dataDir: string;
	maxBytes?: number;
	maxRotatedFiles?: number;
}

interface LogSinkState {
	logFile: string;
	maxBytes: number;
	maxRotatedFiles: number;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_ROTATED = 3;
let activeSink: LogSinkState | null = null;

/** Initialize structured JSONL host logging under `<dataDir>/logs/server.jsonl`. */
export function initLogging(options: LoggingOptions): string {
	const logsDir = join(options.dataDir, "logs");
	mkdirSync(logsDir, { recursive: true });
	const logFile = join(logsDir, "server.jsonl");
	activeSink = {
		logFile,
		maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
		maxRotatedFiles: options.maxRotatedFiles ?? DEFAULT_MAX_ROTATED,
	};
	return logFile;
}

/** Detach the active file sink (used on host shutdown and in tests). */
export function closeLogging(): void {
	activeSink = null;
}

function rotateIfNeeded(sink: LogSinkState): void {
	try {
		if (!existsSync(sink.logFile)) return;
		if (statSync(sink.logFile).size < sink.maxBytes) return;
		for (let i = sink.maxRotatedFiles - 1; i >= 1; i -= 1) {
			const older = `${sink.logFile}.${i}`;
			const next = `${sink.logFile}.${i + 1}`;
			if (existsSync(older)) renameSync(older, next);
		}
		renameSync(sink.logFile, `${sink.logFile}.1`);
	} catch {
		// Never crash host execution because log rotation failed.
	}
}

function writeRecord(level: LogLevel, scope: string, message: string, fields?: Record<string, unknown>): void {
	const sink = activeSink;
	if (!sink) return;
	try {
		rotateIfNeeded(sink);
		const record = {
			ts: new Date().toISOString(),
			level,
			scope,
			msg: message,
			...(fields && Object.keys(fields).length > 0 ? { fields } : {}),
		};
		appendFileSync(sink.logFile, `${JSON.stringify(record)}\n`, "utf8");
	} catch {
		// Best-effort diagnostics only.
	}
}

/** Create a scoped structured logger. Safe to call even before `initLogging()` (no-op file sink). */
export function createLogger(scope: string): StructuredLogger {
	return {
		debug(message, fields) {
			writeRecord("debug", scope, message, fields);
		},
		info(message, fields) {
			writeRecord("info", scope, message, fields);
		},
		warn(message, fields) {
			writeRecord("warn", scope, message, fields);
		},
		error(message, fields) {
			writeRecord("error", scope, message, fields);
		},
	};
}
