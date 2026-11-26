import type {
	MatterDto,
	MatterMessageChannel,
	MatterMessageDto,
	MatterMessageSenderType,
	MatterStatus,
	MatterVisibility,
} from "@pa/contracts/matter";
import type { RoleScope } from "../roles/types.ts";
import type { ModelSelection } from "../rpc/model-selection.ts";
import type { ThinkingLevel } from "../rpc/types.ts";

export type { MatterMessageChannel, MatterMessageSenderType, MatterStatus, MatterVisibility };
export type FeedbackRating = "positive" | "negative" | "neutral";
export type CollaboratorRole = "owner" | "collaborator";
export type PlatformRole = "super_admin" | "user";
export type UserStatus = "active" | "pending_review" | "disabled";
export type OrgMemberRole = "org_owner" | "org_admin" | "org_member" | "org_viewer";
export type RegistrationMode = "open_auto" | "open_review" | "invite_only";
export type WorkspaceSourceType = "local" | "cloned";
export type WorkspaceVisibility = "org" | "restricted";
export type AccessTokenScope = "read" | "full";

export interface PlatformUser {
	id: string;
	email: string;
	displayName: string;
	passwordHash: string;
	platformRole: PlatformRole;
	status: UserStatus;
	maxOrgs: number;
	maxActiveDispatches: number;
	maxPersonalRoles: number;
	canDispatchAi: boolean;
	createdAt: string;
	updatedAt: string;
}

export type PublicPlatformUser = Omit<PlatformUser, "passwordHash">;

export interface UserSessionRecord {
	id: string;
	userId: string;
	expiresAt: string;
	revokedAt: string | null;
	ip: string;
	userAgent: string;
	createdAt: string;
}

export interface UserAccessTokenRecord {
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

export interface PlatformSettings {
	registrationMode: RegistrationMode;
	workspacesRoot: string;
	allowLocalWorkspacePath: boolean;
	localWorkspaceAllowlist: string[];
	allowCommandPreviews: boolean;
	systemOneEnabled: boolean;
	defaultMaxOrgs: number;
	defaultMaxActiveDispatches: number;
	defaultMaxPersonalRoles: number;
	webAccessDeniedRoles: Record<string, string>;
	webSearchProvider: "auto" | "deepseek" | "exa" | "kimi";
	defaultModelSelection: ModelSelection | null;
	updatedAt: string;
}

export interface OrganizationMember {
	orgId: string;
	userId: string;
	email: string;
	displayName: string;
	userStatus: UserStatus;
	orgRole: OrgMemberRole;
	roleTitle: string;
	createdAt: string;
	updatedAt: string;
}

export interface OrganizationInvite {
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

export interface OrganizationAiRoleConfig {
	orgId: string;
	memberId: string;
	enabled: boolean;
	isPrimaryContact: boolean;
	displayNameOverride: string | null;
	providerOverride: string | null;
	modelOverride: string | null;
	thinkingLevelOverride: ThinkingLevel | null;
	gitNameOverride?: string | null;
	gitEmailOverride?: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface AuditLogEntry {
	id: string;
	actorUserId: string | null;
	actorEmail: string;
	actorName: string;
	action: string;
	targetType: string;
	targetId: string;
	orgId: string | null;
	detail: Record<string, unknown> | null;
	ip: string;
	createdAt: string;
}

export interface UploadRecord {
	filename: string;
	orgId: string | null;
	matterId: string | null;
	uploaderUserId: string | null;
	kind: string;
	mimeType: string;
	createdAt: string;
}

export interface Collaborator {
	id: string;
	orgId: string | null;
	name: string;
	roleTitle: string;
	permissionRole: CollaboratorRole;
	createdAt: string;
	updatedAt: string;
}

export interface Organization {
	id: string;
	name: string;
	slug?: string;
	gitEmailDomain: string;
	useRoleGitIdentity?: boolean;
	description: string;
	isDefault: boolean;
	workspacesDir?: string | null;
	createdByUserId?: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface TeamMember {
	id: string;
	templateId: string;
	displayName: string;
	roleTitle: string;
	isPrimaryContact: boolean;
	keywords: string[];
	gitName: string;
	gitEmail: string;
	identitySummary: string;
	roleScope: RoleScope;
	ownerOrgId?: string | null;
	ownerUserId?: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface WorkspaceLink {
	id: string;
	orgId: string | null;
	name: string;
	repoPath: string;
	defaultBranch: string;
	description: string;
	sourceType?: WorkspaceSourceType;
	cloneUrl?: string | null;
	visibility?: WorkspaceVisibility;
	allowedUserIds?: string[];
	repoGitUser?: { name: string; email: string } | null;
	createdAt: string;
}

export type Matter = MatterDto;

export type MatterMessage = MatterMessageDto;

export interface WorkerSessionRecord {
	messageCursor: string | null;
	id: string;
	memberId: string;
	matterId: string;
	workspaceId: string | null;
	piSessionId: string | null;
	sessionFile: string | null;
	status: "active" | "idle" | "closed";
	lastActiveAt: string;
}
