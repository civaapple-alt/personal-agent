export interface VerificationRequest {
	assignmentNumber?: number;
	target: { kind: "commit" | "file" | "draft"; reference: string };
	criteria: string;
}

export type VerificationVerdict = "passed" | "changes_requested" | "inconclusive";

export interface VerificationOutcome {
	verdict: VerificationVerdict;
	summary: string;
	evidence: string[];
}

export function isVerificationVerdict(value: unknown): value is VerificationVerdict {
	return value === "passed" || value === "changes_requested" || value === "inconclusive";
}
