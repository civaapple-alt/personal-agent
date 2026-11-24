import type {
	ManagedSkillDetailDto,
	ManagedSkillEntryDto,
	SkillTrustLevel,
	SkillTrustScope,
} from "@pa/contracts/skill-trust";
import { requestJson } from "./client.ts";

export type { ManagedSkillDetailDto, ManagedSkillEntryDto, SkillTrustLevel, SkillTrustScope };

export function fetchManagedSkills(): Promise<{ skills: ManagedSkillEntryDto[] }> {
	return requestJson<{ skills: ManagedSkillEntryDto[] }>("/api/skills/trust");
}

export function fetchManagedSkillDetail(params: {
	scope: SkillTrustScope;
	scopeId: string;
	skillName: string;
}): Promise<{ detail: ManagedSkillDetailDto }> {
	const query = new URLSearchParams({
		scope: params.scope,
		scopeId: params.scopeId,
		skillName: params.skillName,
	});
	return requestJson<{ detail: ManagedSkillDetailDto }>(`/api/skills/trust/detail?${query.toString()}`);
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
