import type {
	AccessTokenDto,
	AccessTokenScope,
	AccountUserDto,
	AuthSessionPayload,
	OrgInvitePreviewDto,
	PlatformRole,
	RegistrationMode,
	UserStatus,
} from "@pa/contracts/organization";
import { requestJson } from "./client.ts";

export type {
	AccessTokenDto,
	AccessTokenScope,
	AccountUserDto,
	AuthSessionPayload,
	OrgInvitePreviewDto,
	PlatformRole,
	RegistrationMode,
	UserStatus,
};

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

export function listAccessTokens(): Promise<{ tokens: AccessTokenDto[] }> {
	return requestJson("/api/auth/tokens");
}

export function createAccessToken(input: {
	name: string;
	scope: AccessTokenScope;
	allowedOrgIds?: string[] | null;
	allowedWorkspaceIds?: string[] | null;
	expiresInDays?: number | null;
}): Promise<{ token: AccessTokenDto; rawToken: string }> {
	return requestJson("/api/auth/tokens", {
		method: "POST",
		body: JSON.stringify(input),
	});
}

export function revokeAccessToken(tokenId: string): Promise<{ ok: boolean; id: string }> {
	return requestJson(`/api/auth/tokens/${encodeURIComponent(tokenId)}`, {
		method: "DELETE",
	});
}
