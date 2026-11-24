export type SkillTrustScope = "global" | "org" | "personal" | "workspace";
export type SkillTrustLevel = "confirm" | "autonomous" | "disabled";

export interface SkillTrustPolicyRecord {
	scope: SkillTrustScope;
	scopeId: string;
	skillName: string;
	trustLevel: SkillTrustLevel;
	runCount: number;
	lastRunAt: string | null;
	lastOutcome: string | null;
	updatedByUserId: string | null;
	updatedAt: string;
}

export interface ManagedSkillEntryDto {
	scope: SkillTrustScope;
	scopeId: string;
	scopeLabel: string;
	name: string;
	description: string;
	filePath: string;
	scripts: string[];
	trustLevel: SkillTrustLevel;
	runCount: number;
	lastRunAt: string | null;
	lastOutcome: string | null;
	updatedAt: string | null;
	canManage: boolean;
}

export const SKILL_TRUST_LEVEL_LABELS: Record<SkillTrustLevel, string> = {
	confirm: "步骤 3 · 执行前确认",
	autonomous: "步骤 4 · 自主执行",
	disabled: "已停用",
};

export function isValidSkillTrustScope(raw: unknown): raw is SkillTrustScope {
	return raw === "global" || raw === "org" || raw === "personal" || raw === "workspace";
}

export function isValidSkillTrustLevel(raw: unknown): raw is SkillTrustLevel {
	return raw === "confirm" || raw === "autonomous" || raw === "disabled";
}

export function skillTrustPolicyKey(scope: SkillTrustScope, scopeId: string, skillName: string): string {
	return `${scope}:${scopeId}:${skillName}`;
}
