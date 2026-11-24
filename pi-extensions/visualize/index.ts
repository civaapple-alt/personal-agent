/**
 * Portable Pi extension registering the `visualize` tool for Mermaid diagrams,
 * side-by-side option comparisons, and file previews.
 * Adapted from JetBrains ThinkRail's `@thinkrail/pi-visualize` (Apache-2.0) for zero-dependency Node ESM.
 */

export interface ComparisonOption {
	name: string;
	description?: string;
	pros?: string[];
	cons?: string[];
	recommended?: boolean;
	mermaid?: string;
}

export interface VisualizeParams {
	type: "diagram" | "comparison" | "file";
	title?: string;
	mermaid?: string;
	options?: ComparisonOption[];
	path?: string;
	before?: string;
}

export interface VisualizeExtensionApi {
	registerTool(definition: {
		name: string;
		label: string;
		description: string;
		promptSnippet?: string;
		parameters: Record<string, unknown>;
		execute(
			toolCallId: string,
			params: VisualizeParams,
			signal?: AbortSignal,
			onUpdate?: unknown,
			ctx?: { cwd?: string },
		): Promise<{ content: Array<{ type: "text"; text: string }>; details?: unknown }>;
	}): void;
}

export function validateVisualizeParams(params: unknown): VisualizeParams {
	if (!params || typeof params !== "object" || Array.isArray(params)) {
		throw new Error("visualize: parameters must be an object");
	}
	const rec = params as Record<string, unknown>;
	const type = rec.type;
	if (type !== "diagram" && type !== "comparison" && type !== "file") {
		throw new Error("visualize: `type` must be 'diagram', 'comparison', or 'file'");
	}
	const title = typeof rec.title === "string" && rec.title.trim() ? rec.title.trim() : undefined;
	if (type === "diagram") {
		if (typeof rec.mermaid !== "string" || !rec.mermaid.trim()) {
			throw new Error("visualize: `mermaid` source is required when type='diagram'");
		}
		return { type, title, mermaid: rec.mermaid.trim() };
	}
	if (type === "file") {
		if (typeof rec.path !== "string" || !rec.path.trim()) {
			throw new Error("visualize: `path` is required when type='file'");
		}
		const before = typeof rec.before === "string" && rec.before.trim() ? rec.before.trim() : undefined;
		return { type, title, path: rec.path.trim(), ...(before ? { before } : {}) };
	}
	if (!Array.isArray(rec.options) || rec.options.length === 0) {
		throw new Error("visualize: non-empty `options` array is required when type='comparison'");
	}
	const options: ComparisonOption[] = [];
	for (const raw of rec.options) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			throw new Error("visualize: each comparison option must be an object");
		}
		const opt = raw as Record<string, unknown>;
		if (typeof opt.name !== "string" || !opt.name.trim()) {
			throw new Error("visualize: each comparison option requires a non-empty `name`");
		}
		options.push({
			name: opt.name.trim(),
			...(typeof opt.description === "string" && opt.description.trim()
				? { description: opt.description.trim() }
				: {}),
			...(Array.isArray(opt.pros)
				? { pros: opt.pros.filter((item): item is string => typeof item === "string" && item.trim().length > 0) }
				: {}),
			...(Array.isArray(opt.cons)
				? { cons: opt.cons.filter((item): item is string => typeof item === "string" && item.trim().length > 0) }
				: {}),
			...(opt.recommended === true ? { recommended: true } : {}),
			...(typeof opt.mermaid === "string" && opt.mermaid.trim() ? { mermaid: opt.mermaid.trim() } : {}),
		});
	}
	return { type, title, options };
}

export function formatVisualizeMarkdown(params: VisualizeParams): string {
	const heading = params.title ? `### ${params.title}\n\n` : "";
	if (params.type === "diagram") {
		return `${heading}\`\`\`mermaid\n${params.mermaid ?? ""}\n\`\`\``;
	}
	if (params.type === "file") {
		const target = params.before ? `\`${params.before}\` → \`${params.path}\`` : `\`${params.path}\``;
		return `${heading}File preview: ${target}`;
	}
	const blocks = (params.options ?? []).map((opt) => {
		const lines = [`#### ${opt.name}${opt.recommended ? " (Recommended)" : ""}`];
		if (opt.description) lines.push(opt.description);
		for (const pro of opt.pros ?? []) lines.push(`- + ${pro}`);
		for (const con of opt.cons ?? []) lines.push(`- - ${con}`);
		if (opt.mermaid) lines.push("", "```mermaid", opt.mermaid, "```");
		return lines.join("\n");
	});
	return `${heading}${blocks.join("\n\n")}`;
}

const VISUALIZE_PARAMETERS = {
	type: "object",
	additionalProperties: false,
	required: ["type"],
	properties: {
		type: {
			type: "string",
			enum: ["diagram", "comparison", "file"],
			description: "'diagram' needs mermaid; 'comparison' needs options; 'file' needs path.",
		},
		title: { type: "string", description: "Optional heading shown above the visualization." },
		mermaid: { type: "string", description: "Raw Mermaid diagram source when type='diagram'." },
		options: {
			type: "array",
			description: "Alternatives being compared when type='comparison'.",
			items: {
				type: "object",
				required: ["name"],
				properties: {
					name: { type: "string" },
					description: { type: "string" },
					pros: { type: "array", items: { type: "string" } },
					cons: { type: "array", items: { type: "string" } },
					recommended: { type: "boolean" },
					mermaid: { type: "string" },
				},
			},
		},
		path: { type: "string", description: "Workspace-relative file path when type='file'." },
		before: { type: "string", description: "Optional previous version path when type='file'." },
	},
};

export function createVisualizeExtension() {
	return (pi: VisualizeExtensionApi): void => {
		pi.registerTool({
			name: "visualize",
			label: "Visualize",
			description:
				"Render a rich visualization card (Mermaid diagram, side-by-side option comparison, or workspace file preview) instead of ASCII art or dense tables.",
			promptSnippet:
				"Show Mermaid diagrams, option comparisons, or file previews as rich visualization cards when explaining architecture, flows, or trade-offs.",
			parameters: VISUALIZE_PARAMETERS,
			async execute(_toolCallId, rawParams) {
				const params = validateVisualizeParams(rawParams);
				const markdown = formatVisualizeMarkdown(params);
				return {
					content: [{ type: "text", text: markdown }],
					details: params,
				};
			},
		});
	};
}

export default createVisualizeExtension();
