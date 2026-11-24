import type { ManagedSkillEntryDto, SkillTrustLevel, SkillTrustScope } from "@pa/contracts/skill-trust";
import { requestJson } from "./client.ts";

export type { ManagedSkillEntryDto, SkillTrustLevel, SkillTrustScope };

export function fetchManagedSkills(): Promise<{ skills: ManagedSkillEntryDto[] }> {
	return requestJson<{ skills: ManagedSkillEntryDto[] }>("/api/skills/trust");
}

export function updateSkillTrustPolicy(payload: {
	scope: SkillTrustScope;
	scopeId: string;
	skillName: string;
	trustLevel: SkillTrustLevel;
}): Promise<{ ok: boolean; policy: { trustLevel: SkillTrustLevel } }> {
	return requestJson("/api/skills/trust", {
		method: "PATCH",
		body: JSON.stringify(payload),
	});
}
