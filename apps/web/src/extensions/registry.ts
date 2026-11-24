import humanQuestion from "@pa/ext-human-question/web";
import skillCatalog from "@pa/ext-skill-catalog/web";
import teamExtension from "@pa/ext-team-extension/web";
import visualize from "@pa/ext-visualize/web";
import webAccess from "@pa/ext-web-access/web";
import workflow from "@pa/ext-workflow/web";
import type { PaToolDisplaySpec, PaToolRendererRegistration, PaWebExtension } from "@pa/extension-api/web";

/** Static registry of all built-in PA web extensions (browser-only UI metadata and tool renderers). */
export const builtinWebExtensions: readonly PaWebExtension[] = [
	teamExtension,
	humanQuestion,
	skillCatalog,
	visualize,
	webAccess,
	workflow,
];

const toolDisplayIndex = new Map<string, PaToolDisplaySpec>();
const toolRendererIndex = new Map<string, PaToolRendererRegistration>();
for (const extension of builtinWebExtensions) {
	for (const [toolName, spec] of Object.entries(extension.toolDisplays ?? {})) {
		toolDisplayIndex.set(toolName, spec);
	}
	for (const [toolName, registration] of Object.entries(extension.toolRenderers ?? {})) {
		toolRendererIndex.set(toolName, registration);
	}
}

export function getToolDisplay(toolName: string): PaToolDisplaySpec | undefined {
	return toolDisplayIndex.get(toolName);
}

export function getToolRenderer(toolName: string): PaToolRendererRegistration | undefined {
	return toolRendererIndex.get(toolName);
}
