import type { PaServerExtension } from "@pa/extension-api/server";
import { PA_EXTENSION_SDK_API_VERSION } from "./manifest.ts";

/**
 * Curated external server extension contract (stable v1.0 subset of `@pa/extension-api/server`).
 * Host-internal hooks (`builtinPiEntry`, `builtinSkillPackage`, `workflowRule`, `workflowSkillDir`,
 * `supersedesPackages`) are intentionally excluded.
 */
export type ExternalServerExtension = Pick<
	PaServerExtension,
	"name" | "title" | "description" | "tools" | "piPackage" | "interactiveTools"
> & {
	readonly apiVersion: typeof PA_EXTENSION_SDK_API_VERSION;
};

export function defineExternalServerExtension<T extends Omit<ExternalServerExtension, "apiVersion">>(
	extension: T,
): T & { readonly apiVersion: typeof PA_EXTENSION_SDK_API_VERSION } {
	return {
		apiVersion: PA_EXTENSION_SDK_API_VERSION,
		...extension,
	};
}
