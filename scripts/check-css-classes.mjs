#!/usr/bin/env node
// Static gate: verify JSX className tokens in apps/web and pa-extensions/*/web exist in shipped CSS.
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(process.cwd());
const CSS_ROOTS = [join(ROOT, "apps/web/src"), join(ROOT, "pa-extensions")];
const TSX_ROOTS = [join(ROOT, "apps/web/src"), join(ROOT, "pa-extensions")];

// Known semantic/state/SVG marker classes intentionally used without standalone CSS rules.
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
]);

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

/** Extract all class selector names defined in CSS source (handles @media / @supports nesting). */
function extractDefinedCssClasses(cssText) {
	// Strip block comments and quoted strings.
	const cleaned = cssText
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/"(?:\\.|[^"\\])*"/g, '""')
		.replace(/'(?:\\.|[^'\\])*'/g, "''");

	const defined = new Set();
	// Walk brace blocks: accumulate header text before each '{'.
	// If a block is an @-rule wrapper (@media, @supports, @layer, @container), recurse into its body;
	// otherwise the header is a selector list whose `.ident` tokens are defined classes.
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
					// @keyframes, @font-face, @property, etc. — skip body.
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

/** Extract static className tokens from a TSX file along with 1-based line numbers. */
function extractUsedTsxClasses(tsxText) {
	const usages = [];
	const lineAt = (offset) => tsxText.slice(0, offset).split("\n").length;

	// 1. className="a b c" or className='a b c'
	for (const match of tsxText.matchAll(/\bclassName\s*=\s*(?:"([^"]+)"|'([^']+)')/g)) {
		const raw = match[1] ?? match[2] ?? "";
		const line = lineAt(match.index ?? 0);
		for (const token of raw.split(/\s+/).filter(Boolean)) {
			if (/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(token)) {
				usages.push({ token, line });
			}
		}
	}

	// 2. className={`...`} — collect static tokens separated by whitespace (ignore prefix/suffix glued to ${...})
	const tplRe = /\bclassName\s*=\s*\{\s*`([^`]*)`\s*\}/g;
	for (const match of tsxText.matchAll(tplRe)) {
		const raw = match[1] ?? "";
		const line = lineAt(match.index ?? 0);
		// Replace ${...} (non-nested) with a sentinel marker so glued fragments like `is-${x}` are skipped.
		const withSentinel = raw.replace(/\$\{[^}]*\}/g, " __DYN__ ");
		// Also mark directly glued patterns like `is-${x}` or `${x}-card` before replacing
		const rawMarked = raw
			.replace(/[a-zA-Z0-9_-]+\$\{[^}]*\}[a-zA-Z0-9_-]*/g, " ")
			.replace(/\$\{[^}]*\}[a-zA-Z0-9_-]+/g, " ")
			.replace(/[a-zA-Z0-9_-]+\$\{[^}]*\}/g, " ")
			.replace(/\$\{[^}]*\}/g, " ");
		void withSentinel;
		for (const token of rawMarked.split(/\s+/).filter(Boolean)) {
			if (/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(token)) {
				usages.push({ token, line });
			}
		}
	}

	return usages;
}

async function main() {
	const cssFiles = (await Promise.all(CSS_ROOTS.map((dir) => walkFiles(dir, ".css")))).flat();
	const tsxFiles = (await Promise.all(TSX_ROOTS.map((dir) => walkFiles(dir, ".tsx")))).flat();

	const definedClasses = new Set();
	for (const file of cssFiles) {
		const text = await readFile(file, "utf8");
		for (const cls of extractDefinedCssClasses(text)) definedClasses.add(cls);
	}

	const missing = [];
	for (const file of tsxFiles) {
		const text = await readFile(file, "utf8");
		for (const { token, line } of extractUsedTsxClasses(text)) {
			if (!definedClasses.has(token) && !ALLOWED_DYNAMIC_OR_SEMANTIC.has(token)) {
				missing.push({ file: relative(ROOT, file), line, token });
			}
		}
	}

	if (missing.length > 0) {
		console.error(`FAIL css-classes: found ${missing.length} undefined class name(s):`);
		for (const item of missing) {
			console.error(`  ${item.file}:${item.line}  .${item.token}`);
		}
		process.exitCode = 1;
		return;
	}

	console.log(
		`PASS css-classes (${tsxFiles.length} TSX files checked against ${definedClasses.size} CSS classes in ${cssFiles.length} stylesheets)`,
	);
}

await main();
