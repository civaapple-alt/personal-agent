import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const builtinExtensionPaths = {
	"team-extension": "pi-extensions/team-extension/index.ts",
	"skill-catalog": "pi-extensions/skill-catalog/index.ts",
	"human-question": "pi-extensions/human-question/index.ts",
	"role-skills": "pi-extensions/role-skills",
} as const;

export type BuiltinExtensionKind = keyof typeof builtinExtensionPaths;

/**
 * Locate the PA repository/installation root across source workspaces, compiled `dist/`,
 * and bundled CLI artifacts (`apps/cli/dist/main.js`).
 */
export function resolveRepoRoot(fromUrl: string = import.meta.url): string {
	let current = dirname(fileURLToPath(fromUrl));
	for (let depth = 0; depth < 8; depth += 1) {
		if (existsSync(join(current, "pi-extensions"))) return current;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return process.cwd();
}

/** Resolve a repository asset path in the current source or packaged installation. */
export function resolveRepoAssetPath(relativePath: string, fromUrl: string = import.meta.url): string {
	return resolve(resolveRepoRoot(fromUrl), relativePath);
}

/** Resolve the extension entry in the current source or packaged installation. */
export function resolveBuiltinExtensionPath(kind: BuiltinExtensionKind): string {
	return resolveRepoAssetPath(builtinExtensionPaths[kind], import.meta.url);
}
