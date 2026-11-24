import { createTeamBridgeClient, type PiHostToolExtensionApi } from "../../worker-runtime/pi/bridge-client.ts";

export default function skillCaptureExtension(pi: PiHostToolExtensionApi): void {
	const env = { ...process.env };
	const post = createTeamBridgeClient(env);

	pi.registerTool({
		name: "propose_skill",
		label: "提议沉淀 Skill 与脚本",
		description:
			"Propose saving a proven, reusable workflow, convention, user correction, or deterministic helper script as a standard Pi Skill (SKILL.md plus optional executable scripts under scripts/) for human confirmation. Never writes directly to disk until the user approves the confirmation card. Use whenever work uncovers a reusable method, rule, or multi-step procedure that should be one-shot repeatable next time.",
		parameters: {
			type: "object",
			properties: {
				name: {
					type: "string",
					description: "Lowercase kebab-case skill name (e.g. 'release-preflight' or 'daily-repo-digest').",
				},
				description: {
					type: "string",
					description: "Concise trigger description telling future sessions when to load this Skill.",
				},
				body: {
					type: "string",
					description: "Markdown instructions for SKILL.md (without YAML frontmatter).",
				},
				storageScope: {
					type: "string",
					enum: ["global", "org", "personal", "workspace"],
					description: "Target scope: workspace (.agents/skills/), personal, org, or global.",
				},
				rationale: {
					type: "string",
					description: "Why this workflow or rule is worth saving and what repeated effort it eliminates.",
				},
				scripts: {
					type: "array",
					description: "Optional deterministic helper scripts under scripts/<filename>.",
					items: {
						type: "object",
						properties: {
							path: { type: "string", description: "Must match scripts/<safe-filename>." },
							content: { type: "string" },
							executable: { type: "boolean" },
						},
						required: ["path", "content"],
						additionalProperties: false,
					},
				},
			},
			required: ["name", "description", "body", "storageScope", "rationale"],
			additionalProperties: false,
		},
		async execute(callId, args, signal) {
			const result = await post("/tool", { tool: "propose_skill", callId, args }, signal);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});
}
