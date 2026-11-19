import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	type BootstrapPayload,
	type DeliverableDto,
	type FeedbackRating,
	fetchBootstrap,
	fetchMatterDetail,
	type InnerMatterStep,
	type MatterDetailPayload,
	type MatterProgressDto,
	type MatterVisibility,
	openInnerMatterDemo,
	type PreviewServiceDto,
	stopPreview,
	submitDeliverableFeedback,
} from "./api.ts";
import { filterBusinessMembers, isArchitectMemberId, ROLE_ARCHITECT_MEMBER_ID } from "./architectApi.ts";
import { AdminView } from "./components/AdminView.tsx";
import { AuthGateView } from "./components/AuthGateView.tsx";
import { ChatStage } from "./components/ChatStage.tsx";
import { DeliverablesView } from "./components/DeliverablesView.tsx";
import { MaterialsView } from "./components/MaterialsView.tsx";
import { OrgInviteModal } from "./components/OrgInviteModal.tsx";
import { SettingsView } from "./components/SettingsView.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { TeamView } from "./components/TeamView.tsx";
import { RoleArchitectModal } from "./components/team/RoleArchitectModal.tsx";
import { WorkbenchBanners } from "./components/WorkbenchBanners.tsx";
import { type NavTab, parseHashRoute, type SettingsSection } from "./hashRouter.ts";
import { useAuthSession } from "./hooks/useAuthSession.ts";
import { useComposerDraft } from "./hooks/useComposerDraft.ts";
import { useHashRouteNav } from "./hooks/useHashRouteNav.ts";
import { readStoredSetting, useMatterActions } from "./hooks/useMatterActions.ts";
import { useMatterEventSync } from "./hooks/useMatterEventSync.ts";
import { useMatterInitiationState } from "./hooks/useMatterInitiationState.ts";
import { useMatterScope } from "./hooks/useMatterScope.ts";
import { useRsiDistill } from "./hooks/useRsiDistill.ts";
import { useWorkbenchPanels } from "./hooks/useWorkbenchPanels.ts";
import { getBotTheme } from "./utils.ts";

function syncEditionDocumentTitle(requireAuth: boolean | undefined): void {
	if (typeof requireAuth !== "boolean") return;
	document.title = requireAuth ? "Personal Agent · 团队版" : "Personal Agent · 个人版";
}

/** Root application shell coordinating authentication, SSE state sync, hash routing, and workspace tabs. */
export function App() {
	const initialRoute = useMemo(() => parseHashRoute(window.location.hash), []);
	const [serverRequireAuth, setServerRequireAuth] = useState<boolean | null>(null);
	const [composerMode, setComposerMode] = useState<"discussion" | "dispatch">("dispatch");
	const [draftMatterVisibility, setDraftMatterVisibility] = useState<MatterVisibility>("org");
	const [activeTab, setActiveTab] = useState<NavTab>(initialRoute.tab);
	const [settingsSection, setSettingsSection] = useState<SettingsSection>(initialRoute.settingsSection ?? "all");
	const [searchQuery, setSearchQuery] = useState("");
	const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
	const [selectedMatterId, setSelectedMatterId] = useState<string | null>(
		initialRoute.isNewMatter ? null : (initialRoute.matterId ?? null),
	);
	const [matterDetail, setMatterDetail] = useState<MatterDetailPayload | null>(null);
	const [selectedDeliverableId, setSelectedDeliverableId] = useState<string | null>(
		initialRoute.deliverableId ?? null,
	);
	const [selectedMemberId, setSelectedMemberId] = useState<string>("auto");
	const [selectedOrgId, setSelectedOrgId] = useState<string>(() => readStoredSetting("pa.defaultOrgId"));
	const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>(() =>
		readStoredSetting("pa.defaultWorkspaceId"),
	);
	const [draftAiMemberIds, setDraftAiMemberIds] = useState<string[] | null>(null);
	const [draftObserversEnabled, setDraftObserversEnabled] = useState<boolean>(false);
	const [streamingDelta, setStreamingDelta] = useState("");
	const [sseConnected, setSseConnected] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [demoOpening, setDemoOpening] = useState(false);
	const [errorBanner, setErrorBanner] = useState<string | null>(null);
	const [noticeBanner, setNoticeBanner] = useState<string | null>(null);
	const dismissError = useCallback(() => setErrorBanner(null), []);
	const dismissNotice = useCallback(() => setNoticeBanner(null), []);
	const [mobileNavOpen, setMobileNavOpen] = useState(false);
	const [progressByMatter, setProgressByMatter] = useState<Record<string, MatterProgressDto>>({});
	const [progressStartedAt, setProgressStartedAt] = useState<Record<string, number>>({});

	const composerRef = useRef<HTMLTextAreaElement | null>(null);
	const {
		composerText,
		setComposerText,
		composerImages,
		setComposerImages,
		composerFiles,
		setComposerFiles,
		composerAttachmentText,
		handleAddComposerAttachments,
		handleAddPastedText,
		handleRemoveComposerImage,
		handleRemoveComposerFile,
		handleExpandPastedFile,
	} = useComposerDraft(composerRef, setErrorBanner);
	const explicitNewMatterRef = useRef(Boolean(initialRoute.isNewMatter));
	const activeTabRef = useRef<NavTab>(activeTab);
	activeTabRef.current = activeTab;
	const selectedMatterIdRef = useRef<string | null>(selectedMatterId);
	selectedMatterIdRef.current = selectedMatterId;

	const navigateRoute = useHashRouteNav({
		initialRoute,
		explicitNewMatterRef,
		setActiveTab,
		setSelectedDeliverableId,
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
		const data = await fetchBootstrap();
		setBootstrap(data);
		applyEditionState(data.platformPolicy?.requireAuth);
		if (data.activeRuns) {
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
		setSelectedDeliverableId((prev) => prev ?? data.deliverables[0]?.id ?? null);
	}, [applyEditionState]);

	const refreshDetail = useCallback(async (matterId: string | null) => {
		if (!matterId) {
			setMatterDetail(null);
			return;
		}
		const detail = await fetchMatterDetail(matterId);
		setMatterDetail(detail);
		setSelectedWorkspaceId(detail.matter.workspaceId ?? "");
		setSelectedOrgId(detail.matter.orgId ?? "");
		if (detail.activeRun) {
			const snapshot = detail.activeRun;
			setProgressByMatter((prev) => ({ ...prev, [matterId]: snapshot }));
			setProgressStartedAt((prev) => ({ ...prev, [matterId]: snapshot.startedAt }));
			if (snapshot.streamingDelta !== undefined) {
				setStreamingDelta(snapshot.streamingDelta);
			}
		}
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
		setComposerMode,
		setErrorBanner,
		setNoticeBanner,
		onRevoked: resetRevokedWorkspace,
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

	const nowMs = useMatterEventSync({
		authStatus,
		activeTabRef,
		selectedMatterIdRef,
		progressByMatter,
		setProgressByMatter,
		setProgressStartedAt,
		setStreamingDelta,
		setSseConnected,
		setSelectedDeliverableId,
		setPermissionRequired,
		setNoticeBanner,
		setErrorBanner,
		refreshBootstrap,
		refreshDetail,
		applyRevokedSession,
	});

	const activeDeliverable: DeliverableDto | null = useMemo(() => {
		if (!bootstrap || bootstrap.deliverables.length === 0) return null;
		return bootstrap.deliverables.find((d) => d.id === selectedDeliverableId) ?? bootstrap.deliverables[0] ?? null;
	}, [bootstrap, selectedDeliverableId]);

	const activeChatDeliverable: DeliverableDto | null = useMemo(() => {
		if (!matterDetail || matterDetail.deliverables.length === 0) return null;
		return (
			matterDetail.deliverables.find((d) => d.id === selectedDeliverableId) ??
			matterDetail.deliverables[matterDetail.deliverables.length - 1] ??
			null
		);
	}, [matterDetail, selectedDeliverableId]);

	const siblingVersionsFor = useCallback(
		(deliv: DeliverableDto | null) => {
			if (!bootstrap || !deliv) return [];
			return bootstrap.deliverables
				.filter((d) => d.matterId === deliv.matterId && d.title === deliv.title)
				.sort((a, b) => a.version - b.version);
		},
		[bootstrap],
	);

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

	const filteredDeliverables = useMemo(() => {
		const list = bootstrap?.deliverables ?? [];
		const q = searchQuery.trim().toLowerCase();
		if (!q) return list;
		return list.filter((d) => d.title.toLowerCase().includes(q) || d.summary.toLowerCase().includes(q));
	}, [bootstrap, searchQuery]);

	const memberName = (id: string) => bootstrap?.members.find((m) => m.id === id)?.displayName ?? id;
	const workspaceName = (id: string | null) =>
		id ? (bootstrap?.workspaces.find((w) => w.id === id)?.name ?? id) : null;
	const organizationName = (id: string | null) =>
		id ? (bootstrap?.organizations.find((o) => o.id === id)?.name ?? id) : null;

	const previewUrlFor = useCallback(
		(deliv: DeliverableDto | null): string | null => {
			if (!deliv) return null;
			const linked: PreviewServiceDto | undefined = bootstrap?.previews.find((p) => p.deliverableId === deliv.id);
			return deliv.serviceUrl ?? linked?.url ?? null;
		},
		[bootstrap],
	);

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
		setSelectedMemberId,
		setComposerMode,
		setDraftAiMemberIds,
		setDraftObserversEnabled,
	});

	const startNewMatter = () => {
		initiation.resetInitiationState();
		setDraftMatterVisibility("org");
		setSelectedMemberId("auto");
		navigateRoute({ tab: "chats", isNewMatter: true });
		composerRef.current?.focus();
	};

	const startArchitectMatter = (seedText?: string) => {
		initiation.resetInitiationState();
		setSelectedMemberId(ROLE_ARCHITECT_MEMBER_ID);
		setDraftAiMemberIds([ROLE_ARCHITECT_MEMBER_ID]);
		initiation.setDraftPresetMode("solo");
		setDraftObserversEnabled(false);
		if (seedText !== undefined) {
			setComposerText(seedText);
		}
		navigateRoute({ tab: "chats", isNewMatter: true });
		composerRef.current?.focus();
	};

	const launchNewMatterWithMembers = (memberIds: string[]) => {
		if (memberIds.length === 0) return;
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

	const discussionAiEnabled: boolean = useMemo(() => {
		if (selectedMatterId && matterDetail) {
			return matterDetail.matter.discussionAiEnabled ?? false;
		}
		return initiation.draftDiscussionAiEnabled;
	}, [initiation.draftDiscussionAiEnabled, matterDetail, selectedMatterId]);

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
	const handleOpenDemo = async () => {
		if (demoOpening) return;
		setDemoOpening(true);
		try {
			const { matter } = await openInnerMatterDemo();
			explicitNewMatterRef.current = false;
			navigateRoute({ tab: "chats", matterId: matter.id });
			setComposerText("");
			setComposerImages([]);
			setComposerFiles([]);
			setComposerMode("dispatch");
			await refreshBootstrap();
			await refreshDetail(matter.id);
		} catch (error) {
			setErrorBanner(error instanceof Error ? error.message : String(error));
		} finally {
			setDemoOpening(false);
		}
	};
	const handleDemoStep = async (step: InnerMatterStep) => {
		if (!matterDetail?.demoGuide || submitting || !isOwner) return;
		const targetMatterId = matterDetail.matter.id;
		setSubmitting(true);
		try {
			let prompt = step.prompt;
			if (step.id === "revise") {
				const v1 = matterDetail.deliverables.find(
					(item) => item.title === matterDetail.demoGuide?.deliverableTitle && item.version === 1,
				);
				if (!v1) throw new Error("请先完成 V1 阶段交付");
				const feedback = v1.feedback?.trim() || step.feedback;
				if (!v1.feedback?.trim()) await submitDeliverableFeedback(v1.id, { feedback });
				prompt += `\n\n本次反馈：\n${feedback}`;
				await refreshDetail(matterDetail.matter.id);
				await refreshBootstrap();
			}
			if (selectedMatterIdRef.current !== targetMatterId) return;
			setComposerImages([]);
			setComposerFiles([]);
			setComposerMode("dispatch");
			setComposerText(prompt);
			setNoticeBanner(
				step.id === "revise" ? "V1 反馈已保留，修订要求已填入；发送后开始执行" : "提问已填入，可修改后发送给团队",
			);
			composerRef.current?.focus();
		} catch (error) {
			setErrorBanner(error instanceof Error ? error.message : String(error));
		} finally {
			setSubmitting(false);
		}
	};

	const actions = useMatterActions({
		bootstrap,
		isOwner,
		composerMode,
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
		draftDiscussionAiEnabled: initiation.draftDiscussionAiEnabled,
		draftCollaboratorIds: initiation.draftCollaboratorIds,
		draftVisibility: draftMatterVisibility,
		draftObserversEnabled,
		headerContact,
		explicitNewMatterRef,
		memberName,
		workspaceName,
		organizationName,
		setSubmitting,
		setComposerText,
		setComposerImages,
		setComposerFiles,
		setSelectedMemberId,
		setSelectedWorkspaceId,
		setSelectedOrgId,
		setDraftAiMemberIds,
		setDraftConsultMemberIds: initiation.setDraftConsultMemberIds,
		setDraftObserverMemberIds: initiation.setDraftObserverMemberIds,
		setDraftDiscussionAiEnabled: initiation.setDraftDiscussionAiEnabled,
		setDraftObserversEnabled,
		onSyncDraftPresetForObservers: (hasObservers: boolean) => {
			initiation.setDraftPresetMode((prev) =>
				hasObservers ? "lead_review" : prev === "lead_review" ? "lead_consult" : prev,
			);
		},
		onResetInitiation: initiation.resetInitiationState,
		setErrorBanner,
		setNoticeBanner,
		navigateRoute,
		refreshBootstrap,
		refreshDetail,
	});

	const { cancelRsiDistill, runRsiDistill } = useRsiDistill({
		selectedMatterId,
		memberName,
		refreshBootstrap,
		refreshDetail,
		setNoticeBanner,
		setErrorBanner,
	});

	const handleDistillExperiences = (deliv: DeliverableDto, feedback?: string, rating?: FeedbackRating) =>
		runRsiDistill({
			matterId: deliv.matterId,
			deliverableId: deliv.id,
			feedback,
			rating,
		});

	const activeMatterProgress = selectedMatterId ? (progressByMatter[selectedMatterId] ?? null) : null;
	const headerTheme = headerContact ? (memberThemeMap.get(headerContact.id) ?? getBotTheme(0)) : getBotTheme(0);
	const elapsedSeconds = selectedMatterId
		? Math.max(0, Math.floor((nowMs - (progressStartedAt[selectedMatterId] ?? nowMs)) / 1000))
		: 0;

	if (authStatus !== "authenticated") {
		return <AuthGateView status={authStatus} {...auth.gateProps} />;
	}

	const mobileViewTitle =
		activeTab === "deliverables"
			? "交付成果库"
			: activeTab === "team"
				? "我的团队"
				: activeTab === "materials"
					? "项目仓库与资料"
					: activeTab === "admin"
						? "超级管理员控制台"
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

	return (
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
				selectedDeliverableId={selectedDeliverableId}
				progressByMatter={progressByMatter}
				sseConnected={sseConnected}
				searchQuery={searchQuery}
				mobileOpen={mobileNavOpen}
				onCloseMobile={() => setMobileNavOpen(false)}
				onSearchQueryChange={setSearchQuery}
				onNavigate={(route) => {
					setMobileNavOpen(false);
					navigateRoute(route);
				}}
				onToggleMember={(memberId) => {
					setMobileNavOpen(false);
					const nextSelected =
						activeTab === "chats" && selectedMatterId === null && selectedMemberId === memberId
							? "auto"
							: memberId;
					const pickingArchitect = isArchitectMemberId(nextSelected, bootstrap?.members, templateByRoleId);
					if (activeTab !== "chats" || selectedMatterId !== null) {
						navigateRoute({ tab: "chats", isNewMatter: true });
					}
					setSelectedMemberId(nextSelected);
					if (pickingArchitect) {
						setDraftAiMemberIds([nextSelected]);
						initiation.setDraftPresetMode("solo");
						setDraftObserversEnabled(false);
					} else {
						setDraftAiMemberIds(null);
					}
					composerRef.current?.focus();
				}}
				onNewMatter={() => {
					setMobileNavOpen(false);
					startNewMatter();
				}}
				onSwitchOrLogout={() => {
					setMobileNavOpen(false);
					void handleLogoutOrRestore();
				}}
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
				{activeTab === "chats" && (
					<ChatStage
						onOpenDemo={bootstrap?.innerDemoAvailable && isOwner ? () => void handleOpenDemo() : undefined}
						demoOpening={demoOpening}
						onDemoStep={(step) => void handleDemoStep(step)}
						demoStepBusy={submitting}
						composerRef={composerRef}
						currentUser={currentUser}
						accountUser={accountUser}
						isSuperAdmin={isSuperAdmin}
						canDispatchAi={canDispatchAi}
						canManageMatter={canManageMatter}
						collaborators={bootstrap?.collaborators ?? []}
						orgMembersByOrgId={bootstrap?.orgMembersByOrgId ?? {}}
						orgEffectiveMemberIds={orgEffectiveMemberIds}
						composerMode={composerMode}
						onComposerModeChange={setComposerMode}
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
						matterDetail={matterDetail}
						activeDialogs={activeDialogs}
						activeChatDeliverable={activeChatDeliverable}
						deliverablesCount={bootstrap?.deliverables.length ?? 0}
						selectedDeliverableId={selectedDeliverableId}
						activeMatterProgress={activeMatterProgress}
						elapsedSeconds={elapsedSeconds}
						streamingDelta={streamingDelta}
						submitting={submitting}
						composerText={composerText}
						pendingImages={composerImages}
						pendingFiles={composerFiles}
						templateByRoleId={templateByRoleId}
						memoriesByMember={bootstrap?.memoriesByMember ?? {}}
						memberName={memberName}
						workspaceName={workspaceName}
						organizationName={organizationName}
						previewUrlFor={previewUrlFor}
						onComposerTextChange={setComposerText}
						onAddAttachments={(files) => void handleAddComposerAttachments(files)}
						onAddPastedText={handleAddPastedText}
						onRemoveImage={handleRemoveComposerImage}
						onRemoveFile={handleRemoveComposerFile}
						onExpandPastedFile={handleExpandPastedFile}
						onSelectOrganization={actions.handleSelectOrganization}
						onSelectWorkspace={actions.handleSelectWorkspace}
						matterAiMemberIds={matterAiMemberIds}
						matterConsultMemberIds={matterConsultMemberIds}
						observerMemberIds={
							matterDetail ? (matterDetail.matter.observerMemberIds ?? []) : initiation.draftObserverMemberIds
						}
						observersEnabled={observersEnabled}
						discussionAiEnabled={discussionAiEnabled}
						draftAiMemberIds={draftAiMemberIds}
						draftConsultMemberIds={initiation.draftConsultMemberIds}
						draftCollaboratorIds={initiation.draftCollaboratorIds}
						draftVisibility={draftMatterVisibility}
						initiationAssessment={initiation.assessment}
						initiationAssessing={initiation.assessing}
						initiationAssessmentError={initiation.assessmentError}
						initiationModelAssessing={initiation.modelAssessing}
						initiationModelAssessmentError={initiation.modelAssessmentError}
						onChangeLeadMember={actions.handleChangeLeadMember}
						onUpdateMatterAiMembers={actions.handleUpdateMatterAiMembers}
						onUpdateMatterConsultMembers={actions.handleUpdateMatterConsultMembers}
						onToggleDiscussionAiEnabled={actions.handleToggleDiscussionAiEnabled}
						onUpdateDraftAiMemberIds={setDraftAiMemberIds}
						onUpdateDraftCollaboratorIds={initiation.setDraftCollaboratorIds}
						onUpdateDraftVisibility={setDraftMatterVisibility}
						onSetScopeMode={initiation.setScopeMode}
						onToggleObserverPreset={initiation.toggleObserverPreset}
						onToggleDraftMemberConsult={initiation.toggleDraftMemberConsult}
						onToggleDraftMemberObserver={initiation.toggleDraftMemberObserver}
						onApplyPresetMode={(mode, leadId) =>
							initiation.applyPresetMode(mode, leadId ? { leadId } : undefined)
						}
						onApplyInitiationRecommendation={initiation.applyAssessmentRecommendation}
						onRequestModelAssessment={(opts) => void initiation.requestModelAssessment(opts)}
						onCancelModelAssessment={initiation.cancelModelAssessment}
						onOpenArchitect={initiation.openArchitectForGap}
						onToggleObserversEnabled={actions.handleToggleObserversEnabled}
						onUpdateMatterObservers={actions.handleUpdateMatterObservers}
						onUpdateMatterCollaborators={actions.handleUpdateMatterCollaborators}
						onApproveAiRequest={(matterId, messageId) => void actions.handleApproveAiRequest(matterId, messageId)}
						onDismissAiRequest={(matterId, messageId) => void actions.handleDismissAiRequest(matterId, messageId)}
						onApplyRoleProposals={actions.handleApplyRoleProposals}
						onDismissRoleProposals={actions.handleDismissRoleProposals}
						onSendQuickPrompt={(prompt, opts) => void actions.handleSendQuickPrompt(prompt, opts)}
						onConsultArchitect={() => void actions.handleConsultArchitect()}
						onStartArchitectMatter={startArchitectMatter}
						onLaunchWithNewRoles={launchNewMatterWithMembers}
						onSendPrompt={() => void actions.handleSendPrompt()}
						onAbortMatter={actions.handleAbortMatter}
						onNewMatter={startNewMatter}
						onOpenDeliverables={(deliverableId) => navigateRoute({ tab: "deliverables", deliverableId })}
						onOpenTeam={() => navigateRoute({ tab: "team" })}
						onDistillMatter={(matterId) => runRsiDistill({ matterId })}
						onCancelDistillMatter={cancelRsiDistill}
						onRefresh={refreshBootstrap}
						onNotice={(msg) => setNoticeBanner(msg)}
						onError={(msg) => setErrorBanner(msg)}
					/>
				)}

				{activeTab === "deliverables" && (
					<DeliverablesView
						bootstrap={bootstrap}
						currentUser={currentUser}
						accountUser={accountUser}
						isSuperAdmin={isSuperAdmin}
						activeDeliverable={activeDeliverable}
						filteredDeliverables={filteredDeliverables}
						siblingVersions={siblingVersionsFor(activeDeliverable)}
						previewUrlFor={previewUrlFor}
						memberName={memberName}
						workspaceName={workspaceName}
						organizationName={organizationName}
						onSubmitFeedback={actions.handleDeliverableFeedback}
						onDistillExperiences={handleDistillExperiences}
						onCancelDistill={cancelRsiDistill}
						onStopPreview={async (previewId) => {
							await stopPreview(previewId);
							await refreshBootstrap();
						}}
						onSelectDeliverable={(deliverableId, matterId) => {
							navigateRoute({ tab: "deliverables", deliverableId });
							if (matterId) setSelectedMatterId(matterId);
						}}
						onRequestRevision={(deliverable) => {
							navigateRoute({ tab: "chats", matterId: deliverable.matterId });
							setComposerText(`修改「${deliverable.title}」：`);
						}}
						onOpenMatterChat={(matterId) => navigateRoute({ tab: "chats", matterId })}
						onOpenTeam={() => navigateRoute({ tab: "team" })}
						onRefresh={refreshBootstrap}
						onNotice={(msg) => setNoticeBanner(msg)}
						onError={(msg) => setErrorBanner(msg)}
						onNewTask={startNewMatter}
					/>
				)}

				{activeTab === "team" && (
					<TeamView
						currentUser={currentUser}
						accountUser={accountUser}
						isSuperAdmin={isSuperAdmin}
						collaborators={bootstrap?.collaborators ?? []}
						members={bootstrap?.members ?? []}
						workspaces={bootstrap?.workspaces ?? []}
						organizations={bootstrap?.organizations ?? []}
						orgMembersByOrgId={bootstrap?.orgMembersByOrgId ?? {}}
						orgAiRolesByOrgId={bootstrap?.orgAiRolesByOrgId ?? {}}
						matters={bootstrap?.matters ?? []}
						selectedOrgId={effectiveOrgIdForScope}
						defaultWorkspaceId={matterDetail?.matter.workspaceId ?? (selectedWorkspaceId || null)}
						memoriesByMember={bootstrap?.memoriesByMember ?? {}}
						templateByRoleId={templateByRoleId}
						memberName={memberName}
						workspaceName={workspaceName}
						organizationName={organizationName}
						onRefresh={refreshBootstrap}
						onNotice={(msg) => setNoticeBanner(msg)}
						onError={(msg) => setErrorBanner(msg)}
						onPreviewAsCollaborator={(token) => void auth.handleInviteLogin(token)}
						onRestoreOwner={() => void handleLogoutOrRestore()}
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
						onOpenMatter={(matterId) => navigateRoute({ tab: "chats", matterId })}
						onOpenDeliverable={(deliverableId) => navigateRoute({ tab: "deliverables", deliverableId })}
					/>
				)}

				{activeTab === "materials" && (
					<MaterialsView
						workspaces={bootstrap?.workspaces ?? []}
						organizations={bootstrap?.organizations ?? []}
						orgMembersByOrgId={bootstrap?.orgMembersByOrgId ?? {}}
						selectedWorkspaceId={selectedWorkspaceId}
						allowLocalWorkspacePath={bootstrap?.platformPolicy?.allowLocalWorkspacePath ?? true}
						isAccountMode={Boolean(accountUser)}
						onRefresh={refreshBootstrap}
						onNotice={(msg) => setNoticeBanner(msg)}
						onError={(msg) => setErrorBanner(msg)}
						onUseWorkspace={(workspaceId) => {
							setSelectedWorkspaceId(workspaceId);
							startNewMatter();
						}}
					/>
				)}

				{activeTab === "settings" && (
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
				)}

				{activeTab === "admin" && isSuperAdmin && (
					<AdminView {...adminProps} currentUserId={accountUser?.id ?? null} />
				)}
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
							setComposerMode("dispatch");
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
		</div>
	);
}
