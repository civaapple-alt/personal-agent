export type SkillStorageTarget = "global" | "org" | "personal" | "workspace";

export interface SkillScriptFile {
	/** Relative path strictly confined to `scripts/<safe-filename>`. */
	path: string;
	content: string;
	executable?: boolean;
}

export interface SkillProposalItem {
	id: string;
	name: string;
	description: string;
	body: string;
	scripts?: SkillScriptFile[];
	storageScope: SkillStorageTarget;
	rationale: string;
	status: "pending" | "applied" | "dismissed";
	writtenPaths?: string[];
	actedBy?: string;
	actedAt?: string;
}

export const SKILL_PROPOSAL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SKILL_SCRIPT_PATH_RE = /^scripts\/[a-zA-Z0-9._-]{1,120}$/;

export function isSkillStorageTarget(value: unknown): value is SkillStorageTarget {
	return value === "global" || value === "org" || value === "personal" || value === "workspace";
}

/** Parse staged skill proposals attached to a member message's metadata. */
export function readSkillProposals(metadata: Record<string, unknown> | null | undefined): SkillProposalItem[] {
	const raw = metadata?.skillProposals;
	if (!Array.isArray(raw)) return [];
	const results: SkillProposalItem[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const rec = entry as Record<string, unknown>;
		if (
			typeof rec.id !== "string" ||
			typeof rec.name !== "string" ||
			!SKILL_PROPOSAL_NAME_RE.test(rec.name) ||
			typeof rec.description !== "string" ||
			typeof rec.body !== "string" ||
			!isSkillStorageTarget(rec.storageScope) ||
			typeof rec.rationale !== "string" ||
			(rec.status !== "pending" && rec.status !== "applied" && rec.status !== "dismissed")
		) {
			continue;
		}
		const scripts = Array.isArray(rec.scripts)
			? rec.scripts
					.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
					.filter(
						(item) =>
							typeof item.path === "string" &&
							SKILL_SCRIPT_PATH_RE.test(item.path) &&
							typeof item.content === "string",
					)
					.map((item) => ({
						path: item.path as string,
						content: item.content as string,
						...(item.executable === true ? { executable: true } : {}),
					}))
			: undefined;
		const writtenPaths = Array.isArray(rec.writtenPaths)
			? rec.writtenPaths.filter((item): item is string => typeof item === "string")
			: undefined;
		results.push({
			id: rec.id,
			name: rec.name,
			description: rec.description,
			body: rec.body,
			...(scripts && scripts.length > 0 ? { scripts } : {}),
			storageScope: rec.storageScope,
			rationale: rec.rationale,
			status: rec.status,
			...(writtenPaths && writtenPaths.length > 0 ? { writtenPaths } : {}),
			...(typeof rec.actedBy === "string" ? { actedBy: rec.actedBy } : {}),
			...(typeof rec.actedAt === "string" ? { actedAt: rec.actedAt } : {}),
		});
	}
	return results;
}
