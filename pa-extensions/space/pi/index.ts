import { createTeamBridgeClient, type PiHostToolExtensionApi } from "../../worker-runtime/pi/bridge-client.ts";

export default function spaceExtension(pi: PiHostToolExtensionApi): void {
	const env = { ...process.env };
	const post = createTeamBridgeClient(env);

	pi.registerTool({
		name: "read_space",
		label: "读取资料空间",
		description:
			"List this matter's space entries (optionally filtered by docType) or read an entry by pageId. For folder entries, returns README.md plus files[]; pass subPath to read a specific sub-file inside a folder entry.",
		parameters: {
			type: "object",
			properties: {
				pageId: { type: "string" },
				docType: { type: "string", enum: ["plan", "spec", "decision", "rule", "note"] },
				subPath: { type: "string" },
			},
			additionalProperties: false,
		},
		async execute(callId, args, signal) {
			const result = await post("/tool", { tool: "read_space", callId, args }, signal);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});

	if (env.PA_CAN_SAVE_SPACE !== "false") {
		pi.registerTool({
			name: "save_space_page",
			label: "保存空间资料",
			description:
				"Save a plan, spec, decision, rule/SOP, or note to this matter's space. Set docType accurately: plan, spec, decision, rule, or note (default). For multi-file bundles, reference materials, or static demo sites with nested subdirectories (e.g. 'refs/option-a.md', 'demo/index.html', 'demo/assets/app.js', '.gitignore'), set entryKind='folder' and pass files=[{ path, content }, ...] (optionally alongside content for README.md) or pass a single subPath. Provide title and at least one of content, sourcePath, or files.",
			parameters: {
				type: "object",
				properties: {
					type: { type: "string", enum: ["document", "artifact", "prototype_image", "service_url"] },
					docType: { type: "string", enum: ["plan", "spec", "decision", "rule", "note"] },
					entryKind: { type: "string", enum: ["file", "folder"] },
					subPath: { type: "string" },
					files: {
						type: "array",
						minItems: 1,
						maxItems: 50,
						items: {
							type: "object",
							properties: {
								path: { type: "string" },
								content: { type: "string" },
							},
							required: ["path", "content"],
							additionalProperties: false,
						},
					},
					title: { type: "string" },
					content: { type: "string" },
					sourcePath: { type: "string" },
					summary: { type: "string" },
					changeNote: { type: "string" },
					pageId: { type: "string" },
					revision: { type: "integer", minimum: 1 },
				},
				required: ["title"],
				additionalProperties: false,
			},
			async execute(callId, args, signal) {
				const result = await post("/tool", { tool: "save_space_page", callId, args }, signal);
				return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
			},
		});
	}
}
