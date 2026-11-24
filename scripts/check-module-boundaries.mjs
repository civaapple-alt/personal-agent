import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const IMPORT_RE =
	/(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

const SOURCE_EXT_RE = /\.(?:ts|tsx|js|mjs)$/;

function toPosix(path) {
	return path.replaceAll("\\", "/");
}

/** Extract static and dynamic module specifiers from a source file. */
export function extractSpecifiers(source) {
	// Strip line and block comments to avoid matching prose examples.
	const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
	const specifiers = [];
	for (const match of stripped.matchAll(IMPORT_RE)) {
		const spec = match[1] ?? match[2];
		if (spec) specifiers.push(spec);
	}
	return specifiers;
}

function collectFiles(rootDir, subdirs) {
	const results = [];
	const visit = (dir) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
			throw error;
		}
		for (const entry of entries) {
			if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
			const full = resolve(dir, entry.name);
			if (entry.isDirectory()) visit(full);
			else if (entry.isFile() && SOURCE_EXT_RE.test(entry.name)) {
				results.push(toPosix(relative(rootDir, full)));
			}
		}
	};
	for (const subdir of subdirs) visit(resolve(rootDir, subdir));
	return results.sort();
}

function resolveTarget(rootDir, fileRel, specifier) {
	if (!specifier.startsWith(".")) return null;
	return toPosix(relative(rootDir, resolve(dirname(resolve(rootDir, fileRel)), specifier)));
}

/** Validate one import edge `(fileRel -> specifier)` against PA's Three-Ring and dual-half extension rules. */
export function checkImportEdge(rootDir, fileRel, specifier) {
	const target = resolveTarget(rootDir, fileRel, specifier);
	const isNodeBuiltin = specifier.startsWith("node:");

	// 1. packages/contracts: pure wire types & runtime only
	if (fileRel.startsWith("packages/contracts/")) {
		if (isNodeBuiltin) return "packages/contracts must stay runtime-neutral (no node:* imports)";
		if (specifier === "react" || specifier.startsWith("react/")) return "packages/contracts must not import react";
		if (specifier.startsWith("@pa/")) return "packages/contracts must not depend on other @pa/* packages";
		if (target && !target.startsWith("packages/contracts/")) {
			return `packages/contracts must not reach outside itself (${target})`;
		}
		return null;
	}

	// 2. packages/extension-api: strict ./server vs ./web split
	if (fileRel === "packages/extension-api/src/web.ts") {
		if (isNodeBuiltin) return "packages/extension-api/web must not import node:*";
		if (specifier.includes("server"))
			return `packages/extension-api/web must not import server module (${specifier})`;
		if (target && !target.startsWith("packages/extension-api/")) return `illegal relative edge (${target})`;
		return null;
	}
	if (fileRel === "packages/extension-api/src/server.ts") {
		if (specifier === "react" || specifier.startsWith("react/")) {
			return "packages/extension-api/server must not import react";
		}
		if (specifier.includes("/web") || target === "packages/extension-api/src/web.ts") {
			return `packages/extension-api/server must not import web module (${specifier})`;
		}
		return null;
	}

	// 3. apps/web: UI Client ring (browser-only, no server/host imports)
	if (fileRel.startsWith("apps/web/")) {
		if (isNodeBuiltin) return "apps/web must not import node:* built-ins";
		if (
			specifier === "@pa/server" ||
			specifier.startsWith("@pa/server/") ||
			specifier === "@pa/cli" ||
			specifier === "@pa/extension-api/server" ||
			/^@pa\/ext-[^/]+\/server(?:\/|$)/.test(specifier)
		) {
			return `apps/web cannot import server/host package (${specifier})`;
		}
		if (
			target &&
			(target.startsWith("packages/server/") ||
				target.startsWith("apps/cli/") ||
				target.startsWith("pi-extensions/") ||
				/^pa-extensions\/[^/]+\/server\//.test(target))
		) {
			return `apps/web cannot import host/server file (${target})`;
		}
		return null;
	}

	// 4. apps/cli: thin launcher (no web UI imports)
	if (fileRel.startsWith("apps/cli/")) {
		if (
			specifier === "react" ||
			specifier.startsWith("react/") ||
			specifier === "@pa/web" ||
			specifier === "@pa/extension-api/web" ||
			/^@pa\/ext-[^/]+\/web(?:\/|$)/.test(specifier)
		) {
			return `apps/cli must not import web package (${specifier})`;
		}
		if (target && (target.startsWith("apps/web/") || /^pa-extensions\/[^/]+\/web\//.test(target))) {
			return `apps/cli must not import web file (${target})`;
		}
		return null;
	}

	// 5. packages/server: Engine Host ring (no apps/* or web halves)
	if (fileRel.startsWith("packages/server/")) {
		if (
			specifier === "react" ||
			specifier.startsWith("react/") ||
			specifier === "@pa/web" ||
			specifier === "@pa/cli" ||
			specifier === "@pa/extension-api/web" ||
			/^@pa\/ext-[^/]+\/web(?:\/|$)/.test(specifier)
		) {
			return `packages/server must not import web/app package (${specifier})`;
		}
		if (target && (target.startsWith("apps/") || /^pa-extensions\/[^/]+\/web\//.test(target))) {
			return `packages/server must not import app/web file (${target})`;
		}
		return null;
	}

	// 6. pa-extensions/<name>/{server,web}: halves never cross-import
	const extMatch = /^pa-extensions\/([^/]+)\/(server|web)\//.exec(fileRel);
	if (extMatch) {
		const [, extName, half] = extMatch;
		if (half === "web") {
			if (isNodeBuiltin) return `pa-extensions/${extName}/web must not import node:*`;
			if (
				specifier === "@pa/server" ||
				specifier.startsWith("@pa/server/") ||
				specifier === "@pa/extension-api/server" ||
				/^@pa\/ext-[^/]+\/server(?:\/|$)/.test(specifier)
			) {
				return `pa-extensions/${extName}/web cannot import server package (${specifier})`;
			}
			if (
				target &&
				(target.startsWith("packages/server/") ||
					target.startsWith("apps/cli/") ||
					target.startsWith("pi-extensions/") ||
					/^pa-extensions\/[^/]+\/server\//.test(target))
			) {
				return `pa-extensions/${extName}/web cannot import server/pi file (${target})`;
			}
		} else {
			if (
				specifier === "react" ||
				specifier.startsWith("react/") ||
				specifier === "@pa/web" ||
				specifier === "@pa/extension-api/web" ||
				/^@pa\/ext-[^/]+\/web(?:\/|$)/.test(specifier)
			) {
				return `pa-extensions/${extName}/server cannot import web package (${specifier})`;
			}
			if (target && (target.startsWith("apps/web/") || /^pa-extensions\/[^/]+\/web\//.test(target))) {
				return `pa-extensions/${extName}/server cannot import web file (${target})`;
			}
		}
		return null;
	}

	// 7. pi-extensions/*: portable Pi packages, never depend on PA host/app packages
	if (fileRel.startsWith("pi-extensions/")) {
		if (specifier.startsWith("@pa/")) {
			return `pi-extensions must stay portable (cannot import ${specifier})`;
		}
		if (
			target &&
			(target.startsWith("packages/") || target.startsWith("apps/") || target.startsWith("pa-extensions/"))
		) {
			return `pi-extensions must stay portable (cannot import ${target})`;
		}
		return null;
	}

	return null;
}

export function checkModuleBoundaries(rootDir) {
	const files = collectFiles(rootDir, ["apps", "packages", "pa-extensions", "pi-extensions"]);
	const violations = [];
	for (const fileRel of files) {
		const source = readFileSync(resolve(rootDir, fileRel), "utf8");
		for (const specifier of extractSpecifiers(source)) {
			const reason = checkImportEdge(rootDir, fileRel, specifier);
			if (reason) violations.push({ file: fileRel, specifier, reason });
		}
	}
	return { filesChecked: files.length, violations };
}

const isMain = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	const rootDir = fileURLToPath(new URL("../", import.meta.url));
	const { filesChecked, violations } = checkModuleBoundaries(rootDir);
	if (violations.length > 0) {
		for (const item of violations) {
			console.error(`BOUNDARY VIOLATION ${item.file} -> "${item.specifier}": ${item.reason}`);
		}
		process.exitCode = 1;
	} else {
		console.log(`PASS module boundaries (${filesChecked} files across apps, packages, pa-extensions, pi-extensions)`);
	}
}
