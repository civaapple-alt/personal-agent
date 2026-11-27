import type { ModelSelection } from "@pa/contracts/model-selection";
import type {
	AccountUserDto,
	AdminOverviewPayload,
	AdminUserRowDto,
	AuditLogEntryDto,
	PlatformRole,
	PlatformSettingsDto,
	RegistrationMode,
	UserStatus,
} from "@pa/contracts/organization";
import { requestJson } from "./client.ts";

export type { AdminOverviewPayload, AdminUserRowDto, AuditLogEntryDto, PlatformSettingsDto };

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
