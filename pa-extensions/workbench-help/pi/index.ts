import { createTeamBridgeClient, type PiHostToolExtensionApi } from "../../worker-runtime/pi/bridge-client.ts";

export default function workbenchHelpExtension(pi: PiHostToolExtensionApi): void {
	const env = { ...process.env };
	const post = createTeamBridgeClient(env);

	pi.registerTool({
		name: "read_pa_help",
		label: "Read PA help",
		description:
			"Read the installed workbench guide or live facts about this matter. Use the topic IDs from the Personal Agent help index. This tool does not operate the workbench.",
		parameters: {
			type: "object",
			properties: {
				topics: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 },
				language: { type: "string", enum: ["zh", "en"] },
			},
			required: ["topics"],
			additionalProperties: false,
		},
		async execute(callId, args, signal) {
			const result = await post("/tool", { tool: "read_pa_help", callId, args }, signal);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});
}
