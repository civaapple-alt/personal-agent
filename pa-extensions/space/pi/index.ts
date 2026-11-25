import { createTeamBridgeClient, type PiHostToolExtensionApi } from "../../worker-runtime/pi/bridge-client.ts";

export default function spaceExtension(pi: PiHostToolExtensionApi): void {
	const env = { ...process.env };
	const post = createTeamBridgeClient(env);

	pi.registerTool({
		name: "read_space",
		label: "读取资料空间",
		description:
			"List this matter's space entries (optionally filtered by docType) or read an entry by pageId. For folder entries, returns README.md plus files[]; pass subPath to read a specific sub-file inside a folder entry.",
		promptSnippet: "List or read versioned documents and folder entries in this matter's Git space",
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
				"Save a plan, spec, decision, rule/SOP, or note to this matter's Git space. Set docType accurately: plan, spec, decision, rule, or note (default). For multi-file bundles or static HTML demos, prefer writing files cleanly on disk with native write/edit first and passing entryKind='folder' + sourceDir (pointer-based import), or pass inline files=[{ path, content }, ...]. Provide title and at least one of content, sourcePath, sourceDir, or files.",
			promptSnippet: "Publish finished plans, specs, decisions, or multi-file folders to the matter's Git space",
			promptGuidelines: [
				"Use save_space_page for finished deliverables that the user should review or keep (plans, specs, decisions, static HTML prototypes), never for scratch notes or partial drafts.",
				"For multi-file bundles or static prototypes, prefer creating the finished directory on disk with Pi native write/edit and importing it via save_space_page({ title, entryKind: 'folder', sourceDir }) rather than serializing large files into JSON.",
				"Before updating an existing space document, read it first with read_space and pass its pageId and current revision.",
			],
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
					sourceDir: {
						type: "string",
						description:
							"Workspace-relative or absolute directory inside the current workspace to import as a folder entry (skips .git, node_modules, dist, .env*; max 50 UTF-8 text files).",
					},
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
