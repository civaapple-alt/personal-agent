import type { DatabaseSync } from "node:sqlite";
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
}
