import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

/** Parse JSON-encoded `PA_BOARD_OWNED_SCOPE` safely into a normalized string array. */
export function parseOwnedScopeEnv(raw: string | undefined): string[] {
	if (!raw?.trim()) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter((item): item is string => typeof item === "string")
			.map((item) => item.trim())
			.filter(Boolean);
	} catch {
		return [];
	}
}

/** Canonicalize an existing or not-yet-created path by resolving the deepest existing ancestor via `realpathSync`. */
function canonicalizePath(targetPath: string): string {
	const resolved = resolve(targetPath);
	if (existsSync(resolved)) {
		try {
			return realpathSync(resolved);
		} catch {
			return resolved;
		}
	}
	const tail: string[] = [];
	let current = resolved;
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) return resolved;
		tail.unshift(basename(current));
		current = parent;
	}
	try {
		return resolve(realpathSync(current), ...tail);
	} catch {
		return resolved;
	}
}

function normalizeScopePattern(rawEntry: string): string | null {
	const trimmed = rawEntry.trim();
	// Ignore command-like hints (containing whitespace) so acceptance commands in ownedScope do not false-block file writes.
	if (!trimmed || /\s/.test(trimmed)) return null;
	const stripped = trimmed.replace(/\/\*\*?$/, "").replace(/\/+$/, "");
	return stripped || ".";
}

/** Extract target file path for write/edit tool calls; read-only tools return null. */
export function extractWriteTargetPath(toolName: string, input: Record<string, unknown>): string | null {
	if (toolName !== "write" && toolName !== "edit") return null;
	if (typeof input.path === "string" && input.path.trim()) return input.path.trim();
	if (typeof input.file_path === "string" && input.file_path.trim()) return input.file_path.trim();
	return null;
}

/** Check whether `targetPath` falls within any path-like entry in `ownedScope` relative to `cwd`. */
export function isPathWithinOwnedScope(
	targetPath: string,
	ownedScope: readonly string[],
	cwd: string = process.cwd(),
): boolean {
	const pathPatterns = ownedScope.map(normalizeScopePattern).filter((item): item is string => item !== null);
	if (pathPatterns.length === 0) return true;

	const baseDir = canonicalizePath(cwd);
	const resolvedTarget = canonicalizePath(isAbsolute(targetPath) ? targetPath : resolve(baseDir, targetPath));

	for (const pattern of pathPatterns) {
		const resolvedScope = canonicalizePath(isAbsolute(pattern) ? pattern : resolve(baseDir, pattern));
		const rel = relative(resolvedScope, resolvedTarget);
		if (rel === "" || (rel !== ".." && !rel.startsWith(`..${"/"}`) && !rel.startsWith("..\\") && !isAbsolute(rel))) {
			return true;
		}
	}
	return false;
}
