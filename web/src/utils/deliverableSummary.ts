import { stripMarkdownFormatting } from "./formatters.ts";

export interface ParsedDeliverableSummary {
	lead: string;
	details: string[];
}

/** Splits a dense deliverable changeNote/summary into a concise key-point lead and scannable process/evidence bullets. */
export function parseDeliverableSummary(rawSummary: string, maxLeadChars = 130): ParsedDeliverableSummary {
	const normalized = rawSummary
		.replace(/\r\n/g, "\n")
		.replace(/```[^\n]*\n?/g, "")
		.replace(/^\s{0,3}(?:#{1,6}\s+|>\s+|[-*+]\s+|\d+\.\s+)/gm, "")
		.trim();
	if (!normalized) return { lead: "", details: [] };

	const rawParagraphs = normalized
		.split(/\n+/)
		.flatMap((line) =>
			line.split(
				/(?<=^|[。；！？\s])(?=(?:交付依据|变更依据|过程依据|固化结论|关键依据|依据|验证结果|遗留问题)[：:])/,
			),
		)
		.map((part) => part.trim())
		.filter(Boolean);

	const firstPara = rawParagraphs[0] ?? normalized;
	const extraParas = rawParagraphs.slice(1);

	let lead = firstPara;
	const details: string[] = [];

	if (firstPara.length > maxLeadChars) {
		const sentences = firstPara
			.split(/(?<=[。；！？])/)
			.map((s) => s.trim())
			.filter(Boolean);
		if (sentences.length > 1) {
			let acc = "";
			let idx = 0;
			while (idx < sentences.length) {
				const next = sentences[idx]!;
				if (acc && acc.length + next.length > maxLeadChars) break;
				acc += next;
				idx += 1;
				if (acc.length >= Math.floor(maxLeadChars * 0.6)) break;
			}
			lead = acc;
			const remaining = sentences.slice(idx).join("").trim();
			if (remaining) details.push(remaining);
		}
	}

	for (const para of extraParas) {
		const clauses = para
			.split(/(?<=[。])\s*/)
			.map((c) => c.trim())
			.filter(Boolean);
		if (clauses.length > 1 && para.length > maxLeadChars) {
			details.push(...clauses);
		} else {
			details.push(para);
		}
	}

	return {
		lead: stripMarkdownFormatting(lead),
		details: details.map((item) => stripMarkdownFormatting(item)).filter(Boolean),
	};
}
