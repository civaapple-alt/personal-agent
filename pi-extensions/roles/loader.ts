import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface RoleDefinition {
	id: string;
	name: string;
	title: string;
	keywords: string[];
	tools: string[];
	skills: string[];
	antiJobs: string[];
	body: string;
	sourcePath: string;
}

export function getBundledRolesDir(): string {
	return fileURLToPath(new URL("./roles", import.meta.url));
}

function parseInlineArray(raw: string): string[] {
	const trimmed = raw.trim();
	const inner = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
	return inner
		.split(",")
		.map((item) => item.trim().replace(/^["']|["']$/g, ""))
		.filter(Boolean);
}

export function parseRoleMarkdown(content: string, sourcePath: string): RoleDefinition {
	const fallbackId = basename(sourcePath, ".md");
	const normalized = content.replaceAll("\r\n", "\n");
	const meta: Record<string, string> = {};
	let body = normalized.trim();

	if (normalized.startsWith("---\n")) {
		const end = normalized.indexOf("\n---\n", 4);
		if (end !== -1) {
			const frontmatter = normalized.slice(4, end);
			body = normalized.slice(end + 5).trim();
			for (const line of frontmatter.split("\n")) {
				const colon = line.indexOf(":");
				if (colon <= 0) continue;
				const key = line.slice(0, colon).trim();
				const value = line.slice(colon + 1).trim();
				meta[key] = value;
			}
		}
	}

	const id = (meta.id || fallbackId).replace(/^["']|["']$/g, "").trim();
	const name = (meta.name || id).replace(/^["']|["']$/g, "").trim();
	const title = (meta.title || name).replace(/^["']|["']$/g, "").trim();

	return {
		id,
		name,
		title,
		keywords: meta.keywords ? parseInlineArray(meta.keywords) : [],
		tools: meta.tools ? parseInlineArray(meta.tools) : [],
		skills: meta.skills ? parseInlineArray(meta.skills) : [],
		antiJobs: meta.antiJobs ? parseInlineArray(meta.antiJobs) : [],
		body,
		sourcePath,
	};
}

export function resolveRoleSearchDirs(options?: { cwd?: string; env?: Record<string, string | undefined> }): string[] {
	const env = options?.env ?? process.env;
	const candidates = [
		env.PA_ROLES_DIR?.trim(),
		options?.cwd ? join(options.cwd, "roles") : undefined,
		join(homedir(), ".pi", "roles"),
		env.PA_BUNDLED_ROLES_DIR?.trim() || getBundledRolesDir(),
	].filter((dir): dir is string => Boolean(dir));
	return Array.from(new Set(candidates));
}

export function resolveRoleDefinition(
	roleQuery: string,
	options?: { cwd?: string; env?: Record<string, string | undefined> },
): RoleDefinition | undefined {
	const cleaned = roleQuery.trim().replace(/^@/, "").trim();
	if (!cleaned || cleaned.includes("..") || cleaned.includes("/") || cleaned.includes("\\")) {
		return undefined;
	}
	const lower = cleaned.toLowerCase();
	const roles = listRoleDefinitions(options);

	return (
		roles.find((r) => r.id.toLowerCase() === lower) ??
		roles.find((r) => r.name.toLowerCase() === lower || r.title.toLowerCase() === lower) ??
		roles.find((r) => r.keywords.some((kw) => kw.toLowerCase() === lower))
	);
}

export function formatCompactRolesIndex(options?: { cwd?: string; env?: Record<string, string | undefined> }): string {
	const roles = listRoleDefinitions(options);
	if (roles.length === 0) return "";
	return roles
		.map((role) => `- ${role.id} (${role.title})${role.skills.length ? `: skills=[${role.skills.join(", ")}]` : ""}`)
		.join("\n");
}

export function listRoleDefinitions(options?: {
	cwd?: string;
	env?: Record<string, string | undefined>;
}): RoleDefinition[] {
	const byId = new Map<string, RoleDefinition>();
	for (const dir of resolveRoleSearchDirs(options)) {
		if (!existsSync(dir)) continue;
		const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "README.md") continue;
			const fullPath = join(dir, entry.name);
			const parsed = parseRoleMarkdown(readFileSync(fullPath, "utf8"), fullPath);
			if (!byId.has(parsed.id)) {
				byId.set(parsed.id, parsed);
			}
		}
	}
	return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
}
