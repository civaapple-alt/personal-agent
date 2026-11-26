import { createTeamBridgeClient } from "../shared/team-bridge-client.ts";

interface QuestionArguments {
	question: string;
	context?: string;
	options?: string[];
	sourceAssignmentNumber?: number;
}

interface QuestionContext {
	hasUI: boolean;
	ui: {
		select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined>;
		input(title: string, placeholder?: string, opts?: { signal?: AbortSignal }): Promise<string | undefined>;
	};
}

interface QuestionToolResult {
	content: { type: "text"; text: string }[];
	details: unknown;
}

export interface HumanQuestionExtensionApi {
	registerTool(tool: {
		name: string;
		label: string;
		description: string;
		parameters: object;
		execute(
			callId: string,
			args: QuestionArguments,
			signal?: AbortSignal,
			onUpdate?: unknown,
			ctx?: QuestionContext,
		): Promise<QuestionToolResult>;
	}): void;
}

async function askInPi(args: QuestionArguments, signal?: AbortSignal, ctx?: QuestionContext) {
	signal?.throwIfAborted();
	if (!ctx?.hasUI) {
		return { status: "unavailable", note: "This Pi session has no interactive UI. Ask in the conversation." };
	}
	const question = args.question.trim();
	if (!question) throw new Error("question must be nonempty text");
	const options = args.options?.map((option) => option.trim());
	if (options && (options.some((option) => !option) || new Set(options).size !== options.length)) {
		throw new Error("Options must be nonempty and distinct");
	}
	const title = [question, args.context?.trim()].filter(Boolean).join("\n\n");
	const answer = options
		? await ctx.ui.select(title, options, { signal })
		: await ctx.ui.input(title, undefined, { signal });
	signal?.throwIfAborted();
	return answer?.trim() ? { status: "answered", answer: answer.trim() } : { status: "cancelled" };
}

export default function humanQuestionExtension(pi: HumanQuestionExtensionApi): void {
	const { PA_TEAM_BRIDGE_URL, PA_TEAM_BRIDGE_TOKEN, PA_HUMAN_QUESTION_ENABLED } = process.env;
	const inPa = Boolean(PA_TEAM_BRIDGE_URL);
	if (inPa && PA_HUMAN_QUESTION_ENABLED !== "true") return;

	const name = "request_clarification";
	const post = createTeamBridgeClient({ PA_TEAM_BRIDGE_URL, PA_TEAM_BRIDGE_TOKEN });
	pi.registerTool({
		name,
		label: "提请澄清",
		description: inPa
			? "Use when the user explicitly asks for a decision card during assigned work or when a consequential question blocks the work. As a specialist, return the question to your delegator along with any independent findings. As the lead, answer internally when you can; otherwise create a durable human decision in the matter. Include distinct options if the user needs to choose, and finish this turn without assuming an answer. This tool never grants authorization."
			: "Ask the user a consequential question using the current Pi interface. Provide options for a single choice, or omit them for a written answer.",
		parameters: {
			type: "object",
			properties: {
				question: { type: "string", maxLength: 1000 },
				context: { type: "string", maxLength: 3000, description: "Why this is needed and what it blocks" },
				options: {
					type: "array",
					minItems: 2,
					maxItems: 4,
					items: { type: "string", maxLength: 240 },
					description:
						"2–4 short clickable choices (put discrete choices here instead of embedding A./B. inside question)",
				},
				...(inPa
					? {
							sourceAssignmentNumber: {
								type: "integer",
								minimum: 1,
								description: "Direct assignment that raised this question, if applicable",
							},
						}
					: {}),
			},
			required: ["question"],
			additionalProperties: false,
		},
		async execute(callId, args, signal, _onUpdate, ctx) {
			const result = inPa
				? await post("/tool", { tool: name, callId, args }, signal)
				: await askInPi(args, signal, ctx);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});
}
