import type { UserStatus } from "./auth.ts";
import { requestJson } from "./client.ts";
import type { TeamMemberDto } from "./team.ts";

export type OrgMemberRole = "org_owner" | "org_admin" | "org_member" | "org_viewer";

export type WorkspaceSourceType = "local" | "cloned";

export type WorkspaceVisibility = "org" | "restricted";

export interface OrganizationMemberDto {
	orgId: string;
	userId: string;
	orgRole: OrgMemberRole;
	roleTitle: string;
	createdAt: string;
	updatedAt: string;
	email?: string;
	displayName?: string;
	userStatus?: UserStatus;
}

export interface OrganizationInviteDto {
	id: string;
	orgId: string;
	orgRole: OrgMemberRole;
	createdByUserId: string;
	maxUses: number;
	usedCount: number;
	expiresAt: string | null;
	revokedAt: string | null;
	createdAt: string;
}

export interface OrganizationAiRoleConfigDto {
	orgId: string;
	memberId: string;
	enabled: boolean;
	isPrimaryContact: boolean;
	displayNameOverride: string | null;
	providerOverride?: string | null;
	modelOverride: string | null;
	thinkingLevelOverride?: string | null;
	gitNameOverride?: string | null;
	gitEmailOverride?: string | null;
	updatedAt: string;
}

export interface OrganizationDto {
	id: string;
	name: string;
	slug?: string;
	gitEmailDomain: string;
	useRoleGitIdentity?: boolean;
	description: string;
	isDefault?: boolean;
	workspacesDir?: string | null;
	createdByUserId?: string | null;
	orgRole?: OrgMemberRole;
	createdAt: string;
	updatedAt: string;
}

export interface WorkspaceDto {
	id: string;
	orgId: string | null;
	name: string;
	repoPath: string;
	defaultBranch: string;
	description: string;
	sourceType?: "local" | "clone" | WorkspaceSourceType;
	cloneUrl?: string | null;
	visibility?: WorkspaceVisibility;
	allowedUserIds?: string[];
	repoGitUser?: { name: string; email: string } | null;
}

export type CollaboratorRole = "owner" | "collaborator";

export interface CollaboratorDto {
	id: string;
	name: string;
	roleTitle: string;
	permissionRole: CollaboratorRole;
	orgId: string | null;
	token?: string;
	createdAt: string;
	updatedAt: string;
}

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

export function updateOrgAiRoles(
	orgId: string,
	roles: Array<{
		memberId: string;
		enabled: boolean;
		isPrimaryContact?: boolean;
		displayNameOverride?: string | null;
		providerOverride?: string | null;
		modelOverride?: string | null;
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

export function createCollaborator(input: {
	id?: string;
	name: string;
	roleTitle?: string;
	permissionRole?: CollaboratorRole;
	orgId?: string | null;
}): Promise<{ collaborator: CollaboratorDto }> {
	return requestJson("/api/collaborators", {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export function updateCollaborator(
	id: string,
	input: { name?: string; roleTitle?: string; permissionRole?: CollaboratorRole; orgId?: string | null },
): Promise<{ collaborator: CollaboratorDto }> {
	return requestJson(`/api/collaborators/${encodeURIComponent(id)}`, {
		method: "PATCH",
		body: JSON.stringify(input),
	});
}

export function regenerateCollaboratorToken(id: string): Promise<{ collaborator: CollaboratorDto }> {
	return requestJson(`/api/collaborators/${encodeURIComponent(id)}/regenerate-token`, {
		method: "POST",
		body: "{}",
	});
}

export function deleteCollaborator(id: string): Promise<{ ok: boolean }> {
	return requestJson(`/api/collaborators/${encodeURIComponent(id)}`, {
		method: "DELETE",
	});
}
