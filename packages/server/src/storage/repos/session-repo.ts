import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { WorkerSessionRecord } from "../types.ts";
import { nowIso } from "./helpers.ts";

/** Manages persisted Pi worker sessions and process-scoped matter execution leases. */
export class SessionRepo {
	private readonly db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.db = db;
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
		const row = this.db
			.prepare(`SELECT * FROM worker_sessions
			WHERE matter_id = ? AND member_id = ? AND context_key = ? AND workspace_id IS ? AND status != 'closed'
			AND session_file IS NOT NULL ORDER BY rowid DESC LIMIT 1`)
			.get(matterId, memberId, contextKey, workspaceId);
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

	listWorkerSessions(options?: { matterId?: string; memberId?: string; limit?: number }): WorkerSessionRecord[] {
		const conditions = ["session_file IS NOT NULL"];
		const params: Array<string | number> = [];
		if (options?.matterId) {
			conditions.push("matter_id = ?");
			params.push(options.matterId);
		}
		if (options?.memberId) {
			conditions.push("member_id = ?");
			params.push(options.memberId);
		}
		const limit = Math.max(1, Math.min(200, options?.limit ?? 50));
		params.push(limit);
		const rows = this.db
			.prepare(
				`SELECT * FROM worker_sessions WHERE ${conditions.join(" AND ")} ORDER BY last_active_at DESC, rowid DESC LIMIT ?`,
			)
			.all(...params);
		return rows.map((row) => ({
			id: String(row.id),
			memberId: String(row.member_id),
			matterId: String(row.matter_id),
			messageCursor: row.message_cursor ? String(row.message_cursor) : null,
			workspaceId: row.workspace_id ? String(row.workspace_id) : null,
			piSessionId: row.pi_session_id ? String(row.pi_session_id) : null,
			sessionFile: String(row.session_file),
			status: row.status === "active" ? "active" : row.status === "closed" ? "closed" : "idle",
			lastActiveAt: String(row.last_active_at),
		}));
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
}
