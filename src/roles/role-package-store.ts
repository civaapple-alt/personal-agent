import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { link, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { serializeRoleTemplateMarkdown, validateRoleTemplateId } from "./template-loader.ts";
import type { NewSkillDraft, RoleScope, RoleTemplate, SkillStorageScope } from "./types.ts";

const SAFE_SEGMENT_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SKILL_BODY_BYTES = 32_768;

function assertSafeSegment(value: string | null | undefined, label: string): string {
	const trimmed = typeof value === "string" ? value.trim() : "";
	if (!trimmed || !SAFE_SEGMENT_RE.test(trimmed) || trimmed === "." || trimmed === "..") {
		throw new Error(`Invalid ${label} identifier`);
	}
	return trimmed;
}

export function validateSkillName(raw: string): string {
	const trimmed = raw.trim().toLowerCase();
	if (trimmed.length === 0 || trimmed.length > 64 || !SKILL_NAME_RE.test(trimmed) || trimmed === "readme") {
		throw new Error("Skill name must be lowercase kebab-case (1-64 chars, excluding readme)");
	}
	return trimmed;
}

export function slugifySkillName(raw: string, fallback = "custom-method"): string {
	const slug = raw
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
	if (!slug || slug === "readme") return fallback;
	return slug;
}

export function scopeIdPrefix(roleScope: RoleScope, ownerOrgId?: string | null, ownerUserId?: string | null): string {
	if (roleScope === "global") return "";
	const rawOwner = roleScope === "org" ? (ownerOrgId ?? "") : (ownerUserId ?? "");
	const hash = createHash("sha256").update(`${roleScope}:${rawOwner}`).digest("hex").slice(0, 8);
	return `${roleScope === "org" ? "org" : "usr"}-${hash}-`;
}

/** Ensures non-global roles live in tenant-isolated ID namespaces while keeping global IDs clean. */
export function buildScopedRoleId(input: {
	baseId: string;
	roleScope: RoleScope;
	ownerOrgId?: string | null;
	ownerUserId?: string | null;
	existingIds: Set<string>;
	allowCollisionSuffix?: boolean;
}): string {
	const cleanBase =
		input.baseId
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "custom-role";
	const prefix = scopeIdPrefix(input.roleScope, input.ownerOrgId, input.ownerUserId);
	const rawCandidate =
		prefix && !cleanBase.startsWith(prefix) ? `${prefix}${cleanBase}`.slice(0, 128) : cleanBase.slice(0, 128);
	const candidate = validateRoleTemplateId(rawCandidate.replace(/-+$/g, "") || `${prefix}role`);
	if (!input.existingIds.has(candidate)) {
		return candidate;
	}
	if (!input.allowCollisionSuffix) {
		return candidate;
	}
	let index = 2;
	while (true) {
		const suffix = `-${index}`;
		const trimmed = `${candidate.slice(0, 128 - suffix.length).replace(/-+$/g, "")}${suffix}`;
		if (!input.existingIds.has(trimmed)) {
			return validateRoleTemplateId(trimmed);
		}
		index += 1;
	}
}

export function allowedSkillScopesForRole(roleScope: RoleScope, isSuperAdmin: boolean): SkillStorageScope[] {
	if (roleScope === "global") {
		return isSuperAdmin ? ["role_local", "global"] : ["role_local"];
	}
	if (roleScope === "org") {
		return isSuperAdmin ? ["role_local", "org", "global"] : ["role_local", "org"];
	}
	return ["role_local", "personal"];
}

export function validateNewSkillDrafts(
	raw: unknown,
	options?: { roleScope?: RoleScope; allowedScopes?: SkillStorageScope[] },
): NewSkillDraft[] {
	if (!Array.isArray(raw)) return [];
	const allowedScopes = options?.allowedScopes ?? ["role_local", "global", "org", "personal"];
	const seenNames = new Set<string>();
	const result: NewSkillDraft[] = [];
	for (const entry of raw.slice(0, 6)) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const rec = entry as Record<string, unknown>;
		const rawName = typeof rec.name === "string" ? rec.name.trim() : "";
		if (!rawName) continue;
		const name = validateSkillName(slugifySkillName(rawName));
		if (seenNames.has(name)) continue;
		seenNames.add(name);
		const description = typeof rec.description === "string" ? rec.description.replace(/[\r\n]+/g, " ").trim() : "";
		if (!description || description.length > 300) {
			throw new Error(`Skill "${name}" description must be 1-300 single-line characters`);
		}
		const body = typeof rec.body === "string" ? rec.body.trim() : "";
		if (!body) {
			throw new Error(`Skill "${name}" body must not be empty`);
		}
		if (Buffer.byteLength(body, "utf8") > MAX_SKILL_BODY_BYTES) {
			throw new Error(`Skill "${name}" exceeds ${MAX_SKILL_BODY_BYTES} bytes limit`);
		}
		const requestedScope =
			rec.storageScope === "global" ||
			rec.storageScope === "org" ||
			rec.storageScope === "personal" ||
			rec.storageScope === "role_local"
				? rec.storageScope
				: "role_local";
		if (!allowedScopes.includes(requestedScope)) {
			throw new Error(
				`Skill storageScope "${requestedScope}" is not allowed for ${options?.roleScope ?? "this"} role`,
			);
		}
		result.push({ name, description, body, storageScope: requestedScope });
	}
	return result;
}

export function formatSkillMarkdown(draft: NewSkillDraft): string {
	let cleanBody = draft.body.replace(/\r\n/g, "\n").trim();
	if (cleanBody.startsWith("---\n")) {
		const closingIdx = cleanBody.indexOf("\n---\n", 4);
		if (closingIdx !== -1) {
			cleanBody = cleanBody.slice(closingIdx + 5).trim();
		}
	}
	return [`---`, `name: ${draft.name}`, `description: ${draft.description}`, `---`, "", cleanBody, ""].join("\n");
}

export function resolveScopedRolesBaseDir(
	rolesDir: string,
	scope: { roleScope?: RoleScope; ownerOrgId?: string | null; ownerUserId?: string | null },
): string {
	const roleScope = scope.roleScope ?? "global";
	if (roleScope === "global") return resolve(rolesDir);
	if (roleScope === "org") {
		return resolve(rolesDir, "orgs", assertSafeSegment(scope.ownerOrgId, "ownerOrgId"));
	}
	return resolve(rolesDir, "users", assertSafeSegment(scope.ownerUserId, "ownerUserId"));
}

export function resolveScopedSkillsBaseDir(
	skillsDir: string,
	scope: { storageScope: "global" | "org" | "personal"; ownerOrgId?: string | null; ownerUserId?: string | null },
): string {
	if (scope.storageScope === "global") return resolve(skillsDir, "global");
	if (scope.storageScope === "org") {
		return resolve(skillsDir, "orgs", assertSafeSegment(scope.ownerOrgId, "ownerOrgId"));
	}
	return resolve(skillsDir, "users", assertSafeSegment(scope.ownerUserId, "ownerUserId"));
}

async function atomicWriteFile(filePath: string, content: string, createOnly = false): Promise<void> {
	const parentDir = resolve(filePath, "..");
	await mkdir(parentDir, { recursive: true });
	const tmp = join(parentDir, `.tmp-${randomUUID()}.md`);
	try {
		await writeFile(tmp, content, { encoding: "utf8", flag: "wx" });
		if (createOnly) await link(tmp, filePath);
		else await rename(tmp, filePath);
	} finally {
		await rm(tmp, { force: true });
	}
}

interface RolePackageInput {
	rolesDir?: string;
	skillsDir?: string;
	template: RoleTemplate;
	newSkills?: NewSkillDraft[];
}

export class SkillNameConflictError extends Error {
	constructor(name: string) {
		super(`Skill "${name}" already exists in this scope. Select the existing Skill or choose a new name.`);
	}
}

function planSkillWrites(params: RolePackageInput): Array<{ skill: NewSkillDraft; path: string }> {
	if (!params.rolesDir) return [];
	const rolePackageDir = join(resolveScopedRolesBaseDir(params.rolesDir, params.template), params.template.id);
	return (params.newSkills ?? []).map((skill) => {
		if (skill.storageScope === "role_local") {
			return { skill, path: join(rolePackageDir, "skills", skill.name, "SKILL.md") };
		}
		if (!params.skillsDir) {
			throw new Error(`skillsDir is required to save ${skill.storageScope} skill "${skill.name}"`);
		}
		const targetBase = resolveScopedSkillsBaseDir(params.skillsDir, {
			storageScope: skill.storageScope,
			ownerOrgId: params.template.ownerOrgId,
			ownerUserId: params.template.ownerUserId,
		});
		return { skill, path: join(targetBase, skill.name, "SKILL.md") };
	});
}

export function assertNewSkillNamesAvailable(packages: RolePackageInput[]): void {
	const reserved = new Set<string>();
	for (const entry of packages) {
		for (const { skill, path } of planSkillWrites(entry)) {
			if (reserved.has(path) || existsSync(path)) throw new SkillNameConflictError(skill.name);
			reserved.add(path);
		}
	}
}

export async function saveRolePackage(
	params: RolePackageInput,
): Promise<{ template: RoleTemplate; roleFilePath?: string; writtenSkillPaths: string[] }> {
	const roleScope: RoleScope = params.template.roleScope ?? "global";
	const newSkills = params.newSkills ?? [];
	const nextSkills = [...params.template.skills];
	const appendSkillRef = (ref: string) => {
		if (!nextSkills.includes(ref)) nextSkills.push(ref);
	};
	for (const skill of newSkills) {
		appendSkillRef(skill.storageScope === "role_local" ? `skills/${skill.name}/SKILL.md` : skill.name);
	}

	const nextTemplate: RoleTemplate = {
		...params.template,
		roleScope,
		skills: nextSkills,
	};

	if (!params.rolesDir) {
		return { template: nextTemplate, writtenSkillPaths: [] };
	}

	const scopeRolesDir = resolveScopedRolesBaseDir(params.rolesDir, {
		roleScope,
		ownerOrgId: nextTemplate.ownerOrgId,
		ownerUserId: nextTemplate.ownerUserId,
	});
	const rolePackageDir = join(scopeRolesDir, nextTemplate.id);
	const usePackageDir =
		newSkills.some((s) => s.storageScope === "role_local") ||
		nextSkills.some((s) => s.startsWith("skills/")) ||
		existsSync(rolePackageDir);

	const writtenSkillPaths: string[] = [];
	const roleFilePath = usePackageDir
		? join(rolePackageDir, `${nextTemplate.id}.md`)
		: join(scopeRolesDir, `${nextTemplate.id}.md`);

	try {
		for (const { skill, path } of planSkillWrites(params)) {
			try {
				await atomicWriteFile(path, formatSkillMarkdown(skill), true);
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "EEXIST") {
					throw new SkillNameConflictError(skill.name);
				}
				throw error;
			}
			writtenSkillPaths.push(path);
		}
		nextTemplate.sourcePath = roleFilePath;
		await atomicWriteFile(roleFilePath, serializeRoleTemplateMarkdown(nextTemplate));
	} catch (error) {
		await Promise.allSettled(writtenSkillPaths.map((path) => rm(path, { force: true })));
		throw error;
	}

	if (usePackageDir) {
		await rm(join(scopeRolesDir, `${nextTemplate.id}.md`), { force: true });
	}

	return { template: nextTemplate, roleFilePath, writtenSkillPaths };
}

export async function deleteRolePackage(params: {
	rolesDir?: string;
	member: {
		id: string;
		roleScope?: RoleScope;
		ownerOrgId?: string | null;
		ownerUserId?: string | null;
	};
}): Promise<void> {
	if (!params.rolesDir) return;
	const roleId = validateRoleTemplateId(params.member.id);
	const roleScope = params.member.roleScope ?? "global";
	const scopeRolesDir = resolveScopedRolesBaseDir(params.rolesDir, {
		roleScope,
		ownerOrgId: params.member.ownerOrgId,
		ownerUserId: params.member.ownerUserId,
	});
	await rm(join(scopeRolesDir, `${roleId}.md`), { force: true });
	await rm(join(scopeRolesDir, roleId), { recursive: true, force: true });
}
