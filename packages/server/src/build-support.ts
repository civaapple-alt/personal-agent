import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const builtinExtensionPaths = {
	"worker-runtime": "pa-extensions/worker-runtime/pi/index.ts",
	"workbench-help": "pa-extensions/workbench-help/pi/index.ts",
	space: "pa-extensions/space/pi/index.ts",
	delegation: "pa-extensions/delegation/pi/index.ts",
	"skill-capture": "pa-extensions/skill-capture/pi/index.ts",
	workflow: "pa-extensions/workflow/pi/index.ts",
	"skill-catalog": "pi-extensions/skill-catalog/index.ts",
	"human-question": "pi-extensions/human-question/index.ts",
	"role-skills": "pi-extensions/role-skills",
	visualize: "pi-extensions/visualize/index.ts",
} as const;

export type BuiltinExtensionKind = keyof typeof builtinExtensionPaths;

/**
 * Single authoritative manifest of runtime assets that any Personal Agent launcher
 * (`apps/cli`, future desktop shells, release packagers, startup checks) must ship alongside the host.
 */
export const PA_RUNTIME_ASSET_MANIFEST = {
	rolesDir: "roles",
	webDistDir: "apps/web/dist",
	legacyWebDistDir: "web/dist",
	workflowSkillsDir: "pa-extensions/workflow/skills",
	builtinSkillsDir: "pi-extensions/role-skills/skills",
	builtinExtensions: builtinExtensionPaths,
} as const;

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

/** Resolve a built-in Pi extension entry in the current source or packaged installation. */
export function resolveBuiltinExtensionPath(kind: BuiltinExtensionKind): string {
	return resolveRepoAssetPath(builtinExtensionPaths[kind], import.meta.url);
}
