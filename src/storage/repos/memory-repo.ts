import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
	Deliverable,
	FeedbackRating,
	MemberMemory,
	MemoryApplicationOutcome,
	MemoryApplicationRecord,
	MemoryCategory,
	MemoryScope,
	MemoryStatus,
} from "../types.ts";
import { MemoryValidationError, mapMemoryRow, normalizeMemoryCategory, normalizeUniqueIds, nowIso } from "./helpers.ts";
import type { MemberRepo } from "./member-repo.ts";
import type { WorkspaceRepo } from "./workspace-repo.ts";

export interface AddMemoryInput {
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
}

export interface MemoryRepoDeps {
	db: DatabaseSync;
	memberRepo: MemberRepo;
	workspaceRepo: WorkspaceRepo;
	getDeliverable: (id: string) => Deliverable | null;
}

/** Manages role memories, replacement provenance, injection counts, and feedback votes. */
export class MemoryRepo {
	private readonly db: DatabaseSync;
	private readonly memberRepo: MemberRepo;
	private readonly workspaceRepo: WorkspaceRepo;
	private readonly getDeliverable: (id: string) => Deliverable | null;

	constructor(deps: MemoryRepoDeps) {
		this.db = deps.db;
		this.memberRepo = deps.memberRepo;
		this.workspaceRepo = deps.workspaceRepo;
		this.getDeliverable = deps.getDeliverable;
	}

	addMemory(input: AddMemoryInput): MemberMemory {
		return this.writeMemory(() => this.insertMemory(input));
	}

	private insertMemory(input: AddMemoryInput): MemberMemory {
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
				null,
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
		return row ? mapMemoryRow(row) : null;
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
			supersedesMemoryId?: string | null;
		},
	): MemberMemory {
		return this.writeMemory(() => this.patchMemory(id, patch));
	}

	private patchMemory(id: string, patch: Parameters<MemoryRepo["updateMemory"]>[1]): MemberMemory {
		const existing = this.getMemory(id);
		if (!existing) throw new Error(`Memory not found: ${id}`);
		const timestamp = nowIso();
		const nextMemberId = patch.memberId !== undefined ? patch.memberId.trim() : existing.memberId;
		if (!nextMemberId || !this.memberRepo.getMember(nextMemberId)) {
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
		if (existing.supersededBy && nextStatus !== "superseded") {
			throw new MemoryValidationError("Cannot reactivate a memory with an established replacement");
		}
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
				     status = ?, verified = ?, supersedes_memory_id = ?, updated_at = ?
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
		const result = this.db
			.prepare(
				`UPDATE member_memories
				 SET status = 'superseded', verified = 0, superseded_by = ?, updated_at = ?
				 WHERE id = ? AND status IN ('candidate', 'verified') AND superseded_by IS NULL`,
			)
			.run(replacementId, timestamp, targetMemoryId);
		if (result.changes) return;
		const target = this.getMemory(targetMemoryId);
		if (target?.status === "superseded" && target.supersededBy === replacementId) return;
		throw new MemoryValidationError("The prior memory already has a replacement or is no longer active");
	}

	private writeMemory<T>(operation: () => T): T {
		// Outcome commits can already be in a transaction when they add a memory.
		this.db.exec("SAVEPOINT write_memory");
		try {
			const result = operation();
			this.db.exec("RELEASE write_memory");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK TO write_memory; RELEASE write_memory");
			throw error;
		}
	}

	/** Inject role-general facts, organization-shared memory for the workspace's org (or single-workspace legacy company memory), and workspace-specific facts. */
	listRelevantMemories(
		memberId: string,
		workspaceId: string | null,
		options?: { includeCandidates?: boolean; orgId?: string | null },
	): MemberMemory[] {
		const includeCandidates = options?.includeCandidates ?? true;
		const workspace = workspaceId ? this.workspaceRepo.getWorkspace(workspaceId) : null;
		const activeOrgId = workspace ? workspace.orgId : (options?.orgId ?? null);
		const canUseWorkspaceMemories = workspace !== null && !this.workspaceRepo.hasWorkspaceScopeConflict(workspace.id);
		const memories = this.listMemberMemories(memberId);
		const byId = new Map(memories.map((memory) => [memory.id, memory]));
		return memories
			.filter((memory) => {
				if (memory.status === "rejected" || memory.status === "superseded") return false;
				if (memory.supersedesMemoryId) {
					const target = byId.get(memory.supersedesMemoryId);
					if (memory.status !== "verified" || target?.supersededBy !== memory.id) return false;
				}
				if (!includeCandidates && memory.status !== "verified") return false;
				if (memory.scope === "role_general") return true;
				if (memory.scope === "company_private") {
					if (activeOrgId !== null && memory.orgId === activeOrgId) return true;
					return canUseWorkspaceMemories && !memory.orgId && memory.workspaceId === workspaceId;
				}
				return canUseWorkspaceMemories && memory.workspaceId === workspaceId;
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
		return rows.map((row) => mapMemoryRow(row));
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
			documentId: row.document_id ? String(row.document_id) : null,
			commitHash: row.commit_hash ? String(row.commit_hash) : null,
			actorId: row.actor_id ? String(row.actor_id) : null,
			outcome: row.outcome as MemoryApplicationOutcome,
			note: String(row.note ?? ""),
			createdAt: String(row.created_at),
		}));
	}
}
