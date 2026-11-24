import humanQuestion from "@pa/ext-human-question/web";
import skillCatalog from "@pa/ext-skill-catalog/web";
import teamExtension from "@pa/ext-team-extension/web";
import webAccess from "@pa/ext-web-access/web";
import workflow from "@pa/ext-workflow/web";
import type { PaToolDisplaySpec, PaWebExtension } from "@pa/extension-api/web";

/** Static registry of all built-in PA web extensions (browser-only UI metadata and renderers). */
export const builtinWebExtensions: readonly PaWebExtension[] = [
	teamExtension,
	humanQuestion,
	skillCatalog,
	webAccess,
	workflow,
];

const toolDisplayIndex = new Map<string, PaToolDisplaySpec>();
for (const extension of builtinWebExtensions) {
	for (const [toolName, spec] of Object.entries(extension.toolDisplays ?? {})) {
		toolDisplayIndex.set(toolName, spec);
	}
}

export function getToolDisplay(toolName: string): PaToolDisplaySpec | undefined {
	return toolDisplayIndex.get(toolName);
}
