import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { HumanDecision } from "../../orchestrator/human-decision.ts";
import { ROLE_ARCHITECT_MEMBER_ID } from "../../roles/role-architect.ts";
import type { ModelSelection } from "../../rpc/model-selection.ts";
import type {
	Matter,
	MatterMessage,
	MatterMessageChannel,
	MatterMessageSenderType,
	MatterStatus,
	MatterVisibility,
} from "../types.ts";
import { mapMatterRow, mapMessageRow, normalizeUniqueIds, nowIso } from "./helpers.ts";
import type { MemberRepo } from "./member-repo.ts";
import type { OrganizationRepo } from "./organization-repo.ts";
import type { WorkspaceRepo } from "./workspace-repo.ts";

/** Manages matters, participant/observer configuration, and persisted matter messages. */
export class MatterRepo {
	private readonly db: DatabaseSync;
	private readonly memberRepo: MemberRepo;
	private readonly orgRepo: OrganizationRepo;
	private readonly workspaceRepo: WorkspaceRepo;

	constructor(db: DatabaseSync, memberRepo: MemberRepo, orgRepo: OrganizationRepo, workspaceRepo: WorkspaceRepo) {
		this.db = db;
		this.memberRepo = memberRepo;
		this.orgRepo = orgRepo;
		this.workspaceRepo = workspaceRepo;
	}

	private resolveEffectiveAiIds(aiMemberIds: string[] | null): string[] {
		if (aiMemberIds !== null) return aiMemberIds;
		const all = this.memberRepo.listMembers().map((member) => member.id);
		const business = all.filter((id) => id !== ROLE_ARCHITECT_MEMBER_ID);
		return business.length > 0 ? business : all;
	}

	private computeAutoObservers(effectiveAiIds: string[], leadMemberId: string | null): string[] {
		return effectiveAiIds.filter((id) => id !== leadMemberId && id !== ROLE_ARCHITECT_MEMBER_ID);
	}

	createMatter(input: {
		id?: string;
		title: string;
		summary?: string;
		leadMemberId?: string | null;
		workspaceId?: string | null;
		orgId?: string | null;
		createdByUserId?: string | null;
		visibility?: MatterVisibility;
		aiMemberIds?: string[] | null;
		consultMemberIds?: string[] | null;
		observersEnabled?: boolean;
		observerMemberIds?: string[];
		discussionAiEnabled?: boolean;
		modelSelection?: ModelSelection | null;
		collaboratorIds?: string[];
	}): Matter {
		const id = input.id ?? `mat_${randomUUID()}`;
		const timestamp = nowIso();
		let storedAiIds =
			input.aiMemberIds === undefined || input.aiMemberIds === null ? null : normalizeUniqueIds(input.aiMemberIds);
		if (storedAiIds === null && input.aiMemberIds === undefined && Array.isArray(input.consultMemberIds)) {
			storedAiIds = normalizeUniqueIds([
				...(input.leadMemberId ? [input.leadMemberId] : []),
				...input.consultMemberIds,
				...(input.observersEnabled === false ? [] : (input.observerMemberIds ?? [])),
			]);
		}
		if (storedAiIds === null && input.leadMemberId === ROLE_ARCHITECT_MEMBER_ID) {
			storedAiIds = [ROLE_ARCHITECT_MEMBER_ID];
		} else if (storedAiIds !== null && input.leadMemberId && !storedAiIds.includes(input.leadMemberId)) {
			storedAiIds = [input.leadMemberId, ...storedAiIds];
		}
		const effectiveAiIds = this.resolveEffectiveAiIds(storedAiIds);
		const storedConsultIds =
			input.consultMemberIds === undefined || input.consultMemberIds === null
				? null
				: normalizeUniqueIds(input.consultMemberIds).filter(
						(memberId) => effectiveAiIds.includes(memberId) && memberId !== (input.leadMemberId ?? null),
					);
		const hasExplicitObserverList = input.observerMemberIds !== undefined;
		const explicitObserverIds = normalizeUniqueIds(input.observerMemberIds).filter(
			(memberId) => effectiveAiIds.includes(memberId) && memberId !== (input.leadMemberId ?? null),
		);
		const observerIds =
			input.observersEnabled === false
				? []
				: hasExplicitObserverList
					? explicitObserverIds
					: input.observersEnabled === true
						? this.computeAutoObservers(effectiveAiIds, input.leadMemberId ?? null)
						: [];
		const observersEnabled =
			input.observersEnabled === false
				? false
				: hasExplicitObserverList
					? observerIds.length > 0
					: input.observersEnabled === true;
		const discussionAiEnabled = input.discussionAiEnabled ?? false;
		const collaboratorIds = normalizeUniqueIds(input.collaboratorIds);
		const workspaceId = input.workspaceId ?? null;
		const visibility: MatterVisibility = input.visibility === "private" ? "private" : "org";
		this.db
			.prepare(
				`INSERT INTO matters (
					id, title, summary, status, lead_member_id, workspace_id, org_id, created_by_user_id, visibility,
					ai_member_ids_json, consult_member_ids_json, observers_enabled, observer_ids_json, discussion_ai_enabled,
					collaborator_ids_json, model_selection_json, created_at, updated_at
				)
				 VALUES (?, ?, ?, 'open', ?, ?,
						CASE WHEN ? IS NULL THEN ? ELSE (SELECT org_id FROM workspace_links WHERE id = ?) END,
						?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				input.title,
				input.summary ?? "",
				input.leadMemberId ?? null,
				workspaceId,
				workspaceId,
				input.orgId ?? null,
				workspaceId,
				input.createdByUserId ?? null,
				visibility,
				storedAiIds === null ? null : JSON.stringify(storedAiIds),
				storedConsultIds === null ? null : JSON.stringify(storedConsultIds),
				observersEnabled ? 1 : 0,
				JSON.stringify(observerIds),
				discussionAiEnabled ? 1 : 0,
				JSON.stringify(collaboratorIds),
				input.modelSelection ? JSON.stringify(input.modelSelection) : null,
				timestamp,
				timestamp,
			);
		return this.getMatter(id)!;
	}

	updateMatterModelSelection(matterId: string, selection: ModelSelection | null): Matter {
		this.db
			.prepare("UPDATE matters SET model_selection_json = ?, updated_at = ? WHERE id = ?")
			.run(selection ? JSON.stringify(selection) : null, nowIso(), matterId);
		return this.getMatter(matterId)!;
	}

	updateMatterVisibility(matterId: string, visibility: MatterVisibility): Matter {
		const existing = this.getMatter(matterId);
		if (!existing) throw new Error(`Matter not found: ${matterId}`);
		this.db
			.prepare("UPDATE matters SET visibility = ?, updated_at = ? WHERE id = ?")
			.run(visibility, nowIso(), matterId);
		return this.getMatter(matterId)!;
	}

	getMatter(id: string): Matter | null {
		const row = this.db.prepare("SELECT * FROM matters WHERE id = ?").get(id) as Record<string, unknown> | undefined;
		return row ? mapMatterRow(row) : null;
	}

	listMatters(): Matter[] {
		const rows = this.db.prepare("SELECT * FROM matters ORDER BY updated_at DESC").all() as Record<string, unknown>[];
		return rows.map((row) => mapMatterRow(row));
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
		this.db
			.prepare(`UPDATE matters SET workspace_id = ?,
				org_id = CASE WHEN ? IS NULL THEN org_id ELSE (SELECT org_id FROM workspace_links WHERE id = ?) END,
				updated_at = ? WHERE id = ?`)
			.run(workspaceId, workspaceId, workspaceId, timestamp, matterId);
		return this.getMatter(matterId)!;
	}

	updateMatterOrganization(matterId: string, orgId: string | null): Matter {
		const timestamp = nowIso();
		const existing = this.getMatter(matterId);
		if (!existing) throw new Error(`Matter not found: ${matterId}`);
		if (orgId && !this.orgRepo.getOrganization(orgId)) {
			throw new Error(`Organization not found: ${orgId}`);
		}
		const currentWs = existing.workspaceId ? this.workspaceRepo.getWorkspace(existing.workspaceId) : null;
		const nextWorkspaceId = currentWs && currentWs.orgId !== orgId ? null : existing.workspaceId;
		this.db
			.prepare("UPDATE matters SET org_id = ?, workspace_id = ?, updated_at = ? WHERE id = ?")
			.run(orgId, nextWorkspaceId, timestamp, matterId);
		return this.getMatter(matterId)!;
	}

	updateMatterObservers(matterId: string, observerMemberIds: string[]): Matter {
		const existing = this.getMatter(matterId);
		if (!existing) throw new Error(`Matter not found: ${matterId}`);
		const timestamp = nowIso();
		const effectiveAiIds = this.resolveEffectiveAiIds(existing.aiMemberIds);
		const observerIds = normalizeUniqueIds(observerMemberIds).filter(
			(id) => effectiveAiIds.includes(id) && id !== existing.leadMemberId,
		);
		this.db
			.prepare("UPDATE matters SET observer_ids_json = ?, observers_enabled = ?, updated_at = ? WHERE id = ?")
			.run(JSON.stringify(observerIds), observerIds.length > 0 ? 1 : 0, timestamp, matterId);
		return this.getMatter(matterId)!;
	}

	updateMatterObserversEnabled(matterId: string, enabled: boolean): Matter {
		const existing = this.getMatter(matterId);
		if (!existing) throw new Error(`Matter not found: ${matterId}`);
		const timestamp = nowIso();
		const effectiveAiIds = this.resolveEffectiveAiIds(existing.aiMemberIds);
		const observerIds = enabled ? this.computeAutoObservers(effectiveAiIds, existing.leadMemberId) : [];
		this.db
			.prepare("UPDATE matters SET observers_enabled = ?, observer_ids_json = ?, updated_at = ? WHERE id = ?")
			.run(enabled ? 1 : 0, JSON.stringify(observerIds), timestamp, matterId);
		return this.getMatter(matterId)!;
	}

	updateMatterAiMembers(matterId: string, aiMemberIds: string[] | null): Matter {
		const existing = this.getMatter(matterId);
		if (!existing) throw new Error(`Matter not found: ${matterId}`);
		const timestamp = nowIso();
		let normalizedAiIds = aiMemberIds === null ? null : normalizeUniqueIds(aiMemberIds);
		if (normalizedAiIds !== null && existing.leadMemberId && !normalizedAiIds.includes(existing.leadMemberId)) {
			normalizedAiIds = [existing.leadMemberId, ...normalizedAiIds];
		}
		const prevEffectiveAiIds = this.resolveEffectiveAiIds(existing.aiMemberIds);
		const effectiveAiIds = this.resolveEffectiveAiIds(normalizedAiIds);
		const nextObserverIds = existing.observerMemberIds.filter(
			(id) => effectiveAiIds.includes(id) && id !== existing.leadMemberId,
		);
		const nextObserversEnabled = nextObserverIds.length > 0;
		let nextConsultIds =
			existing.consultMemberIds == null
				? null
				: existing.consultMemberIds.filter((id) => effectiveAiIds.includes(id) && id !== existing.leadMemberId);
		if (nextConsultIds !== null) {
			const addedNonObs = effectiveAiIds.filter(
				(id) => id !== existing.leadMemberId && !prevEffectiveAiIds.includes(id) && !nextObserverIds.includes(id),
			);
			nextConsultIds = normalizeUniqueIds([...nextConsultIds, ...addedNonObs]);
		}
		this.db
			.prepare(
				"UPDATE matters SET ai_member_ids_json = ?, consult_member_ids_json = ?, observers_enabled = ?, observer_ids_json = ?, updated_at = ? WHERE id = ?",
			)
			.run(
				normalizedAiIds === null ? null : JSON.stringify(normalizedAiIds),
				nextConsultIds === null ? null : JSON.stringify(nextConsultIds),
				nextObserversEnabled ? 1 : 0,
				JSON.stringify(nextObserverIds),
				timestamp,
				matterId,
			);
		return this.getMatter(matterId)!;
	}

	updateMatterConsultMembers(matterId: string, consultMemberIds: string[] | null): Matter {
		const existing = this.getMatter(matterId);
		if (!existing) throw new Error(`Matter not found: ${matterId}`);
		const timestamp = nowIso();
		if (consultMemberIds === null) {
			this.db
				.prepare("UPDATE matters SET consult_member_ids_json = NULL, updated_at = ? WHERE id = ?")
				.run(timestamp, matterId);
			return this.getMatter(matterId)!;
		}
		const normalizedConsult = normalizeUniqueIds(consultMemberIds).filter(
			(id) => id !== existing.leadMemberId && id !== ROLE_ARCHITECT_MEMBER_ID,
		);
		const nextAiIds =
			existing.aiMemberIds === null ? null : normalizeUniqueIds([...existing.aiMemberIds, ...normalizedConsult]);
		this.db
			.prepare("UPDATE matters SET ai_member_ids_json = ?, consult_member_ids_json = ?, updated_at = ? WHERE id = ?")
			.run(
				nextAiIds === null ? null : JSON.stringify(nextAiIds),
				JSON.stringify(normalizedConsult),
				timestamp,
				matterId,
			);
		return this.getMatter(matterId)!;
	}

	updateMatterDiscussionAiEnabled(matterId: string, enabled: boolean): Matter {
		const existing = this.getMatter(matterId);
		if (!existing) throw new Error(`Matter not found: ${matterId}`);
		this.db
			.prepare("UPDATE matters SET discussion_ai_enabled = ?, updated_at = ? WHERE id = ?")
			.run(enabled ? 1 : 0, nowIso(), matterId);
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

	updateMatterLead(matterId: string, memberId: string): Matter {
		const existing = this.getMatter(matterId);
		if (!existing) throw new Error(`Matter not found: ${matterId}`);
		if (
			existing.leadMemberId === memberId &&
			(existing.aiMemberIds === null || existing.aiMemberIds.includes(memberId))
		) {
			return existing;
		}
		const timestamp = nowIso();
		let nextAiIds = existing.aiMemberIds;
		if (nextAiIds !== null && !nextAiIds.includes(memberId)) {
			nextAiIds = [memberId, ...nextAiIds];
		}
		const effectiveAiIds = this.resolveEffectiveAiIds(nextAiIds);
		const prevEffectiveAiIds = this.resolveEffectiveAiIds(existing.aiMemberIds);
		const prevAllNonLead = this.computeAutoObservers(prevEffectiveAiIds, existing.leadMemberId);
		const wasAllAutoObserved =
			existing.consultMemberIds === null &&
			existing.observersEnabled &&
			prevAllNonLead.length > 0 &&
			prevAllNonLead.every((id) => existing.observerMemberIds.includes(id));
		const nextObserverIds = wasAllAutoObserved
			? this.computeAutoObservers(effectiveAiIds, memberId)
			: existing.observerMemberIds.filter((id) => effectiveAiIds.includes(id) && id !== memberId);
		const nextConsultIds =
			existing.consultMemberIds == null
				? null
				: normalizeUniqueIds([
						...existing.consultMemberIds,
						...(existing.leadMemberId &&
						existing.leadMemberId !== memberId &&
						existing.leadMemberId !== ROLE_ARCHITECT_MEMBER_ID
							? [existing.leadMemberId]
							: []),
					]).filter((id) => effectiveAiIds.includes(id) && id !== memberId);
		this.db
			.prepare(
				"UPDATE matters SET lead_member_id = ?, ai_member_ids_json = ?, consult_member_ids_json = ?, observer_ids_json = ?, observers_enabled = ?, updated_at = ? WHERE id = ?",
			)
			.run(
				memberId,
				nextAiIds === null ? null : JSON.stringify(nextAiIds),
				nextConsultIds === null ? null : JSON.stringify(nextConsultIds),
				JSON.stringify(nextObserverIds),
				nextObserverIds.length > 0 ? 1 : 0,
				timestamp,
				matterId,
			);
		return this.getMatter(matterId)!;
	}

	getMessage(messageId: string): MatterMessage | null {
		const row = this.db.prepare("SELECT * FROM matter_messages WHERE id = ?").get(messageId) as
			| Record<string, unknown>
			| undefined;
		return row ? mapMessageRow(row) : null;
	}

	updateMessageMetadata(messageId: string, metadata: Record<string, unknown>): MatterMessage | null {
		const existing = this.getMessage(messageId);
		if (!existing) return null;
		this.db
			.prepare("UPDATE matter_messages SET metadata_json = ? WHERE id = ?")
			.run(JSON.stringify(metadata), messageId);
		return this.getMessage(messageId);
	}

	/** Atomically claim a pending human AI request; terminal requests cannot be dispatched twice. */
	transitionAiRequest(
		messageId: string,
		status: "approved" | "dismissed",
		audit: Record<string, unknown>,
	): MatterMessage | null {
		const message = this.getMessage(messageId);
		if (!message) return null;
		const metadata = { ...message.metadata, ...audit, aiRequestStatus: status };
		const changed = this.db
			.prepare(`UPDATE matter_messages SET metadata_json = ?
			WHERE id = ? AND channel = 'user' AND sender_type = 'user'
			AND json_extract(metadata_json, '$.mode') = 'ai_request'
			AND json_extract(metadata_json, '$.aiRequestStatus') = 'pending'`)
			.run(JSON.stringify(metadata), messageId).changes;
		return changed ? this.getMessage(messageId) : null;
	}

	transitionHumanDecision(messageId: string, revision: number, decision: HumanDecision): MatterMessage | null {
		const changed = this.db
			.prepare(`UPDATE matter_messages
				SET metadata_json = json_set(metadata_json, '$.humanDecision', json(?))
				WHERE id = ? AND channel = 'user' AND sender_type = 'member'
				AND json_extract(metadata_json, '$.humanDecision.status') = 'pending'
				AND json_extract(metadata_json, '$.humanDecision.revision') = ?`)
			.run(JSON.stringify(decision), messageId, revision).changes;
		return changed ? this.getMessage(messageId) : null;
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
		// Snapshot provenance when writing, never infer an old message's organization at read time.
		const workspace =
			typeof input.metadata?.workspaceId === "string"
				? this.workspaceRepo.getWorkspace(input.metadata.workspaceId)
				: null;
		const metadata = {
			orgId: workspace ? workspace.orgId : (this.getMatter(input.matterId)?.orgId ?? null),
			...input.metadata,
		};
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
				JSON.stringify(metadata),
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
			metadata,
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

		return rows.map((row) => mapMessageRow(row));
	}
}
