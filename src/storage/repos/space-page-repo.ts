import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "./helpers.ts";

export interface SpacePage {
	id: string;
	matterId: string;
	title: string;
	content: string;
	revision: number;
	createdBy: string;
	updatedBy: string;
	createdAt: string;
	updatedAt: string;
}

export interface SpacePageRevision {
	pageId: string;
	revision: number;
	title: string;
	content: string;
	updatedBy: string;
	createdAt: string;
}

interface PageRow {
	id: string;
	matter_id: string;
	title: string;
	content: string;
	revision: number;
	created_by: string;
	updated_by: string;
	created_at: string;
	updated_at: string;
}

function mapPage(row: PageRow): SpacePage {
	return {
		id: row.id,
		matterId: row.matter_id,
		title: row.title,
		content: row.content,
		revision: row.revision,
		createdBy: row.created_by,
		updatedBy: row.updated_by,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export class SpacePageRepo {
	private readonly db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	get(id: string): SpacePage | null {
		const row = this.db.prepare("SELECT * FROM space_pages WHERE id = ?").get(id) as unknown as PageRow | undefined;
		return row ? mapPage(row) : null;
	}

	list(matterId?: string): SpacePage[] {
		const rows = (matterId
			? this.db.prepare("SELECT * FROM space_pages WHERE matter_id = ? ORDER BY updated_at DESC, id").all(matterId)
			: this.db.prepare("SELECT * FROM space_pages ORDER BY updated_at DESC, id").all()) as unknown as PageRow[];
		return rows.map(mapPage);
	}

	listRevisions(pageId: string): SpacePageRevision[] {
		const rows = this.db
			.prepare(
				"SELECT page_id, revision, title, content, updated_by, created_at FROM space_page_revisions WHERE page_id = ? ORDER BY revision DESC",
			)
			.all(pageId) as Array<{
			page_id: string;
			revision: number;
			title: string;
			content: string;
			updated_by: string;
			created_at: string;
		}>;
		return rows.map((row) => ({
			pageId: row.page_id,
			revision: row.revision,
			title: row.title,
			content: row.content,
			updatedBy: row.updated_by,
			createdAt: row.created_at,
		}));
	}

	create(input: { matterId: string; title: string; content: string; actorId: string }): SpacePage {
		const id = `page_${randomUUID()}`;
		const now = nowIso();
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db
				.prepare("INSERT INTO space_pages VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)")
				.run(id, input.matterId, input.title, input.content, input.actorId, input.actorId, now, now);
			this.db
				.prepare("INSERT INTO space_page_revisions VALUES (?, 1, ?, ?, ?, ?)")
				.run(id, input.title, input.content, input.actorId, now);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
		return this.get(id)!;
	}

	update(id: string, input: { revision: number; title: string; content: string; actorId: string }): SpacePage | null {
		const now = nowIso();
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = this.db
				.prepare(
					"UPDATE space_pages SET title = ?, content = ?, revision = revision + 1, updated_by = ?, updated_at = ? WHERE id = ? AND revision = ?",
				)
				.run(input.title, input.content, input.actorId, now, id, input.revision);
			if (result.changes === 0) {
				this.db.exec("ROLLBACK");
				return null;
			}
			this.db
				.prepare("INSERT INTO space_page_revisions VALUES (?, ?, ?, ?, ?, ?)")
				.run(id, input.revision + 1, input.title, input.content, input.actorId, now);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
		return this.get(id);
	}
}
