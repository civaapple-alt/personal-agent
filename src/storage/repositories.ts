import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ThinkingLevel } from "../rpc/types.ts";
import type {
	Collaborator,
	CollaboratorRole,
	Deliverable,
	DeliverableType,
	FeedbackRating,
	Matter,
	MatterMessage,
	MatterMessageChannel,
	MatterMessageSenderType,
	MatterStatus,
	MemberMemory,
	MemoryApplicationOutcome,
	MemoryApplicationRecord,
	MemoryCategory,
	MemoryScope,
	MemoryStatus,
	Organization,
	PublicCollaborator,
	TeamMember,
	WorkerSessionRecord,
	WorkspaceLink,
} from "./types.ts";

export const DEFAULT_ORGANIZATION_ID = "org-default";
export const DEFAULT_ORGANIZATION_NAME = "默认组织";
export const DEFAULT_OWNER_COLLABORATOR_ID = "owner";

export function toPublicCollaborator(collaborator: Collaborator): PublicCollaborator {
	const { token: _token, ...publicInfo } = collaborator;
	return publicInfo;
}

function nowIso(): string {
	return new Date().toISOString();
}

const ASCII_PRINTABLE_RE = /^[\x20-\x7E]+$/;

export function defaultMemberGitName(member: { id: string; displayName?: string; roleTitle?: string }): string {
	const displayName = member.displayName?.trim() ?? "";
	if (displayName && ASCII_PRINTABLE_RE.test(displayName)) return displayName;
	const roleTitle = member.roleTitle?.trim() ?? "";
	if (roleTitle && ASCII_PRINTABLE_RE.test(roleTitle)) return roleTitle;
	return member.id.trim() || roleTitle || displayName || "team-member";
}

export function resolveEffectiveGitIdentity(
	member: Pick<TeamMember, "id" | "displayName" | "gitName" | "gitEmail"> & { roleTitle?: string },
	organization?: Pick<Organization, "gitEmailDomain"> | null,
): { gitName: string; gitEmail: string } {
	const gitName = member.gitName.trim() || defaultMemberGitName(member);
	const rawEmail = member.gitEmail.trim();
	const domain = organization?.gitEmailDomain.trim().replace(/^@+/, "") ?? "";
	const isDefaultEmail = !rawEmail || rawEmail === `${member.id}@team.local`;
	const gitEmail = isDefaultEmail && domain ? `${member.id}@${domain}` : rawEmail || `${member.id}@team.local`;
	return { gitName, gitEmail };
}

export function normalizeMemoryCategory(raw: unknown): MemoryCategory {
	if (
		raw === "efficiency" ||
		raw === "troubleshooting" ||
		raw === "collaboration" ||
		raw === "user_correction" ||
		raw === "domain_constraint" ||
		raw === "general"
	) {
		return raw;
	}
	return "general";
}

function normalizeUniqueIds(ids?: string[]): string[] {
	if (!ids) return [];
	const seen = new Set<string>();
	const result: string[] = [];
	for (const id of ids) {
		const trimmed = id.trim();
		if (trimmed && !seen.has(trimmed)) {
			seen.add(trimmed);
			result.push(trimmed);
		}
	}
	return result;
}

function parseUniqueIds(raw: unknown): string[] {
	if (typeof raw !== "string" || !raw.trim()) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return normalizeUniqueIds(parsed.filter((item): item is string => typeof item === "string"));
	} catch {
		return [];
	}
}

export class MemoryValidationError extends Error {}

export class PersonalAgentStore {
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
		return row ? this.mapMember(row) : null;
	}

	listMembers(): TeamMember[] {
		const rows = this.db
			.prepare("SELECT * FROM team_members ORDER BY is_primary_contact DESC, created_at ASC")
			.all() as Record<string, unknown>[];
		return rows.map((row) => this.mapMember(row));
	}

	getPrimaryContact(): TeamMember | null {
		const row = this.db.prepare("SELECT * FROM team_members WHERE is_primary_contact = 1 LIMIT 1").get() as
			| Record<string, unknown>
			| undefined;
		return row ? this.mapMember(row) : null;
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

	addMemory(input: {
		memberId: string;
		scope: MemoryScope;
		category?: MemoryCategory;
		orgId?: string | null;
		workspaceId?: string | null;
		content: string;
		rationale?: string;
		sourceMatterId?: string | null;
		sourceDeliverableId?: string | null;
		status?: MemoryStatus;
		verified?: boolean;
		supersedesMemoryId?: string | null;
		supersededBy?: string | null;
	}): MemberMemory {
		const id = `mem_${randomUUID()}`;
		const timestamp = nowIso();
		const status: MemoryStatus = input.status ?? (input.verified ? "verified" : "candidate");
		const verified = status === "verified";
		const category = normalizeMemoryCategory(input.category);
		const orgId = input.scope === "company_private" ? (input.orgId ?? null) : null;
		const workspaceId =
			input.scope === "role_general"
				? null
				: input.scope === "company_private" && orgId
					? null
					: (input.workspaceId ?? null);
		const supersedesId = input.supersedesMemoryId ?? null;
		this.validateMemoryReplacement(
			{ id, memberId: input.memberId, scope: input.scope, orgId, workspaceId },
			supersedesId,
		);
		this.db
			.prepare(
				`INSERT INTO member_memories (
					id, member_id, scope, category, org_id, workspace_id, content, rationale,
					source_matter_id, source_deliverable_id, status, verified,
					superseded_by, supersedes_memory_id,
					applied_count, positive_count, negative_count, last_applied_at,
					created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, NULL, ?, ?)`,
			)
			.run(
				id,
				input.memberId,
				input.scope,
				category,
				orgId,
				workspaceId,
				input.content,
				input.rationale ?? "",
				input.sourceMatterId ?? null,
				input.sourceDeliverableId ?? null,
				status,
				verified ? 1 : 0,
				input.supersededBy ?? null,
				supersedesId,
				timestamp,
				timestamp,
			);
		if (verified && supersedesId && supersedesId !== id) {
			this.markMemorySuperseded(supersedesId, id, timestamp);
		}
		return this.getMemory(id)!;
	}

	getMemory(id: string): MemberMemory | null {
		const row = this.db.prepare("SELECT * FROM member_memories WHERE id = ?").get(id) as
			| Record<string, unknown>
			| undefined;
		return row ? this.mapMemory(row) : null;
	}

	findActiveDuplicateMemory(
		memberId: string,
		scope: MemoryScope,
		workspaceId: string | null,
		content: string,
		orgId: string | null = null,
	): MemberMemory | null {
		const normalized = content.replace(/\s+/g, " ").trim().toLowerCase();
		if (!normalized) return null;
		const effectiveOrgId = scope === "company_private" ? orgId : null;
		const effectiveWs =
			scope === "role_general" ? null : scope === "company_private" && effectiveOrgId ? null : workspaceId;
		return (
			this.listMemberMemories(memberId).find(
				(memory) =>
					(memory.status === "candidate" || memory.status === "verified") &&
					memory.scope === scope &&
					memory.orgId === effectiveOrgId &&
					memory.workspaceId === effectiveWs &&
					memory.content.replace(/\s+/g, " ").trim().toLowerCase() === normalized,
			) ?? null
		);
	}

	updateMemory(
		id: string,
		patch: {
			memberId?: string;
			content?: string;
			scope?: MemoryScope;
			category?: MemoryCategory;
			orgId?: string | null;
			workspaceId?: string | null;
			status?: MemoryStatus;
			rationale?: string;
			supersededBy?: string | null;
			supersedesMemoryId?: string | null;
		},
	): MemberMemory {
		const existing = this.getMemory(id);
		if (!existing) throw new Error(`Memory not found: ${id}`);
		const timestamp = nowIso();
		const nextMemberId = patch.memberId !== undefined ? patch.memberId.trim() : existing.memberId;
		if (!nextMemberId || !this.getMember(nextMemberId)) {
			throw new Error(`Member not found: ${nextMemberId || "(empty)"}`);
		}
		const nextScope = patch.scope ?? existing.scope;
		const nextCategory = patch.category !== undefined ? normalizeMemoryCategory(patch.category) : existing.category;
		const nextOrgId =
			nextScope === "company_private" ? (patch.orgId !== undefined ? patch.orgId : existing.orgId) : null;
		const nextWorkspaceId =
			nextScope === "role_general"
				? null
				: nextScope === "company_private" && nextOrgId
					? null
					: patch.workspaceId !== undefined
						? patch.workspaceId
						: existing.workspaceId;
		const nextContent = patch.content !== undefined ? patch.content.trim() : existing.content;
		if (!nextContent) throw new Error("Memory content cannot be empty");
		const nextStatus = patch.status ?? existing.status;
		const nextVerified = nextStatus === "verified";
		const nextRationale = patch.rationale !== undefined ? patch.rationale : existing.rationale;
		const nextSupersededBy = patch.supersededBy !== undefined ? patch.supersededBy : existing.supersededBy;
		const nextSupersedesId =
			patch.supersedesMemoryId !== undefined ? patch.supersedesMemoryId : existing.supersedesMemoryId;

		this.validateMemoryReplacement(
			{ id, memberId: nextMemberId, scope: nextScope, orgId: nextOrgId, workspaceId: nextWorkspaceId },
			nextSupersedesId,
		);
		this.db
			.prepare(
				`UPDATE member_memories
				 SET member_id = ?, scope = ?, category = ?, org_id = ?, workspace_id = ?, content = ?, rationale = ?,
				     status = ?, verified = ?, superseded_by = ?, supersedes_memory_id = ?, updated_at = ?
				 WHERE id = ?`,
			)
			.run(
				nextMemberId,
				nextScope,
				nextCategory,
				nextOrgId,
				nextWorkspaceId,
				nextContent,
				nextRationale,
				nextStatus,
				nextVerified ? 1 : 0,
				nextSupersededBy,
				nextSupersedesId,
				timestamp,
				id,
			);

		if (nextVerified && nextSupersedesId && nextSupersedesId !== id) {
			this.markMemorySuperseded(nextSupersedesId, id, timestamp);
		}
		return this.getMemory(id)!;
	}

	validateMemoryReplacement(
		replacement: {
			id?: string;
			memberId: string;
			scope: MemoryScope;
			orgId?: string | null;
			workspaceId: string | null;
		},
		targetId: string | null,
	): void {
		const sameScope = (memory: MemberMemory) =>
			memory.memberId === replacement.memberId &&
			memory.scope === replacement.scope &&
			memory.orgId === (replacement.orgId ?? null) &&
			memory.workspaceId === replacement.workspaceId;
		if (replacement.id) {
			const existing = this.getMemory(replacement.id);
			const relatedIds = new Set<string>();
			if (existing?.supersededBy) relatedIds.add(existing.supersededBy);
			for (const row of this.db
				.prepare("SELECT id FROM member_memories WHERE superseded_by = ? OR supersedes_memory_id = ?")
				.all(replacement.id, replacement.id))
				relatedIds.add(String(row.id));
			for (const id of relatedIds) {
				const related = this.getMemory(id);
				if (related && !sameScope(related))
					throw new MemoryValidationError(
						"Replacement must retain the same member, scope, organization and workspace as its linked memories",
					);
			}
		}
		if (replacement.id) {
			const retired = this.db.prepare("SELECT id FROM member_memories WHERE superseded_by = ?").all(replacement.id);
			if (retired.some((row) => row.id !== targetId))
				throw new MemoryValidationError("Cannot detach an established memory replacement");
		}
		if (!targetId) return;
		const target = this.getMemory(targetId);
		if (!target || !sameScope(target))
			throw new MemoryValidationError(
				"Replacement must have the same member, scope, organization and workspace as the prior memory",
			);
		const visited = new Set<string>();
		let cursor: MemberMemory | null = target;
		while (cursor) {
			if (cursor.id === replacement.id || visited.has(cursor.id))
				throw new MemoryValidationError("Memory replacement cycle");
			visited.add(cursor.id);
			cursor = cursor.supersedesMemoryId ? this.getMemory(cursor.supersedesMemoryId) : null;
		}
	}

	private markMemorySuperseded(targetMemoryId: string, replacementId: string, timestamp: string): void {
		this.db
			.prepare(
				`UPDATE member_memories
				 SET status = 'superseded', verified = 0, superseded_by = ?, updated_at = ?
				 WHERE id = ? AND status IN ('candidate', 'verified')`,
			)
			.run(replacementId, timestamp, targetMemoryId);
	}

	/** Inject role-general facts, organization-shared memory for the workspace's org (or single-workspace legacy company memory), and workspace-specific facts. */
	listRelevantMemories(
		memberId: string,
		workspaceId: string | null,
		options?: { includeCandidates?: boolean; orgId?: string | null },
	): MemberMemory[] {
		const includeCandidates = options?.includeCandidates ?? true;
		const workspace = workspaceId ? this.getWorkspace(workspaceId) : null;
		const activeOrgId = workspace ? workspace.orgId : (options?.orgId ?? null);
		return this.listMemberMemories(memberId)
			.filter((memory) => {
				if (memory.status === "rejected" || memory.status === "superseded") return false;
				if (!includeCandidates && memory.status !== "verified") return false;
				if (memory.scope === "role_general") return true;
				if (memory.scope === "company_private") {
					if (activeOrgId !== null && memory.orgId === activeOrgId) return true;
					return workspaceId !== null && !memory.orgId && memory.workspaceId === workspaceId;
				}
				return workspaceId !== null && memory.workspaceId === workspaceId;
			})
			.sort((a, b) => {
				const rankA = a.status === "verified" ? 0 : 1;
				const rankB = b.status === "verified" ? 0 : 1;
				if (rankA !== rankB) return rankA - rankB;
				return 0;
			});
	}

	listMemberMemories(memberId: string): MemberMemory[] {
		const rows = this.db
			.prepare("SELECT * FROM member_memories WHERE member_id = ? ORDER BY created_at, rowid")
			.all(memberId) as Record<string, unknown>[];
		return rows.map((row) => this.mapMemory(row));
	}

	recordMemoryApplications(input: {
		memoryIds: string[];
		matterId: string;
		memberId: string;
		deliverableId?: string | null;
		note?: string;
	}): string[] {
		const uniqueIds = normalizeUniqueIds(input.memoryIds);
		if (uniqueIds.length === 0) return [];
		const timestamp = nowIso();
		const applicationIds: string[] = [];
		const insert = this.db.prepare(
			`INSERT INTO memory_applications (id, memory_id, matter_id, member_id, deliverable_id, outcome, note, created_at)
			 VALUES (?, ?, ?, ?, ?, 'applied', ?, ?)`,
		);
		const updateCount = this.db.prepare(
			`UPDATE member_memories
			 SET applied_count = applied_count + 1, last_applied_at = ?, updated_at = ?
			 WHERE id = ?`,
		);
		this.db.exec("BEGIN IMMEDIATE");
		try {
			for (const memoryId of uniqueIds) {
				const applicationId = `mapp_${randomUUID()}`;
				applicationIds.push(applicationId);
				insert.run(
					applicationId,
					memoryId,
					input.matterId,
					input.memberId,
					input.deliverableId ?? null,
					input.note ?? "",
					timestamp,
				);
				updateCount.run(timestamp, timestamp, memoryId);
			}
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
		return applicationIds;
	}

	evaluateMemory(input: {
		memoryId: string;
		outcome: Exclude<MemoryApplicationOutcome, "applied">;
		matterId?: string | null;
		memberId?: string | null;
		deliverableId?: string | null;
		note?: string;
	}): MemberMemory {
		const existing = this.getMemory(input.memoryId);
		if (!existing) throw new Error(`Memory not found: ${input.memoryId}`);
		if (
			input.deliverableId &&
			input.matterId &&
			(input.outcome === "feedback_positive" || input.outcome === "feedback_negative")
		) {
			return this.setMemoryFeedback({
				...input,
				deliverableId: input.deliverableId,
				matterId: input.matterId,
				rating: input.outcome === "feedback_positive" ? "positive" : "negative",
			});
		}
		const timestamp = nowIso();
		const isPositive = input.outcome === "feedback_positive" || input.outcome === "turn_succeeded";
		const isNegative = input.outcome === "feedback_negative" || input.outcome === "turn_failed";
		if (input.matterId) {
			this.db
				.prepare(
					`INSERT INTO memory_applications (id, memory_id, matter_id, member_id, deliverable_id, outcome, note, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					`mapp_${randomUUID()}`,
					input.memoryId,
					input.matterId,
					input.memberId ?? existing.memberId,
					input.deliverableId ?? null,
					input.outcome,
					input.note ?? "",
					timestamp,
				);
		}
		if (isPositive) {
			this.db
				.prepare("UPDATE member_memories SET positive_count = positive_count + 1, updated_at = ? WHERE id = ?")
				.run(timestamp, input.memoryId);
		} else if (isNegative) {
			this.db
				.prepare("UPDATE member_memories SET negative_count = negative_count + 1, updated_at = ? WHERE id = ?")
				.run(timestamp, input.memoryId);
		}
		return this.getMemory(input.memoryId)!;
	}

	private setMemoryFeedback(input: {
		memoryId: string;
		matterId: string;
		deliverableId: string;
		rating: FeedbackRating;
		memberId?: string | null;
		note?: string;
	}): MemberMemory {
		const memory = this.getMemory(input.memoryId);
		if (!memory) throw new Error("Memory not found");
		const linked = this.db
			.prepare(`SELECT 1 FROM deliverable_memory_applications link JOIN memory_applications a ON a.id = link.application_id
			WHERE link.deliverable_id = ? AND a.memory_id = ? AND a.matter_id = ? LIMIT 1`)
			.get(input.deliverableId, input.memoryId, input.matterId);
		if (!linked) throw new Error("Memory was not injected for this deliverable");
		const old = this.db
			.prepare("SELECT rating FROM memory_feedback_votes WHERE deliverable_id = ? AND memory_id = ?")
			.get(input.deliverableId, input.memoryId);
		if (old?.rating === input.rating) return memory;
		const timestamp = nowIso();
		const ownsTransaction = !this.db.isTransaction;
		if (ownsTransaction) this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db
				.prepare(
					"UPDATE member_memories SET positive_count = positive_count + ?, negative_count = negative_count + ?, updated_at = ? WHERE id = ?",
				)
				.run(
					Number(input.rating === "positive") - Number(old?.rating === "positive"),
					Number(input.rating === "negative") - Number(old?.rating === "negative"),
					timestamp,
					input.memoryId,
				);
			this.db
				.prepare(`INSERT INTO memory_feedback_votes (deliverable_id, memory_id, rating) VALUES (?, ?, ?)
				ON CONFLICT(deliverable_id, memory_id) DO UPDATE SET rating = excluded.rating`)
				.run(input.deliverableId, input.memoryId, input.rating);
			if (input.rating !== "neutral")
				this.db
					.prepare(
						`INSERT INTO memory_applications (id,memory_id,matter_id,member_id,deliverable_id,outcome,note,created_at) VALUES (?,?,?,?,?,?,?,?)`,
					)
					.run(
						`mapp_${randomUUID()}`,
						input.memoryId,
						input.matterId,
						input.memberId ?? memory.memberId,
						input.deliverableId,
						`feedback_${input.rating}`,
						input.note ?? "",
						timestamp,
					);
			if (ownsTransaction) this.db.exec("COMMIT");
		} catch (error) {
			if (ownsTransaction) this.db.exec("ROLLBACK");
			throw error;
		}
		return this.getMemory(input.memoryId)!;
	}

	clearDeliverableMemoryFeedback(deliverableId: string): MemberMemory[] {
		const delivery = this.getDeliverable(deliverableId);
		if (!delivery) throw new Error("Deliverable not found");
		const rows = this.db
			.prepare("SELECT memory_id FROM memory_feedback_votes WHERE deliverable_id = ?")
			.all(deliverableId);
		return rows.map((row) =>
			this.setMemoryFeedback({
				memoryId: String(row.memory_id),
				matterId: delivery.matterId,
				deliverableId,
				rating: "neutral",
			}),
		);
	}

	evaluateMatterMemories(input: {
		matterId: string;
		memberId?: string | null;
		deliverableId?: string | null;
		outcome: Exclude<MemoryApplicationOutcome, "applied">;
		note?: string;
	}): MemberMemory[] {
		if (!input.deliverableId) throw new Error("Feedback evaluation requires a specific deliverable");
		const rows = this.db
			.prepare(`SELECT DISTINCT a.memory_id FROM deliverable_memory_applications link
			JOIN memory_applications a ON a.id = link.application_id
			WHERE link.deliverable_id = ? AND a.matter_id = ? AND (? IS NULL OR a.member_id = ?)`)
			.all(input.deliverableId, input.matterId, input.memberId ?? null, input.memberId ?? null) as Array<{
			memory_id: string;
		}>;
		const updated: MemberMemory[] = [];
		for (const row of rows) {
			updated.push(
				this.evaluateMemory({
					memoryId: String(row.memory_id),
					outcome: input.outcome,
					matterId: input.matterId,
					memberId: input.memberId,
					deliverableId: input.deliverableId,
					note: input.note,
				}),
			);
		}
		return updated;
	}

	listMemoryApplications(memoryId: string, limit = 20): MemoryApplicationRecord[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM memory_applications
				 WHERE memory_id = ?
				 ORDER BY created_at DESC, rowid DESC
				 LIMIT ?`,
			)
			.all(memoryId, limit) as Record<string, unknown>[];
		return rows.map((row) => ({
			id: String(row.id),
			memoryId: String(row.memory_id),
			matterId: String(row.matter_id),
			memberId: String(row.member_id),
			deliverableId: row.deliverable_id ? String(row.deliverable_id) : null,
			outcome: row.outcome as MemoryApplicationOutcome,
			note: String(row.note ?? ""),
			createdAt: String(row.created_at),
		}));
	}

	upsertOrganization(input: {
		id?: string;
		name: string;
		gitEmailDomain?: string;
		description?: string;
		isDefault?: boolean;
	}): Organization {
		const name = input.name.trim();
		if (!name) throw new Error("Organization name is required");
		const timestamp = nowIso();
		const gitEmailDomain = (input.gitEmailDomain ?? "").trim().replace(/^@+/, "");
		const description = (input.description ?? "").trim();
		if (input.id) {
			const existing = this.getOrganization(input.id);
			if (existing) {
				this.db.exec("BEGIN IMMEDIATE");
				try {
					if (input.isDefault === true) {
						this.db.prepare("UPDATE organizations SET is_default = 0").run();
					}
					const nextDefault =
						input.isDefault !== undefined ? (input.isDefault ? 1 : 0) : existing.isDefault ? 1 : 0;
					this.db
						.prepare(
							`UPDATE organizations
							 SET name = ?, git_email_domain = ?, description = ?, is_default = ?, updated_at = ?
							 WHERE id = ?`,
						)
						.run(name, gitEmailDomain, description, nextDefault, timestamp, existing.id);
					this.db.exec("COMMIT");
				} catch (err) {
					this.db.exec("ROLLBACK");
					throw err;
				}
				return this.getOrganization(existing.id)!;
			}
		}
		const id = input.id?.trim() || `org_${randomUUID()}`;
		const hasDefault = Boolean(this.db.prepare("SELECT 1 FROM organizations WHERE is_default = 1 LIMIT 1").get());
		const shouldBeDefault = input.isDefault !== undefined ? input.isDefault : !hasDefault;
		this.db.exec("BEGIN IMMEDIATE");
		try {
			if (shouldBeDefault) {
				this.db.prepare("UPDATE organizations SET is_default = 0").run();
			}
			this.db
				.prepare(
					`INSERT INTO organizations (id, name, git_email_domain, description, is_default, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(id, name, gitEmailDomain, description, shouldBeDefault ? 1 : 0, timestamp, timestamp);
			this.db.exec("COMMIT");
		} catch (err) {
			this.db.exec("ROLLBACK");
			throw err;
		}
		return this.getOrganization(id)!;
	}

	updateOrganization(
		id: string,
		patch: { name?: string; gitEmailDomain?: string; description?: string; isDefault?: boolean },
	): Organization {
		const existing = this.getOrganization(id);
		if (!existing) throw new Error(`Organization not found: ${id}`);
		const timestamp = nowIso();
		const name = patch.name !== undefined ? patch.name.trim() || existing.name : existing.name;
		const gitEmailDomain =
			patch.gitEmailDomain !== undefined ? patch.gitEmailDomain.trim().replace(/^@+/, "") : existing.gitEmailDomain;
		const description = patch.description !== undefined ? patch.description.trim() : existing.description;
		const nextDefault = patch.isDefault !== undefined ? patch.isDefault : existing.isDefault;
		this.db.exec("BEGIN IMMEDIATE");
		try {
			if (patch.isDefault === true) {
				this.db.prepare("UPDATE organizations SET is_default = 0").run();
			}
			this.db
				.prepare(
					`UPDATE organizations
					 SET name = ?, git_email_domain = ?, description = ?, is_default = ?, updated_at = ?
					 WHERE id = ?`,
				)
				.run(name, gitEmailDomain, description, nextDefault ? 1 : 0, timestamp, id);
			this.db.exec("COMMIT");
		} catch (err) {
			this.db.exec("ROLLBACK");
			throw err;
		}
		return this.getOrganization(id)!;
	}

	setDefaultOrganization(id: string): Organization {
		return this.updateOrganization(id, { isDefault: true });
	}

	getDefaultOrganization(): Organization | null {
		const defaultRow = this.db
			.prepare("SELECT * FROM organizations WHERE is_default = 1 ORDER BY created_at ASC LIMIT 1")
			.get() as Record<string, unknown> | undefined;
		if (defaultRow) return this.mapOrganization(defaultRow);
		const firstRow = this.db.prepare("SELECT * FROM organizations ORDER BY created_at ASC LIMIT 1").get() as
			| Record<string, unknown>
			| undefined;
		return firstRow ? this.mapOrganization(firstRow) : null;
	}

	ensureDefaultOrganization(): Organization {
		const existing = this.getDefaultOrganization();
		if (existing) {
			if (!existing.isDefault) {
				return this.setDefaultOrganization(existing.id);
			}
			return existing;
		}
		return this.upsertOrganization({
			id: DEFAULT_ORGANIZATION_ID,
			name: DEFAULT_ORGANIZATION_NAME,
			gitEmailDomain: "",
			description: "未单独指定组织时自动归入的默认组织",
			isDefault: true,
		});
	}

	assignOrphanWorkspacesToDefaultOrganization(): number {
		const defaultOrg = this.ensureDefaultOrganization();
		const res = this.db.prepare("UPDATE workspace_links SET org_id = ? WHERE org_id IS NULL").run(defaultOrg.id);
		return Number(res.changes ?? 0);
	}

	getOrganization(id: string): Organization | null {
		const row = this.db.prepare("SELECT * FROM organizations WHERE id = ?").get(id) as
			| Record<string, unknown>
			| undefined;
		return row ? this.mapOrganization(row) : null;
	}

	listOrganizations(): Organization[] {
		const rows = this.db.prepare("SELECT * FROM organizations ORDER BY created_at ASC").all() as Record<
			string,
			unknown
		>[];
		return rows.map((row) => this.mapOrganization(row));
	}

	upsertWorkspace(input: {
		id?: string;
		orgId?: string | null;
		name: string;
		repoPath: string;
		defaultBranch?: string;
		description?: string;
	}): WorkspaceLink {
		const existing = this.db.prepare("SELECT * FROM workspace_links WHERE repo_path = ?").get(input.repoPath) as
			| Record<string, unknown>
			| undefined;
		if (existing) {
			const nextOrgId = input.orgId !== undefined ? input.orgId : existing.org_id ? String(existing.org_id) : null;
			this.db
				.prepare(
					`UPDATE workspace_links
					 SET org_id = ?, name = ?, default_branch = ?, description = ?
					 WHERE id = ?`,
				)
				.run(
					nextOrgId,
					input.name,
					input.defaultBranch ?? String(existing.default_branch),
					input.description ?? String(existing.description),
					String(existing.id),
				);
			return this.getWorkspace(String(existing.id))!;
		}

		const id = input.id ?? `ws_${randomUUID()}`;
		const timestamp = nowIso();
		this.db
			.prepare(
				`INSERT INTO workspace_links (id, org_id, name, repo_path, default_branch, description, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				input.orgId ?? null,
				input.name,
				input.repoPath,
				input.defaultBranch ?? "main",
				input.description ?? "",
				timestamp,
			);
		return this.getWorkspace(id)!;
	}

	updateWorkspace(
		id: string,
		patch: { orgId?: string | null; name?: string; defaultBranch?: string; description?: string },
	): WorkspaceLink {
		const existing = this.getWorkspace(id);
		if (!existing) throw new Error(`Workspace not found: ${id}`);
		const nextOrgId = patch.orgId !== undefined ? patch.orgId : existing.orgId;
		if (nextOrgId && !this.getOrganization(nextOrgId)) {
			throw new Error(`Organization not found: ${nextOrgId}`);
		}
		const nextName = patch.name !== undefined ? patch.name.trim() || existing.name : existing.name;
		const nextBranch =
			patch.defaultBranch !== undefined
				? patch.defaultBranch.trim() || existing.defaultBranch
				: existing.defaultBranch;
		const nextDesc = patch.description !== undefined ? patch.description.trim() : existing.description;
		this.db
			.prepare(
				`UPDATE workspace_links
				 SET org_id = ?, name = ?, default_branch = ?, description = ?
				 WHERE id = ?`,
			)
			.run(nextOrgId, nextName, nextBranch, nextDesc, id);
		return this.getWorkspace(id)!;
	}

	getWorkspace(id: string): WorkspaceLink | null {
		const row = this.db.prepare("SELECT * FROM workspace_links WHERE id = ?").get(id) as
			| Record<string, unknown>
			| undefined;
		return row ? this.mapWorkspace(row) : null;
	}

	listWorkspaces(): WorkspaceLink[] {
		const rows = this.db.prepare("SELECT * FROM workspace_links ORDER BY created_at ASC").all() as Record<
			string,
			unknown
		>[];
		return rows.map((row) => this.mapWorkspace(row));
	}

	createMatter(input: {
		title: string;
		summary?: string;
		leadMemberId?: string | null;
		workspaceId?: string | null;
		orgId?: string | null;
		observerMemberIds?: string[];
		collaboratorIds?: string[];
	}): Matter {
		const id = `mat_${randomUUID()}`;
		const timestamp = nowIso();
		const observerIds = normalizeUniqueIds(input.observerMemberIds);
		const collaboratorIds = normalizeUniqueIds(input.collaboratorIds);
		const workspace = input.workspaceId ? this.getWorkspace(input.workspaceId) : null;
		const effectiveOrgId = workspace ? workspace.orgId : (input.orgId ?? null);
		this.db
			.prepare(
				`INSERT INTO matters (
					id, title, summary, status, lead_member_id, workspace_id, org_id,
					observer_ids_json, collaborator_ids_json, created_at, updated_at
				)
				 VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				input.title,
				input.summary ?? "",
				input.leadMemberId ?? null,
				input.workspaceId ?? null,
				effectiveOrgId,
				JSON.stringify(observerIds),
				JSON.stringify(collaboratorIds),
				timestamp,
				timestamp,
			);
		return this.getMatter(id)!;
	}

	getMatter(id: string): Matter | null {
		const row = this.db.prepare("SELECT * FROM matters WHERE id = ?").get(id) as Record<string, unknown> | undefined;
		return row ? this.mapMatter(row) : null;
	}

	listMatters(): Matter[] {
		const rows = this.db.prepare("SELECT * FROM matters ORDER BY updated_at DESC").all() as Record<string, unknown>[];
		return rows.map((row) => this.mapMatter(row));
	}

	updateMatterStatus(matterId: string, status: MatterStatus, summary?: string): Matter {
		const timestamp = nowIso();
		if (summary !== undefined) {
			this.db
				.prepare("UPDATE matters SET status = ?, summary = ?, updated_at = ? WHERE id = ?")
				.run(status, summary, timestamp, matterId);
		} else {
			this.db.prepare("UPDATE matters SET status = ?, updated_at = ? WHERE id = ?").run(status, timestamp, matterId);
		}
		return this.getMatter(matterId)!;
	}

	updateMatterWorkspace(matterId: string, workspaceId: string | null): Matter {
		const timestamp = nowIso();
		const existing = this.getMatter(matterId);
		if (!existing) throw new Error(`Matter not found: ${matterId}`);
		const workspace = workspaceId ? this.getWorkspace(workspaceId) : null;
		const nextOrgId = workspace ? workspace.orgId : existing.orgId;
		this.db
			.prepare("UPDATE matters SET workspace_id = ?, org_id = ?, updated_at = ? WHERE id = ?")
			.run(workspaceId, nextOrgId, timestamp, matterId);
		return this.getMatter(matterId)!;
	}

	updateMatterOrganization(matterId: string, orgId: string | null): Matter {
		const timestamp = nowIso();
		const existing = this.getMatter(matterId);
		if (!existing) throw new Error(`Matter not found: ${matterId}`);
		if (orgId && !this.getOrganization(orgId)) {
			throw new Error(`Organization not found: ${orgId}`);
		}
		const currentWs = existing.workspaceId ? this.getWorkspace(existing.workspaceId) : null;
		const nextWorkspaceId = currentWs && currentWs.orgId !== orgId ? null : existing.workspaceId;
		this.db
			.prepare("UPDATE matters SET org_id = ?, workspace_id = ?, updated_at = ? WHERE id = ?")
			.run(orgId, nextWorkspaceId, timestamp, matterId);
		return this.getMatter(matterId)!;
	}

	updateMatterObservers(matterId: string, observerMemberIds: string[]): Matter {
		const timestamp = nowIso();
		const observerIds = normalizeUniqueIds(observerMemberIds);
		this.db
			.prepare("UPDATE matters SET observer_ids_json = ?, updated_at = ? WHERE id = ?")
			.run(JSON.stringify(observerIds), timestamp, matterId);
		return this.getMatter(matterId)!;
	}

	updateMatterCollaborators(matterId: string, collaboratorIds: string[]): Matter {
		const existing = this.getMatter(matterId);
		if (!existing) throw new Error(`Matter not found: ${matterId}`);
		const timestamp = nowIso();
		const normalized = normalizeUniqueIds(collaboratorIds);
		this.db
			.prepare("UPDATE matters SET collaborator_ids_json = ?, updated_at = ? WHERE id = ?")
			.run(JSON.stringify(normalized), timestamp, matterId);
		return this.getMatter(matterId)!;
	}

	addMatterCollaborator(matterId: string, collaboratorId: string): Matter {
		const existing = this.getMatter(matterId);
		if (!existing) throw new Error(`Matter not found: ${matterId}`);
		if (existing.collaboratorIds.includes(collaboratorId)) return existing;
		return this.updateMatterCollaborators(matterId, [...existing.collaboratorIds, collaboratorId]);
	}

	getMessage(messageId: string): MatterMessage | null {
		const row = this.db.prepare("SELECT * FROM matter_messages WHERE id = ?").get(messageId) as
			| Record<string, unknown>
			| undefined;
		return row ? this.mapMessage(row) : null;
	}

	updateMessageMetadata(messageId: string, metadata: Record<string, unknown>): MatterMessage | null {
		const existing = this.getMessage(messageId);
		if (!existing) return null;
		this.db
			.prepare("UPDATE matter_messages SET metadata_json = ? WHERE id = ?")
			.run(JSON.stringify(metadata), messageId);
		return this.getMessage(messageId);
	}

	ensureOwnerCollaborator(defaultName?: string): Collaborator {
		const existing = this.getCollaborator(DEFAULT_OWNER_COLLABORATOR_ID);
		if (existing) {
			return existing;
		}
		const timestamp = nowIso();
		const token = `own_${randomUUID().replace(/-/g, "")}`;
		const name = defaultName?.trim() || "团队所有者";
		this.db
			.prepare(
				`INSERT INTO collaborators (id, org_id, name, role_title, permission_role, token, created_at, updated_at)
				 VALUES (?, NULL, ?, ?, 'owner', ?, ?, ?)`,
			)
			.run(DEFAULT_OWNER_COLLABORATOR_ID, name, "Owner / 宿主管理者", token, timestamp, timestamp);
		return this.getCollaborator(DEFAULT_OWNER_COLLABORATOR_ID)!;
	}

	upsertCollaborator(input: {
		id?: string;
		orgId?: string | null;
		name: string;
		roleTitle?: string;
		permissionRole?: CollaboratorRole;
	}): Collaborator {
		const name = input.name.trim();
		if (!name) throw new Error("Collaborator name is required");
		const orgId = input.orgId ?? null;
		if (orgId && !this.getOrganization(orgId)) {
			throw new Error(`Organization not found: ${orgId}`);
		}
		const timestamp = nowIso();
		const existing = input.id ? this.getCollaborator(input.id) : null;
		if (existing) {
			const nextRole: CollaboratorRole =
				existing.id === DEFAULT_OWNER_COLLABORATOR_ID ? "owner" : (input.permissionRole ?? existing.permissionRole);
			const nextTitle = input.roleTitle !== undefined ? input.roleTitle.trim() : existing.roleTitle;
			const nextOrgId = input.orgId !== undefined ? orgId : existing.orgId;
			this.db
				.prepare(
					`UPDATE collaborators
					 SET org_id = ?, name = ?, role_title = ?, permission_role = ?, updated_at = ?
					 WHERE id = ?`,
				)
				.run(nextOrgId, name, nextTitle, nextRole, timestamp, existing.id);
			return this.getCollaborator(existing.id)!;
		}
		const id = input.id?.trim() || `col_${randomUUID().slice(0, 12)}`;
		const permissionRole: CollaboratorRole =
			id === DEFAULT_OWNER_COLLABORATOR_ID ? "owner" : (input.permissionRole ?? "collaborator");
		const token = `${permissionRole === "owner" ? "own" : "inv"}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
		this.db
			.prepare(
				`INSERT INTO collaborators (id, org_id, name, role_title, permission_role, token, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(id, orgId, name, input.roleTitle?.trim() ?? "协作者", permissionRole, token, timestamp, timestamp);
		return this.getCollaborator(id)!;
	}

	regenerateCollaboratorToken(id: string): Collaborator {
		const existing = this.getCollaborator(id);
		if (!existing) throw new Error(`Collaborator not found: ${id}`);
		const timestamp = nowIso();
		const token = `${existing.permissionRole === "owner" ? "own" : "inv"}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
		this.db.prepare("UPDATE collaborators SET token = ?, updated_at = ? WHERE id = ?").run(token, timestamp, id);
		return this.getCollaborator(id)!;
	}

	deleteCollaborator(id: string): boolean {
		if (id === DEFAULT_OWNER_COLLABORATOR_ID) {
			throw new Error("Cannot delete default owner collaborator");
		}
		const result = this.db.prepare("DELETE FROM collaborators WHERE id = ?").run(id);
		return result.changes > 0;
	}

	getCollaborator(id: string): Collaborator | null {
		const row = this.db.prepare("SELECT * FROM collaborators WHERE id = ?").get(id) as
			| Record<string, unknown>
			| undefined;
		return row ? this.mapCollaborator(row) : null;
	}

	getCollaboratorByToken(token: string): Collaborator | null {
		const trimmed = token.trim();
		if (!trimmed) return null;
		const row = this.db.prepare("SELECT * FROM collaborators WHERE token = ?").get(trimmed) as
			| Record<string, unknown>
			| undefined;
		return row ? this.mapCollaborator(row) : null;
	}

	listCollaborators(orgId?: string): Collaborator[] {
		const rows = (
			orgId
				? this.db
						.prepare(
							"SELECT * FROM collaborators WHERE org_id = ? OR org_id IS NULL ORDER BY CASE permission_role WHEN 'owner' THEN 0 ELSE 1 END, created_at ASC",
						)
						.all(orgId)
				: this.db
						.prepare(
							"SELECT * FROM collaborators ORDER BY CASE permission_role WHEN 'owner' THEN 0 ELSE 1 END, created_at ASC",
						)
						.all()
		) as Record<string, unknown>[];
		return rows.map((row) => this.mapCollaborator(row));
	}

	appendMessage(input: {
		matterId: string;
		channel: MatterMessageChannel;
		senderType: MatterMessageSenderType;
		senderId: string;
		content: string;
		metadata?: Record<string, unknown> | null;
	}): MatterMessage {
		const id = `msg_${randomUUID()}`;
		const timestamp = nowIso();
		this.db
			.prepare(
				`INSERT INTO matter_messages (id, matter_id, channel, sender_type, sender_id, content, metadata_json, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				input.matterId,
				input.channel,
				input.senderType,
				input.senderId,
				input.content,
				input.metadata ? JSON.stringify(input.metadata) : null,
				timestamp,
			);
		this.db.prepare("UPDATE matters SET updated_at = ? WHERE id = ?").run(timestamp, input.matterId);
		return {
			id,
			matterId: input.matterId,
			channel: input.channel,
			senderType: input.senderType,
			senderId: input.senderId,
			content: input.content,
			metadata: input.metadata ?? null,
			createdAt: timestamp,
		};
	}

	listMessages(matterId: string, channel?: MatterMessageChannel): MatterMessage[] {
		const rows = (
			channel
				? this.db
						.prepare(
							"SELECT * FROM matter_messages WHERE matter_id = ? AND channel = ? ORDER BY created_at ASC, rowid ASC",
						)
						.all(matterId, channel)
				: this.db
						.prepare("SELECT * FROM matter_messages WHERE matter_id = ? ORDER BY created_at ASC, rowid ASC")
						.all(matterId)
		) as Record<string, unknown>[];

		return rows.map((row) => this.mapMessage(row));
	}

	private mapMessage(row: Record<string, unknown>): MatterMessage {
		return {
			id: String(row.id),
			matterId: String(row.matter_id),
			channel: row.channel as MatterMessageChannel,
			senderType: row.sender_type as MatterMessageSenderType,
			senderId: String(row.sender_id),
			content: String(row.content),
			metadata: row.metadata_json ? (JSON.parse(String(row.metadata_json)) as Record<string, unknown>) : null,
			createdAt: String(row.created_at),
		};
	}

	/**
	 * Record a deliverable and auto-increment its version within the matter+title series.
	 */
	recordDeliverable(input: {
		matterId: string;
		memberId: string;
		type: DeliverableType;
		title: string;
		summary?: string;
		contentOrPath: string;
		serviceUrl?: string | null;
	}): Deliverable {
		const maxRow = this.db
			.prepare("SELECT COALESCE(MAX(version), 0) AS max_ver FROM deliverables WHERE matter_id = ? AND title = ?")
			.get(input.matterId, input.title) as { max_ver: number };
		const version = Number(maxRow.max_ver) + 1;
		const id = `del_${randomUUID()}`;
		const timestamp = nowIso();

		this.db
			.prepare(
				`INSERT INTO deliverables (
					id, matter_id, member_id, type, title, summary, content_or_path, service_url, version, feedback, created_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
			)
			.run(
				id,
				input.matterId,
				input.memberId,
				input.type,
				input.title,
				input.summary ?? "",
				input.contentOrPath,
				input.serviceUrl ?? null,
				version,
				timestamp,
			);
		this.db.prepare("UPDATE matters SET updated_at = ? WHERE id = ?").run(timestamp, input.matterId);

		return {
			id,
			matterId: input.matterId,
			memberId: input.memberId,
			type: input.type,
			title: input.title,
			summary: input.summary ?? "",
			contentOrPath: input.contentOrPath,
			serviceUrl: input.serviceUrl ?? null,
			version,
			feedback: null,
			feedbackRating: null,
			createdAt: timestamp,
		};
	}

	/** Commit a turn's index entries together, including their version numbers. */
	recordDeliverables(inputs: Parameters<PersonalAgentStore["recordDeliverable"]>[0][]): Deliverable[] {
		return this.recordTurnOutcome({ deliverables: inputs, candidates: [], applicationIds: [] }).deliverables;
	}

	recordTurnOutcome(input: {
		deliverables: Parameters<PersonalAgentStore["recordDeliverable"]>[0][];
		candidates: Parameters<PersonalAgentStore["addMemory"]>[0][];
		applicationIds: string[];
	}): { deliverables: Deliverable[]; memories: MemberMemory[]; skippedDuplicates: number } {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const deliverables = input.deliverables.map((entry) => this.recordDeliverable(entry));
			for (const delivery of deliverables) this.linkDeliverableApplications(delivery.id, input.applicationIds);
			const memories: MemberMemory[] = [];
			let skippedDuplicates = 0;
			for (const candidate of input.candidates) {
				if (
					this.findActiveDuplicateMemory(
						candidate.memberId,
						candidate.scope,
						candidate.workspaceId ?? null,
						candidate.content,
						candidate.orgId ?? null,
					)
				) {
					skippedDuplicates++;
					continue;
				}
				memories.push(this.addMemory({ ...candidate, status: "candidate", verified: false }));
			}
			this.db.exec("COMMIT");
			return { deliverables, memories, skippedDuplicates };
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	linkDeliverableApplications(deliverableId: string, applicationIds: string[]): void {
		const delivery = this.getDeliverable(deliverableId);
		if (!delivery) throw new Error("Deliverable not found");
		const insert =
			this.db.prepare(`INSERT OR IGNORE INTO deliverable_memory_applications (deliverable_id, application_id)
			SELECT ?, id FROM memory_applications WHERE id = ? AND matter_id = ? AND outcome = 'applied'`);
		for (const id of applicationIds) insert.run(deliverableId, id, delivery.matterId);
	}

	getDeliverable(id: string): Deliverable | null {
		const row = this.db.prepare("SELECT * FROM deliverables WHERE id = ?").get(id) as
			| Record<string, unknown>
			| undefined;
		return row ? this.mapDeliverable(row) : null;
	}

	listDeliverables(matterId?: string): Deliverable[] {
		const rows = (
			matterId
				? this.db
						.prepare("SELECT * FROM deliverables WHERE matter_id = ? ORDER BY created_at DESC, version DESC")
						.all(matterId)
				: this.db.prepare("SELECT * FROM deliverables ORDER BY created_at DESC, version DESC").all()
		) as Record<string, unknown>[];

		return rows.map((row) => this.mapDeliverable(row));
	}

	recordDeliverableFeedback(
		deliverableId: string,
		feedback: string,
		rating?: FeedbackRating,
	): { deliverable: Deliverable; evaluatedMemories: MemberMemory[] } {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const deliverable = this.addDeliverableFeedback(deliverableId, feedback, rating);
			if (!deliverable) throw new Error("Deliverable not found");
			const evaluatedMemories =
				rating === "neutral"
					? this.clearDeliverableMemoryFeedback(deliverableId)
					: rating
						? this.evaluateMatterMemories({
								matterId: deliverable.matterId,
								deliverableId,
								outcome: rating === "positive" ? "feedback_positive" : "feedback_negative",
								note: feedback,
							})
						: [];
			this.db.exec("COMMIT");
			return { deliverable, evaluatedMemories };
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	addDeliverableFeedback(deliverableId: string, feedback: string, rating?: FeedbackRating | null): Deliverable | null {
		if (rating !== undefined) {
			this.db
				.prepare("UPDATE deliverables SET feedback = ?, feedback_rating = ? WHERE id = ?")
				.run(feedback, rating, deliverableId);
		} else {
			this.db.prepare("UPDATE deliverables SET feedback = ? WHERE id = ?").run(feedback, deliverableId);
		}
		return this.getDeliverable(deliverableId);
	}

	recordWorkerSession(input: {
		memberId: string;
		matterId: string;
		workspaceId: string | null;
		piSessionId: string | null;
		sessionFile: string | null;
		status: "active" | "idle" | "closed";
		contextKey?: string;
		messageCursor?: string;
	}): WorkerSessionRecord {
		const id = `wsess_${randomUUID()}`;
		const timestamp = nowIso();
		this.db
			.prepare(
				`INSERT INTO worker_sessions (id, member_id, matter_id, workspace_id, pi_session_id, session_file, status, last_active_at, context_key, message_cursor)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				input.memberId,
				input.matterId,
				input.workspaceId,
				input.piSessionId,
				input.sessionFile,
				input.status,
				timestamp,
				input.contextKey ?? null,
				input.messageCursor ?? null,
			);
		return {
			id,
			messageCursor: input.messageCursor ?? null,
			memberId: input.memberId,
			matterId: input.matterId,
			workspaceId: input.workspaceId,
			piSessionId: input.piSessionId,
			sessionFile: input.sessionFile,
			status: input.status,
			lastActiveAt: timestamp,
		};
	}

	findWorkerSession(
		matterId: string,
		memberId: string,
		contextKey: string,
		workspaceId: string | null,
	): WorkerSessionRecord | null {
		let row = this.db
			.prepare(`SELECT * FROM worker_sessions
			WHERE matter_id = ? AND member_id = ? AND context_key = ? AND status != 'closed'
			AND session_file IS NOT NULL ORDER BY rowid DESC LIMIT 1`)
			.get(matterId, memberId, contextKey);
		if (!row)
			row = this.db
				.prepare(`SELECT * FROM worker_sessions WHERE matter_id = ? AND member_id = ?
			AND workspace_id IS ? AND context_key IS NULL AND session_file IS NOT NULL
			ORDER BY rowid DESC LIMIT 1`)
				.get(matterId, memberId, workspaceId);
		return row
			? {
					id: String(row.id),
					memberId,
					matterId,
					messageCursor: row.message_cursor ? String(row.message_cursor) : null,
					workspaceId: row.workspace_id ? String(row.workspace_id) : null,
					piSessionId: row.pi_session_id ? String(row.pi_session_id) : null,
					sessionFile: String(row.session_file),
					status: row.status === "active" ? "active" : "idle",
					lastActiveAt: String(row.last_active_at),
				}
			: null;
	}

	finishWorkerSession(id: string, status: "idle" | "closed"): void {
		this.db
			.prepare("UPDATE worker_sessions SET status = ?, last_active_at = ? WHERE id = ?")
			.run(status, nowIso(), id);
	}

	hasLiveMatterLease(matterId: string): boolean {
		const lease = this.db.prepare("SELECT owner_pid FROM matter_execution_leases WHERE matter_id = ?").get(matterId);
		if (!lease) return false;
		try {
			process.kill(Number(lease.owner_pid), 0);
			return true;
		} catch (error) {
			return !(error instanceof Error && "code" in error && error.code === "ESRCH");
		}
	}

	acquireMatterLease(matterId: string, ownerId: string): boolean {
		const prior = this.db.prepare("SELECT owner_id FROM matter_execution_leases WHERE matter_id = ?").get(matterId);
		if (prior) {
			if (this.hasLiveMatterLease(matterId)) return false;
			this.db
				.prepare("DELETE FROM matter_execution_leases WHERE matter_id = ? AND owner_id = ?")
				.run(matterId, String(prior.owner_id));
		}
		return (
			this.db
				.prepare("INSERT OR IGNORE INTO matter_execution_leases (matter_id, owner_id, owner_pid) VALUES (?, ?, ?)")
				.run(matterId, ownerId, process.pid).changes > 0
		);
	}

	releaseMatterLease(matterId: string, ownerId: string): void {
		this.db
			.prepare("DELETE FROM matter_execution_leases WHERE matter_id = ? AND owner_id = ?")
			.run(matterId, ownerId);
	}

	updateMatterLead(matterId: string, memberId: string): void {
		this.db.prepare("UPDATE matters SET lead_member_id = ? WHERE id = ?").run(memberId, matterId);
	}

	private mapOrganization(row: Record<string, unknown>): Organization {
		return {
			id: String(row.id),
			name: String(row.name),
			gitEmailDomain: typeof row.git_email_domain === "string" ? row.git_email_domain : "",
			description: typeof row.description === "string" ? row.description : "",
			isDefault: Boolean(row.is_default),
			createdAt: String(row.created_at),
			updatedAt: String(row.updated_at),
		};
	}

	private mapMember(row: Record<string, unknown>): TeamMember {
		const id = String(row.id);
		const displayName = String(row.display_name);
		const roleTitle = String(row.role_title);
		const rawGitName = typeof row.git_name === "string" ? row.git_name.trim() : "";
		const rawGitEmail = typeof row.git_email === "string" ? row.git_email.trim() : "";
		return {
			id,
			templateId: String(row.template_id),
			displayName,
			roleTitle,
			isPrimaryContact: Boolean(row.is_primary_contact),
			provider: String(row.provider),
			model: String(row.model),
			thinkingLevel: row.thinking_level as ThinkingLevel,
			keywords: JSON.parse(String(row.keywords_json)) as string[],
			gitName: rawGitName || defaultMemberGitName({ id, displayName, roleTitle }),
			gitEmail: rawGitEmail || `${id}@team.local`,
			identitySummary: typeof row.identity_summary === "string" ? row.identity_summary : "",
			createdAt: String(row.created_at),
			updatedAt: String(row.updated_at),
		};
	}

	private mapWorkspace(row: Record<string, unknown>): WorkspaceLink {
		return {
			id: String(row.id),
			orgId: row.org_id ? String(row.org_id) : null,
			name: String(row.name),
			repoPath: String(row.repo_path),
			defaultBranch: String(row.default_branch),
			description: String(row.description),
			createdAt: String(row.created_at),
		};
	}

	private mapMemory(row: Record<string, unknown>): MemberMemory {
		const rawStatus = typeof row.status === "string" && row.status ? row.status : null;
		const status: MemoryStatus =
			rawStatus === "candidate" || rawStatus === "verified" || rawStatus === "rejected" || rawStatus === "superseded"
				? rawStatus
				: row.verified
					? "verified"
					: "candidate";
		return {
			id: String(row.id),
			memberId: String(row.member_id),
			scope: row.scope as MemoryScope,
			category: normalizeMemoryCategory(row.category),
			orgId: row.org_id ? String(row.org_id) : null,
			workspaceId: row.workspace_id ? String(row.workspace_id) : null,
			content: String(row.content),
			rationale: typeof row.rationale === "string" ? row.rationale : "",
			sourceMatterId: row.source_matter_id ? String(row.source_matter_id) : null,
			sourceDeliverableId: row.source_deliverable_id ? String(row.source_deliverable_id) : null,
			status,
			verified: status === "verified",
			supersededBy: row.superseded_by ? String(row.superseded_by) : null,
			supersedesMemoryId: row.supersedes_memory_id ? String(row.supersedes_memory_id) : null,
			appliedCount: Number(row.applied_count ?? 0),
			positiveCount: Number(row.positive_count ?? 0),
			negativeCount: Number(row.negative_count ?? 0),
			lastAppliedAt: row.last_applied_at ? String(row.last_applied_at) : null,
			createdAt: String(row.created_at),
			updatedAt: row.updated_at ? String(row.updated_at) : String(row.created_at),
		};
	}

	private mapDeliverable(row: Record<string, unknown>): Deliverable {
		const rawRating = row.feedback_rating;
		const feedbackRating: FeedbackRating | null =
			rawRating === "positive" || rawRating === "negative" || rawRating === "neutral" ? rawRating : null;
		return {
			id: String(row.id),
			matterId: String(row.matter_id),
			memberId: String(row.member_id),
			type: row.type as DeliverableType,
			title: String(row.title),
			summary: String(row.summary),
			contentOrPath: String(row.content_or_path),
			serviceUrl: row.service_url ? String(row.service_url) : null,
			version: Number(row.version),
			feedback: row.feedback ? String(row.feedback) : null,
			feedbackRating,
			createdAt: String(row.created_at),
		};
	}

	private mapCollaborator(row: Record<string, unknown>): Collaborator {
		const permissionRole: CollaboratorRole = row.permission_role === "owner" ? "owner" : "collaborator";
		return {
			id: String(row.id),
			orgId: row.org_id ? String(row.org_id) : null,
			name: String(row.name),
			roleTitle: typeof row.role_title === "string" ? row.role_title : "",
			permissionRole,
			token: String(row.token),
			createdAt: String(row.created_at),
			updatedAt: String(row.updated_at),
		};
	}

	private mapMatter(row: Record<string, unknown>): Matter {
		return {
			id: String(row.id),
			title: String(row.title),
			summary: String(row.summary),
			status: row.status as MatterStatus,
			leadMemberId: row.lead_member_id ? String(row.lead_member_id) : null,
			workspaceId: row.workspace_id ? String(row.workspace_id) : null,
			orgId: row.org_id ? String(row.org_id) : null,
			observerMemberIds: parseUniqueIds(row.observer_ids_json),
			collaboratorIds: parseUniqueIds(row.collaborator_ids_json),
			createdAt: String(row.created_at),
			updatedAt: String(row.updated_at),
		};
	}
}
