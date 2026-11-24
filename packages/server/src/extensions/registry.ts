import type { PaExtensionSummary } from "@pa/contracts/extensions";
import delegation from "@pa/ext-delegation/server";
import humanQuestion from "@pa/ext-human-question/server";
import skillCapture from "@pa/ext-skill-capture/server";
import skillCatalog from "@pa/ext-skill-catalog/server";
import space from "@pa/ext-space/server";
import visualize from "@pa/ext-visualize/server";
import webAccess from "@pa/ext-web-access/server";
import workbenchHelp from "@pa/ext-workbench-help/server";
import workerRuntime from "@pa/ext-worker-runtime/server";
import workflow from "@pa/ext-workflow/server";
import { type PaServerExtension, summarizeServerExtension } from "@pa/extension-api/server";

export interface ServerExtensionEntry {
	readonly specifier: string;
	readonly extension: PaServerExtension;
}

/** Static registry of all built-in PA server extensions (RPC subprocess assembly + governance). */
export const builtinServerExtensions: readonly ServerExtensionEntry[] = [
	{ specifier: "@pa/ext-worker-runtime/server", extension: workerRuntime },
	{ specifier: "@pa/ext-workbench-help/server", extension: workbenchHelp },
	{ specifier: "@pa/ext-space/server", extension: space },
	{ specifier: "@pa/ext-delegation/server", extension: delegation },
	{ specifier: "@pa/ext-skill-capture/server", extension: skillCapture },
	{ specifier: "@pa/ext-human-question/server", extension: humanQuestion },
	{ specifier: "@pa/ext-skill-catalog/server", extension: skillCatalog },
	{ specifier: "@pa/ext-visualize/server", extension: visualize },
	{ specifier: "@pa/ext-web-access/server", extension: webAccess },
	{ specifier: "@pa/ext-workflow/server", extension: workflow },
];

export function listServerExtensionSummaries(): PaExtensionSummary[] {
	return builtinServerExtensions.map((entry) => summarizeServerExtension(entry.extension));
}

export function findServerExtension(name: string): PaServerExtension | undefined {
	return builtinServerExtensions.find((entry) => entry.extension.name === name)?.extension;
}
