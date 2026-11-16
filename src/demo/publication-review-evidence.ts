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
export function specialistsBeforePublication(traces: ReviewToolTrace[]): string[] {
	const published = traces.find(
		(trace) =>
			trace.memberId === "product-manager" &&
			trace.toolName === "publish_deliverable" &&
			trace.ended !== undefined &&
			trace.isError === false,
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
