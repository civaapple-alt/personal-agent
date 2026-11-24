import type { DatabaseSync } from "node:sqlite";
import type { SkillTrustLevel, SkillTrustPolicyRecord, SkillTrustScope } from "@pa/contracts/skill-trust";
import { nowIso } from "./helpers.ts";

function mapRow(row: Record<string, unknown>): SkillTrustPolicyRecord {
	return {
		scope: row.storage_scope as SkillTrustScope,
		scopeId: String(row.scope_id ?? ""),
		skillName: String(row.skill_name),
		trustLevel: row.trust_level as SkillTrustLevel,
		runCount: Number(row.run_count ?? 0),
		lastRunAt: row.last_run_at ? String(row.last_run_at) : null,
		lastOutcome: row.last_outcome ? String(row.last_outcome) : null,
		updatedByUserId: row.updated_by_user_id ? String(row.updated_by_user_id) : null,
		updatedAt: String(row.updated_at),
	};
}

/** Manages Four-Step Trust policies and script execution telemetry for disk-persisted Skills. */
export class SkillTrustRepo {
	private readonly db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	getPolicy(scope: SkillTrustScope, scopeId: string, skillName: string): SkillTrustPolicyRecord | null {
		const row = this.db
			.prepare(
				`SELECT * FROM skill_trust_policies
				 WHERE storage_scope = ? AND scope_id = ? AND skill_name = ?`,
			)
			.get(scope, scopeId, skillName) as Record<string, unknown> | undefined;
		return row ? mapRow(row) : null;
	}

	listPolicies(): SkillTrustPolicyRecord[] {
		const rows = this.db
			.prepare("SELECT * FROM skill_trust_policies ORDER BY storage_scope, scope_id, skill_name")
			.all() as Record<string, unknown>[];
		return rows.map(mapRow);
	}

	upsertPolicy(input: {
		scope: SkillTrustScope;
		scopeId: string;
		skillName: string;
		trustLevel: SkillTrustLevel;
		updatedByUserId?: string | null;
	}): SkillTrustPolicyRecord {
		const updatedAt = nowIso();
		this.db
			.prepare(
				`INSERT INTO skill_trust_policies (
					storage_scope, scope_id, skill_name, trust_level, run_count, last_run_at, last_outcome, updated_by_user_id, updated_at
				) VALUES (?, ?, ?, ?, 0, NULL, NULL, ?, ?)
				ON CONFLICT(storage_scope, scope_id, skill_name) DO UPDATE SET
					trust_level = excluded.trust_level,
					updated_by_user_id = excluded.updated_by_user_id,
					updated_at = excluded.updated_at`,
			)
			.run(input.scope, input.scopeId, input.skillName, input.trustLevel, input.updatedByUserId ?? null, updatedAt);
		return this.getPolicy(input.scope, input.scopeId, input.skillName)!;
	}

	recordExecution(input: {
		scope: SkillTrustScope;
		scopeId: string;
		skillName: string;
		outcome: string;
		defaultTrustLevel?: SkillTrustLevel;
	}): SkillTrustPolicyRecord {
		const now = nowIso();
		const defaultLevel = input.defaultTrustLevel ?? "confirm";
		this.db
			.prepare(
				`INSERT INTO skill_trust_policies (
					storage_scope, scope_id, skill_name, trust_level, run_count, last_run_at, last_outcome, updated_by_user_id, updated_at
				) VALUES (?, ?, ?, ?, 1, ?, ?, NULL, ?)
				ON CONFLICT(storage_scope, scope_id, skill_name) DO UPDATE SET
					run_count = skill_trust_policies.run_count + 1,
					last_run_at = excluded.last_run_at,
					last_outcome = excluded.last_outcome`,
			)
			.run(input.scope, input.scopeId, input.skillName, defaultLevel, now, input.outcome, now);
		return this.getPolicy(input.scope, input.scopeId, input.skillName)!;
	}
}
