#!/usr/bin/env node
// File-size health check gate: blocks new >=1000-line files and enforces baselines on legacy watchlist files.
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(process.cwd());
const SCAN_ROOTS = ["apps", "packages", "pa-extensions", "pi-extensions"];
const EXT_RE = /\.(?:ts|tsx|css)$/;

// Pre-existing 0.9.0 files not covered by P-0902; cannot grow past their recorded baseline.
const WATCHLIST_MAX_LINES = new Map([
	["apps/web/src/styles/board.css", 1245],
	["apps/web/src/styles/shell.css", 1159],
	["apps/web/src/styles/chat-cards.css", 1075],
	["apps/web/src/components/chat/MatterBoardPane.tsx", 1075],
	["packages/server/src/storage/repos/board-repo.ts", 1010],
]);

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
const watchlistReport = [];

for (const file of allFiles.sort()) {
	const rel = relative(ROOT, file).replaceAll("\\", "/");
	const content = await readFile(file, "utf8");
	const lines = content === "" ? 0 : content.replace(/\n$/, "").split("\n").length;
	const baseline = WATCHLIST_MAX_LINES.get(rel);
	if (baseline !== undefined) {
		watchlistReport.push({ rel, lines, baseline });
		if (lines > baseline) {
			violations.push(`${rel}: ${lines} lines exceeds watchlist baseline (${baseline})`);
		}
	} else if (lines >= limit) {
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
	console.log(
		`PASS file-sizes (${allFiles.length} source/CSS files checked, default limit <${limit} lines; ${watchlistReport.length} legacy watchlist items within baseline)`,
	);
}
