import type { DatabaseSync } from "node:sqlite";
import type { MemberMemory } from "../types.ts";
import type { AddMemoryInput, MemoryRepo } from "./memory-repo.ts";
import { syncSpaceFeedbackVotes } from "./space-feedback-votes.ts";

/** Commit successful turn memories and links to their space document revisions. */
export class TurnOutcomeRepo {
	private readonly db: DatabaseSync;
	private readonly memoryRepo: MemoryRepo;

	constructor(db: DatabaseSync, memoryRepo: MemoryRepo) {
		this.db = db;
		this.memoryRepo = memoryRepo;
	}

	recordTurnOutcome(input: {
		candidates: AddMemoryInput[];
		applicationIds: string[];
		spaceDocuments?: Array<{ id: string; headCommit: string }>;
	}): { memories: MemberMemory[]; skippedDuplicates: number } {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const linkSpaceApplication = this.db.prepare(`INSERT OR IGNORE INTO space_document_memory_applications
				(document_id, commit_hash, application_id)
				SELECT d.id, ?, a.id FROM space_documents d
				JOIN memory_applications a ON a.matter_id = d.matter_id
				WHERE d.id = ? AND a.id = ? AND a.outcome = 'applied'`);
			for (const document of input.spaceDocuments ?? []) {
				for (const applicationId of input.applicationIds) {
					linkSpaceApplication.run(document.headCommit, document.id, applicationId);
				}
				const feedbackRows = this.db
					.prepare(
						"SELECT actor_id, rating, feedback FROM space_document_feedback WHERE document_id = ? AND commit_hash = ?",
					)
					.all(document.id, document.headCommit) as Array<{
					actor_id: string;
					rating: "positive" | "negative" | "neutral" | null;
					feedback: string;
				}>;
				for (const feedback of feedbackRows) {
					syncSpaceFeedbackVotes(this.db, {
						documentId: document.id,
						commitHash: document.headCommit,
						actorId: feedback.actor_id,
						rating: feedback.rating,
						feedback: feedback.feedback,
					});
				}
			}
			const memories: MemberMemory[] = [];
			let skippedDuplicates = 0;
			for (const candidate of input.candidates) {
				if (
					this.memoryRepo.findActiveDuplicateMemory(
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
				memories.push(this.memoryRepo.addMemory({ ...candidate, status: "candidate", verified: false }));
			}
			this.db.exec("COMMIT");
			return { memories, skippedDuplicates };
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
}
