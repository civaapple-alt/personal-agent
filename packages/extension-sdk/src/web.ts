import type { PaToolDisplayContext, PaToolDisplaySpec, PaWebExtension } from "@pa/extension-api/web";
import { PA_EXTENSION_SDK_API_VERSION } from "./manifest.ts";

export type { PaToolDisplayContext, PaToolDisplaySpec };

/** Curated external web extension contract (browser-only, stable v1.0 subset). */
export type ExternalWebExtension = Pick<PaWebExtension, "name" | "title" | "description" | "toolDisplays"> & {
	readonly apiVersion: typeof PA_EXTENSION_SDK_API_VERSION;
};

export function defineExternalWebExtension<T extends Omit<ExternalWebExtension, "apiVersion">>(
	extension: T,
): T & { readonly apiVersion: typeof PA_EXTENSION_SDK_API_VERSION } {
	return {
		apiVersion: PA_EXTENSION_SDK_API_VERSION,
		...extension,
	};
}
