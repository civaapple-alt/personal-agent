import type { DatabaseSync } from "node:sqlite";
import { ROLE_ARCHITECT_MEMBER_ID } from "../../roles/role-architect.ts";
import type { RoleScope } from "../../roles/types.ts";
import type { ThinkingLevel } from "../../rpc/types.ts";
import type { TeamMember } from "../types.ts";
import { defaultMemberGitName, mapMemberRow, nowIso, parseUniqueIds } from "./helpers.ts";

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
		provider?: string;
		model?: string;
		thinkingLevel?: ThinkingLevel;
		keywords: string[];
		gitName?: string;
		gitEmail?: string;
		identitySummary?: string;
		roleScope?: RoleScope;
		ownerOrgId?: string | null;
		ownerUserId?: string | null;
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
		const rawOwnerOrgId = input.ownerOrgId !== undefined ? input.ownerOrgId : (existing?.ownerOrgId ?? null);
		const rawOwnerUserId = input.ownerUserId !== undefined ? input.ownerUserId : (existing?.ownerUserId ?? null);
		const roleScope: RoleScope =
			input.roleScope ?? existing?.roleScope ?? (rawOwnerUserId ? "personal" : rawOwnerOrgId ? "org" : "global");
		const ownerOrgId = roleScope === "org" ? rawOwnerOrgId?.trim() || null : null;
		const ownerUserId = roleScope === "personal" ? rawOwnerUserId?.trim() || null : null;
		if (roleScope === "org" && !ownerOrgId) {
			throw new Error("Organization-scoped member requires ownerOrgId");
		}
		if (roleScope === "personal" && !ownerUserId) {
			throw new Error("Personal-scoped member requires ownerUserId");
		}
		const isPrimaryContact = roleScope === "global" && input.isPrimaryContact ? 1 : 0;
		if (existing) {
			this.db
				.prepare(
					`UPDATE team_members
					 SET template_id = ?, display_name = ?, role_title = ?, is_primary_contact = ?,
					     provider = ?, model = ?, thinking_level = ?, keywords_json = ?,
					     git_name = ?, git_email = ?, identity_summary = ?,
					     role_scope = ?, owner_org_id = ?, owner_user_id = ?, updated_at = ?
					 WHERE id = ?`,
				)
				.run(
					input.templateId,
					input.displayName,
					input.roleTitle,
					isPrimaryContact,
					input.provider ?? existing?.provider ?? "",
					input.model ?? existing?.model ?? "",
					input.thinkingLevel ?? existing?.thinkingLevel ?? "off",
					JSON.stringify(input.keywords),
					gitName,
					gitEmail,
					identitySummary,
					roleScope,
					ownerOrgId,
					ownerUserId,
					timestamp,
					input.id,
				);
			this.db.prepare("DELETE FROM removed_role_templates WHERE template_id = ?").run(input.templateId);
			return this.getMember(input.id)!;
		}

		this.db
			.prepare(
				`INSERT INTO team_members (
					id, template_id, display_name, role_title, is_primary_contact,
					provider, model, thinking_level, keywords_json,
					git_name, git_email, identity_summary, role_scope, owner_org_id, owner_user_id, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				input.id,
				input.templateId,
				input.displayName,
				input.roleTitle,
				isPrimaryContact,
				input.provider ?? "",
				input.model ?? "",
				input.thinkingLevel ?? "off",
				JSON.stringify(input.keywords),
				gitName,
				gitEmail,
				identitySummary,
				roleScope,
				ownerOrgId,
				ownerUserId,
				timestamp,
				timestamp,
			);
		this.db.prepare("DELETE FROM removed_role_templates WHERE template_id = ?").run(input.templateId);
		return this.getMember(input.id)!;
	}

	countPersonalRoles(userId: string): number {
		const row = this.db
			.prepare("SELECT COUNT(*) AS cnt FROM team_members WHERE role_scope = 'personal' AND owner_user_id = ?")
			.get(userId) as { cnt?: number } | undefined;
		return Number(row?.cnt ?? 0);
	}

	isRoleTemplateRemoved(templateId: string): boolean {
		return Boolean(this.db.prepare("SELECT 1 FROM removed_role_templates WHERE template_id = ?").get(templateId));
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
		if (existing.roleScope !== "global") {
			throw new Error("仅平台通用（global）AI 角色可设为全局默认主联系人");
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
			const leadCount = Number(leadRow?.count ?? 0);
			if (leadCount > 0) {
				throw new Error(`该角色已作为主负责人关联 ${leadCount} 个事项，不可直接删除`);
			}

			const matterRows = this.db
				.prepare(
					"SELECT id, ai_member_ids_json, consult_member_ids_json, observer_ids_json, observers_enabled FROM matters",
				)
				.all();
			const timestamp = nowIso();
			const updateRoster = this.db.prepare(`UPDATE matters SET ai_member_ids_json = ?, consult_member_ids_json = ?,
				observer_ids_json = ?, observers_enabled = ?, updated_at = ? WHERE id = ?`);
			for (const row of matterRows) {
				const ai = parseUniqueIds(row.ai_member_ids_json);
				const consult = parseUniqueIds(row.consult_member_ids_json);
				const observers = parseUniqueIds(row.observer_ids_json);
				if (![ai, consult, observers].some((ids) => ids.includes(memberId))) continue;
				const nextObservers = observers.filter((id) => id !== memberId);
				updateRoster.run(
					row.ai_member_ids_json == null ? null : JSON.stringify(ai.filter((id) => id !== memberId)),
					row.consult_member_ids_json == null ? null : JSON.stringify(consult.filter((id) => id !== memberId)),
					JSON.stringify(nextObservers),
					observers.includes(memberId) && nextObservers.length === 0 ? 0 : Number(row.observers_enabled),
					timestamp,
					String(row.id),
				);
			}

			this.db.prepare("DELETE FROM memory_applications WHERE member_id = ?").run(memberId);
			this.db.prepare("DELETE FROM worker_sessions WHERE member_id = ?").run(memberId);
			this.db.prepare("DELETE FROM member_memories WHERE member_id = ?").run(memberId);
			this.db.prepare("DELETE FROM team_members WHERE id = ?").run(memberId);
			this.db
				.prepare("INSERT OR REPLACE INTO removed_role_templates (template_id, removed_at) VALUES (?, ?)")
				.run(existing.templateId, timestamp);
			this.db.exec("COMMIT");
			return existing;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
}
