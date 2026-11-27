import type { ModelSelection } from "@pa/contracts/model-selection";
import type {
	CollaboratorDto,
	CollaboratorRole,
	OrganizationAiRoleConfigDto,
	OrganizationDto,
	OrganizationInviteDto,
	OrganizationMemberDto,
	OrgMemberRole,
} from "@pa/contracts/organization";
import type { TeamMemberDto } from "@pa/contracts/team";
import type { WorkspaceDto, WorkspaceSourceType, WorkspaceVisibility } from "@pa/contracts/workspace";
import { requestJson } from "./client.ts";

export type {
	CollaboratorDto,
	CollaboratorRole,
	OrganizationAiRoleConfigDto,
	OrganizationDto,
	OrganizationInviteDto,
	OrganizationMemberDto,
	OrgMemberRole,
	WorkspaceDto,
	WorkspaceSourceType,
	WorkspaceVisibility,
};

export function createOrganization(input: {
	id?: string;
	name: string;
	gitEmailDomain?: string;
	useRoleGitIdentity?: boolean;
	description?: string;
	aiMemberIds?: string[];
	primaryAiMemberId?: string;
}): Promise<{ organization: OrganizationDto }> {
	return requestJson("/api/organizations", {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export function updateOrganization(
	orgId: string,
	input: {
		name?: string;
		gitEmailDomain?: string;
		useRoleGitIdentity?: boolean;
		description?: string;
		isDefault?: boolean;
	},
): Promise<{ organization: OrganizationDto }> {
	return requestJson(`/api/organizations/${encodeURIComponent(orgId)}`, {
		method: "PATCH",
		body: JSON.stringify(input),
	});
}

export function setDefaultOrganization(orgId: string): Promise<{ organization: OrganizationDto }> {
	return requestJson(`/api/organizations/${encodeURIComponent(orgId)}/default`, {
		method: "POST",
	});
}

export function addWorkspace(input: {
	orgId?: string | null;
	name: string;
	sourceType?: "local" | "clone" | WorkspaceSourceType;
	cloneUrl?: string;
	repoPath?: string;
	defaultBranch?: string;
	description?: string;
	visibility?: WorkspaceVisibility;
	allowedUserIds?: string[];
}): Promise<{ workspace: WorkspaceDto }> {
	return requestJson("/api/workspaces", {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export function updateWorkspace(
	workspaceId: string,
	input: {
		orgId?: string | null;
		name?: string;
		defaultBranch?: string;
		description?: string;
		visibility?: WorkspaceVisibility;
		allowedUserIds?: string[];
	},
): Promise<{ workspace: WorkspaceDto }> {
	return requestJson(`/api/workspaces/${encodeURIComponent(workspaceId)}`, {
		method: "PATCH",
		body: JSON.stringify(input),
	});
}

export function joinOrganizationByInvite(
	inviteToken: string,
): Promise<{ ok: boolean; organization: OrganizationDto; membership: OrganizationMemberDto }> {
	return requestJson("/api/organizations/join", {
		method: "POST",
		body: JSON.stringify({ inviteToken }),
	});
}

export function fetchOrgMembers(orgId: string): Promise<{ members: OrganizationMemberDto[] }> {
	return requestJson(`/api/organizations/${encodeURIComponent(orgId)}/members`);
}

export function addOrgMember(
	orgId: string,
	input: { email?: string; userId?: string; orgRole: OrgMemberRole; roleTitle?: string },
): Promise<{ member: OrganizationMemberDto }> {
	return requestJson(`/api/organizations/${encodeURIComponent(orgId)}/members`, {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export function updateOrgMember(
	orgId: string,
	userId: string,
	input: { orgRole?: OrgMemberRole; roleTitle?: string },
): Promise<{ member: OrganizationMemberDto }> {
	return requestJson(`/api/organizations/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`, {
		method: "PATCH",
		body: JSON.stringify(input),
	});
}

export function removeOrgMember(orgId: string, userId: string): Promise<{ ok: boolean }> {
	return requestJson(`/api/organizations/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`, {
		method: "DELETE",
	});
}

export function fetchOrgInvites(orgId: string): Promise<{ invites: OrganizationInviteDto[] }> {
	return requestJson(`/api/organizations/${encodeURIComponent(orgId)}/invites`);
}

export function createOrgInvite(
	orgId: string,
	input: { orgRole: OrgMemberRole; maxUses?: number; expiresInHours?: number },
): Promise<{ invite: OrganizationInviteDto; rawToken: string }> {
	return requestJson(`/api/organizations/${encodeURIComponent(orgId)}/invites`, {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export function revokeOrgInvite(orgId: string, inviteId: string): Promise<{ invite: OrganizationInviteDto }> {
	return requestJson(
		`/api/organizations/${encodeURIComponent(orgId)}/invites/${encodeURIComponent(inviteId)}/revoke`,
		{ method: "POST", body: "{}" },
	);
}

export function setOrgAiPrimaryContact(orgId: string, primaryMemberId: string): Promise<{ primaryMemberId: string }> {
	return requestJson(`/api/organizations/${encodeURIComponent(orgId)}/ai-roles`, {
		method: "PATCH",
		body: JSON.stringify({ primaryMemberId }),
	});
}

export function organizationRoleModel(config?: OrganizationAiRoleConfigDto): ModelSelection | null {
	if (!config?.providerOverride || !config.modelOverride) return null;
	return {
		provider: config.providerOverride,
		model: config.modelOverride,
		thinkingLevel: config.thinkingLevelOverride ?? undefined,
	};
}

export function updateOrgAiRoles(
	orgId: string,
	roles: Array<{
		memberId: string;
		enabled: boolean;
		isPrimaryContact?: boolean;
		displayNameOverride?: string | null;
		providerOverride?: string | null;
		modelOverride?: string | null;
		modelSelection?: ModelSelection | null;
		thinkingLevelOverride?: string | null;
		gitNameOverride?: string | null;
		gitEmailOverride?: string | null;
	}>,
	options?: { useRoleGitIdentity?: boolean },
): Promise<{
	organization?: OrganizationDto;
	configs: OrganizationAiRoleConfigDto[];
	effectiveMembers: TeamMemberDto[];
}> {
	return requestJson(`/api/organizations/${encodeURIComponent(orgId)}/ai-roles`, {
		method: "PUT",
		body: JSON.stringify({
			roles,
			...(options?.useRoleGitIdentity !== undefined ? { useRoleGitIdentity: options.useRoleGitIdentity } : {}),
		}),
	});
}
