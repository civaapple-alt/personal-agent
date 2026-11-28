import type { ReactNode } from "react";

function isSafeUrl(url: string): boolean {
	return url.startsWith("http://") || url.startsWith("https://") || url.startsWith("/");
}

function renderInline(text: string): ReactNode[] {
	const nodes: ReactNode[] = [];
	const tokenPattern = /(`[^`]+`|\*\*[^*]+\*\*|~~[^~]+~~|\[[^\]]+\]\([^)]+\))/g;
	let lastIndex = 0;
	let keyIndex = 0;

	for (const match of text.matchAll(tokenPattern)) {
		const index = match.index ?? 0;
		if (index > lastIndex) {
			nodes.push(text.slice(lastIndex, index));
		}
		const token = match[0];
		if (token.startsWith("`") && token.endsWith("`")) {
			nodes.push(
				<code key={`code-${keyIndex++}`} className="md-inline-code">
					{token.slice(1, -1)}
				</code>,
			);
		} else if (token.startsWith("**") && token.endsWith("**")) {
			nodes.push(<strong key={`bold-${keyIndex++}`}>{token.slice(2, -2)}</strong>);
		} else if (token.startsWith("~~") && token.endsWith("~~")) {
			nodes.push(
				<del key={`del-${keyIndex++}`} className="md-del">
					{token.slice(2, -2)}
				</del>,
			);
		} else if (token.startsWith("[")) {
			const closeBracket = token.indexOf("](");
			const label = token.slice(1, closeBracket);
			const url = token.slice(closeBracket + 2, -1).trim();
			if (isSafeUrl(url)) {
				nodes.push(
					<a key={`link-${keyIndex++}`} href={url} target="_blank" rel="noreferrer" className="md-link">
						{label}
					</a>,
				);
			} else {
				nodes.push(token);
			}
		}
		lastIndex = index + token.length;
	}

	if (lastIndex < text.length) {
		nodes.push(text.slice(lastIndex));
	}
	return nodes;
}

function renderTableCell(text: string): ReactNode {
	const segments = text.split(/<br\s*\/?>/i);
	if (segments.length <= 1) {
		return renderInline(text);
	}
	let segKey = 0;
	return segments.map((seg, idx) => (
		<span key={`seg-${segKey++}-${seg.slice(0, 8)}`}>
			{idx > 0 && <br />}
			{renderInline(seg.trim())}
		</span>
	));
}

function splitTableRow(rawLine: string): string[] {
	let line = rawLine.trim();
	if (line.startsWith("|")) {
		line = line.slice(1);
	}
	if (line.endsWith("|") && !line.endsWith("\\|")) {
		line = line.slice(0, -1);
	}

	const cells: string[] = [];
	let current = "";
	let inBackticks = false;

	for (let i = 0; i < line.length; i++) {
		const ch = line[i] ?? "";
		const next = line[i + 1] ?? "";
		if (ch === "\\" && next === "|") {
			current += "|";
			i++;
			continue;
		}
		if (ch === "`") {
			inBackticks = !inBackticks;
			current += ch;
			continue;
		}
		if (ch === "|" && !inBackticks) {
			cells.push(current.trim());
			current = "";
			continue;
		}
		current += ch;
	}
	cells.push(current.trim());
	return cells;
}

type CellAlign = "left" | "center" | "right";

function alignClass(align: CellAlign | undefined): string {
	if (align === "center") return "text-center";
	if (align === "right") return "text-right";
	return "text-left";
}

function parseTableAlignments(separatorLine: string): CellAlign[] | null {
	const trimmed = separatorLine.trim();
	if (!trimmed.includes("|") || !trimmed.includes("-")) return null;
	const cells = splitTableRow(trimmed);
	if (cells.length === 0) return null;

	const alignments: CellAlign[] = [];
	for (const cell of cells) {
		const token = cell.replace(/\s+/g, "");
		if (!/^:?-{1,}:?$/.test(token)) {
			return null;
		}
		if (token.startsWith(":") && token.endsWith(":")) {
			alignments.push("center");
		} else if (token.endsWith(":")) {
			alignments.push("right");
		} else {
			alignments.push("left");
		}
	}
	return alignments;
}

function isHorizontalRule(trimmed: string): boolean {
	return /^(-{3,}|\*{3,}|_{3,})$/.test(trimmed.replace(/\s+/g, ""));
}

function isTableStart(lines: string[], index: number): boolean {
	const header = (lines[index] ?? "").trim();
	const sep = (lines[index + 1] ?? "").trim();
	if (!header.includes("|") || !sep) return false;
	const alignments = parseTableAlignments(sep);
	if (!alignments) return false;
	const headers = splitTableRow(header);
	return headers.length > 0 && headers.some((h) => h.length > 0);
}

function isBlockStart(lines: string[], index: number): boolean {
	const cur = (lines[index] ?? "").trim();
	if (cur.length === 0) return true;
	if (cur.startsWith("```")) return true;
	if (/^#{1,4}\s+/.test(cur)) return true;
	if (cur.startsWith("- ") || cur.startsWith("* ")) return true;
	if (cur.startsWith("> ")) return true;
	if (/^\d+\.\s+/.test(cur)) return true;
	if (isHorizontalRule(cur)) return true;
	if (isTableStart(lines, index)) return true;
	return false;
}

export function MarkdownView(props: { content: string }): ReactNode {
	const lines = props.content.replaceAll("\r\n", "\n").split("\n");
	const blocks: ReactNode[] = [];
	let i = 0;
	let keyIndex = 0;

	while (i < lines.length) {
		const line = lines[i] ?? "";
		const trimmed = line.trim();

		if (trimmed.length === 0) {
			i++;
			continue;
		}

		if (trimmed.startsWith("```")) {
			const lang = trimmed.slice(3).trim();
			const codeLines: string[] = [];
			i++;
			while (i < lines.length && !(lines[i] ?? "").trim().startsWith("```")) {
				codeLines.push(lines[i] ?? "");
				i++;
			}
			i++;
			blocks.push(
				<pre key={`pre-${keyIndex++}`} className="md-pre" data-lang={lang || undefined}>
					<code>{codeLines.join("\n")}</code>
				</pre>,
			);
			continue;
		}

		if (isTableStart(lines, i)) {
			const headers = splitTableRow(trimmed);
			const rawAlignments = parseTableAlignments(lines[i + 1] ?? "") ?? [];
			const colCount = Math.max(headers.length, rawAlignments.length);
			const alignments: CellAlign[] = Array.from(
				{ length: colCount },
				(_, colIdx) => rawAlignments[colIdx] ?? "left",
			);
			const normalizedHeaders = Array.from({ length: colCount }, (_, colIdx) => headers[colIdx] ?? "");
			i += 2;

			const bodyRows: string[][] = [];
			while (i < lines.length) {
				const rowLine = (lines[i] ?? "").trim();
				if (rowLine.length === 0 || !rowLine.includes("|") || isHorizontalRule(rowLine)) {
					break;
				}
				const parsed = splitTableRow(rowLine);
				bodyRows.push(Array.from({ length: colCount }, (_, colIdx) => parsed[colIdx] ?? ""));
				i++;
			}

			blocks.push(
				<div key={`tbl-${keyIndex++}`} className="md-table-wrap">
					<table className="md-table">
						<thead>
							<tr>
								{normalizedHeaders.map((cell, colIdx) => (
									<th key={`th-${keyIndex++}`} className={alignClass(alignments[colIdx])}>
										{renderTableCell(cell)}
									</th>
								))}
							</tr>
						</thead>
						{bodyRows.length > 0 && (
							<tbody>
								{bodyRows.map((row) => (
									<tr key={`tr-${keyIndex++}`}>
										{row.map((cell, colIdx) => (
											<td key={`td-${keyIndex++}`} className={alignClass(alignments[colIdx])}>
												{renderTableCell(cell)}
											</td>
										))}
									</tr>
								))}
							</tbody>
						)}
					</table>
				</div>,
			);
			continue;
		}

		if (isHorizontalRule(trimmed)) {
			blocks.push(<hr key={`hr-${keyIndex++}`} className="md-hr" />);
			i++;
			continue;
		}

		const headingMatch = /^(#{1,4})\s+(.*)$/.exec(trimmed);
		if (headingMatch) {
			const level = headingMatch[1]?.length ?? 1;
			const headingText = headingMatch[2] ?? "";
			const cls = level === 1 ? "md-h1" : level === 2 ? "md-h2" : "md-h3";
			blocks.push(
				<div key={`h-${keyIndex++}`} className={cls}>
					{renderInline(headingText)}
				</div>,
			);
			i++;
			continue;
		}

		if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
			const items: string[] = [];
			while (i < lines.length) {
				const cur = (lines[i] ?? "").trim();
				if (cur.startsWith("- ") || cur.startsWith("* ")) {
					items.push(cur.slice(2));
					i++;
				} else {
					break;
				}
			}
			blocks.push(
				<ul key={`ul-${keyIndex++}`} className="md-list">
					{items.map((item) => (
						<li key={`li-${keyIndex++}`}>{renderInline(item)}</li>
					))}
				</ul>,
			);
			continue;
		}

		if (/^\d+\.\s+/.test(trimmed)) {
			const items: string[] = [];
			while (i < lines.length) {
				const cur = (lines[i] ?? "").trim();
				const match = /^\d+\.\s+(.*)$/.exec(cur);
				if (match?.[1] !== undefined) {
					items.push(match[1]);
					i++;
				} else {
					break;
				}
			}
			blocks.push(
				<ol key={`ol-${keyIndex++}`} className="md-list md-olist">
					{items.map((item) => (
						<li key={`oli-${keyIndex++}`}>{renderInline(item)}</li>
					))}
				</ol>,
			);
			continue;
		}

		if (trimmed.startsWith("> ")) {
			const quoteLines: string[] = [];
			while (i < lines.length && (lines[i] ?? "").trim().startsWith("> ")) {
				quoteLines.push((lines[i] ?? "").trim().slice(2));
				i++;
			}
			blocks.push(
				<blockquote key={`bq-${keyIndex++}`} className="md-quote">
					{renderInline(quoteLines.join(" "))}
				</blockquote>,
			);
			continue;
		}

		const paraLines: string[] = [];
		while (i < lines.length && !isBlockStart(lines, i)) {
			paraLines.push((lines[i] ?? "").trim());
			i++;
		}
		blocks.push(
			<p key={`p-${keyIndex++}`} className="md-p">
				{renderInline(paraLines.join(" "))}
			</p>,
		);
	}

	return <div className="md-body">{blocks}</div>;
}
