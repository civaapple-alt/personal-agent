import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RoleScope, RoleTemplate, RoleTemplateSections } from "./types.ts";

const ROLE_SECTION_HEADINGS = [
	["responsibilitiesAndBoundaries", "Responsibilities and Boundaries"],
	["skillsAndMethods", "Skills and Methods"],
	["toolsAndEnvironment", "Tools and Environment"],
	["collaborationConventions", "Collaboration and Communication"],
	["deliveryAndVerification", "Delivery and Verification"],
] as const satisfies ReadonlyArray<readonly [keyof RoleTemplateSections, string]>;

export function formatRoleTemplateBody(sections: RoleTemplateSections): string {
	return ROLE_SECTION_HEADINGS.filter(([key]) => sections[key].trim())
		.map(([key, heading]) => `## ${heading}\n${sections[key]}`)
		.join("\n\n");
}

/** Role IDs are filenames as well as stable runtime keys. */
export function validateRoleTemplateId(id: string): string {
	if (id.length > 128 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || id === "readme") {
		throw new Error("Role id must be a lowercase kebab-case identifier of at most 128 characters, excluding readme");
	}
	return id;
}

const SCOPE_DIR_NAMES = new Set(["global", "orgs", "users"]);
const SAFE_OWNER_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

export function parseRoleScope(raw: unknown): RoleScope | undefined {
	if (raw === "global" || raw === "org" || raw === "personal") return raw;
	return undefined;
}

function normalizeScopeOverride(override?: {
	roleScope?: RoleScope;
	ownerOrgId?: string | null;
	ownerUserId?: string | null;
}): { roleScope: RoleScope; ownerOrgId: string | null; ownerUserId: string | null } | undefined {
	if (!override?.roleScope) return undefined;
	if (override.roleScope === "global") {
		return { roleScope: "global", ownerOrgId: null, ownerUserId: null };
	}
	if (override.roleScope === "org") {
		const orgId = typeof override.ownerOrgId === "string" ? override.ownerOrgId.trim() : "";
		if (!orgId) return undefined;
		return { roleScope: "org", ownerOrgId: orgId, ownerUserId: null };
	}
	const userId = typeof override.ownerUserId === "string" ? override.ownerUserId.trim() : "";
	if (!userId) return undefined;
	return { roleScope: "personal", ownerOrgId: null, ownerUserId: userId };
}

function parseInlineArray(rawValue: string): string[] {
	const inner = rawValue.slice(1, -1).trim();
	if (inner.length === 0) {
		return [];
	}
	return inner
		.split(",")
		.map((item) => item.trim().replace(/^["']|["']$/g, ""))
		.filter((item) => item.length > 0);
}

function parseFrontmatter(block: string): Record<string, string | boolean | string[]> {
	const result: Record<string, string | boolean | string[]> = {};
	const lines = block.split(/\r?\n/);

	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (line.length === 0 || line.startsWith("#")) {
			continue;
		}
		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) {
			throw new Error(`Invalid frontmatter line: ${line}`);
		}
		const key = line.slice(0, colonIdx).trim();
		const value = line.slice(colonIdx + 1).trim();

		if (value === "true") {
			result[key] = true;
		} else if (value === "false") {
			result[key] = false;
		} else if (value.startsWith("[") && value.endsWith("]")) {
			result[key] = parseInlineArray(value);
		} else {
			result[key] = value.replace(/^["']|["']$/g, "");
		}
	}

	return result;
}

function extractSections(body: string): RoleTemplateSections {
	const sectionMap = new Map<string, string>();
	const headingRegex = /^##\s+(.+)$/gm;
	const matches: Array<{ heading: string; start: number; contentStart: number }> = [];

	while (true) {
		const match = headingRegex.exec(body);
		if (!match) break;
		matches.push({
			heading: match[1]!.trim(),
			start: match.index,
			contentStart: match.index + match[0].length,
		});
	}

	for (let i = 0; i < matches.length; i++) {
		const current = matches[i]!;
		const next = matches[i + 1];
		const sliceEnd = next ? next.start : body.length;
		const content = body.slice(current.contentStart, sliceEnd).trim();
		sectionMap.set(current.heading.toLowerCase(), content);
	}

	const sections: RoleTemplateSections = {
		responsibilitiesAndBoundaries: "",
		skillsAndMethods: "",
		toolsAndEnvironment: "",
		collaborationConventions: "",
		deliveryAndVerification: "",
	};
	for (const [key, heading] of ROLE_SECTION_HEADINGS) {
		sections[key] = sectionMap.get(heading.toLowerCase()) ?? "";
	}
	return sections;
}

function requireString(meta: Record<string, string | boolean | string[]>, key: string, source?: string): string {
	const value = meta[key];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`Missing required string frontmatter field "${key}"${source ? ` in ${source}` : ""}`);
	}
	return value.trim();
}

function optionalStringArray(meta: Record<string, string | boolean | string[]>, key: string): string[] {
	const value = meta[key];
	if (Array.isArray(value)) {
		return value;
	}
	return [];
}

/**
 * Parse a Markdown + YAML frontmatter role definition into a typed RoleTemplate.
 * Directory-derived `explicitScope` always overrides frontmatter scope to prevent scope spoofing.
 */
export function parseRoleTemplateMarkdown(
	markdown: string,
	sourcePath?: string,
	explicitScope?: { roleScope?: RoleScope; ownerOrgId?: string | null; ownerUserId?: string | null },
): RoleTemplate {
	const normalized = markdown.replace(/\r\n/g, "\n");
	if (!normalized.startsWith("---\n")) {
		throw new Error(`Role template must start with YAML frontmatter${sourcePath ? `: ${sourcePath}` : ""}`);
	}

	const closingIdx = normalized.indexOf("\n---\n", 4);
	if (closingIdx === -1) {
		throw new Error(`Unterminated YAML frontmatter${sourcePath ? `: ${sourcePath}` : ""}`);
	}

	const frontmatterRaw = normalized.slice(4, closingIdx);
	const body = normalized.slice(closingIdx + 5).trim();
	const meta = parseFrontmatter(frontmatterRaw);

	const roleKind = meta.roleKind === "architect" ? "architect" : meta.roleKind === "solo" ? "solo" : undefined;
	const responsibilityKeywords = meta.responsibilityKeywords;
	const forcedScope = normalizeScopeOverride(explicitScope);
	const parsedScope = parseRoleScope(meta.roleScope) ?? "global";
	const parsedOrgId = typeof meta.ownerOrgId === "string" && meta.ownerOrgId.trim() ? meta.ownerOrgId.trim() : null;
	const parsedUserId =
		typeof meta.ownerUserId === "string" && meta.ownerUserId.trim() ? meta.ownerUserId.trim() : null;
	const effectiveScope = forcedScope
		? forcedScope
		: parsedScope === "org" && parsedOrgId
			? { roleScope: "org" as const, ownerOrgId: parsedOrgId, ownerUserId: null }
			: parsedScope === "personal" && parsedUserId
				? { roleScope: "personal" as const, ownerOrgId: null, ownerUserId: parsedUserId }
				: { roleScope: "global" as const, ownerOrgId: null, ownerUserId: null };

	return {
		id: validateRoleTemplateId(requireString(meta, "id", sourcePath)),
		name: requireString(meta, "name", sourcePath),
		title: requireString(meta, "title", sourcePath),
		...(roleKind ? { roleKind } : {}),
		roleScope: effectiveScope.roleScope,
		ownerOrgId: effectiveScope.ownerOrgId,
		ownerUserId: effectiveScope.ownerUserId,
		version: requireString(meta, "version", sourcePath),
		shareable: typeof meta.shareable === "boolean" ? meta.shareable : true,
		isPrimaryContact:
			effectiveScope.roleScope === "global" && typeof meta.isPrimaryContact === "boolean"
				? meta.isPrimaryContact
				: false,
		keywords: optionalStringArray(meta, "keywords"),
		...(Array.isArray(responsibilityKeywords) ? { responsibilityKeywords } : {}),
		tools: optionalStringArray(meta, "tools"),
		skills: optionalStringArray(meta, "skills"),
		mcpDependencies: optionalStringArray(meta, "mcpDependencies"),
		...(optionalStringArray(meta, "antiJobs").length > 0 ? { antiJobs: optionalStringArray(meta, "antiJobs") } : {}),
		sections: extractSections(body),
		rawBody: body,
		sourcePath,
	};
}

/**
 * Load `.md` role templates from a single directory (supporting both `<id>.md` and `<id>/<id>.md` role packages).
 */
export async function loadRoleTemplatesFromDir(
	dirPath: string,
	options?: {
		explicitScope?: { roleScope: RoleScope; ownerOrgId?: string | null; ownerUserId?: string | null };
		excludeDirs?: Set<string>;
	},
): Promise<RoleTemplate[]> {
	const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => []);
	const fileCandidates: Array<{ sortKey: string; fullPath: string }> = [];
	for (const entry of entries) {
		if (entry.isFile() && entry.name.endsWith(".md") && entry.name.toLowerCase() !== "readme.md") {
			fileCandidates.push({ sortKey: entry.name, fullPath: join(dirPath, entry.name) });
			continue;
		}
		if (entry.isDirectory()) {
			if (options?.excludeDirs?.has(entry.name)) continue;
			const packageFile = join(dirPath, entry.name, `${entry.name}.md`);
			if (existsSync(packageFile)) {
				fileCandidates.push({ sortKey: entry.name, fullPath: packageFile });
			}
		}
	}
	fileCandidates.sort((a, b) => a.sortKey.localeCompare(b.sortKey));

	const templates: RoleTemplate[] = [];
	for (const item of fileCandidates) {
		const content = await readFile(item.fullPath, "utf8");
		templates.push(parseRoleTemplateMarkdown(content, item.fullPath, options?.explicitScope));
	}
	return templates;
}

/**
 * Load shareable baseline templates from `builtinDir` merged with custom `.md` roles in `customDir`.
 * Supports:
 * - `<customDir>/*.md` and `<customDir>/<roleId>/` -> `global`
 * - `<customDir>/orgs/<orgId>/` -> `org`
 * - `<customDir>/users/<userId>/` -> `personal`
 */
export async function loadRoleTemplatesWithCustomDir(builtinDir: string, customDir?: string): Promise<RoleTemplate[]> {
	const merged = new Map<string, RoleTemplate>();
	const globalIds = new Set<string>();
	for (const tpl of await loadRoleTemplatesFromDir(builtinDir, {
		explicitScope: { roleScope: "global", ownerOrgId: null, ownerUserId: null },
	})) {
		merged.set(tpl.id, tpl);
		globalIds.add(tpl.id);
	}
	if (customDir && customDir !== builtinDir && existsSync(customDir)) {
		for (const tpl of await loadRoleTemplatesFromDir(customDir, {
			explicitScope: { roleScope: "global", ownerOrgId: null, ownerUserId: null },
			excludeDirs: SCOPE_DIR_NAMES,
		})) {
			merged.set(tpl.id, tpl);
			globalIds.add(tpl.id);
		}
		const orgsDir = join(customDir, "orgs");
		if (existsSync(orgsDir)) {
			const orgEntries = await readdir(orgsDir, { withFileTypes: true }).catch(() => []);
			for (const entry of orgEntries.sort((a, b) => a.name.localeCompare(b.name))) {
				if (!entry.isDirectory() || !SAFE_OWNER_ID_RE.test(entry.name)) continue;
				for (const tpl of await loadRoleTemplatesFromDir(join(orgsDir, entry.name), {
					explicitScope: { roleScope: "org", ownerOrgId: entry.name, ownerUserId: null },
				})) {
					if (globalIds.has(tpl.id)) continue;
					merged.set(tpl.id, tpl);
				}
			}
		}
		const usersDir = join(customDir, "users");
		if (existsSync(usersDir)) {
			const userEntries = await readdir(usersDir, { withFileTypes: true }).catch(() => []);
			for (const entry of userEntries.sort((a, b) => a.name.localeCompare(b.name))) {
				if (!entry.isDirectory() || !SAFE_OWNER_ID_RE.test(entry.name)) continue;
				for (const tpl of await loadRoleTemplatesFromDir(join(usersDir, entry.name), {
					explicitScope: { roleScope: "personal", ownerOrgId: null, ownerUserId: entry.name },
				})) {
					if (globalIds.has(tpl.id)) continue;
					merged.set(tpl.id, tpl);
				}
			}
		}
	}
	return [...merged.values()];
}

/**
 * Serialize a RoleTemplate back to shareable Markdown (excluding any private runtime state).
 */
export function serializeRoleTemplateMarkdown(template: RoleTemplate): string {
	const formatList = (items: string[]) => `[${items.join(", ")}]`;
	const frontmatter = [
		"---",
		`id: ${template.id}`,
		`name: ${template.name}`,
		`title: ${template.title}`,
		...(template.roleKind === "architect" || template.roleKind === "solo" ? [`roleKind: ${template.roleKind}`] : []),
		...(template.roleScope && template.roleScope !== "global" ? [`roleScope: ${template.roleScope}`] : []),
		...(template.roleScope === "org" && template.ownerOrgId ? [`ownerOrgId: ${template.ownerOrgId}`] : []),
		...(template.roleScope === "personal" && template.ownerUserId ? [`ownerUserId: ${template.ownerUserId}`] : []),
		`version: ${template.version}`,
		`shareable: ${String(template.shareable)}`,
		`isPrimaryContact: ${String(template.isPrimaryContact)}`,
		`keywords: ${formatList(template.keywords)}`,
		...(template.responsibilityKeywords
			? [`responsibilityKeywords: ${formatList(template.responsibilityKeywords)}`]
			: []),
		`tools: ${formatList(template.tools)}`,
		`skills: ${formatList(template.skills)}`,
		`mcpDependencies: ${formatList(template.mcpDependencies)}`,
		...(template.antiJobs && template.antiJobs.length > 0 ? [`antiJobs: ${formatList(template.antiJobs)}`] : []),
		"---",
	].join("\n");

	return `${frontmatter}\n\n${template.rawBody.trim()}\n`;
}
