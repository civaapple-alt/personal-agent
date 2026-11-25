import { createTeamBridgeClient, type PiHostToolExtensionApi } from "../../worker-runtime/pi/bridge-client.ts";

export default function delegationExtension(pi: PiHostToolExtensionApi): void {
	const env = { ...process.env };
	const post = createTeamBridgeClient(env);

	pi.registerTool({
		name: "delegate_to_member",
		label: "咨询团队成员",
		description:
			"Ask an existing colleague to perform specialist work and return evidence. Include the objective, constraints, and expected evidence. During authorized work, the lead can set verification to assign independent review of a commit, workspace text file, or a staged document draft. Use a different member from the author and refer to their completed assignment when applicable. The answer includes the assignment number for this turn's handoff board.",
		parameters: {
			type: "object",
			properties: {
				memberId: { type: "string" },
				task: { type: "string" },
				handoffDocumentIds: {
					type: "array",
					items: { type: "string" },
					maxItems: 5,
					description:
						"Optional Space document IDs visible in this matter to attach as structured handoff context (validated before launching the colleague; missing or inaccessible documents fail closed).",
				},
				verification: {
					type: "object",
					properties: {
						assignmentNumber: {
							type: "integer",
							minimum: 1,
							description: "Completed assignment number in this turn, when there is one",
						},
						target: {
							type: "object",
							properties: {
								kind: { type: "string", enum: ["commit", "file", "draft"] },
								reference: {
									type: "string",
									description:
										"Full commit hash, workspace-relative text path, or exact staged document title",
								},
							},
							required: ["kind", "reference"],
							additionalProperties: false,
						},
						criteria: { type: "string" },
					},
					required: ["target", "criteria"],
					additionalProperties: false,
				},
			},
			required: ["memberId", "task"],
			additionalProperties: false,
		},
		async execute(callId, args, signal) {
			const result = await post("/tool", { tool: "delegate_to_member", callId, args }, signal);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});
}
