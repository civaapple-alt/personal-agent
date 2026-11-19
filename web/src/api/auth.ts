import { requestJson } from "./client.ts";
import type { CollaboratorDto, OrgMemberRole } from "./organizations.ts";

export type PlatformRole = "super_admin" | "user";

export type UserStatus = "active" | "pending_review" | "disabled";

export type RegistrationMode = "open_auto" | "open_review" | "invite_only";

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
	lastLoginAt: string | null;
}

export interface AuthSessionPayload {
	authenticated: boolean;
	requireAuth?: boolean;
	permissionRequired: boolean;
	revokedSession?: boolean;
	pendingApproval?: boolean;
	needsAdminSetup?: boolean;
	registrationMode?: RegistrationMode;
	authKind?: "session" | "legacy_token" | "loopback" | null;
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

export function fetchAuthSession(): Promise<AuthSessionPayload> {
	return requestJson<AuthSessionPayload>("/api/auth/session");
}

export function fetchOrgInvitePreview(token: string): Promise<OrgInvitePreviewDto> {
	return requestJson<OrgInvitePreviewDto>(`/api/auth/invite-preview?token=${encodeURIComponent(token)}`);
}

export function setupInitialAdmin(input: {
	email: string;
	password: string;
	displayName: string;
}): Promise<{ ok: boolean; accountUser: AccountUserDto }> {
	return requestJson("/api/auth/setup-admin", {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export function registerWithEmail(input: {
	email: string;
	password: string;
	displayName: string;
	inviteToken?: string;
}): Promise<{ ok: boolean; pendingApproval?: boolean; accountUser: AccountUserDto }> {
	return requestJson("/api/auth/register", {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export function loginWithEmail(input: { email: string; password: string; inviteToken?: string }): Promise<{
	ok: boolean;
	pendingApproval?: boolean;
	joinedOrgId?: string | null;
	accountUser?: AccountUserDto;
}> {
	return requestJson("/api/auth/login", {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export function loginWithInviteToken(token: string): Promise<{ ok: boolean; currentUser: CollaboratorDto }> {
	return requestJson("/api/auth/login", {
		method: "POST",
		body: JSON.stringify({ token }),
	});
}

export function changeAccountPassword(input: {
	currentPassword: string;
	newPassword: string;
}): Promise<{ ok: boolean }> {
	return requestJson("/api/auth/change-password", {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export function logoutAuthSession(): Promise<{ ok: boolean }> {
	return requestJson("/api/auth/logout", {
		method: "POST",
		body: "{}",
	});
}
