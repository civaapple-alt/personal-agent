import type { PaExtensionSummary } from "@pa/contracts/extensions";
import humanQuestion from "@pa/ext-human-question/server";
import skillCatalog from "@pa/ext-skill-catalog/server";
import teamExtension from "@pa/ext-team-extension/server";
import webAccess from "@pa/ext-web-access/server";
import workflow from "@pa/ext-workflow/server";
import { type PaServerExtension, summarizeServerExtension } from "@pa/extension-api/server";

export interface ServerExtensionEntry {
	readonly specifier: string;
	readonly extension: PaServerExtension;
}

/** Static registry of all built-in PA server extensions (RPC subprocess assembly + governance). */
export const builtinServerExtensions: readonly ServerExtensionEntry[] = [
	{ specifier: "@pa/ext-team-extension/server", extension: teamExtension },
	{ specifier: "@pa/ext-human-question/server", extension: humanQuestion },
	{ specifier: "@pa/ext-skill-catalog/server", extension: skillCatalog },
	{ specifier: "@pa/ext-web-access/server", extension: webAccess },
	{ specifier: "@pa/ext-workflow/server", extension: workflow },
];

export function listServerExtensionSummaries(): PaExtensionSummary[] {
	return builtinServerExtensions.map((entry) => summarizeServerExtension(entry.extension));
}

export function findServerExtension(name: string): PaServerExtension | undefined {
	return builtinServerExtensions.find((entry) => entry.extension.name === name)?.extension;
}
