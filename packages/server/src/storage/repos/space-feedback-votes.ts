import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/** Synchronize one reviewer's votes for the memories used by this exact document commit. */
export function syncSpaceFeedbackVotes(
	db: DatabaseSync,
	input: {
		documentId: string;
		commitHash: string;
		actorId: string;
		rating: "positive" | "negative" | "neutral" | null;
		feedback?: string;
	},
): void {
	const rows = db
		.prepare(`SELECT DISTINCT a.memory_id, v.rating AS previous_rating
			FROM space_document_memory_applications link
			JOIN memory_applications a ON a.id = link.application_id
			LEFT JOIN space_document_memory_votes v ON v.document_id = link.document_id
				AND v.commit_hash = link.commit_hash AND v.actor_id = ? AND v.memory_id = a.memory_id
			WHERE link.document_id = ? AND link.commit_hash = ?`)
		.all(input.actorId, input.documentId, input.commitHash);
	const rating = input.rating === "positive" || input.rating === "negative" ? input.rating : null;
	for (const row of rows) {
		const previous = row.previous_rating;
		if (previous === rating) continue;
		if (rating) {
			db.prepare(`INSERT INTO space_document_memory_votes (document_id, commit_hash, actor_id, memory_id, rating)
				VALUES (?, ?, ?, ?, ?) ON CONFLICT(document_id, commit_hash, actor_id, memory_id)
				DO UPDATE SET rating = excluded.rating`).run(
				input.documentId,
				input.commitHash,
				input.actorId,
				String(row.memory_id),
				rating,
			);
			db.prepare(`INSERT INTO memory_applications
				(id, memory_id, matter_id, member_id, document_id, commit_hash, actor_id, outcome, note, created_at)
				SELECT ?, m.id, d.matter_id, m.member_id, d.id, ?, ?, ?, ?, ?
				FROM member_memories m JOIN space_documents d ON d.id = ? WHERE m.id = ? AND d.matter_id IS NOT NULL`).run(
				`mapp_${randomUUID()}`,
				input.commitHash,
				input.actorId,
				`feedback_${rating}`,
				input.feedback ?? "",
				new Date().toISOString(),
				input.documentId,
				String(row.memory_id),
			);
		} else {
			db.prepare(`DELETE FROM space_document_memory_votes
				WHERE document_id = ? AND commit_hash = ? AND actor_id = ? AND memory_id = ?`).run(
				input.documentId,
				input.commitHash,
				input.actorId,
				String(row.memory_id),
			);
		}
	}
}
