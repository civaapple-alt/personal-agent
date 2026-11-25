import type {
	ManagedSkillDetailDto,
	ManagedSkillEntryDto,
	PiNativeSkillDetailDto,
	PiNativeSkillDto,
	SkillTrustLevel,
	SkillTrustScope,
} from "@pa/contracts/skill-trust";
import { requestJson } from "./client.ts";

export type {
	ManagedSkillDetailDto,
	ManagedSkillEntryDto,
	PiNativeSkillDetailDto,
	PiNativeSkillDto,
	SkillTrustLevel,
	SkillTrustScope,
};

export interface ManagedSkillsListResponse {
	skills: ManagedSkillEntryDto[];
	piNativeSkills?: PiNativeSkillDto[];
	piNativeSkillsError?: string | null;
}

export function fetchManagedSkills(options?: { refresh?: boolean }): Promise<ManagedSkillsListResponse> {
	const path = options?.refresh ? "/api/skills/trust?refresh=1" : "/api/skills/trust";
	return requestJson<ManagedSkillsListResponse>(path);
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

export function fetchPiNativeSkillDetail(params: {
	name: string;
	source: string;
}): Promise<{ detail: PiNativeSkillDetailDto }> {
	const query = new URLSearchParams({
		name: params.name,
		source: params.source,
	});
	return requestJson<{ detail: PiNativeSkillDetailDto }>(`/api/skills/trust/native-detail?${query.toString()}`);
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
