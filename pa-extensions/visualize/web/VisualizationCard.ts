import type { PaToolRenderProps } from "@pa/extension-api/web";
import { createElement as h, useState } from "react";

interface ComparisonOptionView {
	name: string;
	description?: string;
	pros: string[];
	cons: string[];
	recommended: boolean;
	mermaid?: string;
}

function readString(args: Record<string, unknown>, key: string): string | undefined {
	const value = args[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseComparisonOptions(raw: unknown): ComparisonOptionView[] {
	if (!Array.isArray(raw)) return [];
	const items: ComparisonOptionView[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const rec = entry as Record<string, unknown>;
		const name = readString(rec, "name");
		if (!name) continue;
		items.push({
			name,
			description: readString(rec, "description"),
			pros: Array.isArray(rec.pros)
				? rec.pros.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
				: [],
			cons: Array.isArray(rec.cons)
				? rec.cons.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
				: [],
			recommended: rec.recommended === true,
			mermaid: readString(rec, "mermaid"),
		});
	}
	return items;
}

function MermaidCodeCard({ source, title }: { source: string; title?: string }) {
	const [copied, setCopied] = useState(false);
	const handleCopy = () => {
		const nav = (globalThis as { navigator?: { clipboard?: { writeText(text: string): Promise<void> } } }).navigator;
		if (nav?.clipboard) {
			void nav.clipboard.writeText(source).then(() => {
				setCopied(true);
				setTimeout(() => setCopied(false), 1500);
			});
		}
	};
	return h(
		"div",
		{ className: "pa-viz-diagram" },
		h(
			"div",
			{ className: "pa-viz-card-head" },
			h("span", { className: "pa-viz-badge" }, "Mermaid"),
			title ? h("strong", { className: "pa-viz-title" }, title) : null,
			h(
				"button",
				{ type: "button", className: "btn-inline btn-xs", onClick: handleCopy },
				copied ? "已复制" : "复制源码",
			),
		),
		h("pre", { className: "pa-viz-code" }, h("code", null, source)),
	);
}

/** Rich visualization card rendered via `@pa/ext-visualize/web` toolRenderers. */
export function VisualizationCard({ args }: PaToolRenderProps) {
	const kind = readString(args, "type");
	const title = readString(args, "title");

	if (kind === "diagram") {
		const mermaid = readString(args, "mermaid");
		if (!mermaid) return null;
		return h(MermaidCodeCard, { source: mermaid, title });
	}

	if (kind === "file") {
		const path = readString(args, "path");
		const before = readString(args, "before");
		if (!path) return null;
		return h(
			"div",
			{ className: "pa-viz-file" },
			h("span", { className: "pa-viz-badge" }, before ? "前后对比" : "文件预览"),
			title ? h("strong", { className: "pa-viz-title" }, title) : null,
			h("code", { className: "pa-viz-path" }, before ? `${before} → ${path}` : path),
		);
	}

	if (kind === "comparison") {
		const options = parseComparisonOptions(args.options);
		if (options.length === 0) return null;
		return h(
			"div",
			{ className: "pa-viz-comparison" },
			title ? h("div", { className: "pa-viz-title" }, title) : null,
			h(
				"div",
				{ className: "pa-viz-option-grid" },
				options.map((opt) =>
					h(
						"div",
						{ key: opt.name, className: `pa-viz-option-card ${opt.recommended ? "is-recommended" : ""}` },
						h(
							"div",
							{ className: "pa-viz-option-head" },
							h("strong", null, opt.name),
							opt.recommended ? h("span", { className: "pa-viz-rec-badge" }, "推荐") : null,
						),
						opt.description ? h("p", { className: "pa-viz-option-desc" }, opt.description) : null,
						opt.pros.length > 0
							? h(
									"ul",
									{ className: "pa-viz-list is-pros" },
									opt.pros.map((item) => h("li", { key: item }, `✓ ${item}`)),
								)
							: null,
						opt.cons.length > 0
							? h(
									"ul",
									{ className: "pa-viz-list is-cons" },
									opt.cons.map((item) => h("li", { key: item }, `✗ ${item}`)),
								)
							: null,
						opt.mermaid ? h(MermaidCodeCard, { source: opt.mermaid }) : null,
					),
				),
			),
		);
	}

	return null;
}
