import type { ThinkingLevel } from "../rpc/types.ts";

export interface RoleTemplateSections {
	responsibilitiesAndBoundaries: string;
	skillsAndMethods: string;
	toolsAndEnvironment: string;
	collaborationConventions: string;
	deliveryAndVerification: string;
}

/**
 * Shareable role capability definition loaded from `roles/*.md`.
 * Intentionally excludes company-private or project-private memories.
 */
export interface RoleTemplate {
	id: string;
	name: string;
	title: string;
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
