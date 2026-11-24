import type {
	PaToolDisplayContext,
	PaToolDisplaySpec,
	PaToolRenderer,
	PaToolRendererRegistration,
	PaToolRenderProps,
	PaWebExtension,
} from "@pa/extension-api/web";
import { PA_EXTENSION_SDK_API_VERSION } from "./manifest.ts";

export type { PaToolDisplayContext, PaToolDisplaySpec, PaToolRenderer, PaToolRendererRegistration, PaToolRenderProps };

/** Curated external web extension contract (browser-only, stable v1.0 subset). */
export type ExternalWebExtension = Pick<
	PaWebExtension,
	"name" | "title" | "description" | "toolDisplays" | "toolRenderers"
> & {
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
