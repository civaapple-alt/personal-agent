import type { ThinkingLevel } from "../../rpc/types.ts";
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
	MemoryCategory,
	MemoryScope,
	MemoryStatus,
	Organization,
	PublicCollaborator,
	TeamMember,
	WorkspaceLink,
} from "../types.ts";

export const DEFAULT_ORGANIZATION_ID = "org-default";
export const DEFAULT_ORGANIZATION_NAME = "默认组织";
export const DEFAULT_OWNER_COLLABORATOR_ID = "owner";

const ASCII_PRINTABLE_RE = /^[\x20-\x7E]+$/;

/** Thrown when a memory replacement link violates immutability, scope alignment, or acyclicity rules. */
export class MemoryValidationError extends Error {}

export function nowIso(): string {
	return new Date().toISOString();
}

export function toPublicCollaborator(collaborator: Collaborator): PublicCollaborator {
	const { token: _token, ...publicInfo } = collaborator;
	return publicInfo;
}

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

export function normalizeUniqueIds(ids?: string[]): string[] {
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

export function parseUniqueIds(raw: unknown): string[] {
	if (typeof raw !== "string" || !raw.trim()) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return normalizeUniqueIds(parsed.filter((item): item is string => typeof item === "string"));
	} catch {
		return [];
	}
}

export function mapOrganizationRow(row: Record<string, unknown>): Organization {
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

export function mapMemberRow(row: Record<string, unknown>): TeamMember {
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

export function mapWorkspaceRow(row: Record<string, unknown>): WorkspaceLink {
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

export function mapMemoryRow(row: Record<string, unknown>): MemberMemory {
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

export function mapDeliverableRow(row: Record<string, unknown>): Deliverable {
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

export function mapCollaboratorRow(row: Record<string, unknown>): Collaborator {
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

export function mapMessageRow(row: Record<string, unknown>): MatterMessage {
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

export function mapMatterRow(row: Record<string, unknown>): Matter {
	const observerMemberIds = parseUniqueIds(row.observer_ids_json);
	return {
		id: String(row.id),
		title: String(row.title),
		summary: String(row.summary),
		status: row.status as MatterStatus,
		leadMemberId: row.lead_member_id ? String(row.lead_member_id) : null,
		workspaceId: row.workspace_id ? String(row.workspace_id) : null,
		orgId: row.org_id ? String(row.org_id) : null,
		aiMemberIds:
			row.ai_member_ids_json === null || row.ai_member_ids_json === undefined
				? null
				: parseUniqueIds(row.ai_member_ids_json),
		observersEnabled: Boolean(row.observers_enabled) || observerMemberIds.length > 0,
		observerMemberIds,
		collaboratorIds: parseUniqueIds(row.collaborator_ids_json),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}
