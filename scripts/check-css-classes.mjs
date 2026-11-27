#!/usr/bin/env node
// Static gate: verify JSX className & cn() tokens in apps/web and pa-extensions/*/web are valid legacy or Tailwind v4 classes.
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { __unstable__loadDesignSystem } from "@tailwindcss/node";

const ROOT = resolve(process.cwd());
const APP_CSS = join(ROOT, "apps/web/src/styles/app.css");
const CSS_ROOTS = [join(ROOT, "apps/web/src"), join(ROOT, "pa-extensions")];
const TSX_ROOTS = [join(ROOT, "apps/web/src"), join(ROOT, "pa-extensions")];

// Known semantic/state/SVG/Tailwind marker classes intentionally used without standalone CSS rules.
const ALLOWED_DYNAMIC_OR_SEMANTIC = new Set([
	"active",
	"selected",
	"disabled",
	"open",
	"closed",
	"expanded",
	"collapsed",
	"compact",
	"error",
	"warn",
	"info",
	"ok",
	"bot-eye",
	"bot-eye-happy",
	"delegation-graph",
	"unified-roster-panel",
	"is-other",
	"adjustment",
	"group",
	"peer",
]);

const TAILWIND_MARKER_RE = /^(?:group|peer)\/[a-zA-Z0-9_-]+$/;
const RAW_HEX_UTILITY_RE = /\[[^\]]*#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b[^\]]*\]/;
const CLASS_CONST_NAME_RE = /^[A-Z0-9_]*(?:CLASS(?:ES|NAME|NAMES)?|_CLS)$/;
const CLASS_HELPER_CALLS = new Set(["cn", "clsx", "classNames"]);

async function walkFiles(dir, ext, results = []) {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return results;
	}
	for (const entry of entries) {
		if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			await walkFiles(full, ext, results);
		} else if (entry.isFile() && entry.name.endsWith(ext)) {
			results.push(full);
		}
	}
	return results;
}

/** Extract all class selector names defined in CSS source (handles @media / @supports / @layer nesting). */
function extractDefinedCssClasses(cssText) {
	const cleaned = cssText
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/"(?:\\.|[^"\\])*"/g, '""')
		.replace(/'(?:\\.|[^'\\])*'/g, "''");

	const defined = new Set();
	let idx = 0;
	const len = cleaned.length;

	function scanBlock(endChar) {
		let buf = "";
		while (idx < len) {
			const ch = cleaned[idx++];
			if (ch === endChar) return;
			if (ch === ";") {
				buf = "";
				continue;
			}
			if (ch === "{") {
				const header = buf.trim();
				buf = "";
				if (/^@(?:media|supports|layer|container|document|scope)\b/i.test(header)) {
					scanBlock("}");
				} else if (/^@/.test(header)) {
					skipBlock();
				} else {
					for (const match of header.matchAll(/\.([a-zA-Z_][a-zA-Z0-9_-]*)/g)) {
						defined.add(match[1]);
					}
					skipBlock();
				}
				continue;
			}
			buf += ch;
		}
	}

	function skipBlock() {
		let depth = 1;
		while (idx < len && depth > 0) {
			const ch = cleaned[idx++];
			if (ch === "{") depth++;
			else if (ch === "}") depth--;
		}
	}

	scanBlock("");
	return defined;
}

function skipLineComment(src, i) {
	while (i < src.length && src[i] !== "\n") i++;
	return i;
}

function skipBlockComment(src, i) {
	i += 2;
	while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
	return Math.min(i + 2, src.length);
}

function readQuotedString(src, start) {
	const quote = src[start];
	let i = start + 1;
	let value = "";
	while (i < src.length) {
		const ch = src[i];
		if (ch === "\\") {
			if (i + 1 < src.length) {
				const next = src[i + 1];
				if (next === "n" || next === "t" || next === "r") value += " ";
				else value += next;
				i += 2;
				continue;
			}
		}
		if (ch === quote) return { value, end: i + 1 };
		if (ch === "\n") value += " ";
		else value += ch;
		i++;
	}
	return { value, end: i };
}

function skipBalanced(src, start, openCh, closeCh) {
	let depth = 1;
	let i = start + 1;
	while (i < src.length && depth > 0) {
		const ch = src[i];
		if (ch === "/" && src[i + 1] === "/") {
			i = skipLineComment(src, i);
			continue;
		}
		if (ch === "/" && src[i + 1] === "*") {
			i = skipBlockComment(src, i);
			continue;
		}
		if (ch === '"' || ch === "'") {
			i = readQuotedString(src, i).end;
			continue;
		}
		if (ch === "`") {
			i = skipTemplate(src, i);
			continue;
		}
		if (ch === openCh) depth++;
		else if (ch === closeCh) depth--;
		i++;
	}
	return i;
}

function skipTemplate(src, start) {
	let i = start + 1;
	while (i < src.length) {
		const ch = src[i];
		if (ch === "\\") {
			i += 2;
			continue;
		}
		if (ch === "`") return i + 1;
		if (ch === "$" && src[i + 1] === "{") {
			i = skipBalanced(src, i + 1, "{", "}");
			continue;
		}
		i++;
	}
	return i;
}

/** Extract class tokens from TSX `className`, `cn(...)`, and `*_CLASSES` declarations. */
function extractUsedTsxClasses(tsxText) {
	const usages = [];
	const lineOffsets = [0];
	for (let i = 0; i < tsxText.length; i++) {
		if (tsxText[i] === "\n") lineOffsets.push(i + 1);
	}
	const lineAt = (offset) => {
		let lo = 0;
		let hi = lineOffsets.length - 1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (lineOffsets[mid] <= offset) lo = mid + 1;
			else hi = mid - 1;
		}
		return hi + 1;
	};

	const pushTokens = (raw, offset) => {
		const line = lineAt(offset);
		for (const token of raw.split(/\s+/)) {
			if (!token) continue;
			// Skip pure punctuation/numbers that are not CSS class names.
			if (/^[0-9]+$/.test(token)) continue;
			usages.push({ token, line });
		}
	};

	const isComparisonBefore = (src, pos) => {
		let j = pos - 1;
		while (j >= 0 && /\s/.test(src[j])) j--;
		return (
			(src[j] === "=" && src[j - 1] === "=") ||
			(src[j] === "=" && src[j - 1] === "!" && src[j - 2] === "!") ||
			(src[j] === "=" && src[j - 1] === "!" && src[j - 2] !== "!")
		);
	};

	const isComparisonAfter = (src, pos) => {
		let j = pos;
		while (j < src.length && /\s/.test(src[j])) j++;
		return src.startsWith("===", j) || src.startsWith("!==", j) || src.startsWith("==", j) || src.startsWith("!=", j);
	};

	const isObjectKeyAfter = (src, pos) => {
		let j = pos;
		while (j < src.length && /\s/.test(src[j])) j++;
		return src[j] === ":";
	};

	function scanTemplate(start, allowObjectValues) {
		let i = start + 1;
		let chunkStart = i;
		let chunk = "";
		let gluedStart = false;

		const flushChunk = (gluedEnd) => {
			let text = chunk;
			if (gluedStart) text = text.replace(/^\S+/, "");
			if (gluedEnd) text = text.replace(/\S+$/, "");
			if (text.trim()) pushTokens(text, chunkStart);
			chunk = "";
		};

		while (i < tsxText.length) {
			const ch = tsxText[i];
			if (ch === "\\") {
				if (i + 1 < tsxText.length) {
					const next = tsxText[i + 1];
					chunk += next === "n" || next === "t" || next === "r" ? " " : next;
					i += 2;
					continue;
				}
			}
			if (ch === "`") {
				flushChunk(false);
				return i + 1;
			}
			if (ch === "$" && tsxText[i + 1] === "{") {
				flushChunk(true);
				i = scanExpr(i + 2, "}", false, allowObjectValues);
				chunkStart = i;
				gluedStart = true;
				continue;
			}
			chunk += ch;
			i++;
		}
		flushChunk(false);
		return i;
	}

	function scanExpr(start, endChar, isObjectMap, allowNestedObjects) {
		let i = start;
		let lastIdent = "";
		while (i < tsxText.length) {
			const ch = tsxText[i];
			if (ch === endChar) return i + 1;
			if (ch === "/" && tsxText[i + 1] === "/") {
				i = skipLineComment(tsxText, i);
				continue;
			}
			if (ch === "/" && tsxText[i + 1] === "*") {
				i = skipBlockComment(tsxText, i);
				continue;
			}
			if (ch === '"' || ch === "'") {
				const strStart = i;
				const { value, end } = readQuotedString(tsxText, i);
				const skip =
					isComparisonBefore(tsxText, strStart) ||
					isComparisonAfter(tsxText, end) ||
					isObjectKeyAfter(tsxText, end);
				if (!skip && value.trim()) pushTokens(value, strStart);
				i = end;
				lastIdent = "";
				continue;
			}
			if (ch === "`") {
				i = scanTemplate(i, allowNestedObjects);
				lastIdent = "";
				continue;
			}
			if (ch === "{") {
				if (isObjectMap || allowNestedObjects) {
					i = scanExpr(i + 1, "}", true, false);
				} else {
					i = skipBalanced(tsxText, i, "{", "}");
				}
				lastIdent = "";
				continue;
			}
			if (ch === "[") {
				i = skipBalanced(tsxText, i, "[", "]");
				lastIdent = "";
				continue;
			}
			if (ch === "(") {
				if (!lastIdent || CLASS_HELPER_CALLS.has(lastIdent)) {
					i = scanExpr(i + 1, ")", false, allowNestedObjects);
				} else {
					i = skipBalanced(tsxText, i, "(", ")");
				}
				lastIdent = "";
				continue;
			}
			if (/[a-zA-Z_$]/.test(ch)) {
				const m = /^[a-zA-Z_$][a-zA-Z0-9_$]*/.exec(tsxText.slice(i));
				lastIdent = m ? m[0] : "";
				i += lastIdent.length;
				continue;
			}
			if (!/\s/.test(ch)) lastIdent = "";
			i++;
		}
		return i;
	}

	let i = 0;
	while (i < tsxText.length) {
		const ch = tsxText[i];
		if (ch === "/" && tsxText[i + 1] === "/") {
			i = skipLineComment(tsxText, i);
			continue;
		}
		if (ch === "/" && tsxText[i + 1] === "*") {
			i = skipBlockComment(tsxText, i);
			continue;
		}
		if (ch === '"' || ch === "'") {
			i = readQuotedString(tsxText, i).end;
			continue;
		}
		if (ch === "`") {
			i = skipTemplate(tsxText, i);
			continue;
		}

		// Match JSX attribute `className=...`
		if (
			tsxText.startsWith("className", i) &&
			(i === 0 || !/[a-zA-Z0-9_$]/.test(tsxText[i - 1])) &&
			!/[a-zA-Z0-9_$]/.test(tsxText[i + 9] ?? "")
		) {
			let j = i + 9;
			while (j < tsxText.length && /\s/.test(tsxText[j])) j++;
			if (tsxText[j] === "=") {
				j++;
				while (j < tsxText.length && /\s/.test(tsxText[j])) j++;
				if (tsxText[j] === '"' || tsxText[j] === "'") {
					const { value, end } = readQuotedString(tsxText, j);
					if (value.trim()) pushTokens(value, j);
					i = end;
					continue;
				}
				if (tsxText[j] === "{") {
					i = scanExpr(j + 1, "}", false, false);
					continue;
				}
			}
		}

		// Match `cn(...)` / `clsx(...)` calls
		if (/[a-zA-Z_$]/.test(ch) && (i === 0 || !/[a-zA-Z0-9_$.]/.test(tsxText[i - 1]))) {
			const identMatch = /^[a-zA-Z_$][a-zA-Z0-9_$]*/.exec(tsxText.slice(i));
			if (identMatch) {
				const ident = identMatch[0];
				let j = i + ident.length;
				while (j < tsxText.length && /\s/.test(tsxText[j])) j++;
				if (CLASS_HELPER_CALLS.has(ident) && tsxText[j] === "(") {
					i = scanExpr(j + 1, ")", false, false);
					continue;
				}
				// Match `const VARIANT_CLASSES ... = { ... }` or `const BASE_CLASS = "..."`
				if (ident === "const") {
					const nameMatch = /^([A-Z0-9_]+)/.exec(tsxText.slice(j));
					if (nameMatch && CLASS_CONST_NAME_RE.test(nameMatch[1])) {
						j += nameMatch[0].length;
						// Skip optional type annotation `: Type` until top-level `=`
						let angleDepth = 0;
						let parenDepth = 0;
						let braceDepth = 0;
						let bracketDepth = 0;
						while (j < tsxText.length) {
							const c = tsxText[j];
							if (c === "<") angleDepth++;
							else if (c === ">" && tsxText[j - 1] !== "=" && angleDepth > 0) angleDepth--;
							else if (c === "(") parenDepth++;
							else if (c === ")" && parenDepth > 0) parenDepth--;
							else if (c === "{") braceDepth++;
							else if (c === "}" && braceDepth > 0) braceDepth--;
							else if (c === "[") bracketDepth++;
							else if (c === "]" && bracketDepth > 0) bracketDepth--;
							else if (
								c === "=" &&
								tsxText[j + 1] !== ">" &&
								angleDepth === 0 &&
								parenDepth === 0 &&
								braceDepth === 0 &&
								bracketDepth === 0
							) {
								j++;
								while (j < tsxText.length && /\s/.test(tsxText[j])) j++;
								if (tsxText[j] === '"' || tsxText[j] === "'") {
									const { value, end } = readQuotedString(tsxText, j);
									if (value.trim()) pushTokens(value, j);
									i = end;
								} else if (tsxText[j] === "{") {
									i = scanExpr(j + 1, "}", true, false);
								} else {
									i = j;
								}
								break;
							} else if (c === ";") {
								i = j + 1;
								break;
							}
							j++;
						}
						continue;
					}
				}
				i += ident.length;
				continue;
			}
		}

		i++;
	}

	return usages;
}

async function main() {
	const cssFiles = (await Promise.all(CSS_ROOTS.map((dir) => walkFiles(dir, ".css")))).flat();
	const tsxFiles = (await Promise.all(TSX_ROOTS.map((dir) => walkFiles(dir, ".tsx")))).flat();

	const definedClasses = new Set();
	let legacySheetCount = 0;
	for (const file of cssFiles) {
		if (file === APP_CSS) continue;
		legacySheetCount++;
		const text = await readFile(file, "utf8");
		for (const cls of extractDefinedCssClasses(text)) definedClasses.add(cls);
	}

	const appCssText = await readFile(APP_CSS, "utf8");
	const designSystem = await __unstable__loadDesignSystem(appCssText, { base: dirname(APP_CSS) });

	const allUsages = [];
	const unknownTokens = new Set();
	const forbiddenHex = [];

	for (const file of tsxFiles) {
		const text = await readFile(file, "utf8");
		const rel = relative(ROOT, file);
		for (const { token, line } of extractUsedTsxClasses(text)) {
			allUsages.push({ file: rel, line, token });
			if (RAW_HEX_UTILITY_RE.test(token)) {
				forbiddenHex.push({ file: rel, line, token });
				continue;
			}
			if (definedClasses.has(token) || ALLOWED_DYNAMIC_OR_SEMANTIC.has(token) || TAILWIND_MARKER_RE.test(token)) {
				continue;
			}
			unknownTokens.add(token);
		}
	}

	const candidateList = Array.from(unknownTokens);
	const compiledCss = candidateList.length > 0 ? designSystem.candidatesToCss(candidateList) : [];
	const invalidTokens = new Set();
	for (let idx = 0; idx < candidateList.length; idx++) {
		if (!compiledCss[idx]) invalidTokens.add(candidateList[idx]);
	}

	const missing = allUsages.filter((item) => invalidTokens.has(item.token));

	if (forbiddenHex.length > 0 || missing.length > 0) {
		if (forbiddenHex.length > 0) {
			console.error(`FAIL css-classes: found ${forbiddenHex.length} raw hex color Tailwind utility(ies):`);
			for (const item of forbiddenHex) {
				console.error(`  ${item.file}:${item.line}  ${item.token} (use semantic tokens instead of raw hex)`);
			}
		}
		if (missing.length > 0) {
			console.error(`FAIL css-classes: found ${missing.length} undefined class name(s):`);
			for (const item of missing) {
				console.error(`  ${item.file}:${item.line}  .${item.token}`);
			}
		}
		process.exitCode = 1;
		return;
	}

	const validTailwindCount = candidateList.length - invalidTokens.size;
	console.log(
		`PASS css-classes (${tsxFiles.length} TSX files checked against ${definedClasses.size} legacy classes in ${legacySheetCount} stylesheets + ${validTailwindCount} Tailwind utilities)`,
	);
}

await main();
