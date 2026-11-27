#!/usr/bin/env node
// File-size health check gate: blocks any source/CSS file reaching >=1000 lines with zero exemptions.
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(process.cwd());
const SCAN_ROOTS = ["apps", "packages", "pa-extensions", "pi-extensions"];
const EXT_RE = /\.(?:ts|tsx|css)$/;

function parseLimit(argv) {
	const idx = argv.indexOf("--limit");
	if (idx >= 0) {
		const parsed = Number(argv[idx + 1]);
		if (!Number.isFinite(parsed) || parsed < 100) {
			throw new Error("--limit must be a number >= 100");
		}
		return Math.trunc(parsed);
	}
	return 1000;
}

async function collectFiles(dir, results = []) {
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
			await collectFiles(full, results);
		} else if (entry.isFile() && EXT_RE.test(entry.name)) {
			results.push(full);
		}
	}
	return results;
}

const limit = parseLimit(process.argv.slice(2));
const allFiles = [];
for (const root of SCAN_ROOTS) {
	await collectFiles(join(ROOT, root), allFiles);
}

const violations = [];
for (const file of allFiles.sort()) {
	const rel = relative(ROOT, file).replaceAll("\\", "/");
	const content = await readFile(file, "utf8");
	const lines = content === "" ? 0 : content.replace(/\n$/, "").split("\n").length;
	if (lines >= limit) {
		violations.push(`${rel}: ${lines} lines (>= ${limit} limit)`);
	}
}

if (violations.length > 0) {
	console.error(`FAIL check:sizes (${violations.length} violation(s)):`);
	for (const item of violations) {
		console.error(`  - ${item}`);
	}
	process.exitCode = 1;
} else {
	console.log(`PASS file-sizes (${allFiles.length} source/CSS files checked, all <${limit} lines, 0 exemptions)`);
}
