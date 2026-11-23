import type { ReviewScenarioId } from "./publication-review-case.ts";

export const REVIEW_SCENARIO_IDS: ReviewScenarioId[] = ["autonomous", "required", "solo"];
export type ReviewPolicy = "baseline" | "current";
export interface ReviewPlanItem {
	scenarioId: ReviewScenarioId;
	repetition: number;
	policy: ReviewPolicy;
}
export type ReviewOptions =
	| { kind: "help" }
	| { kind: "summarize"; directory: string }
	| { kind: "run"; scenarioIds: ReviewScenarioId[]; repeat: number; timeoutSeconds: number };

export function parseScenarioId(value: unknown): ReviewScenarioId {
	if (value === "autonomous" || value === "required" || value === "solo") return value;
	throw new Error("Scenario must be autonomous, required, solo or all");
}
export function parseRepeat(value: unknown): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 10)
		throw new Error("Repeat must be an integer from 1 to 10");
	return value;
}
export function parseReviewOptions(args: string[]): ReviewOptions {
	if (args.length === 1 && args[0] === "--help") return { kind: "help" };
	if (args.length === 2 && args[0] === "--summarize" && args[1]?.trim())
		return { kind: "summarize", directory: args[1] };
	let scenarioIds: ReviewScenarioId[] = ["autonomous"];
	let repeat = 1;
	let timeoutSeconds = 240;
	const seen = new Set<string>();
	for (let i = 0; i < args.length; i += 2) {
		const key = args[i];
		const value = args[i + 1];
		if (!key || !value || seen.has(key)) throw new Error("Options require one value each, without duplicates");
		seen.add(key);
		if (key === "--scenario") scenarioIds = value === "all" ? [...REVIEW_SCENARIO_IDS] : [parseScenarioId(value)];
		else if (key === "--repeat" && /^\d+$/.test(value)) repeat = parseRepeat(Number(value));
		else if (key === "--timeout-seconds" && /^\d+$/.test(value) && Number(value) >= 60 && Number(value) <= 1200)
			timeoutSeconds = Number(value);
		else throw new Error(`Unsupported option: ${key}; use --help`);
	}
	return { kind: "run", scenarioIds, repeat, timeoutSeconds };
}
export function reviewPlan(scenarioIds: ReviewScenarioId[], repeat: number): ReviewPlanItem[] {
	const plan: ReviewPlanItem[] = [];
	for (let repetition = 1; repetition <= parseRepeat(repeat); repetition++) {
		for (const scenarioId of scenarioIds) {
			const policies: ReviewPolicy[] = repetition % 2 ? ["baseline", "current"] : ["current", "baseline"];
			for (const policy of policies) plan.push({ scenarioId, repetition, policy });
		}
	}
	return plan;
}
export const reviewDirectory = (item: ReviewPlanItem) => `${item.scenarioId}/repeat-${item.repetition}/${item.policy}`;
