import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	type BootstrapPayload,
	type CollaboratorDto,
	type ComposerImageAttachment,
	type DeliverableDto,
	type FeedbackRating,
	fetchAuthSession,
	fetchBootstrap,
	fetchMatterDetail,
	type InnerMatterStep,
	loginWithInviteToken,
	logoutAuthSession,
	type MatterDetailPayload,
	type MatterProgressDto,
	openInnerMatterDemo,
	type PreviewServiceDto,
	type RoleTemplateDto,
	setAuthRevokedHandler,
	stopPreview,
	submitDeliverableFeedback,
	type TeamMemberDto,
} from "./api.ts";
import { AuthGateView } from "./components/AuthGateView.tsx";
import { ChatStage } from "./components/ChatStage.tsx";
import { DeliverablesView } from "./components/DeliverablesView.tsx";
import { MaterialsView } from "./components/MaterialsView.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { TeamView } from "./components/TeamView.tsx";
import { RoleArchitectModal } from "./components/team/RoleArchitectModal.tsx";
import { type NavTab, parseHashRoute } from "./hashRouter.ts";
import { useHashRouteNav } from "./hooks/useHashRouteNav.ts";
import { readStoredSetting, useMatterActions } from "./hooks/useMatterActions.ts";
import { useMatterEventSync } from "./hooks/useMatterEventSync.ts";
import { useMatterInitiationState } from "./hooks/useMatterInitiationState.ts";
import { useRsiDistill } from "./hooks/useRsiDistill.ts";
import { MAX_COMPOSER_IMAGES, prepareComposerImages } from "./imageAttachments.ts";
import { buildStarterTasks, getBotTheme } from "./utils.ts";

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

/** Root application shell coordinating authentication, SSE state sync, hash routing, and workspace tabs. */
export function App() {
	const initialInviteToken = useMemo(() => extractInitialInviteToken(), []);
	const initialRoute = useMemo(() => parseHashRoute(window.location.hash), []);
	const [authStatus, setAuthStatus] = useState<"checking" | "authenticated" | "unauthenticated">("checking");
	const [permissionRequired, setPermissionRequired] = useState(true);
	const [authTokenInput, setAuthTokenInput] = useState("");
	const [authError, setAuthError] = useState<string | null>(null);
	const [currentUserOverride, setCurrentUserOverride] = useState<CollaboratorDto | null>(null);
	const [composerMode, setComposerMode] = useState<"discussion" | "dispatch">("dispatch");
	const [activeTab, setActiveTab] = useState<NavTab>(initialRoute.tab);
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
	const [draftObserversEnabled, setDraftObserversEnabled] = useState<boolean>(
		() => readStoredSetting("pa.defaultObserversEnabled") === "true",
	);
	const [composerText, setComposerText] = useState("");
	const [composerImages, setComposerImages] = useState<ComposerImageAttachment[]>([]);
	const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
	composerImagesRef.current = composerImages;
	const [streamingDelta, setStreamingDelta] = useState("");
	const [sseConnected, setSseConnected] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [demoOpening, setDemoOpening] = useState(false);
	const [errorBanner, setErrorBanner] = useState<string | null>(null);
	const [noticeBanner, setNoticeBanner] = useState<string | null>(null);
	const [mobileNavOpen, setMobileNavOpen] = useState(false);
	const [progressByMatter, setProgressByMatter] = useState<Record<string, MatterProgressDto>>({});
	const [progressStartedAt, setProgressStartedAt] = useState<Record<string, number>>({});

	const composerRef = useRef<HTMLTextAreaElement | null>(null);
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
	});

	const refreshBootstrap = useCallback(async () => {
		const data = await fetchBootstrap();
		setBootstrap(data);
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
			if (savedOrg !== "__unset__") {
				return savedOrg && data.organizations.some((o) => o.id === savedOrg) ? savedOrg : "";
			}
			return (data.organizations.find((o) => o.isDefault) ?? data.organizations[0])?.id ?? "";
		});
		setSelectedDeliverableId((prev) => prev ?? data.deliverables[0]?.id ?? null);
	}, []);

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

	const applyRevokedSession = useCallback((message?: string) => {
		setCurrentUserOverride(null);
		setBootstrap(null);
		setMatterDetail(null);
		setProgressByMatter({});
		setSseConnected(false);
		setAuthError(message ?? "当前邀请口令已失效或已被重置，请向所有者获取新的邀请链接或口令");
		setAuthStatus("unauthenticated");
		void fetchAuthSession()
			.then((s) => setPermissionRequired(s.permissionRequired))
			.catch(() => {});
	}, []);

	useEffect(() => {
		setAuthRevokedHandler((message) => applyRevokedSession(message));
		return () => setAuthRevokedHandler(null);
	}, [applyRevokedSession]);

	useEffect(() => {
		let cancelled = false;
		const initSession = async () => {
			if (initialInviteToken) {
				try {
					const loginRes = await loginWithInviteToken(initialInviteToken);
					if (cancelled) return;
					setCurrentUserOverride(loginRes.currentUser);
					if (loginRes.currentUser.permissionRole === "collaborator") {
						setComposerMode("discussion");
					}
					const cleanHash = window.location.hash.includes("invite=") ? "#chats" : window.location.hash || "#chats";
					window.history.replaceState(null, "", `${window.location.pathname}${cleanHash}`);
					setAuthStatus("authenticated");
					await refreshBootstrap();
					return;
				} catch (err: unknown) {
					if (cancelled) return;
					setAuthError(err instanceof Error ? err.message : "邀请链接无效或已失效，请重新向所有者获取");
					setAuthStatus("unauthenticated");
					void fetchAuthSession()
						.then((s) => {
							if (!cancelled) setPermissionRequired(s.permissionRequired);
						})
						.catch(() => {});
					return;
				}
			}
			try {
				const session = await fetchAuthSession();
				if (cancelled) return;
				setPermissionRequired(session.permissionRequired);
				if (!session.authenticated) {
					if (session.revokedSession) {
						setAuthError("当前邀请口令已失效或已被重置，请向所有者获取新的邀请链接或口令");
					}
					setAuthStatus("unauthenticated");
					return;
				}
				setCurrentUserOverride(session.currentUser);
				if (session.currentUser?.permissionRole === "collaborator") {
					setComposerMode("discussion");
				}
				setAuthStatus("authenticated");
				await refreshBootstrap();
			} catch (err: unknown) {
				if (cancelled) return;
				setErrorBanner(err instanceof Error ? err.message : String(err));
			}
		};
		void initSession();
		return () => {
			cancelled = true;
		};
	}, [initialInviteToken, refreshBootstrap]);

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

	const headerContact: TeamMemberDto | null = useMemo(() => {
		if (!bootstrap) return null;
		if (selectedMatterId && matterDetail?.matter.leadMemberId) {
			return bootstrap.members.find((m) => m.id === matterDetail.matter.leadMemberId) ?? null;
		}
		if (selectedMemberId !== "auto") {
			return bootstrap.members.find((m) => m.id === selectedMemberId) ?? null;
		}
		return bootstrap.members.find((m) => m.isPrimaryContact) ?? bootstrap.members[0] ?? null;
	}, [bootstrap, matterDetail, selectedMatterId, selectedMemberId]);

	const memberThemeMap = useMemo(() => {
		const map = new Map<string, { bg: string; tilt: string }>();
		bootstrap?.members.forEach((member, index) => {
			map.set(member.id, getBotTheme(index));
		});
		return map;
	}, [bootstrap]);

	const activeDialogs = useMemo(() => {
		if (!bootstrap) return [];
		return selectedMatterId
			? bootstrap.pendingDialogs.filter((d) => d.matterId === selectedMatterId)
			: bootstrap.pendingDialogs;
	}, [bootstrap, selectedMatterId]);

	const templateByRoleId = useMemo(() => {
		const map = new Map<string, RoleTemplateDto>();
		for (const tpl of bootstrap?.templates ?? []) {
			map.set(tpl.id, tpl);
		}
		return map;
	}, [bootstrap]);

	const selectedWorkspace = useMemo(
		() => bootstrap?.workspaces.find((w) => w.id === selectedWorkspaceId) ?? null,
		[bootstrap, selectedWorkspaceId],
	);

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

	const starterTasks = useMemo(
		() => buildStarterTasks(bootstrap?.members, selectedWorkspace),
		[bootstrap, selectedWorkspace],
	);

	const initiation = useMatterInitiationState({
		selectedMatterId,
		composerText,
		composerImageCount: composerImages.length,
		selectedWorkspaceId,
		selectedMemberId,
		members: bootstrap?.members ?? [],
		setSelectedMemberId,
		setComposerMode,
		setDraftAiMemberIds,
		setDraftObserversEnabled,
	});

	const startNewMatter = () => {
		initiation.resetInitiationState();
		setSelectedMemberId("auto");
		navigateRoute({ tab: "chats", isNewMatter: true });
		composerRef.current?.focus();
	};

	const matterAiMemberIds: string[] = useMemo(() => {
		const allIds = (bootstrap?.members ?? []).map((m) => m.id);
		const validIds = new Set(allIds);
		const leadId = headerContact?.id;
		const raw =
			selectedMatterId && matterDetail
				? matterDetail.matter.aiMemberIds === null || matterDetail.matter.aiMemberIds === undefined
					? allIds
					: matterDetail.matter.aiMemberIds
				: draftAiMemberIds === null
					? allIds
					: draftAiMemberIds;
		const filtered = raw.filter((id) => validIds.has(id));
		if (leadId && validIds.has(leadId) && !filtered.includes(leadId)) {
			return [leadId, ...filtered];
		}
		return filtered.length > 0 ? filtered : allIds;
	}, [bootstrap, draftAiMemberIds, headerContact?.id, matterDetail, selectedMatterId]);

	const observersEnabled: boolean = useMemo(() => {
		if (selectedMatterId && matterDetail) {
			return Boolean(
				matterDetail.matter.observersEnabled ?? (matterDetail.matter.observerMemberIds?.length ?? 0) > 0,
			);
		}
		return draftObserversEnabled;
	}, [draftObserversEnabled, matterDetail, selectedMatterId]);

	const handleAddComposerImages = useCallback(async (files: FileList | File[]) => {
		const { attachments, warnings } = await prepareComposerImages(files, composerImagesRef.current.length);
		if (attachments.length > 0) {
			setComposerImages((prev) => [...prev, ...attachments].slice(0, MAX_COMPOSER_IMAGES));
		}
		if (warnings.length > 0) {
			setErrorBanner(warnings[0]!);
		}
	}, []);

	const handleRemoveComposerImage = useCallback((imageId: string) => {
		setComposerImages((prev) => prev.filter((item) => item.id !== imageId));
	}, []);

	const currentUser = bootstrap?.currentUser ?? currentUserOverride ?? null;
	const isOwner = currentUser?.permissionRole !== "collaborator";
	const handleOpenDemo = async () => {
		if (demoOpening) return;
		setDemoOpening(true);
		try {
			const { matter } = await openInnerMatterDemo();
			explicitNewMatterRef.current = false;
			navigateRoute({ tab: "chats", matterId: matter.id });
			setComposerText("");
			setComposerImages([]);
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

	const handleInviteLogin = async (tokenValue: string) => {
		const token = tokenValue.trim();
		if (!token) return;
		setAuthError(null);
		try {
			const res = await loginWithInviteToken(token);
			setCurrentUserOverride(res.currentUser);
			setComposerMode(res.currentUser.permissionRole === "collaborator" ? "discussion" : "dispatch");
			setAuthTokenInput("");
			setAuthStatus("authenticated");
			await refreshBootstrap();
		} catch (err: unknown) {
			setAuthError(err instanceof Error ? err.message : "邀请口令无效");
		}
	};

	const handleLogoutOrRestore = async () => {
		try {
			await logoutAuthSession();
			const session = await fetchAuthSession();
			if (session.authenticated && session.currentUser) {
				setCurrentUserOverride(session.currentUser);
				setComposerMode(session.currentUser.permissionRole === "collaborator" ? "discussion" : "dispatch");
				await refreshBootstrap();
				setNoticeBanner(`已切换回「${session.currentUser.name}」身份`);
			} else {
				setCurrentUserOverride(null);
				setBootstrap(null);
				setAuthStatus("unauthenticated");
			}
		} catch (err: unknown) {
			setErrorBanner(err instanceof Error ? err.message : String(err));
		}
	};

	const actions = useMatterActions({
		bootstrap,
		isOwner,
		composerMode,
		composerText,
		composerImages,
		submitting,
		selectedMatterId,
		selectedMemberId,
		selectedWorkspaceId,
		selectedWorkspace,
		selectedOrgId,
		draftAiMemberIds,
		draftObserverMemberIds: initiation.draftObserverMemberIds,
		draftCollaboratorIds: initiation.draftCollaboratorIds,
		draftObserversEnabled,
		headerContact,
		explicitNewMatterRef,
		memberName,
		workspaceName,
		organizationName,
		setSubmitting,
		setComposerText,
		setComposerImages,
		setSelectedMemberId,
		setSelectedWorkspaceId,
		setSelectedOrgId,
		setDraftAiMemberIds,
		setDraftObserverMemberIds: initiation.setDraftObserverMemberIds,
		setDraftObserversEnabled,
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

	if (authStatus === "checking" || authStatus === "unauthenticated") {
		return (
			<AuthGateView
				status={authStatus}
				permissionRequired={permissionRequired}
				authError={authError}
				authTokenInput={authTokenInput}
				onTokenInputChange={setAuthTokenInput}
				onSubmitInvite={(token) => void handleInviteLogin(token)}
				onRestoreOwner={() => void handleLogoutOrRestore()}
			/>
		);
	}

	const mobileViewTitle =
		activeTab === "deliverables"
			? "交付成果库"
			: activeTab === "team"
				? "我的团队"
				: activeTab === "materials"
					? "项目仓库与资料"
					: matterDetail?.matter.title || "新事项对话";
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
					if (activeTab !== "chats" || selectedMatterId !== null) {
						setDraftAiMemberIds(null);
						setSelectedMemberId(memberId);
						navigateRoute({ tab: "chats", isNewMatter: true });
					} else {
						setSelectedMemberId((prev) => (prev === memberId ? "auto" : memberId));
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
						collaborators={bootstrap?.collaborators ?? []}
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
						errorBanner={errorBanner}
						noticeBanner={noticeBanner}
						starterTasks={starterTasks}
						templateByRoleId={templateByRoleId}
						memoriesByMember={bootstrap?.memoriesByMember ?? {}}
						memberName={memberName}
						workspaceName={workspaceName}
						organizationName={organizationName}
						previewUrlFor={previewUrlFor}
						onComposerTextChange={setComposerText}
						onAddImages={(files) => void handleAddComposerImages(files)}
						onRemoveImage={handleRemoveComposerImage}
						onSelectOrganization={actions.handleSelectOrganization}
						onSelectWorkspace={actions.handleSelectWorkspace}
						matterAiMemberIds={matterAiMemberIds}
						observerMemberIds={
							matterDetail ? (matterDetail.matter.observerMemberIds ?? []) : initiation.draftObserverMemberIds
						}
						observersEnabled={observersEnabled}
						draftPresetMode={initiation.draftPresetMode}
						draftAiMemberIds={draftAiMemberIds}
						draftCollaboratorIds={initiation.draftCollaboratorIds}
						initiationAssessment={initiation.assessment}
						initiationAssessing={initiation.assessing}
						onChangeLeadMember={actions.handleChangeLeadMember}
						onUpdateMatterAiMembers={actions.handleUpdateMatterAiMembers}
						onUpdateDraftAiMemberIds={setDraftAiMemberIds}
						onUpdateDraftCollaboratorIds={initiation.setDraftCollaboratorIds}
						onApplyPresetMode={(mode, leadId) =>
							initiation.applyPresetMode(mode, leadId ? { leadId } : undefined)
						}
						onApplyInitiationRecommendation={initiation.applyAssessmentRecommendation}
						onOpenArchitect={initiation.openArchitectForGap}
						onToggleObserversEnabled={actions.handleToggleObserversEnabled}
						onUpdateMatterObservers={actions.handleUpdateMatterObservers}
						onUpdateMatterCollaborators={actions.handleUpdateMatterCollaborators}
						onApproveAiRequest={(matterId, messageId) => void actions.handleApproveAiRequest(matterId, messageId)}
						onDismissAiRequest={(matterId, messageId) => void actions.handleDismissAiRequest(matterId, messageId)}
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
						onDismissError={() => setErrorBanner(null)}
						onDismissNotice={() => setNoticeBanner(null)}
					/>
				)}

				{activeTab === "deliverables" && (
					<DeliverablesView
						bootstrap={bootstrap}
						currentUser={currentUser}
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
						collaborators={bootstrap?.collaborators ?? []}
						members={bootstrap?.members ?? []}
						workspaces={bootstrap?.workspaces ?? []}
						organizations={bootstrap?.organizations ?? []}
						matters={bootstrap?.matters ?? []}
						defaultWorkspaceId={matterDetail?.matter.workspaceId ?? (selectedWorkspaceId || null)}
						memoriesByMember={bootstrap?.memoriesByMember ?? {}}
						templateByRoleId={templateByRoleId}
						memberName={memberName}
						workspaceName={workspaceName}
						organizationName={organizationName}
						onRefresh={refreshBootstrap}
						onNotice={(msg) => setNoticeBanner(msg)}
						onError={(msg) => setErrorBanner(msg)}
						onPreviewAsCollaborator={(token) => void handleInviteLogin(token)}
						onRestoreOwner={() => void handleLogoutOrRestore()}
						onAssignTask={(memberId) => {
							setSelectedMemberId(memberId);
							startNewMatter();
						}}
						onOpenArchitect={() => initiation.openArchitectForGap()}
						onOpenMatter={(matterId) => navigateRoute({ tab: "chats", matterId })}
						onOpenDeliverable={(deliverableId) => navigateRoute({ tab: "deliverables", deliverableId })}
					/>
				)}

				{activeTab === "materials" && (
					<MaterialsView
						workspaces={bootstrap?.workspaces ?? []}
						organizations={bootstrap?.organizations ?? []}
						selectedWorkspaceId={selectedWorkspaceId}
						onRefresh={refreshBootstrap}
						onNotice={(msg) => setNoticeBanner(msg)}
						onError={(msg) => setErrorBanner(msg)}
						onUseWorkspace={(workspaceId) => {
							setSelectedWorkspaceId(workspaceId);
							startNewMatter();
						}}
					/>
				)}
			</main>

			<RoleArchitectModal
				open={initiation.architectOpen}
				seedGap={initiation.architectSeed}
				onClose={() => initiation.setArchitectOpen(false)}
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
		</div>
	);
}
