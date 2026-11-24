import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export type ManagedSkillScope = "global" | "org" | "personal" | "workspace";
export type ManagedSkillTrustLevel = "confirm" | "autonomous" | "disabled";

export interface ManagedSkillRoot {
	root: string;
	scope: ManagedSkillScope;
	scopeId: string;
}

export interface MatchedSkillScriptCall {
	scope: ManagedSkillScope;
	scopeId: string;
	skillName: string;
	scriptRelPath: string;
	policyKey: string;
}

const SCRIPT_TOKEN_RE = /(?:^|[\s"'`=:(;])([^\s"'`&|;()<>]+\/scripts\/[a-zA-Z0-9._/-]+)/g;

function normalizeSlashes(value: string): string {
	return value.replaceAll("\\", "/");
}

function canonicalizePath(target: string): string {
	const resolved = resolve(target);
	try {
		return realpathSync(resolved);
	} catch {
		return resolved;
	}
}

/**
 * Detects whether a `bash` command invokes a script located inside one of the managed PA Skill roots
 * (`<root>/<skillName>/scripts/<file>`). Pure & deterministic so it can run inside Pi's `tool_call` hook.
 */
export function matchManagedSkillScriptCall(
	command: string,
	managedRoots: readonly ManagedSkillRoot[],
	cwd: string = process.cwd(),
): MatchedSkillScriptCall | null {
	if (!command.trim() || managedRoots.length === 0) return null;
	const canonicalCwd = canonicalizePath(cwd);
	const normalizedRoots = managedRoots.map((entry) => ({
		...entry,
		resolvedRoot: canonicalizePath(entry.root),
	}));

	SCRIPT_TOKEN_RE.lastIndex = 0;
	let match = SCRIPT_TOKEN_RE.exec(command);
	while (match) {
		const rawToken = match[1]?.trim();
		if (rawToken) {
			const candidatePath = canonicalizePath(isAbsolute(rawToken) ? rawToken : resolve(canonicalCwd, rawToken));
			for (const rootEntry of normalizedRoots) {
				const rel = normalizeSlashes(relative(rootEntry.resolvedRoot, candidatePath));
				if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) continue;
				const segments = rel.split("/").filter(Boolean);
				if (segments.length >= 3 && segments[1] === "scripts") {
					const skillName = segments[0]!;
					const scriptRelPath = segments.slice(1).join("/");
					return {
						scope: rootEntry.scope,
						scopeId: rootEntry.scopeId,
						skillName,
						scriptRelPath,
						policyKey: `${rootEntry.scope}:${rootEntry.scopeId}:${skillName}`,
					};
				}
			}
		}
		match = SCRIPT_TOKEN_RE.exec(command);
	}
	return null;
}

export function parseManagedSkillRoots(raw: string | undefined): ManagedSkillRoot[] {
	if (!raw?.trim()) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(item): item is ManagedSkillRoot =>
				Boolean(item) &&
				typeof item === "object" &&
				typeof (item as ManagedSkillRoot).root === "string" &&
				typeof (item as ManagedSkillRoot).scope === "string" &&
				typeof (item as ManagedSkillRoot).scopeId === "string",
		);
	} catch {
		return [];
	}
}

export function parseSkillTrustPolicies(raw: string | undefined): Map<string, ManagedSkillTrustLevel> {
	const map = new Map<string, ManagedSkillTrustLevel>();
	if (!raw?.trim()) return map;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return map;
		for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (value === "confirm" || value === "autonomous" || value === "disabled") {
				map.set(key, value);
			}
		}
	} catch {
		// Ignore malformed policy map
	}
	return map;
}
