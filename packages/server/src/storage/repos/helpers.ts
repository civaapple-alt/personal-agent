import { readStoredModelSelection } from "../../rpc/model-selection.ts";
import type {
	Matter,
	MatterMessage,
	MatterMessageChannel,
	MatterMessageSenderType,
	MatterStatus,
	MatterVisibility,
	MemberMemory,
	MemoryCategory,
	MemoryScope,
	MemoryStatus,
	Organization,
	PlatformUser,
	PublicPlatformUser,
	TeamMember,
	WorkspaceLink,
	WorkspaceSourceType,
	WorkspaceVisibility,
} from "../types.ts";

export const DEFAULT_ORGANIZATION_ID = "org-default";
export const DEFAULT_ORGANIZATION_NAME = "默认组织";
export const DEFAULT_LOCAL_ADMIN_USER_ID = "usr_local_owner";

const ASCII_PRINTABLE_RE = /^[\x20-\x7E]+$/;

/** Thrown when a memory replacement link violates immutability, scope alignment, or acyclicity rules. */
export class MemoryValidationError extends Error {}

export function nowIso(): string {
	return new Date().toISOString();
}

export function toPublicUser(user: PlatformUser): PublicPlatformUser {
	const { passwordHash: _passwordHash, ...publicUser } = user;
	return publicUser;
}

export function slugifyOrganizationName(name: string, fallbackId: string): string {
	const ascii = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32);
	if (ascii) return ascii;
	return fallbackId.replace(/[^a-z0-9_-]/gi, "").slice(0, 32) || "org";
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
	const slug = typeof row.slug === "string" && row.slug.trim() ? row.slug.trim() : undefined;
	const workspacesDir =
		typeof row.workspaces_dir === "string" && row.workspaces_dir.trim() ? row.workspaces_dir.trim() : undefined;
	const createdByUserId =
		typeof row.created_by_user_id === "string" && row.created_by_user_id.trim()
			? row.created_by_user_id.trim()
			: undefined;
	return {
		id: String(row.id),
		name: String(row.name),
		...(slug ? { slug } : {}),
		gitEmailDomain: typeof row.git_email_domain === "string" ? row.git_email_domain : "",
		useRoleGitIdentity: Boolean(row.use_role_git_identity),
		description: typeof row.description === "string" ? row.description : "",
		isDefault: Boolean(row.is_default),
		...(workspacesDir ? { workspacesDir } : {}),
		...(createdByUserId ? { createdByUserId } : {}),
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
	const ownerOrgId =
		typeof row.owner_org_id === "string" && row.owner_org_id.trim() ? row.owner_org_id.trim() : undefined;
	const ownerUserId =
		typeof row.owner_user_id === "string" && row.owner_user_id.trim() ? row.owner_user_id.trim() : undefined;
	const rawScope = row.role_scope;
	const roleScope =
		rawScope === "personal" || ownerUserId
			? ("personal" as const)
			: rawScope === "org" || ownerOrgId
				? ("org" as const)
				: ("global" as const);
	return {
		id,
		templateId: String(row.template_id),
		displayName,
		roleTitle,
		isPrimaryContact: roleScope === "global" ? Boolean(row.is_primary_contact) : false,
		keywords: JSON.parse(String(row.keywords_json)) as string[],
		gitName: rawGitName || defaultMemberGitName({ id, displayName, roleTitle }),
		gitEmail: rawGitEmail || `${id}@team.local`,
		identitySummary: typeof row.identity_summary === "string" ? row.identity_summary : "",
		roleScope,
		...(ownerOrgId ? { ownerOrgId } : {}),
		...(ownerUserId ? { ownerUserId } : {}),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}

export function mapWorkspaceRow(row: Record<string, unknown>): WorkspaceLink {
	const sourceType: WorkspaceSourceType | undefined = row.source_type === "cloned" ? "cloned" : undefined;
	const cloneUrl = typeof row.clone_url === "string" && row.clone_url.trim() ? row.clone_url.trim() : undefined;
	const visibility: WorkspaceVisibility | undefined = row.visibility === "restricted" ? "restricted" : undefined;
	return {
		id: String(row.id),
		orgId: row.org_id ? String(row.org_id) : null,
		name: String(row.name),
		repoPath: String(row.repo_path),
		defaultBranch: String(row.default_branch),
		description: String(row.description),
		...(sourceType ? { sourceType } : {}),
		...(cloneUrl ? { cloneUrl } : {}),
		...(visibility ? { visibility } : {}),
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
	const createdByUserId =
		typeof row.created_by_user_id === "string" && row.created_by_user_id.trim()
			? row.created_by_user_id.trim()
			: undefined;
	const visibility: MatterVisibility | undefined = row.visibility === "private" ? "private" : undefined;
	return {
		id: String(row.id),
		title: String(row.title),
		summary: String(row.summary),
		status: row.status as MatterStatus,
		leadMemberId: row.lead_member_id ? String(row.lead_member_id) : null,
		workspaceId: row.workspace_id ? String(row.workspace_id) : null,
		orgId: row.org_id ? String(row.org_id) : null,
		...(createdByUserId ? { createdByUserId } : {}),
		...(visibility ? { visibility } : {}),
		aiMemberIds:
			row.ai_member_ids_json === null || row.ai_member_ids_json === undefined
				? null
				: parseUniqueIds(row.ai_member_ids_json),
		consultMemberIds:
			row.consult_member_ids_json === null || row.consult_member_ids_json === undefined
				? null
				: parseUniqueIds(row.consult_member_ids_json),
		observersEnabled: Boolean(row.observers_enabled),
		observerMemberIds,
		discussionAiEnabled: Boolean(row.discussion_ai_enabled),
		modelSelection: readStoredModelSelection(
			row.model_selection_json ? JSON.parse(String(row.model_selection_json)) : null,
		),
		collaboratorIds: parseUniqueIds(row.collaborator_ids_json),
		createdAt: String(row.created_at),
		updatedAt: String(row.updated_at),
	};
}
