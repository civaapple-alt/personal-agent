import type { BoardMemberDto, BoardPostDto, BoardPostSummaryDto, MatterEventDto } from "@pa/contracts/board";
import type {
	MatterCollaborationMode,
	MatterDecisionStatus,
	MatterDto,
	MatterMessageChannel,
	MatterMessageDto,
	MatterMessageKind,
	MatterMessageSenderType,
	MatterStatus,
	MatterVisibility,
} from "@pa/contracts/matter";
import type { ModelSelection } from "@pa/contracts/model-selection";
import type {
	AccessTokenDto,
	AccessTokenScope,
	AccountUserDto,
	AuditLogEntryDto,
	CollaboratorDto,
	CollaboratorRole,
	OrganizationAiRoleConfigDto,
	OrganizationDto,
	OrganizationInviteDto,
	OrganizationMemberDto,
	OrgMemberRole,
	PlatformRole,
	PlatformSettingsDto,
	RegistrationMode,
	UploadRecordDto,
	UserSessionRecordDto,
	UserStatus,
	WebSearchProviderPreference,
} from "@pa/contracts/organization";
import type { WorkerSessionRecordDto, WorkerSessionStatus } from "@pa/contracts/runtime";
import type { FeedbackRating } from "@pa/contracts/space";
import type { RoleScope, TeamMemberDto } from "@pa/contracts/team";
import type { ThinkingLevel } from "@pa/contracts/thinking-levels";
import type { WorkspaceDto, WorkspaceSourceType, WorkspaceVisibility } from "@pa/contracts/workspace";

export type {
	AccessTokenScope,
	BoardMemberDto,
	BoardPostDto,
	BoardPostSummaryDto,
	CollaboratorRole,
	FeedbackRating,
	MatterCollaborationMode,
	MatterDecisionStatus,
	MatterEventDto,
	MatterMessageChannel,
	MatterMessageKind,
	MatterMessageSenderType,
	MatterStatus,
	MatterVisibility,
	OrgMemberRole,
	PlatformRole,
	RegistrationMode,
	UserStatus,
	WebSearchProviderPreference,
	WorkerSessionStatus,
	WorkspaceSourceType,
	WorkspaceVisibility,
};

export interface PlatformUser extends AccountUserDto {
	passwordHash: string;
}

export type PublicPlatformUser = Omit<PlatformUser, "passwordHash">;

export type UserSessionRecord = UserSessionRecordDto;

export type UserAccessTokenRecord = AccessTokenDto;

export interface PlatformSettings extends PlatformSettingsDto {
	webAccessDeniedRoles: Record<string, string>;
	webSearchProvider: WebSearchProviderPreference;
	defaultModelSelection: ModelSelection | null;
}

export interface OrganizationMember extends OrganizationMemberDto {
	email: string;
	displayName: string;
	userStatus: UserStatus;
}

export type OrganizationInvite = OrganizationInviteDto;

export interface OrganizationAiRoleConfig extends OrganizationAiRoleConfigDto {
	providerOverride: string | null;
	thinkingLevelOverride: ThinkingLevel | null;
	createdAt: string;
}

export interface AuditLogEntry extends AuditLogEntryDto {
	actorEmail: string;
	actorName: string;
	targetId: string;
	ip: string;
}

export type UploadRecord = UploadRecordDto;

export type Collaborator = CollaboratorDto;

export interface Organization extends OrganizationDto {
	isDefault: boolean;
}

export interface TeamMember extends TeamMemberDto {
	roleScope: RoleScope;
	createdAt: string;
	updatedAt: string;
}

export interface WorkspaceLink extends WorkspaceDto {
	sourceType?: WorkspaceSourceType;
	createdAt: string;
}

export type Matter = MatterDto;

export type MatterMessage = MatterMessageDto;

export type WorkerSessionRecord = WorkerSessionRecordDto;
