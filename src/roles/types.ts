import type { ThinkingLevel } from "../rpc/types.ts";

export interface RoleTemplateSections {
	responsibilitiesAndBoundaries: string;
	skillsAndMethods: string;
	toolsAndEnvironment: string;
	collaborationConventions: string;
	deliveryAndVerification: string;
}

export type RoleKind = "business" | "architect";

export interface RoleCapabilityReport {
	skills: Array<{ name: string; state: "file_present" | "missing" }>;
	mcpDependencies: Array<{ name: string; state: "runtime_check_required" }>;
}

/**
 * Shareable role capability definition loaded from `roles/*.md` or built-in meta roles.
 * Intentionally excludes company-private or project-private memories.
 */
export interface RoleTemplate {
	id: string;
	name: string;
	title: string;
	roleKind?: RoleKind;
	version: string;
	shareable: boolean;
	defaultProvider: string;
	defaultModel: string;
	thinkingLevel: ThinkingLevel;
	isPrimaryContact: boolean;
	keywords: string[];
	tools: string[];
	skills: string[];
	mcpDependencies: string[];
	antiJobs?: string[];
	sections: RoleTemplateSections;
	rawBody: string;
	sourcePath?: string;
}
