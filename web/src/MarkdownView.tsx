import type { ReactNode } from "react";

function isSafeUrl(url: string): boolean {
	return url.startsWith("http://") || url.startsWith("https://") || url.startsWith("/");
}

function renderInline(text: string): ReactNode[] {
	const nodes: ReactNode[] = [];
	const tokenPattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;
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

		if (trimmed.startsWith("### ")) {
			blocks.push(
				<h4 key={`h4-${keyIndex++}`} className="md-h3">
					{renderInline(trimmed.slice(4))}
				</h4>,
			);
			i++;
			continue;
		}
		if (trimmed.startsWith("## ")) {
			blocks.push(
				<h3 key={`h3-${keyIndex++}`} className="md-h2">
					{renderInline(trimmed.slice(3))}
				</h3>,
			);
			i++;
			continue;
		}
		if (trimmed.startsWith("# ")) {
			blocks.push(
				<h2 key={`h2-${keyIndex++}`} className="md-h1">
					{renderInline(trimmed.slice(2))}
				</h2>,
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
		while (i < lines.length) {
			const cur = (lines[i] ?? "").trim();
			if (
				cur.length === 0 ||
				cur.startsWith("```") ||
				cur.startsWith("# ") ||
				cur.startsWith("## ") ||
				cur.startsWith("### ") ||
				cur.startsWith("- ") ||
				cur.startsWith("* ") ||
				cur.startsWith("> ") ||
				/^\d+\.\s+/.test(cur)
			) {
				break;
			}
			paraLines.push(cur);
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
