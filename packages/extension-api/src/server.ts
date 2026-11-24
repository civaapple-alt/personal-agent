import type { PaExtensionKind, PaExtensionSummary } from "@pa/contracts/extensions";

/**
 * RPC-subprocess extension descriptor for the PA Engine Host.
 * PA always drives Pi via RPC subprocesses ("Influence by feeding, never by assembling"),
 * so a server extension declares which Pi extension entries/packages, tools, skills, and
 * environment variables it contributes to a worker session.
 */
export interface PaServerExtension {
	readonly name: string;
	readonly title: string;
	readonly description: string;
	readonly kind: PaExtensionKind;
	/** Tool names owned or governed by this extension. */
	readonly tools: readonly string[];
	/** Optional upstream npm Pi package name wrapped by this extension (e.g. `pi-web-access`). */
	readonly piPackage?: string;
	/** Optional relative path (from repo root) to a built-in Pi extension entry under `pi-extensions/`. */
	readonly builtinPiEntry?: string;
	/** Optional relative path (from repo root) to a built-in Pi skill package directory under `pi-extensions/`. */
	readonly builtinSkillPackage?: string;
	/** Tool names that pause or stage structured user input. */
	readonly interactiveTools?: readonly string[];
}

export function defineServerExtension<T extends PaServerExtension>(extension: T): T {
	return extension;
}

export function summarizeServerExtension(extension: PaServerExtension): PaExtensionSummary {
	return {
		name: extension.name,
		title: extension.title,
		description: extension.description,
		kind: extension.kind,
		tools: extension.tools,
		...(extension.piPackage ? { piPackage: extension.piPackage } : {}),
	};
}
