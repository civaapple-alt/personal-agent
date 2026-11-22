import type { RoleScope } from "../roles/types.ts";
import type { ModelSelection } from "../rpc/model-selection.ts";
import type { ThinkingLevel } from "../rpc/types.ts";

export type MemoryScope = "role_general" | "company_private" | "project_private";
export type MemoryStatus = "candidate" | "verified" | "rejected" | "superseded";
export type MemoryCategory =
	| "general"
	| "efficiency"
	| "troubleshooting"
	| "collaboration"
	| "user_correction"
	| "domain_constraint";
export type FeedbackRating = "positive" | "negative" | "neutral";
export type MemoryApplicationOutcome =
	| "applied"
	| "turn_succeeded"
	| "turn_failed"
	| "feedback_positive"
	| "feedback_negative";
export type MatterStatus = "open" | "waiting_user" | "delivered" | "archived";
export type MatterMessageChannel = "user" | "internal_collab" | "notice";
export type MatterMessageSenderType = "user" | "member" | "system";
export type DeliverableType = "document" | "artifact" | "prototype_image" | "service_url";
export type CollaboratorRole = "owner" | "collaborator";
export type PlatformRole = "super_admin" | "user";
export type UserStatus = "active" | "pending_review" | "disabled";
export type OrgMemberRole = "org_owner" | "org_admin" | "org_member" | "org_viewer";
export type RegistrationMode = "open_auto" | "open_review" | "invite_only";
export type WorkspaceSourceType = "local" | "cloned";
export type WorkspaceVisibility = "org" | "restricted";
export type MatterVisibility = "org" | "private";

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
	pstackDir: string | null;
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
	token: string;
	createdAt: string;
	updatedAt: string;
}

export type PublicCollaborator = Omit<Collaborator, "token">;

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
	/** Legacy member metadata retained for existing databases and clients. Worker selection is scoped separately. */
	provider: string;
	model: string;
	thinkingLevel: ThinkingLevel;
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

export interface MemberMemory {
	id: string;
	memberId: string;
	scope: MemoryScope;
	category: MemoryCategory;
	orgId: string | null;
	workspaceId: string | null;
	content: string;
	rationale: string;
	sourceMatterId: string | null;
	status: MemoryStatus;
	verified: boolean;
	supersededBy: string | null;
	supersedesMemoryId: string | null;
	appliedCount: number;
	positiveCount: number;
	negativeCount: number;
	lastAppliedAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface MemoryApplicationRecord {
	id: string;
	memoryId: string;
	matterId: string;
	memberId: string;
	documentId: string | null;
	commitHash: string | null;
	actorId: string | null;
	outcome: MemoryApplicationOutcome;
	note: string;
	createdAt: string;
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

export interface Matter {
	id: string;
	title: string;
	summary: string;
	status: MatterStatus;
	leadMemberId: string | null;
	workspaceId: string | null;
	orgId: string | null;
	createdByUserId?: string | null;
	visibility?: MatterVisibility;
	aiMemberIds: string[] | null;
	consultMemberIds?: string[] | null;
	observersEnabled: boolean;
	observerMemberIds: string[];
	discussionAiEnabled?: boolean;
	modelSelection?: ModelSelection | null;
	collaboratorIds: string[];
	createdAt: string;
	updatedAt: string;
}

export interface MatterMessage {
	id: string;
	matterId: string;
	channel: MatterMessageChannel;
	senderType: MatterMessageSenderType;
	senderId: string;
	content: string;
	metadata: Record<string, unknown> | null;
	createdAt: string;
}

export interface Deliverable {
	id: string;
	matterId: string;
	memberId: string;
	type: DeliverableType;
	title: string;
	summary: string;
	contentOrPath: string;
	serviceUrl: string | null;
	version: number;
	feedback: string | null;
	feedbackRating: FeedbackRating | null;
	createdAt: string;
}

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
