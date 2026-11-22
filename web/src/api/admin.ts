import type { AccountUserDto, PlatformRole, RegistrationMode, UserStatus } from "./auth.ts";
import { requestJson } from "./client.ts";
import type { ModelSelection } from "./models.ts";
import type { OrganizationDto, OrganizationMemberDto } from "./organizations.ts";

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
	pstackDir?: string | null;
	defaultModelSelection?: ModelSelection | null;
	updatedAt: string;
}

export interface AuditLogEntryDto {
	id: string;
	actorUserId: string | null;
	actorEmail: string | null;
	action: string;
	targetType: string;
	targetId: string | null;
	orgId: string | null;
	detail: Record<string, unknown> | null;
	ipAddress: string | null;
	createdAt: string;
}

export interface AdminUserRowDto extends AccountUserDto {
	ownedOrgCount: number;
	orgMemberships: OrganizationMemberDto[];
}

export interface AdminOverviewPayload {
	settings: PlatformSettingsDto;
	users: AdminUserRowDto[];
	organizations: OrganizationDto[];
	activeRuns: Array<{ matterId: string; title: string; label: string; startedAt: number }>;
	auditLogs: AuditLogEntryDto[];
}

export function fetchAdminOverview(): Promise<AdminOverviewPayload> {
	return requestJson("/api/admin/overview");
}

export function updateAdminSettings(
	input: Partial<{
		registrationMode: RegistrationMode;
		workspacesRoot: string;
		allowLocalWorkspacePath: boolean;
		localWorkspaceAllowlist: string[];
		allowCommandPreviews: boolean;
		systemOneEnabled: boolean;
		defaultMaxOrgs: number;
		defaultMaxActiveDispatches: number;
		defaultMaxPersonalRoles: number;
		defaultModelSelection: ModelSelection | null;
	}>,
): Promise<{ settings: PlatformSettingsDto }> {
	return requestJson("/api/admin/settings", {
		method: "PATCH",
		body: JSON.stringify(input),
	});
}

export function updateAdminUser(
	userId: string,
	input: Partial<{
		displayName: string;
		platformRole: PlatformRole;
		status: UserStatus;
		maxOrgs: number;
		maxActiveDispatches: number;
		maxPersonalRoles: number;
		canDispatchAi: boolean;
	}>,
): Promise<{ user: AccountUserDto }> {
	return requestJson(`/api/admin/users/${encodeURIComponent(userId)}`, {
		method: "PATCH",
		body: JSON.stringify(input),
	});
}

export function abortAdminMatter(matterId: string): Promise<{ ok: boolean; aborted: boolean }> {
	return requestJson(`/api/admin/matters/${encodeURIComponent(matterId)}/abort`, {
		method: "POST",
		body: "{}",
	});
}
