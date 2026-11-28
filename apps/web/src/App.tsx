import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { updateMatterStatus } from "./api/matters.ts";
import type { ModelSelection } from "./api/models.ts";
import { organizationRoleModel } from "./api/organizations.ts";
import {
	type BootstrapPayload,
	fetchBootstrap,
	fetchMatterDetail,
	type MatterDetailPayload,
	type MatterProgressDto,
	type MatterVisibility,
} from "./api.ts";
import {
	filterBusinessMembers,
	isArchitectMemberId,
	isSoloMemberId,
	ROLE_ARCHITECT_MEMBER_ID,
} from "./architectApi.ts";
import { ModelCatalogProvider } from "./components/ModelPicker.tsx";
import { OrgInviteModal } from "./components/OrgInviteModal.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { WorkbenchBanners } from "./components/WorkbenchBanners.tsx";
import { type HashRoute, type NavTab, parseHashRoute, type SettingsSection } from "./hashRouter.ts";
import { useAuthSession } from "./hooks/useAuthSession.ts";
import { useComposerDraft } from "./hooks/useComposerDraft.ts";
import { useHashRouteNav } from "./hooks/useHashRouteNav.ts";
import { readStoredSetting, useMatterActions } from "./hooks/useMatterActions.ts";
import { useMatterEventSync } from "./hooks/useMatterEventSync.ts";
import { useMatterInitiationState } from "./hooks/useMatterInitiationState.ts";
import { useMatterScope } from "./hooks/useMatterScope.ts";
import { useStableCallback } from "./hooks/useStableCallback.ts";
import { useWorkbenchPanels } from "./hooks/useWorkbenchPanels.ts";
import { Button, IconButton } from "./primitives/index.ts";
import { getBotTheme } from "./utils.ts";
import { AppArchiveConfirmModal, AppStageRouter } from "./views/AppStageRouter.tsx";
import { AuthGateView } from "./views/AuthGateView.tsx";

function syncEditionDocumentTitle(requireAuth: boolean | undefined): void {
	if (typeof requireAuth !== "boolean") return;
	document.title = requireAuth ? "Personal Agent · 团队版" : "Personal Agent · 个人版";
}

const NEW_MATTER_DRAFT = "new:matter";
const NEW_ARCHITECT_DRAFT = "new:architect";

/** Root application shell coordinating authentication, SSE state sync, hash routing, and workspace tabs. */
export function App() {
	const initialRoute = useMemo(() => parseHashRoute(window.location.hash), []);
	const [serverRequireAuth, setServerRequireAuth] = useState<boolean | null>(null);
	const [draftModelSelection, setDraftModelSelection] = useState<ModelSelection | null>(null);
	const [draftMatterVisibility, setDraftMatterVisibility] = useState<MatterVisibility>("org");
	const [activeTab, setActiveTab] = useState<NavTab>(initialRoute.tab);
	const [settingsSection, setSettingsSection] = useState<SettingsSection>(initialRoute.settingsSection ?? "all");
	const [searchQuery, setSearchQuery] = useState("");
	const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
	const [selectedMatterId, setSelectedMatterId] = useState<string | null>(
		initialRoute.isNewMatter ? null : (initialRoute.matterId ?? null),
	);
	const [matterDetail, setMatterDetail] = useState<MatterDetailPayload | null>(null);
	const [spaceRoute, setSpaceRoute] = useState<{ pageId?: string }>({
		pageId: initialRoute.spacePageId,
	});
	const [selectedMemberId, setSelectedMemberId] = useState<string>(
		initialRoute.isNewMatter && initialRoute.newMatterLeadId ? initialRoute.newMatterLeadId : "auto",
	);
	const [selectedOrgId, setSelectedOrgId] = useState<string>(() => readStoredSetting("pa.defaultOrgId"));
	const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>(() =>
		readStoredSetting("pa.defaultWorkspaceId"),
	);
	const [defaultDraftAiMemberIds, setDraftAiMemberIds] = useState<string[] | null>(null);
	const [draftObserversEnabled, setDraftObserversEnabled] = useState<boolean>(false);
	const [streamingDelta, setStreamingDelta] = useState("");
	const [sseConnected, setSseConnected] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [errorBanner, setErrorBanner] = useState<string | null>(null);
	const [noticeBanner, setNoticeBanner] = useState<string | null>(null);
	const dismissError = useCallback(() => setErrorBanner(null), []);
	const dismissNotice = useCallback(() => setNoticeBanner(null), []);
	const [mobileNavOpen, setMobileNavOpen] = useState(false);
	const [progressByMatter, setProgressByMatter] = useState<Record<string, MatterProgressDto>>({});
	const [progressStartedAt, setProgressStartedAt] = useState<Record<string, number>>({});

	const composerRef = useRef<HTMLTextAreaElement | null>(null);
	const composerDraftKey =
		selectedMatterId ?? (selectedMemberId === ROLE_ARCHITECT_MEMBER_ID ? NEW_ARCHITECT_DRAFT : NEW_MATTER_DRAFT);
	const {
		composerText,
		setComposerText,
		appendComposerText,
		composerImages,
		composerFiles,
		clearSentComposer,
		resetComposerDrafts,
		composerAttachmentText,
		handleAddComposerAttachments,
		handleAddPastedText,
		handleRemoveComposerImage,
		handleRemoveComposerFile,
		handleExpandPastedFile,
	} = useComposerDraft(composerDraftKey, composerRef, setErrorBanner);
	const explicitNewMatterRef = useRef(Boolean(initialRoute.isNewMatter));
	const selectedMatterIdRef = useRef<string | null>(selectedMatterId);
	selectedMatterIdRef.current = selectedMatterId;
	const matterStreamRevision = useRef({ total: 0, byMatter: new Map<string, number>() });
	const detailRequest = useRef(0);

	const navigateRoute = useHashRouteNav({
		initialRoute,
		explicitNewMatterRef,
		setActiveTab,
		setSpaceRoute,
		setSelectedMatterId,
		setSelectedMemberId,
		setSettingsSection,
	});

	const applyEditionState = useCallback((requireAuthValue: boolean | undefined) => {
		if (typeof requireAuthValue !== "boolean") return;
		syncEditionDocumentTitle(requireAuthValue);
		setServerRequireAuth(requireAuthValue);
	}, []);

	const refreshBootstrap = useCallback(async () => {
		const revision = matterStreamRevision.current.total;
		const data = await fetchBootstrap();
		setBootstrap(data);
		applyEditionState(data.platformPolicy?.requireAuth);
		if (data.activeRuns && revision === matterStreamRevision.current.total) {
			const nextProgress: Record<string, MatterProgressDto> = {};
			const nextStartedAt: Record<string, number> = {};
			for (const [id, snapshot] of Object.entries(data.activeRuns)) {
				nextProgress[id] = snapshot;
				nextStartedAt[id] = snapshot.startedAt;
			}
			setProgressByMatter(nextProgress);
			setProgressStartedAt(nextStartedAt);
		}
		setSelectedMatterId((prev) => (explicitNewMatterRef.current ? null : (prev ?? data.matters[0]?.id ?? null)));
		let resolvedWorkspaceId = "";
		setSelectedWorkspaceId((prev) => {
			if (prev && data.workspaces.some((w) => w.id === prev)) {
				resolvedWorkspaceId = prev;
				return prev;
			}
			const saved = readStoredSetting("pa.defaultWorkspaceId", "__unset__");
			if (saved !== "__unset__") {
				resolvedWorkspaceId = saved && data.workspaces.some((w) => w.id === saved) ? saved : "";
				return resolvedWorkspaceId;
			}
			resolvedWorkspaceId = data.workspaces[0]?.id || "";
			return resolvedWorkspaceId;
		});
		const resolvedWs = resolvedWorkspaceId
			? (data.workspaces.find((w) => w.id === resolvedWorkspaceId) ?? null)
			: null;
		setSelectedOrgId((prev) => {
			if (prev && data.organizations.some((o) => o.id === prev)) return prev;
			if (resolvedWs?.orgId) return resolvedWs.orgId;
			const savedOrg = readStoredSetting("pa.defaultOrgId", "__unset__");
			const canLeaveOrgUnbound = data.authKind !== "session" || data.accountUser?.platformRole === "super_admin";
			if (savedOrg !== "__unset__") {
				if (savedOrg && data.organizations.some((o) => o.id === savedOrg)) return savedOrg;
				if (savedOrg === "" && canLeaveOrgUnbound) return "";
			}
			return (data.organizations.find((o) => o.isDefault) ?? data.organizations[0])?.id ?? "";
		});
	}, [applyEditionState]);

	const refreshDetail = useCallback(async (matterId: string | null) => {
		if (matterId !== selectedMatterIdRef.current) return;
		const request = ++detailRequest.current;
		if (!matterId) {
			setMatterDetail(null);
			return;
		}
		const revision = matterStreamRevision.current.byMatter.get(matterId);
		const detail = await fetchMatterDetail(matterId);
		if (request !== detailRequest.current || matterId !== selectedMatterIdRef.current) return;
		setMatterDetail(detail);
		setSelectedWorkspaceId(detail.matter.workspaceId ?? "");
		setSelectedOrgId(detail.matter.orgId ?? "");
		if (revision !== matterStreamRevision.current.byMatter.get(matterId)) return;
		const snapshot = detail.activeRun;
		if (!snapshot) return;
		setProgressByMatter((prev) => ({ ...prev, [matterId]: snapshot }));
		setProgressStartedAt((prev) => ({ ...prev, [matterId]: snapshot.startedAt }));
		if (snapshot.streamingDelta !== undefined) setStreamingDelta(snapshot.streamingDelta);
	}, []);

	const {
		runtimeOverview,
		clearAdminOverview,
		clearPanels,
		openRuntimePanel,
		openAdminPanel,
		settingsProps,
		adminProps,
	} = useWorkbenchPanels(refreshBootstrap);

	const resetRevokedWorkspace = useCallback(() => {
		setBootstrap(null);
		setMatterDetail(null);
		clearPanels();
		setProgressByMatter({});
		setSseConnected(false);
	}, [clearPanels]);

	const auth = useAuthSession({
		bootstrapAuthKind: bootstrap?.authKind,
		applyEditionState,
		refreshBootstrap,
		setErrorBanner,
		setNoticeBanner,
		onRevoked: resetRevokedWorkspace,
		onResetDrafts: resetComposerDrafts,
		onResetAdmin: clearAdminOverview,
		onClearBootstrap: () => setBootstrap(null),
		onExitAdmin: () => {
			if (activeTab === "admin") navigateRoute({ tab: "chats" }, { replace: true });
		},
	});
	const {
		authStatus,
		authKind,
		currentUserOverride,
		sessionAccountUser,
		permissionRequired,
		setPermissionRequired,
		applyRevokedSession,
		handleLogoutOrRestore,
	} = auth;

	useEffect(() => {
		if (authStatus !== "authenticated") clearPanels();
		else if (activeTab === "settings") openRuntimePanel();
	}, [authStatus, activeTab, clearPanels, openRuntimePanel]);

	useEffect(() => {
		if (authStatus !== "authenticated") return;
		setStreamingDelta("");
		void refreshDetail(selectedMatterId).catch(() => {});
	}, [authStatus, selectedMatterId, refreshDetail]);

	useMatterEventSync({
		authStatus,
		selectedMatterIdRef,
		matterStreamRevision,
		setProgressByMatter,
		setProgressStartedAt,
		setStreamingDelta,
		setSseConnected,
		setPermissionRequired,
		setErrorBanner,
		refreshBootstrap,
		refreshDetail,
		applyRevokedSession,
	});

	const {
		selectedWorkspace,
		draftEffectiveOrgId,
		effectiveOrgIdForScope,
		headerContact,
		memberThemeMap,
		activeDialogs,
		templateByRoleId,
		initiationScopedMembers,
		effectiveOrg,
		orgEffectiveMemberIds,
	} = useMatterScope({
		bootstrap,
		matterDetail,
		selectedMatterId,
		selectedMemberId,
		selectedOrgId,
		selectedWorkspaceId,
	});

	const filteredMatters = useMemo(() => {
		const list = bootstrap?.matters ?? [];
		const q = searchQuery.trim().toLowerCase();
		if (!q) return list;
		return list.filter((m) => m.title.toLowerCase().includes(q) || m.summary.toLowerCase().includes(q));
	}, [bootstrap, searchQuery]);

	const memberName = (id: string) => bootstrap?.members.find((m) => m.id === id)?.displayName ?? id;
	const workspaceName = (id: string | null) =>
		id ? (bootstrap?.workspaces.find((w) => w.id === id)?.name ?? id) : null;
	const organizationName = (id: string | null) =>
		id ? (bootstrap?.organizations.find((o) => o.id === id)?.name ?? id) : null;

	const initiation = useMatterInitiationState({
		selectedMatterId,
		composerText,
		composerImageCount: composerImages.length,
		composerFileCount: composerFiles.length,
		composerAttachmentText,
		selectedWorkspaceId,
		selectedOrgId: draftEffectiveOrgId ?? "",
		selectedMemberId,
		members: initiationScopedMembers,
		defaultAiMemberIds: defaultDraftAiMemberIds,
		setSelectedMemberId,
		setDraftAiMemberIds,
		setDraftObserversEnabled,
	});
	const { draftAiMemberIds } = initiation;

	const resolveDefaultPrimaryLeadId = () => {
		const business = filterBusinessMembers(initiationScopedMembers, templateByRoleId);
		return business.find((member) => member.isPrimaryContact)?.id ?? business[0]?.id ?? "auto";
	};

	const startNewMatter = (preferredLeadId?: string) => {
		setDraftModelSelection(null);
		initiation.resetInitiationState();
		setDraftMatterVisibility("org");
		const leadId = preferredLeadId ?? resolveDefaultPrimaryLeadId();
		setSelectedMemberId(leadId);
		navigateRoute({ tab: "chats", isNewMatter: true, newMatterLeadId: leadId === "auto" ? undefined : leadId });
		composerRef.current?.focus();
	};

	const startNewMatterFromCurrent = () => {
		const currentMatter =
			selectedMatterId && matterDetail?.matter.id === selectedMatterId ? matterDetail.matter : null;
		const currentLeadId = currentMatter?.leadMemberId ?? null;
		const currentIsArchitect = isArchitectMemberId(currentLeadId, bootstrap?.members ?? [], templateByRoleId);
		if (!currentMatter || currentIsArchitect) {
			startNewMatter();
			return;
		}
		initiation.resetInitiationState();
		setSelectedOrgId(currentMatter.orgId ?? "");
		setSelectedWorkspaceId(currentMatter.workspaceId ?? "");
		const inheritedLeadId =
			currentLeadId && initiationScopedMembers.some((member) => member.id === currentLeadId)
				? currentLeadId
				: resolveDefaultPrimaryLeadId();
		setSelectedMemberId(inheritedLeadId);
		setDraftModelSelection(currentMatter.modelSelection ?? null);
		setDraftMatterVisibility(currentMatter.visibility ?? "org");
		initiation.setDraftCollaborationMode(currentMatter.collaborationMode ?? "lead");
		initiation.setDraftCollaboratorIds(currentMatter.collaboratorIds ?? []);
		setDraftAiMemberIds(currentMatter.aiMemberIds ?? null);
		initiation.syncDraftRoster(
			currentMatter.consultMemberIds ?? null,
			currentMatter.observerMemberIds ?? [],
			inheritedLeadId === "auto" ? null : inheritedLeadId,
		);
		setDraftObserversEnabled(Boolean(currentMatter.observersEnabled));
		navigateRoute({
			tab: "chats",
			isNewMatter: true,
			newMatterLeadId: inheritedLeadId === "auto" ? undefined : inheritedLeadId,
		});
		composerRef.current?.focus();
	};

	const startArchitectMatter = (seedText?: string) => {
		setDraftModelSelection(null);
		initiation.resetInitiationState();
		setSelectedMemberId(ROLE_ARCHITECT_MEMBER_ID);
		setDraftAiMemberIds([ROLE_ARCHITECT_MEMBER_ID]);
		initiation.setDraftPresetMode("solo");
		setDraftObserversEnabled(false);
		if (seedText !== undefined) {
			appendComposerText(seedText, NEW_ARCHITECT_DRAFT);
		}
		navigateRoute({ tab: "chats", isNewMatter: true, newMatterLeadId: ROLE_ARCHITECT_MEMBER_ID });
		composerRef.current?.focus();
	};

	const launchNewMatterWithMembers = (memberIds: string[]) => {
		if (memberIds.length === 0) return;
		setDraftModelSelection(null);
		initiation.resetInitiationState();
		setSelectedMemberId(memberIds[0]!);
		setDraftAiMemberIds(memberIds);
		initiation.setDraftPresetMode(memberIds.length === 1 ? "solo" : "lead_consult");
		setDraftObserversEnabled(false);
		navigateRoute({ tab: "chats", isNewMatter: true, newMatterLeadId: memberIds[0]! });
		composerRef.current?.focus();
	};

	useEffect(() => {
		if (activeTab !== "chats" || selectedMatterId !== null || !explicitNewMatterRef.current) return;
		const nextHash =
			selectedMemberId && selectedMemberId !== "auto"
				? `#/chats/new/${encodeURIComponent(selectedMemberId)}`
				: "#/chats/new";
		if (window.location.hash !== nextHash) {
			window.history.replaceState(null, "", nextHash);
		}
	}, [activeTab, selectedMatterId, selectedMemberId]);

	const matterAiMemberIds: string[] = useMemo(() => {
		const allMembers = bootstrap?.members ?? [];
		const allBusinessIds = filterBusinessMembers(allMembers, templateByRoleId).map((m) => m.id);
		const validIds = new Set(allMembers.map((m) => m.id));
		const leadId = headerContact?.id;
		const defaultIds =
			isArchitectMemberId(leadId, allMembers, templateByRoleId) ||
			isSoloMemberId(leadId, allMembers, templateByRoleId)
				? [leadId!]
				: allBusinessIds;
		const raw =
			selectedMatterId && matterDetail
				? matterDetail.matter.aiMemberIds === null || matterDetail.matter.aiMemberIds === undefined
					? defaultIds
					: matterDetail.matter.aiMemberIds
				: draftAiMemberIds === null
					? defaultIds
					: draftAiMemberIds;
		const filtered = raw.filter((id) => validIds.has(id));
		if (leadId && validIds.has(leadId) && !filtered.includes(leadId)) {
			return [leadId, ...filtered];
		}
		return filtered.length > 0 ? filtered : defaultIds;
	}, [bootstrap, draftAiMemberIds, headerContact?.id, matterDetail, selectedMatterId, templateByRoleId]);

	const observersEnabled: boolean = useMemo(() => {
		if (selectedMatterId && matterDetail) {
			return Boolean(
				matterDetail.matter.observersEnabled ?? (matterDetail.matter.observerMemberIds?.length ?? 0) > 0,
			);
		}
		return draftObserversEnabled;
	}, [draftObserversEnabled, matterDetail, selectedMatterId]);

	const matterConsultMemberIds: string[] | null = useMemo(() => {
		if (selectedMatterId && matterDetail) {
			return matterDetail.matter.consultMemberIds ?? null;
		}
		return initiation.draftConsultMemberIds;
	}, [initiation.draftConsultMemberIds, matterDetail, selectedMatterId]);

	const currentUser = bootstrap?.currentUser ?? currentUserOverride ?? null;
	const accountUser = bootstrap?.accountUser ?? sessionAccountUser ?? null;
	const isSuperAdmin = accountUser
		? accountUser.platformRole === "super_admin"
		: !permissionRequired && currentUser?.permissionRole !== "collaborator";

	useEffect(() => {
		if (authStatus !== "authenticated" || activeTab !== "admin") return;
		if (!isSuperAdmin) {
			navigateRoute({ tab: "chats" }, { replace: true });
			return;
		}
		openAdminPanel();
	}, [authStatus, activeTab, isSuperAdmin, navigateRoute, openAdminPanel]);
	const canDispatchAi = accountUser
		? accountUser.status === "active" && accountUser.canDispatchAi && effectiveOrg?.orgRole !== "org_viewer"
		: currentUser?.permissionRole !== "collaborator";
	const isOwner = canDispatchAi;
	const canManageMatter =
		!selectedMatterId ||
		isSuperAdmin ||
		(!accountUser && currentUser?.permissionRole === "owner") ||
		Boolean(
			accountUser &&
				(matterDetail?.matter.createdByUserId === accountUser.id ||
					effectiveOrg?.orgRole === "org_owner" ||
					effectiveOrg?.orgRole === "org_admin"),
		);
	const actions = useMatterActions({
		bootstrap,
		isOwner,
		currentMatterLeadId: matterDetail?.matter.id === selectedMatterId ? matterDetail?.matter.leadMemberId : null,
		composerText,
		composerImages,
		composerFiles,
		submitting,
		selectedMatterId,
		selectedMemberId,
		selectedWorkspaceId,
		selectedWorkspace,
		selectedOrgId,
		draftAiMemberIds,
		draftConsultMemberIds: initiation.draftConsultMemberIds,
		draftObserverMemberIds: initiation.draftObserverMemberIds,
		draftCollaboratorIds: initiation.draftCollaboratorIds,
		draftVisibility: draftMatterVisibility,
		draftCollaborationMode: initiation.draftCollaborationMode,
		draftObserversEnabled,
		draftModelSelection,
		headerContact,
		explicitNewMatterRef,
		memberName,
		workspaceName,
		organizationName,
		setSubmitting,
		clearSentComposer,
		setSelectedMemberId,
		setSelectedWorkspaceId,
		setSelectedOrgId,
		setDraftAiMemberIds,
		setDraftConsultMemberIds: initiation.setDraftConsultMemberIds,
		setDraftObserverMemberIds: initiation.setDraftObserverMemberIds,
		setDraftObserversEnabled,
		onSyncDraftPresetForObservers: (hasObservers: boolean) => {
			initiation.setDraftPresetMode((prev) =>
				hasObservers ? "lead_review" : prev === "lead_review" ? "lead_consult" : prev,
			);
		},
		onResetInitiation: () => {
			setDraftModelSelection(null);
			initiation.resetInitiationState();
		},
		setErrorBanner,
		setNoticeBanner,
		navigateRoute,
		refreshBootstrap,
		refreshDetail,
	});

	const activeMatterProgress = selectedMatterId ? (progressByMatter[selectedMatterId] ?? null) : null;
	const headerTheme = headerContact ? (memberThemeMap.get(headerContact.id) ?? getBotTheme(0)) : getBotTheme(0);
	const activeProgressStartedAt = selectedMatterId ? (progressStartedAt[selectedMatterId] ?? null) : null;

	// Stable handlers keep the memoized Sidebar from re-rendering on every streamed text delta.
	const handleCloseMobileNav = useStableCallback(() => setMobileNavOpen(false));
	useEffect(() => {
		if (!mobileNavOpen) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setMobileNavOpen(false);
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [mobileNavOpen]);
	const handleSidebarNavigate = useStableCallback((route: HashRoute) => {
		setMobileNavOpen(false);
		navigateRoute(route);
	});
	const handleSidebarToggleMember = useStableCallback((memberId: string) => {
		setMobileNavOpen(false);
		const nextSelected =
			activeTab === "chats" && selectedMatterId === null && selectedMemberId === memberId ? "auto" : memberId;
		const pickingArchitect = isArchitectMemberId(nextSelected, bootstrap?.members, templateByRoleId);
		const pickingSolo = isSoloMemberId(nextSelected, bootstrap?.members, templateByRoleId);
		const alreadyOnNewMatter = activeTab === "chats" && selectedMatterId === null;
		navigateRoute(
			{ tab: "chats", isNewMatter: true, newMatterLeadId: nextSelected === "auto" ? undefined : nextSelected },
			{ replace: alreadyOnNewMatter },
		);
		setSelectedMemberId(nextSelected);
		if (pickingArchitect || selectedMemberId === ROLE_ARCHITECT_MEMBER_ID) setDraftModelSelection(null);
		if (pickingArchitect || pickingSolo) {
			setDraftAiMemberIds([nextSelected]);
			initiation.setDraftPresetMode("solo");
			setDraftObserversEnabled(false);
		} else {
			setDraftAiMemberIds(null);
		}
		composerRef.current?.focus();
	});
	const handleSidebarNewMatter = useStableCallback(() => {
		setMobileNavOpen(false);
		startNewMatter();
	});
	const handleSidebarSwitchOrLogout = useStableCallback(() => {
		setMobileNavOpen(false);
		void handleLogoutOrRestore();
	});
	const [pendingArchiveConfirm, setPendingArchiveConfirm] = useState<{
		matterId: string;
		title: string;
		archived: boolean;
	} | null>(null);
	const [archivingMatter, setArchivingMatter] = useState(false);

	const handleSidebarToggleArchiveMatter = useStableCallback((matterId: string, archived: boolean) => {
		const target =
			bootstrap?.matters.find((m) => m.id === matterId) ??
			(matterDetail?.matter.id === matterId ? matterDetail.matter : null);
		setPendingArchiveConfirm({
			matterId,
			title: target?.title ?? matterId,
			archived,
		});
	});

	const handleConfirmArchiveMatter = async () => {
		if (!pendingArchiveConfirm || archivingMatter) return;
		const { matterId, archived } = pendingArchiveConfirm;
		setArchivingMatter(true);
		setErrorBanner(null);
		try {
			await updateMatterStatus(matterId, archived ? "archived" : "open");
			setPendingArchiveConfirm(null);
			await refreshBootstrap();
			if (selectedMatterId === matterId) await refreshDetail(matterId);
			setNoticeBanner(archived ? "事项已归档，可在左侧「已归档」中查看" : "事项已恢复至最近事项");
		} catch (err) {
			setErrorBanner(err instanceof Error ? err.message : String(err));
		} finally {
			setArchivingMatter(false);
		}
	};

	if (authStatus !== "authenticated") {
		return <AuthGateView status={authStatus} {...auth.gateProps} />;
	}

	const mobileViewTitle =
		activeTab === "deliverables"
			? "资料空间"
			: activeTab === "team"
				? "AI 团队"
				: activeTab === "organizations"
					? "组织"
					: activeTab === "materials"
						? "工作区"
						: activeTab === "admin"
							? "超级管理员控制台"
							: activeTab === "account"
								? "个人账号"
								: activeTab === "settings"
									? settingsSection === "base"
										? "设置 · Agent 底座"
										: settingsSection === "extensions"
											? "设置 · 扩展插件"
											: settingsSection === "config"
												? "设置 · 运行配置"
												: settingsSection === "skills"
													? "设置 · 技能与信任"
													: settingsSection === "insights"
														? "设置 · 运行洞察"
														: "设置"
									: matterDetail?.matter.title || "新事项对话";
	const runtimeBadge = runtimeOverview
		? runtimeOverview.base.available && runtimeOverview.base.version
			? `Pi ${runtimeOverview.base.version}`
			: "Pi 未就绪"
		: "Pi RPC";
	const hasRunningMatters = Object.keys(progressByMatter).length > 0;
	const currentMatter = matterDetail?.matter.id === selectedMatterId ? matterDetail.matter : null;
	const currentLeadId = selectedMatterId
		? currentMatter?.leadMemberId
		: selectedMemberId === "auto"
			? null
			: selectedMemberId;
	const currentModelOrgId = selectedMatterId ? currentMatter?.orgId : draftEffectiveOrgId;
	const orgLeadModel =
		currentModelOrgId && currentLeadId
			? organizationRoleModel(
					bootstrap?.orgAiRolesByOrgId?.[currentModelOrgId]?.configs.find(
						(config) => config.enabled && config.memberId === currentLeadId,
					),
				)
			: null;

	const workbench = (
		<div className="flex flex-col min-[961px]:flex-row h-dvh w-full max-w-[100vw] overflow-hidden bg-stage">
			{mobileNavOpen && (
				<button
					type="button"
					className="min-[961px]:hidden fixed inset-0 z-[55] border-0 p-0 bg-black/40 cursor-pointer"
					aria-label="关闭导航抽屉"
					onClick={() => setMobileNavOpen(false)}
				/>
			)}
			<Sidebar
				activeTab={activeTab}
				bootstrap={bootstrap}
				currentUser={currentUser}
				authKind={bootstrap?.authKind ?? authKind}
				requireAuth={serverRequireAuth}
				isSuperAdmin={isSuperAdmin}
				orgEffectiveMemberIds={orgEffectiveMemberIds}
				runtimeBadge={runtimeBadge}
				filteredMatters={filteredMatters}
				selectedMatterId={selectedMatterId}
				selectedMemberId={selectedMemberId}
				progressByMatter={progressByMatter}
				sseConnected={sseConnected}
				searchQuery={searchQuery}
				mobileOpen={mobileNavOpen}
				onCloseMobile={handleCloseMobileNav}
				onSearchQueryChange={setSearchQuery}
				onNavigate={handleSidebarNavigate}
				onToggleMember={handleSidebarToggleMember}
				onNewMatter={handleSidebarNewMatter}
				onToggleArchiveMatter={handleSidebarToggleArchiveMatter}
				onSwitchOrLogout={handleSidebarSwitchOrLogout}
			/>

			<main className="relative flex-1 min-w-0 min-h-0 max-w-full flex flex-col overflow-hidden bg-stage">
				<WorkbenchBanners
					errorBanner={errorBanner}
					noticeBanner={noticeBanner}
					onDismissError={dismissError}
					onDismissNotice={dismissNotice}
				/>
				<div className="min-[961px]:hidden flex items-center justify-between gap-2.5 h-[50px] px-3.5 border-b border-line bg-sidebar shrink-0">
					<IconButton
						size="md"
						className="relative rounded-full"
						aria-label="打开导航菜单"
						onClick={() => setMobileNavOpen(true)}
					>
						<svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true">
							<path
								d="M3.5 5.5h13M3.5 10h13M3.5 14.5h13"
								stroke="currentColor"
								strokeWidth="1.7"
								strokeLinecap="round"
							/>
						</svg>
						{hasRunningMatters && (
							<span
								className="absolute top-1 right-1 size-[7px] rounded-full bg-success-text"
								aria-hidden="true"
							/>
						)}
					</IconButton>
					<span className="flex-1 min-w-0 text-sm font-semibold text-ink truncate">{mobileViewTitle}</span>
					<Button
						variant="secondary"
						size="xs"
						onClick={() => {
							setMobileNavOpen(false);
							startNewMatter();
						}}
					>
						+ 新建事项
					</Button>
				</div>
				<AppStageRouter
					activeTab={activeTab}
					settingsSection={settingsSection}
					spaceRoute={spaceRoute}
					bootstrap={bootstrap}
					currentUser={currentUser}
					accountUser={accountUser}
					authKind={bootstrap?.authKind ?? authKind}
					serverRequireAuth={serverRequireAuth}
					isSuperAdmin={isSuperAdmin}
					canDispatchAi={canDispatchAi}
					canManageMatter={canManageMatter}
					orgEffectiveMemberIds={orgEffectiveMemberIds}
					selectedWorkspace={selectedWorkspace}
					selectedWorkspaceId={selectedWorkspaceId}
					selectedOrgId={selectedOrgId}
					effectiveOrgIdForScope={effectiveOrgIdForScope}
					selectedMemberId={selectedMemberId}
					headerContact={headerContact}
					headerTheme={headerTheme}
					selectedMatterId={selectedMatterId}
					currentMatter={currentMatter}
					matterDetail={matterDetail}
					activeDialogs={activeDialogs}
					activeMatterProgress={activeMatterProgress}
					activeProgressStartedAt={activeProgressStartedAt}
					streamingDelta={streamingDelta}
					submitting={submitting}
					templateByRoleId={templateByRoleId}
					matterAiMemberIds={matterAiMemberIds}
					matterConsultMemberIds={matterConsultMemberIds}
					observersEnabled={observersEnabled}
					draftModelSelection={draftModelSelection}
					draftMatterVisibility={draftMatterVisibility}
					orgLeadModel={orgLeadModel}
					currentLeadId={currentLeadId}
					composerRef={composerRef}
					composerDraft={{
						composerRef,
						composerText,
						pendingImages: composerImages,
						pendingFiles: composerFiles,
						onComposerTextChange: setComposerText,
						onAddAttachments: (files) => void handleAddComposerAttachments(files),
						onAddPastedText: handleAddPastedText,
						onRemoveImage: handleRemoveComposerImage,
						onRemoveFile: handleRemoveComposerFile,
						onExpandPastedFile: handleExpandPastedFile,
					}}
					initiation={initiation}
					actions={actions}
					settingsProps={settingsProps}
					adminProps={adminProps}
					memberName={memberName}
					organizationName={organizationName}
					navigateRoute={navigateRoute}
					startNewMatter={startNewMatter}
					startNewMatterFromCurrent={startNewMatterFromCurrent}
					startArchitectMatter={startArchitectMatter}
					launchNewMatterWithMembers={launchNewMatterWithMembers}
					handleSidebarToggleArchiveMatter={handleSidebarToggleArchiveMatter}
					handleSidebarSwitchOrLogout={handleSidebarSwitchOrLogout}
					refreshBootstrap={refreshBootstrap}
					setDraftModelSelection={setDraftModelSelection}
					setMatterDetail={setMatterDetail}
					setDraftAiMemberIds={setDraftAiMemberIds}
					setDraftMatterVisibility={setDraftMatterVisibility}
					setSelectedWorkspaceId={setSelectedWorkspaceId}
					setComposerText={setComposerText}
					setNoticeBanner={setNoticeBanner}
					setErrorBanner={setErrorBanner}
				/>
			</main>

			<OrgInviteModal
				{...auth.inviteDialogProps}
				authKind={bootstrap?.authKind ?? authKind}
				accountUser={accountUser}
				currentUser={currentUser}
			/>

			<AppArchiveConfirmModal
				pendingArchiveConfirm={pendingArchiveConfirm}
				archivingMatter={archivingMatter}
				onClose={() => !archivingMatter && setPendingArchiveConfirm(null)}
				onConfirm={() => void handleConfirmArchiveMatter()}
			/>
		</div>
	);
	return <ModelCatalogProvider>{workbench}</ModelCatalogProvider>;
}
