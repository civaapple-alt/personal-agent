import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { updateMatterModelSelection, updateMatterStatus } from "./api/matters.ts";
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
import { filterBusinessMembers, isArchitectMemberId, ROLE_ARCHITECT_MEMBER_ID } from "./architectApi.ts";
import { MatterModelControl, ModelCatalogProvider } from "./components/ModelPicker.tsx";
import { OrgInviteModal } from "./components/OrgInviteModal.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { RoleArchitectModal } from "./components/team/RoleArchitectModal.tsx";
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
import { ErrorBoundary } from "./primitives/ErrorBoundary.tsx";
import { ModalDialog } from "./primitives/ModalDialog.tsx";
import { ViewFade } from "./primitives/ViewTransitions.tsx";
import { getBotTheme } from "./utils.ts";
import { AccountView } from "./views/AccountView.tsx";
import { AdminView } from "./views/AdminView.tsx";
import { AuthGateView } from "./views/AuthGateView.tsx";
import { ChatStage } from "./views/ChatStage.tsx";
import { DeliverablesView } from "./views/DeliverablesView.tsx";
import { MaterialsView } from "./views/MaterialsView.tsx";
import { OrganizationsView } from "./views/OrganizationsView.tsx";
import { SettingsView } from "./views/SettingsView.tsx";
import { TeamView } from "./views/TeamView.tsx";

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
	const [selectedMemberId, setSelectedMemberId] = useState<string>("auto");
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

	const startNewMatter = () => {
		setDraftModelSelection(null);
		initiation.resetInitiationState();
		setDraftMatterVisibility("org");
		setSelectedMemberId(resolveDefaultPrimaryLeadId());
		navigateRoute({ tab: "chats", isNewMatter: true });
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
		initiation.setDraftCollaboratorIds(currentMatter.collaboratorIds ?? []);
		setDraftAiMemberIds(currentMatter.aiMemberIds ?? null);
		initiation.syncDraftRoster(
			currentMatter.consultMemberIds ?? null,
			currentMatter.observerMemberIds ?? [],
			inheritedLeadId === "auto" ? null : inheritedLeadId,
		);
		setDraftObserversEnabled(Boolean(currentMatter.observersEnabled));
		navigateRoute({ tab: "chats", isNewMatter: true });
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
		navigateRoute({ tab: "chats", isNewMatter: true });
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
		navigateRoute({ tab: "chats", isNewMatter: true });
		composerRef.current?.focus();
	};

	const matterAiMemberIds: string[] = useMemo(() => {
		const allMembers = bootstrap?.members ?? [];
		const allBusinessIds = filterBusinessMembers(allMembers, templateByRoleId).map((m) => m.id);
		const validIds = new Set(allMembers.map((m) => m.id));
		const leadId = headerContact?.id;
		const defaultIds = isArchitectMemberId(leadId, allMembers, templateByRoleId) ? [leadId!] : allBusinessIds;
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
	const handleSidebarNavigate = useStableCallback((route: HashRoute) => {
		setMobileNavOpen(false);
		navigateRoute(route);
	});
	const handleSidebarToggleMember = useStableCallback((memberId: string) => {
		setMobileNavOpen(false);
		const nextSelected =
			activeTab === "chats" && selectedMatterId === null && selectedMemberId === memberId ? "auto" : memberId;
		const pickingArchitect = isArchitectMemberId(nextSelected, bootstrap?.members, templateByRoleId);
		if (activeTab !== "chats" || selectedMatterId !== null) {
			navigateRoute({ tab: "chats", isNewMatter: true });
		}
		setSelectedMemberId(nextSelected);
		if (pickingArchitect || selectedMemberId === ROLE_ARCHITECT_MEMBER_ID) setDraftModelSelection(null);
		if (pickingArchitect) {
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
		<div className="bot-shell">
			{mobileNavOpen && (
				<button
					type="button"
					className="mobile-sidebar-backdrop"
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

			<main className="main-stage">
				<WorkbenchBanners
					errorBanner={errorBanner}
					noticeBanner={noticeBanner}
					onDismissError={dismissError}
					onDismissNotice={dismissNotice}
				/>
				<div className="mobile-topbar">
					<button
						type="button"
						className="icon-btn mobile-nav-trigger"
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
						{hasRunningMatters && <span className="mobile-nav-dot" />}
					</button>
					<span className="mobile-topbar-title">{mobileViewTitle}</span>
					<button
						type="button"
						className="btn-pill-outline btn-xs"
						onClick={() => {
							setMobileNavOpen(false);
							startNewMatter();
						}}
					>
						+ 新建事项
					</button>
				</div>
				<ErrorBoundary key={activeTab} scope={activeTab}>
					{activeTab === "chats" && (
						<ViewFade>
							<ChatStage
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
								initiation={{
									draftAiMemberIds,
									draftConsultMemberIds: initiation.draftConsultMemberIds,
									draftCollaboratorIds: initiation.draftCollaboratorIds,
									draftVisibility: draftMatterVisibility,
									assessment: initiation.assessment,
									modelAssessing: initiation.modelAssessing,
									modelAssessmentError: initiation.modelAssessmentError,
									onUpdateDraftAiMemberIds: setDraftAiMemberIds,
									onUpdateDraftCollaboratorIds: initiation.setDraftCollaboratorIds,
									onUpdateDraftVisibility: setDraftMatterVisibility,
									onSetScopeMode: initiation.setScopeMode,
									onToggleObserverPreset: () => actions.handleToggleObserversEnabled(!draftObserversEnabled),
									onToggleDraftMemberConsult: initiation.toggleDraftMemberConsult,
									onToggleDraftMemberObserver: initiation.toggleDraftMemberObserver,
									onApplyPresetMode: (mode) => initiation.applyPresetMode(mode),
									onApplyRecommendation: initiation.applyAssessmentRecommendation,
									onRequestModelAssessment: (opts) => void initiation.requestModelAssessment(opts),
									onCancelModelAssessment: initiation.cancelModelAssessment,
									onOpenArchitect: initiation.openArchitectForGap,
									onStartArchitectMatter: startArchitectMatter,
								}}
								currentUser={currentUser}
								accountUser={accountUser}
								isSuperAdmin={isSuperAdmin}
								canDispatchAi={canDispatchAi}
								canManageMatter={canManageMatter}
								orgMembersByOrgId={bootstrap?.orgMembersByOrgId ?? {}}
								orgEffectiveMemberIds={orgEffectiveMemberIds}
								selectedWorkspace={selectedWorkspace}
								selectedWorkspaceId={selectedWorkspaceId}
								selectedOrgId={selectedOrgId}
								workspaces={bootstrap?.workspaces ?? []}
								organizations={bootstrap?.organizations ?? []}
								members={bootstrap?.members ?? []}
								selectedMemberId={selectedMemberId}
								headerContact={headerContact}
								headerTheme={headerTheme}
								selectedMatterId={selectedMatterId}
								matterDetail={currentMatter ? matterDetail : null}
								activeDialogs={activeDialogs}
								activeMatterProgress={activeMatterProgress}
								progressStartedAt={activeProgressStartedAt}
								streamingDelta={streamingDelta}
								submitting={submitting}
								templateByRoleId={templateByRoleId}
								memberName={memberName}
								onSelectOrganization={actions.handleSelectOrganization}
								onSelectWorkspace={actions.handleSelectWorkspace}
								matterAiMemberIds={matterAiMemberIds}
								matterConsultMemberIds={matterConsultMemberIds}
								observerMemberIds={
									matterDetail
										? (matterDetail.matter.observerMemberIds ?? [])
										: initiation.draftObserverMemberIds
								}
								observersEnabled={observersEnabled}
								onChangeLeadMember={actions.handleChangeLeadMember}
								onUpdateMatterAiMembers={actions.handleUpdateMatterAiMembers}
								onUpdateMatterConsultMembers={actions.handleUpdateMatterConsultMembers}
								onToggleObserversEnabled={actions.handleToggleObserversEnabled}
								onUpdateMatterObservers={actions.handleUpdateMatterObservers}
								onUpdateMatterCollaborators={actions.handleUpdateMatterCollaborators}
								onApproveAiRequest={(matterId, messageId) =>
									void actions.handleApproveAiRequest(matterId, messageId)
								}
								onDismissAiRequest={(matterId, messageId) =>
									void actions.handleDismissAiRequest(matterId, messageId)
								}
								onApplyRoleProposals={actions.handleApplyRoleProposals}
								onDismissRoleProposals={actions.handleDismissRoleProposals}
								onSendQuickPrompt={actions.handleSendQuickPrompt}
								onConsultArchitect={() => void actions.handleConsultArchitect()}
								onLaunchWithNewRoles={launchNewMatterWithMembers}
								modelControl={
									canDispatchAi && canManageMatter && (!selectedMatterId || currentMatter) ? (
										<MatterModelControl
											key={selectedMatterId ?? "new"}
											label={currentLeadId === ROLE_ARCHITECT_MEMBER_ID ? "架构师模型" : "主责模型"}
											value={
												selectedMatterId ? (currentMatter?.modelSelection ?? null) : draftModelSelection
											}
											roleModel={orgLeadModel}
											leadKnown={Boolean(currentLeadId)}
											disabled={submitting || Boolean(activeMatterProgress)}
											immediate={!selectedMatterId}
											onSave={async (selection) => {
												if (!selectedMatterId) {
													setDraftModelSelection(selection);
													return;
												}
												const { matter } = await updateMatterModelSelection(selectedMatterId, selection);
												setMatterDetail((detail) =>
													detail?.matter.id === matter.id ? { ...detail, matter } : detail,
												);
											}}
										/>
									) : null
								}
								onSendPrompt={() => void actions.handleSendPrompt()}
								onAbortMatter={actions.handleAbortMatter}
								onNewMatter={startNewMatterFromCurrent}
								onOpenDeliverables={(targetId) => navigateRoute({ tab: "deliverables", spacePageId: targetId })}
								onOpenTeam={() => navigateRoute({ tab: "team" })}
								onToggleArchiveMatter={handleSidebarToggleArchiveMatter}
								onRefresh={refreshBootstrap}
								onNotice={(msg) => setNoticeBanner(msg)}
							/>
						</ViewFade>
					)}

					{activeTab === "deliverables" && (
						<ViewFade>
							<DeliverablesView
								spaceRoute={spaceRoute}
								bootstrap={bootstrap}
								memberName={memberName}
								onOpenMatterChat={(matterId) => navigateRoute({ tab: "chats", matterId })}
							/>
						</ViewFade>
					)}

					{activeTab === "team" && (
						<ViewFade>
							<TeamView
								currentUser={currentUser}
								accountUser={accountUser}
								isSuperAdmin={isSuperAdmin}
								members={bootstrap?.members ?? []}
								workspaces={bootstrap?.workspaces ?? []}
								organizations={bootstrap?.organizations ?? []}
								orgAiRolesByOrgId={bootstrap?.orgAiRolesByOrgId ?? {}}
								matters={bootstrap?.matters ?? []}
								selectedOrgId={effectiveOrgIdForScope}
								defaultWorkspaceId={matterDetail?.matter.workspaceId ?? (selectedWorkspaceId || null)}
								templateByRoleId={templateByRoleId}
								memberName={memberName}
								organizationName={organizationName}
								onRefresh={refreshBootstrap}
								onNotice={(msg) => setNoticeBanner(msg)}
								onError={(msg) => setErrorBanner(msg)}
								onAssignTask={(memberId) => {
									startNewMatter();
									setSelectedMemberId(memberId);
									if (isArchitectMemberId(memberId, bootstrap?.members, templateByRoleId)) {
										setDraftAiMemberIds([memberId]);
										initiation.setDraftPresetMode("solo");
									}
								}}
								onOpenArchitect={() => initiation.openArchitectForGap()}
								onOpenArchitectMatter={() => startArchitectMatter()}
								onOpenOrganizations={() => navigateRoute({ tab: "organizations" })}
							/>
						</ViewFade>
					)}

					{activeTab === "organizations" && (
						<ViewFade>
							<OrganizationsView
								currentUser={currentUser}
								accountUser={accountUser}
								isSuperAdmin={isSuperAdmin}
								organizations={bootstrap?.organizations ?? []}
								workspaces={bootstrap?.workspaces ?? []}
								members={bootstrap?.members ?? []}
								templateByRoleId={templateByRoleId}
								orgMembersByOrgId={bootstrap?.orgMembersByOrgId ?? {}}
								orgAiRolesByOrgId={bootstrap?.orgAiRolesByOrgId ?? {}}
								selectedOrgId={effectiveOrgIdForScope}
								onOpenSpace={(spaceId) => navigateRoute({ tab: "deliverables", spacePageId: spaceId })}
								onOpenWorkspaces={() => navigateRoute({ tab: "materials" })}
								onRefresh={refreshBootstrap}
								onNotice={(msg) => setNoticeBanner(msg)}
								onError={(msg) => setErrorBanner(msg)}
							/>
						</ViewFade>
					)}

					{activeTab === "materials" && (
						<ViewFade>
							<MaterialsView
								workspaces={bootstrap?.workspaces ?? []}
								organizations={bootstrap?.organizations ?? []}
								orgMembersByOrgId={bootstrap?.orgMembersByOrgId ?? {}}
								matters={bootstrap?.matters ?? []}
								memberName={memberName}
								selectedWorkspaceId={selectedWorkspaceId}
								allowLocalWorkspacePath={bootstrap?.platformPolicy?.allowLocalWorkspacePath ?? true}
								isAccountMode={Boolean(accountUser)}
								onRefresh={refreshBootstrap}
								onNotice={(msg) => setNoticeBanner(msg)}
								onError={(msg) => setErrorBanner(msg)}
								onOpenMatter={(matterId) => navigateRoute({ tab: "chats", matterId })}
								onOpenSpace={(targetId) => navigateRoute({ tab: "deliverables", spacePageId: targetId })}
								onUseWorkspace={(workspaceId) => {
									setSelectedWorkspaceId(workspaceId);
									startNewMatter();
								}}
							/>
						</ViewFade>
					)}

					{activeTab === "settings" && (
						<ViewFade>
							<SettingsView
								{...settingsProps}
								currentUser={currentUser}
								isSuperAdmin={isSuperAdmin}
								activeSection={settingsSection}
								onSelectSection={(section) => navigateRoute({ tab: "settings", settingsSection: section })}
								onNotice={(msg) => setNoticeBanner(msg)}
								onError={(msg) => setErrorBanner(msg)}
								onOpenTeam={() => navigateRoute({ tab: "team" })}
							/>
						</ViewFade>
					)}

					{activeTab === "admin" && isSuperAdmin && (
						<ViewFade>
							<AdminView
								{...adminProps}
								currentUserId={accountUser?.id ?? null}
								onNotice={setNoticeBanner}
								onError={setErrorBanner}
							/>
						</ViewFade>
					)}

					{activeTab === "account" && (
						<ViewFade>
							<AccountView
								accountUser={accountUser}
								currentUser={currentUser}
								authKind={bootstrap?.authKind ?? authKind}
								requireAuth={serverRequireAuth}
								organizations={bootstrap?.organizations ?? []}
								workspaces={bootstrap?.workspaces ?? []}
								onSwitchOrLogout={handleSidebarSwitchOrLogout}
								onNotice={setNoticeBanner}
								onError={setErrorBanner}
							/>
						</ViewFade>
					)}
				</ErrorBoundary>
			</main>

			<RoleArchitectModal
				open={initiation.architectOpen}
				seedGap={initiation.architectSeed}
				members={bootstrap?.members ?? []}
				templateByRoleId={templateByRoleId}
				isSuperAdmin={isSuperAdmin}
				accountUser={accountUser}
				currentUser={currentUser}
				organizations={bootstrap?.organizations ?? []}
				defaultOrgId={effectiveOrgIdForScope}
				onClose={() => initiation.setArchitectOpen(false)}
				onOpenArchitectMatter={() => startArchitectMatter()}
				onCreated={async (member) => {
					await refreshBootstrap();
					if (activeTab === "chats" && !selectedMatterId) {
						setSelectedMemberId(member.id);
						setDraftAiMemberIds((prev) =>
							initiation.draftPresetMode === "solo"
								? [member.id]
								: prev
									? Array.from(new Set([member.id, ...prev]))
									: [member.id],
						);
						if (initiation.draftPresetMode === "human_first") {
							initiation.setDraftPresetMode("solo");
						}
					}
				}}
				onNotice={(msg) => setNoticeBanner(msg)}
				onError={(msg) => setErrorBanner(msg)}
			/>

			<OrgInviteModal
				{...auth.inviteDialogProps}
				authKind={bootstrap?.authKind ?? authKind}
				accountUser={accountUser}
				currentUser={currentUser}
			/>

			<ModalDialog
				open={Boolean(pendingArchiveConfirm)}
				title={pendingArchiveConfirm?.archived ? "确认归档事项" : "确认恢复事项"}
				subtitle={
					pendingArchiveConfirm?.archived
						? "归档不会删除历史对话或空间文档，仅将事项置为只读状态。"
						: "恢复后该事项将回到左侧最近事项列表，并可继续对话。"
				}
				size="sm"
				closeDisabled={archivingMatter}
				onClose={() => !archivingMatter && setPendingArchiveConfirm(null)}
				footer={
					<>
						<button
							type="button"
							className="btn-pill-outline"
							disabled={archivingMatter}
							onClick={() => setPendingArchiveConfirm(null)}
						>
							取消
						</button>
						<button
							type="button"
							className="btn-pill-dark"
							disabled={archivingMatter}
							onClick={() => void handleConfirmArchiveMatter()}
						>
							{archivingMatter ? "处理中…" : pendingArchiveConfirm?.archived ? "确认归档" : "确认恢复"}
						</button>
					</>
				}
			>
				{pendingArchiveConfirm && (
					<p className="muted-hint">
						{pendingArchiveConfirm.archived
							? `确定要归档「${pendingArchiveConfirm.title}」吗？归档后将不能继续发送消息，可随时恢复。`
							: `确定要恢复「${pendingArchiveConfirm.title}」为活跃事项吗？`}
					</p>
				)}
			</ModalDialog>
		</div>
	);
	return <ModelCatalogProvider>{workbench}</ModelCatalogProvider>;
}
