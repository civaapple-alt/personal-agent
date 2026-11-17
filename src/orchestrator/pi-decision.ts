import type { PromptRunResult } from "../rpc/pi-rpc-worker.ts";
import type { ThinkingLevel } from "../rpc/types.ts";
import type { WorkerFactory } from "./types.ts";

export type PiDecisionErrorKind = "aborted" | "parse_error" | "validation_error" | "worker_error";

/** Typed failure emitted when an isolated Pi decision run aborts, fails, or violates its output contract. */
export class PiDecisionError extends Error {
	readonly kind: PiDecisionErrorKind;
	readonly rawText?: string;

	constructor(kind: PiDecisionErrorKind, message: string, options?: { rawText?: string; cause?: unknown }) {
		super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
		this.name = "PiDecisionError";
		this.kind = kind;
		this.rawText = options?.rawText;
	}
}

export interface PiDecisionSpec<T> {
	/** Short decision identifier used in error diagnostics. */
	name: string;
	/** Explicit system + contract instructions describing the JSON schema and constraints. */
	systemPrompt: string;
	/** Bounded user input and structured context sent to the decision model. */
	userPrompt: string;
	/** Optional bounded tool allowlist (e.g. `["read"]`); omitted or empty runs completely tool-free (`--tools ""`). */
	tools?: string[];
	/** Reasoning effort override; defaults to `"low"` for fast structured decisions. */
	thinkingLevel?: ThinkingLevel;
	/** Runtime schema validator converting raw parsed JSON object into typed `T` (throw or return null on violation). */
	validate: (raw: Record<string, unknown>) => T | null;
}

export interface RunTypedPiDecisionDeps {
	cwd: string;
	provider: string;
	model: string;
	workerFactory: WorkerFactory;
}

export interface RunTypedPiDecisionOptions {
	timeoutMs?: number;
	signal: AbortSignal;
}

export interface PiDecisionResult<T> {
	decision: T;
	rawText: string;
}

/** Extracts the first top-level JSON object from model prose or fenced ```json blocks. */
export function extractJsonObject(rawText: string): Record<string, unknown> | null {
	const cleaned = rawText.trim();
	const jsonBlock = cleaned
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/i, "")
		.trim();
	const start = jsonBlock.indexOf("{");
	const end = jsonBlock.lastIndexOf("}");
	if (start === -1 || end <= start) return null;

	try {
		const parsed = JSON.parse(jsonBlock.slice(start, end + 1));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

/**
 * Executes a single stateless, schema-enforced decision call via Pi RPC (`noSession: true`, isolated extensions/skills),
 * validates the structured JSON result against `spec.validate`, and propagates cancellation via `AbortSignal`.
 */
export async function runTypedPiDecision<T>(
	deps: RunTypedPiDecisionDeps,
	spec: PiDecisionSpec<T>,
	options: RunTypedPiDecisionOptions,
): Promise<PiDecisionResult<T>> {
	options.signal.throwIfAborted();
	const toolsArg = spec.tools && spec.tools.length > 0 ? spec.tools.join(",") : "";
	const worker = deps.workerFactory({
		cwd: deps.cwd,
		provider: deps.provider,
		model: deps.model,
		noSession: true,
		args: ["--no-extensions", "--no-skills", "--no-mcp", "--tools", toolsArg],
		env: { PA_DECISION_NAME: spec.name },
	});

	const onAbort = () => {
		void worker.abort?.().catch(() => {});
		void worker.stop().catch(() => {});
	};
	options.signal.addEventListener("abort", onAbort, { once: true });

	let promptResult: PromptRunResult;
	try {
		await worker.start();
		if (worker.setThinkingLevel) {
			await worker.setThinkingLevel(spec.thinkingLevel ?? "low");
		}
		options.signal.throwIfAborted();
		promptResult = await worker.runPromptAndWait(`${spec.systemPrompt}\n\n---\n\n${spec.userPrompt}`, {
			timeoutMs: options.timeoutMs ?? 60_000,
			signal: options.signal,
		});
	} catch (error) {
		if (options.signal.aborted) {
			throw new PiDecisionError("aborted", `Decision "${spec.name}" was aborted`, { cause: error });
		}
		throw new PiDecisionError(
			"worker_error",
			`Decision "${spec.name}" worker failed: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	} finally {
		options.signal.removeEventListener("abort", onAbort);
		await worker.stop().catch(() => {});
	}

	if (promptResult.aborted || options.signal.aborted) {
		throw new PiDecisionError("aborted", `Decision "${spec.name}" was aborted`, {
			rawText: promptResult.assistantText,
		});
	}

	const rawObject = extractJsonObject(promptResult.assistantText);
	if (!rawObject) {
		throw new PiDecisionError("parse_error", `Decision "${spec.name}" did not return valid JSON`, {
			rawText: promptResult.assistantText,
		});
	}

	const validated = spec.validate(rawObject);
	if (validated === null) {
		throw new PiDecisionError("validation_error", `Decision "${spec.name}" JSON failed schema validation`, {
			rawText: promptResult.assistantText,
		});
	}

	return {
		decision: validated,
		rawText: promptResult.assistantText,
	};
}
