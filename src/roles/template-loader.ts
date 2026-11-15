import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ThinkingLevel } from "../rpc/types.ts";
import type { RoleTemplate, RoleTemplateSections } from "./types.ts";

const VALID_THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

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
		sectionMap.set(current.heading, content);
	}

	return {
		responsibilitiesAndBoundaries: sectionMap.get("职责与边界") ?? "",
		skillsAndMethods: sectionMap.get("技能与工作方法") ?? "",
		toolsAndEnvironment: sectionMap.get("工具与环境依赖") ?? "",
		collaborationConventions: sectionMap.get("协作和沟通约定") ?? "",
		deliveryAndVerification: sectionMap.get("交付与验证方式") ?? "",
	};
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
 */
export function parseRoleTemplateMarkdown(markdown: string, sourcePath?: string): RoleTemplate {
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

	const thinkingRaw = requireString(meta, "thinkingLevel", sourcePath) as ThinkingLevel;
	if (!VALID_THINKING_LEVELS.has(thinkingRaw)) {
		throw new Error(`Invalid thinkingLevel "${thinkingRaw}"${sourcePath ? ` in ${sourcePath}` : ""}`);
	}

	return {
		id: requireString(meta, "id", sourcePath),
		name: requireString(meta, "name", sourcePath),
		title: requireString(meta, "title", sourcePath),
		version: requireString(meta, "version", sourcePath),
		shareable: typeof meta.shareable === "boolean" ? meta.shareable : true,
		defaultProvider: requireString(meta, "defaultProvider", sourcePath),
		defaultModel: requireString(meta, "defaultModel", sourcePath),
		thinkingLevel: thinkingRaw,
		isPrimaryContact: typeof meta.isPrimaryContact === "boolean" ? meta.isPrimaryContact : false,
		keywords: optionalStringArray(meta, "keywords"),
		tools: optionalStringArray(meta, "tools"),
		skills: optionalStringArray(meta, "skills"),
		mcpDependencies: optionalStringArray(meta, "mcpDependencies"),
		sections: extractSections(body),
		rawBody: body,
		sourcePath,
	};
}

/**
 * Load `.md` role templates, excluding README documentation, sorted deterministically by filename.
 */
export async function loadRoleTemplatesFromDir(dirPath: string): Promise<RoleTemplate[]> {
	const entries = await readdir(dirPath, { withFileTypes: true });
	const markdownFiles = entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name.toLowerCase() !== "readme.md")
		.map((entry) => entry.name)
		.sort();

	const templates: RoleTemplate[] = [];
	for (const fileName of markdownFiles) {
		const fullPath = join(dirPath, fileName);
		const content = await readFile(fullPath, "utf8");
		templates.push(parseRoleTemplateMarkdown(content, fullPath));
	}
	return templates;
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
		`version: ${template.version}`,
		`shareable: ${String(template.shareable)}`,
		`defaultProvider: ${template.defaultProvider}`,
		`defaultModel: ${template.defaultModel}`,
		`thinkingLevel: ${template.thinkingLevel}`,
		`isPrimaryContact: ${String(template.isPrimaryContact)}`,
		`keywords: ${formatList(template.keywords)}`,
		`tools: ${formatList(template.tools)}`,
		`skills: ${formatList(template.skills)}`,
		`mcpDependencies: ${formatList(template.mcpDependencies)}`,
		"---",
	].join("\n");

	return `${frontmatter}\n\n${template.rawBody.trim()}\n`;
}
