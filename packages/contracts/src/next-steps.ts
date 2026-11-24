export const NEXT_STEPS_TOOL_NAME = "suggest_next_steps";
export const MAX_NEXT_STEP_SUGGESTIONS = 4;

export type NextStepKind = "action" | "verify" | "capture" | "question";

export interface NextStepSuggestion {
	label: string;
	prompt: string;
	kind?: NextStepKind;
}

export interface NextStepsDetails {
	suggestions: NextStepSuggestion[];
}

function normalizeKind(raw: unknown): NextStepKind | undefined {
	return raw === "action" || raw === "verify" || raw === "capture" || raw === "question" ? raw : undefined;
}

/**
 * Normalizes raw tool arguments or persisted metadata into a clean, deduplicated list of up to 4 next-step suggestions.
 * Accepts either plain strings or `{ label, prompt?, kind? }` objects.
 */
export function normalizeNextSteps(raw: unknown): NextStepSuggestion[] {
	if (!Array.isArray(raw)) return [];
	const results: NextStepSuggestion[] = [];
	const seen = new Set<string>();
	for (const entry of raw) {
		let label = "";
		let prompt = "";
		let kind: NextStepKind | undefined;
		if (typeof entry === "string") {
			const clean = entry.replace(/\s+/g, " ").trim();
			label = clean.slice(0, 64);
			prompt = clean.slice(0, 400);
		} else if (entry && typeof entry === "object") {
			const rec = entry as Record<string, unknown>;
			const rawLabel = typeof rec.label === "string" ? rec.label.replace(/\s+/g, " ").trim() : "";
			const rawPrompt = typeof rec.prompt === "string" ? rec.prompt.replace(/\s+/g, " ").trim() : "";
			label = (rawLabel || rawPrompt).slice(0, 64);
			prompt = (rawPrompt || rawLabel).slice(0, 400);
			kind = normalizeKind(rec.kind);
		}
		if (!label || !prompt) continue;
		const key = prompt.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		results.push({ label, prompt, ...(kind ? { kind } : {}) });
		if (results.length >= MAX_NEXT_STEP_SUGGESTIONS) break;
	}
	return results;
}

/** Reads validated next-step suggestions from a settled assistant message's metadata. */
export function readNextStepsFromMetadata(metadata: Record<string, unknown> | null | undefined): NextStepSuggestion[] {
	if (!metadata || typeof metadata !== "object") return [];
	return normalizeNextSteps(metadata.nextSteps);
}
