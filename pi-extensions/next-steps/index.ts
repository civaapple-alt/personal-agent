/**
 * Portable Pi extension for `suggest_next_steps`.
 * Adapted in spirit from @thinkrail/pi-next-steps (Apache-2.0).
 * Zero Personal Agent dependencies — works identically in vanilla Pi CLI and RPC hosts.
 */

export const NEXT_STEPS_TOOL_NAME = "suggest_next_steps";
const MAX_SUGGESTIONS = 4;

export interface PortableNextStep {
	label: string;
	prompt: string;
	kind?: "action" | "verify" | "capture" | "question";
}

export interface PortableNextStepsDetails {
	suggestions: PortableNextStep[];
}

interface PiNextStepsExtensionApi {
	registerTool(spec: {
		name: string;
		label: string;
		description: string;
		parameters: Record<string, unknown>;
		execute(
			callId: string,
			args: Record<string, unknown>,
		): Promise<{ content: Array<{ type: "text"; text: string }>; details: PortableNextStepsDetails }>;
	}): void;
}

export function normalizePortableNextSteps(raw: unknown): PortableNextStep[] {
	if (!Array.isArray(raw)) return [];
	const out: PortableNextStep[] = [];
	const seen = new Set<string>();
	for (const item of raw) {
		let label = "";
		let prompt = "";
		let kind: PortableNextStep["kind"];
		if (typeof item === "string") {
			const clean = item.replace(/\s+/g, " ").trim();
			label = clean.slice(0, 64);
			prompt = clean.slice(0, 400);
		} else if (item && typeof item === "object") {
			const rec = item as Record<string, unknown>;
			const rawLabel = typeof rec.label === "string" ? rec.label.replace(/\s+/g, " ").trim() : "";
			const rawPrompt = typeof rec.prompt === "string" ? rec.prompt.replace(/\s+/g, " ").trim() : "";
			label = (rawLabel || rawPrompt).slice(0, 64);
			prompt = (rawPrompt || rawLabel).slice(0, 400);
			if (rec.kind === "action" || rec.kind === "verify" || rec.kind === "capture" || rec.kind === "question") {
				kind = rec.kind;
			}
		}
		if (!label || !prompt) continue;
		const key = prompt.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ label, prompt, ...(kind ? { kind } : {}) });
		if (out.length >= MAX_SUGGESTIONS) break;
	}
	return out;
}

export default function nextStepsExtension(pi: PiNextStepsExtensionApi): void {
	pi.registerTool({
		name: NEXT_STEPS_TOOL_NAME,
		label: "建议下一步",
		description:
			"After writing your answer, optionally suggest 2-4 concise, high-value follow-up messages the user can click to send next (e.g. advance to the next step, delegate independent QA verification, or capture a proven workflow as a Skill). Skip when nothing useful applies.",
		parameters: {
			type: "object",
			properties: {
				suggestions: {
					type: "array",
					minItems: 1,
					maxItems: MAX_SUGGESTIONS,
					description: "Ordered list of 2-4 concrete next-step suggestions.",
					items: {
						type: "object",
						properties: {
							label: { type: "string", description: "Short button label (<= 24 chars preferred)." },
							prompt: { type: "string", description: "Exact follow-up message sent when clicked." },
							kind: {
								type: "string",
								enum: ["action", "verify", "capture", "question"],
								description: "Optional category: action, verify, capture (propose_skill), or question.",
							},
						},
						required: ["label", "prompt"],
						additionalProperties: false,
					},
				},
			},
			required: ["suggestions"],
			additionalProperties: false,
		},
		async execute(_callId, args) {
			const suggestions = normalizePortableNextSteps(args.suggestions);
			const summary =
				suggestions.length > 0
					? `Suggested ${suggestions.length} next steps:\n${suggestions.map((s, idx) => `${idx + 1}. ${s.label}`).join("\n")}`
					: "No valid next-step suggestions provided.";
			return {
				content: [{ type: "text", text: summary }],
				details: { suggestions },
			};
		},
	});
}
