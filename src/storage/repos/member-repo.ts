import type { DatabaseSync } from "node:sqlite";
import { ROLE_ARCHITECT_MEMBER_ID } from "../../roles/role-architect.ts";
import type { ThinkingLevel } from "../../rpc/types.ts";
import type { TeamMember } from "../types.ts";
import { defaultMemberGitName, mapMemberRow, nowIso } from "./helpers.ts";

/** Manages persisted AI team members, primary contact selection, and Git author identity profiles. */
export class MemberRepo {
	private readonly db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	upsertMember(input: {
		id: string;
		templateId: string;
		displayName: string;
		roleTitle: string;
		isPrimaryContact: boolean;
		provider: string;
		model: string;
		thinkingLevel: ThinkingLevel;
		keywords: string[];
		gitName?: string;
		gitEmail?: string;
		identitySummary?: string;
	}): TeamMember {
		const timestamp = nowIso();
		const existing = this.getMember(input.id);
		const fallbackGitName = defaultMemberGitName(input);
		const gitName =
			input.gitName !== undefined
				? input.gitName.trim() || fallbackGitName
				: existing?.gitName.trim() || fallbackGitName;
		const gitEmail =
			input.gitEmail !== undefined
				? input.gitEmail.trim() || `${input.id}@team.local`
				: existing?.gitEmail.trim() || `${input.id}@team.local`;
		const identitySummary =
			input.identitySummary !== undefined ? input.identitySummary.trim() : (existing?.identitySummary ?? "");
		if (existing) {
			this.db
				.prepare(
					`UPDATE team_members
					 SET template_id = ?, display_name = ?, role_title = ?, is_primary_contact = ?,
					     provider = ?, model = ?, thinking_level = ?, keywords_json = ?,
					     git_name = ?, git_email = ?, identity_summary = ?, updated_at = ?
					 WHERE id = ?`,
				)
				.run(
					input.templateId,
					input.displayName,
					input.roleTitle,
					input.isPrimaryContact ? 1 : 0,
					input.provider,
					input.model,
					input.thinkingLevel,
					JSON.stringify(input.keywords),
					gitName,
					gitEmail,
					identitySummary,
					timestamp,
					input.id,
				);
			return this.getMember(input.id)!;
		}

		this.db
			.prepare(
				`INSERT INTO team_members (
					id, template_id, display_name, role_title, is_primary_contact,
					provider, model, thinking_level, keywords_json,
					git_name, git_email, identity_summary, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				input.id,
				input.templateId,
				input.displayName,
				input.roleTitle,
				input.isPrimaryContact ? 1 : 0,
				input.provider,
				input.model,
				input.thinkingLevel,
				JSON.stringify(input.keywords),
				gitName,
				gitEmail,
				identitySummary,
				timestamp,
				timestamp,
			);
		return this.getMember(input.id)!;
	}

	updateMemberIdentity(
		memberId: string,
		patch: {
			displayName?: string;
			roleTitle?: string;
			gitName?: string;
			gitEmail?: string;
			identitySummary?: string;
		},
	): TeamMember {
		const existing = this.getMember(memberId);
		if (!existing) {
			throw new Error(`Member not found: ${memberId}`);
		}
		const timestamp = nowIso();
		const displayName =
			patch.displayName !== undefined ? patch.displayName.trim() || existing.displayName : existing.displayName;
		const roleTitle =
			patch.roleTitle !== undefined ? patch.roleTitle.trim() || existing.roleTitle : existing.roleTitle;
		const gitName =
			patch.gitName !== undefined
				? patch.gitName.trim() || defaultMemberGitName({ id: existing.id, displayName, roleTitle })
				: existing.gitName;
		const gitEmail =
			patch.gitEmail !== undefined ? patch.gitEmail.trim() || `${existing.id}@team.local` : existing.gitEmail;
		const identitySummary =
			patch.identitySummary !== undefined ? patch.identitySummary.trim() : existing.identitySummary;
		this.db
			.prepare(
				`UPDATE team_members
				 SET display_name = ?, role_title = ?, git_name = ?, git_email = ?, identity_summary = ?, updated_at = ?
				 WHERE id = ?`,
			)
			.run(displayName, roleTitle, gitName, gitEmail, identitySummary, timestamp, memberId);
		return this.getMember(memberId)!;
	}

	getMember(id: string): TeamMember | null {
		const row = this.db.prepare("SELECT * FROM team_members WHERE id = ?").get(id) as
			| Record<string, unknown>
			| undefined;
		return row ? mapMemberRow(row) : null;
	}

	listMembers(): TeamMember[] {
		const rows = this.db
			.prepare("SELECT * FROM team_members ORDER BY is_primary_contact DESC, created_at ASC")
			.all() as Record<string, unknown>[];
		return rows.map((row) => mapMemberRow(row));
	}

	getPrimaryContact(): TeamMember | null {
		const row = this.db.prepare("SELECT * FROM team_members WHERE is_primary_contact = 1 LIMIT 1").get() as
			| Record<string, unknown>
			| undefined;
		return row ? mapMemberRow(row) : null;
	}

	setPrimaryContact(memberId: string): TeamMember {
		const existing = this.getMember(memberId);
		if (!existing) {
			throw new Error(`Member not found: ${memberId}`);
		}
		const timestamp = nowIso();
		this.db.prepare("UPDATE team_members SET is_primary_contact = 0, updated_at = ?").run(timestamp);
		this.db
			.prepare("UPDATE team_members SET is_primary_contact = 1, updated_at = ? WHERE id = ?")
			.run(timestamp, memberId);
		return this.getMember(memberId)!;
	}

	deleteMember(memberId: string): TeamMember {
		const existing = this.getMember(memberId);
		if (!existing) {
			throw new Error(`Member not found: ${memberId}`);
		}
		if (memberId === ROLE_ARCHITECT_MEMBER_ID) {
			throw new Error("内置元角色「角色架构师」不支持删除");
		}
		if (existing.isPrimaryContact) {
			throw new Error("默认主联系人不可直接删除，请先将其他成员设为主联系");
		}

		this.db.exec("BEGIN IMMEDIATE");
		try {
			const leadRow = this.db
				.prepare("SELECT COUNT(*) AS count FROM matters WHERE lead_member_id = ?")
				.get(memberId) as { count?: number } | undefined;
			const delivRow = this.db
				.prepare("SELECT COUNT(*) AS count FROM deliverables WHERE member_id = ?")
				.get(memberId) as { count?: number } | undefined;
			const leadCount = Number(leadRow?.count ?? 0);
			const delivCount = Number(delivRow?.count ?? 0);
			if (leadCount > 0 || delivCount > 0) {
				throw new Error(
					`该角色已作为主负责人关联 ${leadCount} 个事项或留存 ${delivCount} 项交付成果，不可直接删除`,
				);
			}

			const matterRows = this.db
				.prepare("SELECT id, ai_member_ids_json, observer_ids_json FROM matters")
				.all() as Array<{ id: string; ai_member_ids_json: string | null; observer_ids_json: string | null }>;
			const timestamp = nowIso();
			for (const row of matterRows) {
				const rawAi = row.ai_member_ids_json ? (JSON.parse(row.ai_member_ids_json) as string[]) : null;
				const rawObs = row.observer_ids_json ? (JSON.parse(row.observer_ids_json) as string[]) : [];
				const aiChanged = Boolean(rawAi?.includes(memberId));
				const obsChanged = rawObs.includes(memberId);
				if (aiChanged || obsChanged) {
					const nextAi = rawAi && aiChanged ? rawAi.filter((id) => id !== memberId) : rawAi;
					const nextObs = obsChanged ? rawObs.filter((id) => id !== memberId) : rawObs;
					this.db
						.prepare(
							"UPDATE matters SET ai_member_ids_json = ?, observer_ids_json = ?, updated_at = ? WHERE id = ?",
						)
						.run(nextAi === null ? null : JSON.stringify(nextAi), JSON.stringify(nextObs), timestamp, row.id);
				}
			}

			this.db.prepare("DELETE FROM memory_applications WHERE member_id = ?").run(memberId);
			this.db.prepare("DELETE FROM worker_sessions WHERE member_id = ?").run(memberId);
			this.db.prepare("DELETE FROM member_memories WHERE member_id = ?").run(memberId);
			this.db.prepare("DELETE FROM team_members WHERE id = ?").run(memberId);
			this.db.exec("COMMIT");
			return existing;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
}
