import { useCallback, useEffect, useMemo, useState } from "react";
import {
	type AccountUserDto,
	fetchAuthSession,
	fetchOrgInvitePreview,
	loginWithEmail,
	logoutAuthSession,
	type OrgInvitePreviewDto,
	type RegistrationMode,
	registerWithEmail,
	setupInitialAdmin,
} from "../api/auth.ts";
import { setAuthRevokedHandler } from "../api/client.ts";
import { type CollaboratorDto, joinOrganizationByInvite } from "../api/organizations.ts";
import type { BootstrapPayload } from "../api.ts";

function extractInitialInviteToken(): string {
	try {
		const searchToken = new URLSearchParams(window.location.search).get("invite")?.trim();
		if (searchToken) return searchToken;
		const hash = window.location.hash;
		const match = hash.match(/invite=([^&]+)/);
		if (match?.[1]) return decodeURIComponent(match[1]).trim();
	} catch {
		// Ignore URL parsing errors.
	}
	return "";
}

interface AuthSessionOptions {
	bootstrapAuthKind: BootstrapPayload["authKind"];
	applyEditionState: (requireAuth?: boolean) => void;
	refreshBootstrap: () => Promise<void>;
	setErrorBanner: (message: string | null) => void;
	setNoticeBanner: (message: string | null) => void;
	onRevoked: () => void;
	onResetDrafts: () => void;
	onResetAdmin: () => void;
	onClearBootstrap: () => void;
	onExitAdmin: () => void;
}

/** Owns login, registration, invitation, and session revocation for the workbench. */
export function useAuthSession({
	bootstrapAuthKind,
	applyEditionState,
	refreshBootstrap,
	setErrorBanner,
	setNoticeBanner,
	onRevoked,
	onResetDrafts,
	onResetAdmin,
	onClearBootstrap,
	onExitAdmin,
}: AuthSessionOptions) {
	const initialInviteToken = useMemo(() => extractInitialInviteToken(), []);
	const initialOrgInvite = initialInviteToken.startsWith("orginv_") ? initialInviteToken : "";
	const [authStatus, setAuthStatus] = useState<"checking" | "authenticated" | "unauthenticated">("checking");
	const [permissionRequired, setPermissionRequired] = useState(true);
	const [needsAdminSetup, setNeedsAdminSetup] = useState(false);
	const [pendingApproval, setPendingApproval] = useState(false);
	const [registrationMode, setRegistrationMode] = useState<RegistrationMode>("open_review");
	const [sessionAccountUser, setSessionAccountUser] = useState<AccountUserDto | null>(null);
	const [authKind, setAuthKind] = useState<"session" | "legacy_token" | "loopback" | null>(null);
	const [activeOrgInviteToken, setActiveOrgInviteToken] = useState(initialOrgInvite);
	const [invitePreview, setInvitePreview] = useState<OrgInvitePreviewDto | null>(null);
	const [showInviteSwitchModal, setShowInviteSwitchModal] = useState(false);
	const [inviteActionBusy, setInviteActionBusy] = useState(false);
	const [authPreferredTab, setAuthPreferredTab] = useState<"login" | "register" | null>(null);
	const [authError, setAuthError] = useState<string | null>(null);
	const [currentUserOverride, setCurrentUserOverride] = useState<CollaboratorDto | null>(null);

	const applyRevokedSession = useCallback(
		(message?: string) => {
			setCurrentUserOverride(null);
			setSessionAccountUser(null);
			onRevoked();
			onResetDrafts();
			setAuthError(message ?? "当前登录凭证已失效或已被管理员吊销，请重新登录");
			setAuthStatus("unauthenticated");
			void fetchAuthSession()
				.then((s) => {
					applyEditionState(s.requireAuth);
					setPermissionRequired(s.permissionRequired);
					setNeedsAdminSetup(Boolean(s.needsAdminSetup));
					setPendingApproval(Boolean(s.pendingApproval));
					setRegistrationMode(s.registrationMode ?? "open_review");
					setSessionAccountUser(s.accountUser ?? null);
				})
				.catch(() => {});
		},
		[applyEditionState, onRevoked, onResetDrafts],
	);

	useEffect(() => {
		setAuthRevokedHandler((message) => applyRevokedSession(message));
		return () => setAuthRevokedHandler(null);
	}, [applyRevokedSession]);

	const syncSessionAndBootstrap = useCallback(async () => {
		const session = await fetchAuthSession();
		applyEditionState(session.requireAuth);
		setPermissionRequired(session.permissionRequired);
		setNeedsAdminSetup(Boolean(session.needsAdminSetup));
		setPendingApproval(Boolean(session.pendingApproval));
		setRegistrationMode(session.registrationMode ?? "open_review");
		setSessionAccountUser(session.accountUser ?? null);
		setAuthKind(session.authKind ?? null);
		if (!session.authenticated) {
			if (session.revokedSession) {
				setAuthError("当前登录凭证已失效或已被重置，请重新登录");
			}
			setAuthStatus("unauthenticated");
			return false;
		}
		setCurrentUserOverride(session.currentUser);
		setAuthStatus("authenticated");
		await refreshBootstrap();
		return true;
	}, [applyEditionState, refreshBootstrap]);

	useEffect(() => {
		let cancelled = false;
		const initSession = async () => {
			try {
				if (initialOrgInvite) {
					void fetchOrgInvitePreview(initialOrgInvite)
						.then((preview) => {
							if (!cancelled) setInvitePreview(preview);
						})
						.catch(() => {});
				}
				const ok = await syncSessionAndBootstrap();
				if (cancelled) return;
				if (ok && initialOrgInvite) {
					setShowInviteSwitchModal(true);
				}
			} catch (err: unknown) {
				if (cancelled) return;
				setErrorBanner(err instanceof Error ? err.message : String(err));
			}
		};
		void initSession();
		return () => {
			cancelled = true;
		};
	}, [initialOrgInvite, setErrorBanner, syncSessionAndBootstrap]);

	const handleSetupAdmin = async (input: { email: string; password: string; displayName: string }) => {
		setAuthError(null);
		try {
			await setupInitialAdmin(input);
			await syncSessionAndBootstrap();
		} catch (err: unknown) {
			setAuthError(err instanceof Error ? err.message : "初始化超级管理员失败");
		}
	};

	const handleRegisterEmail = async (input: {
		email: string;
		password: string;
		displayName: string;
		inviteToken?: string;
	}) => {
		setAuthError(null);
		try {
			const res = await registerWithEmail(input);
			setSessionAccountUser(res.accountUser);
			if (res.pendingApproval) {
				setPendingApproval(true);
				setAuthStatus("unauthenticated");
				return;
			}
			await syncSessionAndBootstrap();
			if (activeOrgInviteToken) {
				setActiveOrgInviteToken("");
				setShowInviteSwitchModal(false);
				window.history.replaceState(null, "", `${window.location.pathname}${window.location.hash || "#/chats"}`);
			}
		} catch (err: unknown) {
			setAuthError(err instanceof Error ? err.message : "注册失败");
		}
	};

	const handleLoginEmail = async (input: { email: string; password: string; inviteToken?: string }) => {
		setAuthError(null);
		try {
			const res = await loginWithEmail(input);
			if (res.pendingApproval) {
				setSessionAccountUser(res.accountUser ?? null);
				setPendingApproval(true);
				setAuthStatus("unauthenticated");
				return;
			}
			await syncSessionAndBootstrap();
			if (activeOrgInviteToken) {
				setActiveOrgInviteToken("");
				setShowInviteSwitchModal(false);
				window.history.replaceState(null, "", `${window.location.pathname}${window.location.hash || "#/chats"}`);
			}
			if (res.joinedOrgId) {
				setNoticeBanner("登录成功并已自动加入邀请组织");
			}
		} catch (err: unknown) {
			setAuthError(err instanceof Error ? err.message : "邮箱或密码错误");
		}
	};

	const clearPendingInviteFromUrl = () => {
		setShowInviteSwitchModal(false);
		setActiveOrgInviteToken("");
		window.history.replaceState(null, "", `${window.location.pathname}${window.location.hash || "#/chats"}`);
	};

	const handleSwitchToInviteAuth = async (targetTab: "register" | "login") => {
		if (inviteActionBusy) return;
		setInviteActionBusy(true);
		try {
			const currentKind = bootstrapAuthKind ?? authKind;
			if (currentKind && currentKind !== "loopback") {
				await logoutAuthSession();
			}
			onResetAdmin();
			onResetDrafts();
			setPendingApproval(false);
			setSessionAccountUser(null);
			setCurrentUserOverride(null);
			onClearBootstrap();
			setAuthKind(null);
			setAuthError(null);
			setAuthPreferredTab(targetTab);
			setShowInviteSwitchModal(false);
			if (activeOrgInviteToken) {
				const preview = await fetchOrgInvitePreview(activeOrgInviteToken).catch(() => null);
				if (preview) setInvitePreview(preview);
			}
			setAuthStatus("unauthenticated");
		} catch (err: unknown) {
			setErrorBanner(err instanceof Error ? err.message : String(err));
		} finally {
			setInviteActionBusy(false);
		}
	};

	const handleAcceptInviteWithCurrentUser = async () => {
		if (!activeOrgInviteToken || inviteActionBusy) return;
		setInviteActionBusy(true);
		try {
			const joined = await joinOrganizationByInvite(activeOrgInviteToken);
			clearPendingInviteFromUrl();
			setNoticeBanner(`已使用当前账号加入组织「${joined.organization.name}」`);
			await refreshBootstrap();
		} catch (err: unknown) {
			setErrorBanner(err instanceof Error ? err.message : "加入组织失败");
		} finally {
			setInviteActionBusy(false);
		}
	};

	const handleRefreshAuthSession = async () => {
		setAuthError(null);
		try {
			await syncSessionAndBootstrap();
		} catch (err: unknown) {
			setAuthError(err instanceof Error ? err.message : "刷新登录状态失败");
		}
	};

	const handleLogoutOrRestore = async () => {
		const effectiveKind = bootstrapAuthKind ?? authKind;
		try {
			// On localhost免登录模式, clicking "切换账号" opens the login/registration gate without loop-bouncing.
			if (effectiveKind === "loopback" && !permissionRequired) {
				onResetDrafts();
				setAuthError(null);
				setAuthStatus("unauthenticated");
				return;
			}
			await logoutAuthSession();
			onResetAdmin();
			onResetDrafts();
			setPendingApproval(false);
			setSessionAccountUser(null);
			setAuthKind(null);
			onExitAdmin();
			const session = await fetchAuthSession();
			applyEditionState(session.requireAuth);
			setPermissionRequired(session.permissionRequired);
			setNeedsAdminSetup(Boolean(session.needsAdminSetup));
			setRegistrationMode(session.registrationMode ?? "open_review");
			setCurrentUserOverride(null);
			onClearBootstrap();
			setAuthStatus("unauthenticated");
		} catch (err: unknown) {
			setErrorBanner(err instanceof Error ? err.message : String(err));
		}
	};

	const handleRestoreLoopbackOwner = async () => {
		setAuthError(null);
		try {
			await logoutAuthSession();
			const ok = await syncSessionAndBootstrap();
			if (ok) {
				setNoticeBanner("已返回本机免密所有者视图");
			}
		} catch (err: unknown) {
			setErrorBanner(err instanceof Error ? err.message : String(err));
		}
	};

	return {
		authStatus,
		authKind,
		currentUserOverride,
		sessionAccountUser,
		permissionRequired,
		setPermissionRequired,
		applyRevokedSession,
		handleLogoutOrRestore,
		gateProps: {
			permissionRequired,
			needsAdminSetup,
			pendingApproval,
			registrationMode,
			accountUser: sessionAccountUser,
			authError,
			orgInviteToken: activeOrgInviteToken,
			invitePreview,
			preferredTab: authPreferredTab,
			onSetupAdmin: handleSetupAdmin,
			onLoginEmail: handleLoginEmail,
			onRegisterEmail: handleRegisterEmail,
			onRefreshSession: handleRefreshAuthSession,
			onLogoutPending: handleLogoutOrRestore,
			onRestoreOwner: () => void handleRestoreLoopbackOwner(),
		},
		inviteDialogProps: {
			open: showInviteSwitchModal && Boolean(activeOrgInviteToken),
			invitePreview,
			inviteActionBusy,
			onClose: clearPendingInviteFromUrl,
			onSwitchAccount: handleSwitchToInviteAuth,
			onAccept: handleAcceptInviteWithCurrentUser,
		},
	};
}
