import { fileURLToPath } from "node:url";

export const builtinExtensionPaths = {
	"team-extension": "pi-extensions/team-extension/index.ts",
	"pstack-extension": "pi-extensions/pstack-methods/index.ts",
	"human-question": "pi-extensions/human-question/index.ts",
} as const;

export type BuiltinExtensionKind = keyof typeof builtinExtensionPaths;

/** Resolve the extension entry in the current source or packaged installation. */
export function resolveBuiltinExtensionPath(kind: BuiltinExtensionKind): string {
	return fileURLToPath(new URL(`../../${builtinExtensionPaths[kind]}`, import.meta.url));
}
