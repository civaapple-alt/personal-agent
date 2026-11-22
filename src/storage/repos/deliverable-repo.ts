import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Deliverable, DeliverableType, FeedbackRating, MemberMemory } from "../types.ts";
import { mapDeliverableRow, nowIso } from "./helpers.ts";
import type { MemoryRepo } from "./memory-repo.ts";

export interface RecordDeliverableInput {
	matterId: string;
	memberId: string;
	type: DeliverableType;
	title: string;
	summary?: string;
	contentOrPath: string;
	serviceUrl?: string | null;
}

/** Manages versioned deliverables, turn outcome commits, and deliverable-level memory feedback. */
export class DeliverableRepo {
	private readonly db: DatabaseSync;
	private readonly memoryRepo: MemoryRepo;

	constructor(db: DatabaseSync, memoryRepo: MemoryRepo) {
		this.db = db;
		this.memoryRepo = memoryRepo;
	}

	/**
	 * Record a deliverable and auto-increment its version within the matter+title series.
	 */
	recordDeliverable(input: RecordDeliverableInput): Deliverable {
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

	/** Record a batch of explicit deliveries atomically. */
	recordDeliverables(inputs: RecordDeliverableInput[]): Deliverable[] {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = inputs.map((input) => this.recordDeliverable(input));
			this.db.exec("COMMIT");
			return result;
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
		return row ? mapDeliverableRow(row) : null;
	}

	listDeliverables(matterId?: string): Deliverable[] {
		const rows = (
			matterId
				? this.db
						.prepare("SELECT * FROM deliverables WHERE matter_id = ? ORDER BY created_at DESC, version DESC")
						.all(matterId)
				: this.db.prepare("SELECT * FROM deliverables ORDER BY created_at DESC, version DESC").all()
		) as Record<string, unknown>[];

		return rows.map((row) => mapDeliverableRow(row));
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
					? this.memoryRepo.clearDeliverableMemoryFeedback(deliverableId)
					: rating
						? this.memoryRepo.evaluateMatterMemories({
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
}
