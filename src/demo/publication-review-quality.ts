import { createHash } from "node:crypto";
import type { ReviewCriterion } from "./publication-review-case.ts";

export const reviewHash = (text: string) => createHash("sha256").update(text).digest("hex");
function isReviewObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function reviewObject(value: unknown): Record<string, unknown> {
	if (!isReviewObject(value)) throw new Error("Expected an object");
	return value;
}
export function reviewText(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) throw new Error("Expected nonempty text");
	return value;
}

export interface QualityReviewFile {
	schemaVersion: 1;
	documentSha256: string;
	reviewer: string;
	judgments: Array<
		| { criterionId: string; verdict: "pending" }
		| {
				criterionId: string;
				verdict: "pass" | "fail";
				explanation: string;
				evidence: Array<{ line: number; text: string }>;
		  }
	>;
	newIssues: Array<{
		severity: "blocker" | "note";
		explanation: string;
		evidence: Array<{ line: number; text: string }>;
	}>;
}
export type QualityResult =
	| { status: "unavailable"; reason: string }
	| { status: "invalid"; reason: string }
	| {
			status: "pending" | "pass" | "fail";
			reviewer: string;
			reviewed: number;
			total: number;
			judgments: QualityReviewFile["judgments"];
			newIssues: QualityReviewFile["newIssues"];
	  };

export function qualityReviewTemplate(content: string, rubric: ReviewCriterion[]): QualityReviewFile {
	return {
		schemaVersion: 1,
		documentSha256: reviewHash(content),
		reviewer: "",
		judgments: rubric.map(({ id }) => ({ criterionId: id, verdict: "pending" })),
		newIssues: [],
	};
}

/** Validate provenance and quoted lines, not the correctness of a reviewer's semantic judgment. */
export function assessQuality(input: {
	content: string | null;
	documentSha256: string | null;
	rubric: ReviewCriterion[];
	review: unknown;
}): QualityResult {
	if (input.content === null && input.documentSha256 === null)
		return { status: "unavailable", reason: "No final published document" };
	if (input.content === null || input.documentSha256 === null)
		return { status: "invalid", reason: "Published snapshot or its hash is missing" };
	try {
		if (reviewHash(input.content) !== input.documentSha256)
			throw new Error("Published snapshot changed since execution");
		const raw = reviewObject(input.review);
		if (raw.schemaVersion !== 1 || raw.documentSha256 !== input.documentSha256)
			throw new Error("Review does not match the final document hash");
		if (typeof raw.reviewer !== "string" || !Array.isArray(raw.judgments) || !Array.isArray(raw.newIssues))
			throw new Error("Invalid reviewer or judgments");
		const reviewer = raw.reviewer;
		const lines = input.content.split("\n");
		const citations = (value: unknown) => {
			if (!Array.isArray(value) || value.length === 0) throw new Error("Completed judgments require line evidence");
			return value.map((value) => {
				const citation = reviewObject(value);
				if (typeof citation.line !== "number" || !Number.isInteger(citation.line) || citation.line < 1)
					throw new Error("Invalid evidence line");
				const text = reviewText(citation.text);
				if (lines[citation.line - 1] !== text) throw new Error("Quoted line does not match the final document");
				return { line: citation.line, text };
			});
		};
		const seen = new Set<string>();
		const judgments: QualityReviewFile["judgments"] = [];
		for (const value of raw.judgments) {
			const item = reviewObject(value);
			const criterionId = reviewText(item.criterionId);
			if (seen.has(criterionId) || !input.rubric.some(({ id }) => id === criterionId))
				throw new Error("Duplicate or unknown criterion");
			seen.add(criterionId);
			if (item.verdict === "pending") {
				judgments.push({ criterionId, verdict: "pending" });
				continue;
			}
			if (item.verdict !== "pass" && item.verdict !== "fail")
				throw new Error("Verdict must be pending, pass or fail");
			if (!reviewer.trim()) throw new Error("Completed judgments require an identified independent reviewer");
			const evidence = citations(item.evidence);
			judgments.push({ criterionId, verdict: item.verdict, explanation: reviewText(item.explanation), evidence });
		}
		if (seen.size !== input.rubric.length) throw new Error("Review must contain every criterion exactly once");
		const newIssues = raw.newIssues.map((value): QualityReviewFile["newIssues"][number] => {
			const item = reviewObject(value);
			if (item.severity !== "blocker" && item.severity !== "note") throw new Error("Invalid new-issue severity");
			if (!reviewer.trim()) throw new Error("New issues require an identified reviewer");
			return {
				severity: item.severity,
				explanation: reviewText(item.explanation),
				evidence: citations(item.evidence),
			};
		});
		const reviewed = judgments.filter(({ verdict }) => verdict !== "pending").length;
		return {
			status:
				judgments.some(({ verdict }) => verdict === "fail") ||
				newIssues.some(({ severity }) => severity === "blocker")
					? "fail"
					: reviewed === judgments.length
						? "pass"
						: "pending",
			reviewer,
			reviewed,
			total: judgments.length,
			judgments,
			newIssues,
		};
	} catch (error) {
		return { status: "invalid", reason: error instanceof Error ? error.message : String(error) };
	}
}
