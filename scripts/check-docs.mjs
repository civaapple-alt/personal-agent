// Read-only, dependency-free validation of repository Markdown navigation and command references.
import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const ignored = new Set(["node_modules", "dist", ".git", ".data", ".pi"]);
async function markdownFiles(directory) {
	const paths = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (entry.name.startsWith(".") || ignored.has(entry.name)) continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) paths.push(...(await markdownFiles(path)));
		else if (entry.isFile() && entry.name.endsWith(".md")) paths.push(path);
	}
	return paths;
}

function headings(source) {
	const seen = new Map();
	return [...source.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => {
		// This checker supports plain Markdown heading anchors used by the local guides.
		const base = match[1]
			.toLowerCase()
			.replace(/[^\p{L}\p{N}\p{M}_ -]/gu, "")
			.replace(/ /g, "-");
		const index = seen.get(base) ?? 0;
		seen.set(base, index + 1);
		return index ? `${base}-${index}` : base;
	});
}

const { scripts } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
let links = 0;
let commands = 0;
const files = await markdownFiles(root);
const navigation = new Map(files.map((path) => [path, []]));
for (const path of files) {
	const source = await readFile(path, "utf8");
	assert.ok(!source.includes("file://"), `${path}: use repository-relative links`);
	for (const match of source.matchAll(/\bnpm run ([\w:.-]+)/g)) {
		assert.ok(Object.hasOwn(scripts, match[1]), `${path}: missing npm script ${match[1]}`);
		commands++;
	}
	for (const match of source.matchAll(/\bnpm (test|start)\b/g)) {
		assert.ok(Object.hasOwn(scripts, match[1]), `${path}: missing npm script ${match[1]}`);
		commands++;
	}
	for (const match of source.matchAll(/\bnode (?:--test )?([^\n`]+)/g)) {
		for (const argument of match[1]
			.trim()
			.split(/\s+/)
			.filter((arg) => /\.(?:ts|mjs|js)$/.test(arg))) {
			// All commands run from the root. Dist paths are checked against the source without requiring a build.
			const entry = argument.startsWith("dist/")
				? argument.replace(/^dist\//, "src/").replace(/\.js$/, ".ts")
				: argument;
			assert.ok((await stat(resolve(root, entry))).isFile(), `${path}: missing Node entry ${entry}`);
			commands++;
		}
	}
	const prose = source.replace(/```[\s\S]*?```/g, "");
	for (const match of prose.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
		const target = match[1];
		if (/^https?:\/\//.test(target)) continue;
		assert.ok(!/^[a-z][a-z\d+.-]*:/i.test(target), `${path}: unsupported link ${target}`);
		const [local, fragment] = target.split("#");
		const destination = local ? resolve(dirname(path), decodeURIComponent(local)) : path;
		const info = await stat(destination);
		if (navigation.has(destination)) navigation.get(path).push(destination);
		if (fragment) {
			assert.ok(info.isFile(), `${path}: anchor needs a file: ${target}`);
			const text = (await readFile(destination, "utf8")).replace(/```[\s\S]*?```/g, "");
			assert.ok(headings(text).includes(decodeURIComponent(fragment)), `${path}: missing anchor ${target}`);
		}
		links++;
	}
}
const reached = new Set();
const pending = [join(root, "AGENTS.md"), join(root, "README.md")].filter((path) => navigation.has(path));
while (pending.length) {
	const path = pending.pop();
	if (reached.has(path)) continue;
	reached.add(path);
	pending.push(...navigation.get(path));
}
for (const path of files) assert.ok(reached.has(path), `Navigation unreachable from root: ${path}`);
console.log(`PASS ${files.length} Markdown files, ${links} local links, ${commands} command references`);
console.log(`PASS all ${reached.size} guides reachable from root navigation`);
console.log("File/command existence only; no commands, remote URLs, diagrams or model requests executed.");
