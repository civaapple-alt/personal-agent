import type { ModelSelection } from "./model-selection.ts";
import type { ThinkingLevel } from "./thinking-levels.ts";

export type PlatformRole = "super_admin" | "user";
export type UserStatus = "active" | "pending_review" | "disabled";
export type OrgMemberRole = "org_owner" | "org_admin" | "org_member" | "org_viewer";
export type RegistrationMode = "open_auto" | "open_review" | "invite_only";
export type AccessTokenScope = "read" | "full";
export type CollaboratorRole = "owner" | "collaborator";
export type WebSearchProviderPreference = "auto" | "deepseek" | "exa" | "kimi";

/** Public account profile exposed across auth, bootstrap, and admin APIs (excludes password hash). */
export interface AccountUserDto {
	id: string;
	email: string;
	displayName: string;
	platformRole: PlatformRole;
	status: UserStatus;
	maxOrgs: number;
	maxActiveDispatches: number;
	maxPersonalRoles: number;
	canDispatchAi: boolean;
	createdAt: string;
	updatedAt: string;
	lastLoginAt?: string | null;
}

export interface UserSessionRecordDto {
	id: string;
	userId: string;
	expiresAt: string;
	revokedAt: string | null;
	ip: string;
	userAgent: string;
	createdAt: string;
}

export interface AccessTokenDto {
	id: string;
	userId: string;
	name: string;
	tokenPrefix: string;
	scope: AccessTokenScope;
	allowedOrgIds: string[] | null;
	allowedWorkspaceIds: string[] | null;
	expiresAt: string | null;
	lastUsedAt: string | null;
	revokedAt: string | null;
	createdAt: string;
}

export interface PlatformSettingsDto {
	registrationMode: RegistrationMode;
	workspacesRoot: string;
	allowLocalWorkspacePath: boolean;
	localWorkspaceAllowlist: string[];
	allowCommandPreviews: boolean;
	systemOneEnabled: boolean;
	defaultMaxOrgs: number;
	defaultMaxActiveDispatches: number;
	defaultMaxPersonalRoles: number;
	webAccessDeniedRoles?: Record<string, string>;
	webSearchProvider?: WebSearchProviderPreference;
	defaultModelSelection?: ModelSelection | null;
	updatedAt: string;
}

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
	thinkingLevelOverride?: ThinkingLevel | null;
	gitNameOverride?: string | null;
	gitEmailOverride?: string | null;
	createdAt?: string;
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

export interface CollaboratorDto {
	id: string;
	orgId: string | null;
	name: string;
	roleTitle: string;
	permissionRole: CollaboratorRole;
	createdAt: string;
	updatedAt: string;
}

export interface AuditLogEntryDto {
	id: string;
	actorUserId: string | null;
	actorEmail: string | null;
	actorName?: string;
	action: string;
	targetType: string;
	targetId: string | null;
	orgId: string | null;
	detail: Record<string, unknown> | null;
	ip?: string;
	ipAddress?: string | null;
	createdAt: string;
}

export interface UploadRecordDto {
	filename: string;
	orgId: string | null;
	matterId: string | null;
	uploaderUserId: string | null;
	kind: string;
	mimeType: string;
	createdAt: string;
}

export interface AuthSessionPayload {
	authenticated: boolean;
	requireAuth?: boolean;
	permissionRequired: boolean;
	revokedSession?: boolean;
	pendingApproval?: boolean;
	needsAdminSetup?: boolean;
	registrationMode?: RegistrationMode;
	authKind?: "session" | "loopback" | null;
	currentUser: CollaboratorDto | null;
	accountUser?: AccountUserDto | null;
}

export interface OrgInvitePreviewDto {
	valid: boolean;
	reason?: string;
	orgId?: string;
	orgName?: string;
	orgRole?: OrgMemberRole;
	alreadyMember?: boolean;
	existingRole?: OrgMemberRole | null;
}

export interface AdminUserRowDto extends AccountUserDto {
	ownedOrgCount: number;
	orgMemberships: OrganizationMemberDto[];
}

export interface AdminOverviewPayload {
	settings: PlatformSettingsDto;
	users: AdminUserRowDto[];
	organizations: OrganizationDto[];
	activeRuns: Array<{
		matterId: string;
		title: string;
		matterTitle?: string;
		label: string;
		startedAt: number;
		orgId?: string | null;
		startedByUserId?: string | null;
		stage?: string;
	}>;
	auditLogs: AuditLogEntryDto[];
}
