import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RoleCapabilityReport, RoleScope, RoleTemplate } from "./types.ts";

export const builtinSkillsDir = fileURLToPath(new URL("../../pi-extensions/role-skills/skills/", import.meta.url));
const SAFE_SEGMENT_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ROLE_LOCAL_SKILL_RE = /^skills\/([a-z0-9]+(?:-[a-z0-9]+)*)\/SKILL\.md$/;

export interface SkillResolutionOptions {
	skillsDir?: string;
}

export interface ScopedSkillCatalogOptions {
	skillsDir?: string;
	roleScope?: RoleScope;
	ownerOrgId?: string | null;
	ownerUserId?: string | null;
}

export interface ScopedSkillCatalogEntry {
	name: string;
	description: string;
	scope: "builtin" | "global" | "org" | "personal";
}

function isSafePathSegment(value: string | null | undefined): value is string {
	return typeof value === "string" && SAFE_SEGMENT_RE.test(value) && value !== "." && value !== "..";
}

export function validateSkillReference(name: string): { kind: "role_local" | "catalog"; normalized: string } {
	const trimmed = name.trim();
	if (!trimmed || isAbsolute(trimmed) || trimmed.includes("\\")) {
		throw new Error(`Unsafe or invalid skill reference: ${name}`);
	}
	const segments = trimmed.split("/");
	if (segments.some((seg) => seg === "" || seg === "." || seg === "..")) {
		throw new Error(`Unsafe skill path segment: ${name}`);
	}
	if (trimmed.includes("/")) {
		if (!ROLE_LOCAL_SKILL_RE.test(trimmed)) {
			throw new Error(`Role-local skill path must match skills/<kebab-name>/SKILL.md: ${name}`);
		}
		return { kind: "role_local", normalized: trimmed };
	}
	if (trimmed.length > 64 || !SKILL_NAME_RE.test(trimmed) || trimmed === "readme") {
		throw new Error(`Skill name must be a lowercase kebab-case identifier (<=64 chars): ${name}`);
	}
	return { kind: "catalog", normalized: trimmed };
}

/** Allowed filesystem roots for a given role template when verifying realpath containment. */
export function resolveAllowedSkillRoots(
	template?: Pick<RoleTemplate, "sourcePath" | "roleScope" | "ownerOrgId" | "ownerUserId">,
	options?: SkillResolutionOptions,
): string[] {
	const roots = [builtinSkillsDir];
	if (options?.skillsDir) {
		roots.push(resolve(options.skillsDir, "global"));
		if (template?.roleScope === "org" && isSafePathSegment(template.ownerOrgId)) {
			roots.push(resolve(options.skillsDir, "orgs", template.ownerOrgId));
		}
		if (template?.roleScope === "personal" && isSafePathSegment(template.ownerUserId)) {
			roots.push(resolve(options.skillsDir, "users", template.ownerUserId));
		}
	}
	if (template?.sourcePath) {
		roots.push(resolve(dirname(template.sourcePath), "skills"));
	}
	return roots;
}

export function resolveRoleSkillPath(
	name: string,
	template?: Pick<RoleTemplate, "sourcePath" | "roleScope" | "ownerOrgId" | "ownerUserId">,
	options?: SkillResolutionOptions,
): string {
	const ref = validateSkillReference(name);
	if (ref.kind === "role_local") {
		if (!template?.sourcePath) {
			throw new Error(`Role-local skill ${name} requires a role sourcePath`);
		}
		const baseDir = resolve(dirname(template.sourcePath));
		const candidate = resolve(baseDir, ref.normalized);
		const rel = relative(baseDir, candidate);
		if (isAbsolute(rel) || rel.startsWith("..") || !rel.startsWith("skills/")) {
			throw new Error(`Skill path escapes role directory: ${name}`);
		}
		return candidate;
	}
	const candidates: string[] = [];
	if (options?.skillsDir) {
		if (template?.roleScope === "personal" && isSafePathSegment(template.ownerUserId)) {
			candidates.push(resolve(options.skillsDir, "users", template.ownerUserId, ref.normalized, "SKILL.md"));
		}
		if (template?.roleScope === "org" && isSafePathSegment(template.ownerOrgId)) {
			candidates.push(resolve(options.skillsDir, "orgs", template.ownerOrgId, ref.normalized, "SKILL.md"));
		}
		candidates.push(resolve(options.skillsDir, "global", ref.normalized, "SKILL.md"));
	}
	candidates.push(resolve(builtinSkillsDir, ref.normalized, "SKILL.md"));
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	return candidates[0]!;
}

async function readSkillsFromDirectory(
	dir: string,
	scope: ScopedSkillCatalogEntry["scope"],
): Promise<ScopedSkillCatalogEntry[]> {
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	const result: ScopedSkillCatalogEntry[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.isDirectory() || !SKILL_NAME_RE.test(entry.name) || entry.name === "readme") continue;
		const content = await readFile(resolve(dir, entry.name, "SKILL.md"), "utf8").catch(() => null);
		if (content === null) continue;
		result.push({
			name: entry.name,
			description: content.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? entry.name,
			scope,
		});
	}
	return result;
}

/** Lists installed skills visible to the caller's target scope (personal/org/global + builtin). */
export async function listScopedSkillCatalog(options?: ScopedSkillCatalogOptions): Promise<ScopedSkillCatalogEntry[]> {
	const merged = new Map<string, ScopedSkillCatalogEntry>();
	for (const item of await readSkillsFromDirectory(builtinSkillsDir, "builtin")) {
		merged.set(item.name, item);
	}
	if (options?.skillsDir) {
		for (const item of await readSkillsFromDirectory(resolve(options.skillsDir, "global"), "global")) {
			merged.set(item.name, item);
		}
		if (options.roleScope === "org" && isSafePathSegment(options.ownerOrgId)) {
			for (const item of await readSkillsFromDirectory(
				resolve(options.skillsDir, "orgs", options.ownerOrgId),
				"org",
			)) {
				merged.set(item.name, item);
			}
		}
		if (options.roleScope === "personal" && isSafePathSegment(options.ownerUserId)) {
			for (const item of await readSkillsFromDirectory(
				resolve(options.skillsDir, "users", options.ownerUserId),
				"personal",
			)) {
				merged.set(item.name, item);
			}
		}
	}
	return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Only lists installed project methods; it never installs dependencies or probes external services. */
export async function listRoleSkillCatalog(): Promise<Array<{ name: string; description: string }>> {
	const entries = await readSkillsFromDirectory(builtinSkillsDir, "builtin");
	return entries.map(({ name, description }) => ({ name, description }));
}

export async function assessRoleCapabilities(
	template: RoleTemplate,
	options?: SkillResolutionOptions,
): Promise<RoleCapabilityReport> {
	const skills = await Promise.all(
		template.skills.map(async (name) => {
			try {
				const skillPath = resolveRoleSkillPath(name, template, options);
				const info = await stat(skillPath).catch(() => null);
				return { name, state: info?.isFile() ? ("file_present" as const) : ("missing" as const) };
			} catch {
				return { name, state: "missing" as const };
			}
		}),
	);
	return {
		skills,
		mcpDependencies: template.mcpDependencies.map((name) => ({ name, state: "runtime_check_required" })),
	};
}
