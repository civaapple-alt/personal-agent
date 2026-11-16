export interface ReviewToolTrace {
	memberId: string;
	toolName: string;
	toolCallId: string;
	args: unknown;
	started: number;
	ended?: number;
	isError?: boolean;
}

/** Mechanical facts only. Content quality remains an independent full-text review. */
export function specialistsBeforePublication(traces: ReviewToolTrace[], title: string): string[] {
	const published = traces.findLast(
		(trace) =>
			trace.memberId === "product-manager" &&
			trace.toolName === "publish_deliverable" &&
			trace.ended !== undefined &&
			trace.isError === false &&
			trace.args !== null &&
			typeof trace.args === "object" &&
			"title" in trace.args &&
			trace.args.title === title,
	);
	if (!published) return [];
	return [
		...new Set(
			traces.flatMap((trace) => {
				if (
					trace.memberId !== "product-manager" ||
					trace.toolName !== "delegate_to_member" ||
					trace.isError !== false ||
					trace.ended === undefined ||
					trace.ended >= published.started ||
					!trace.args ||
					typeof trace.args !== "object" ||
					!("memberId" in trace.args) ||
					typeof trace.args.memberId !== "string"
				)
					return [];
				return [trace.args.memberId];
			}),
		),
	];
}

import type { CollaborationExpectation } from "./publication-review-case.ts";

export type CollaborationResult = {
	status: "pass" | "fail" | "not_required";
	expectation: CollaborationExpectation;
	consulted: string[];
	missing: string[];
};
export function assessCollaboration(expectation: CollaborationExpectation, consulted: string[]): CollaborationResult {
	const missing = expectation.kind === "required" ? expectation.memberIds.filter((id) => !consulted.includes(id)) : [];
	return {
		status: expectation.kind === "optional" ? "not_required" : missing.length ? "fail" : "pass",
		expectation,
		consulted,
		missing,
	};
}
