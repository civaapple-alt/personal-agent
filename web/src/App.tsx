import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	type AccountUserDto,
	type AdminOverviewPayload,
	abortAdminMatter,
	type BootstrapPayload,
	type CollaboratorDto,
	type ComposerFileAttachment,
	type ComposerImageAttachment,
	type DeliverableDto,
	type FeedbackRating,
	fetchAdminOverview,
	fetchAuthSession,
	fetchBootstrap,
	fetchMatterDetail,
	fetchRuntimeOverview,
	type InnerMatterStep,
	joinOrganizationByInvite,
	loginWithEmail,
	loginWithInviteToken,
	logoutAuthSession,
	type MatterDetailPayload,
	type MatterProgressDto,
	type MatterVisibility,
	openInnerMatterDemo,
	type PreviewServiceDto,
	type RegistrationMode,
	type RoleTemplateDto,
	type RuntimeOverviewDto,
	registerWithEmail,
	setAuthRevokedHandler,
	setupInitialAdmin,
	stopPreview,
	submitDeliverableFeedback,
	type TeamMemberDto,
	updateAdminSettings,
	updateAdminUser,
} from "./api.ts";
import { filterBusinessMembers, isArchitectMemberId, ROLE_ARCHITECT_MEMBER_ID } from "./architectApi.ts";
import { AdminView } from "./components/AdminView.tsx";
import { AuthGateView } from "./components/AuthGateView.tsx";
import { ChatStage } from "./components/ChatStage.tsx";
import { DeliverablesView } from "./components/DeliverablesView.tsx";
import { MaterialsView } from "./components/MaterialsView.tsx";
import { SettingsView } from "./components/SettingsView.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { TeamView } from "./components/TeamView.tsx";
import { RoleArchitectModal } from "./components/team/RoleArchitectModal.tsx";
import { type NavTab, parseHashRoute, type SettingsSection } from "./hashRouter.ts";
import { useHashRouteNav } from "./hooks/useHashRouteNav.ts";
import { readStoredSetting, useMatterActions } from "./hooks/useMatterActions.ts";
import { useMatterEventSync } from "./hooks/useMatterEventSync.ts";
import { useMatterInitiationState } from "./hooks/useMatterInitiationState.ts";
import { useRsiDistill } from "./hooks/useRsiDistill.ts";
import {
	createPastedTextAttachment,
	isSupportedImageFile,
	MAX_COMPOSER_FILE_BYTES,
	MAX_COMPOSER_FILES,
	MAX_COMPOSER_IMAGES,
	prepareComposerFiles,
	prepareComposerImages,
} from "./imageAttachments.ts";
import { getBotTheme } from "./utils.ts";

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
	const initialOrgInvite = initialInviteToken.startsWith("orginv_") ? initialInviteToken : "";
	const initialLegacyInvite =
		initialInviteToken && !initialInviteToken.startsWith("orginv_") ? initialInviteToken : "";
	const initialRoute = useMemo(() => parseHashRoute(window.location.hash), []);
	const [authStatus, setAuthStatus] = useState<"checking" | "authenticated" | "unauthenticated">("checking");
	const [permissionRequired, setPermissionRequired] = useState(true);
	const [needsAdminSetup, setNeedsAdminSetup] = useState(false);
	const [pendingApproval, setPendingApproval] = useState(false);
	const [registrationMode, setRegistrationMode] = useState<RegistrationMode>("open_auto");
	const [sessionAccountUser, setSessionAccountUser] = useState<AccountUserDto | null>(null);
	const [authTokenInput, setAuthTokenInput] = useState(initialLegacyInvite);
	const [authError, setAuthError] = useState<string | null>(null);
	const [currentUserOverride, setCurrentUserOverride] = useState<CollaboratorDto | null>(null);
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
	const [composerText, setComposerText] = useState("");
	const [composerImages, setComposerImages] = useState<ComposerImageAttachment[]>([]);
	const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
	composerImagesRef.current = composerImages;
	const [composerFiles, setComposerFiles] = useState<ComposerFileAttachment[]>([]);
	const composerFilesRef = useRef<ComposerFileAttachment[]>([]);
	composerFilesRef.current = composerFiles;
	const [streamingDelta, setStreamingDelta] = useState("");
	const [sseConnected, setSseConnected] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [demoOpening, setDemoOpening] = useState(false);
	const [errorBanner, setErrorBanner] = useState<string | null>(null);
	const [noticeBanner, setNoticeBanner] = useState<string | null>(null);
	const [noticePaused, setNoticePaused] = useState(false);
	const [mobileNavOpen, setMobileNavOpen] = useState(false);
	const [progressByMatter, setProgressByMatter] = useState<Record<string, MatterProgressDto>>({});
	const [progressStartedAt, setProgressStartedAt] = useState<Record<string, number>>({});
	const [runtimeOverview, setRuntimeOverview] = useState<RuntimeOverviewDto | null>(null);
	const [runtimeLoading, setRuntimeLoading] = useState(false);
	const [runtimeError, setRuntimeError] = useState<string | null>(null);
	const [adminOverview, setAdminOverview] = useState<AdminOverviewPayload | null>(null);
	const [adminLoading, setAdminLoading] = useState(false);
	const [adminError, setAdminError] = useState<string | null>(null);

	const composerRef = useRef<HTMLTextAreaElement | null>(null);
	const explicitNewMatterRef = useRef(Boolean(initialRoute.isNewMatter));
	const runtimeAutoFetchedRef = useRef(false);
	const adminAutoFetchedRef = useRef(false);
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
		setSessionAccountUser(null);
		setBootstrap(null);
		setMatterDetail(null);
		setRuntimeOverview(null);
		setRuntimeError(null);
		setAdminOverview(null);
		setAdminError(null);
		runtimeAutoFetchedRef.current = false;
		adminAutoFetchedRef.current = false;
		setProgressByMatter({});
		setSseConnected(false);
		setAuthError(message ?? "当前登录凭证已失效或已被管理员吊销，请重新登录");
		setAuthStatus("unauthenticated");
		void fetchAuthSession()
			.then((s) => {
				setPermissionRequired(s.permissionRequired);
				setNeedsAdminSetup(Boolean(s.needsAdminSetup));
				setPendingApproval(Boolean(s.pendingApproval));
				setRegistrationMode(s.registrationMode ?? "open_auto");
				setSessionAccountUser(s.accountUser ?? null);
			})
			.catch(() => {});
	}, []);

	useEffect(() => {
		setAuthRevokedHandler((message) => applyRevokedSession(message));
		return () => setAuthRevokedHandler(null);
	}, [applyRevokedSession]);

	const syncSessionAndBootstrap = useCallback(async () => {
		const session = await fetchAuthSession();
		setPermissionRequired(session.permissionRequired);
		setNeedsAdminSetup(Boolean(session.needsAdminSetup));
		setPendingApproval(Boolean(session.pendingApproval));
		setRegistrationMode(session.registrationMode ?? "open_auto");
		setSessionAccountUser(session.accountUser ?? null);
		if (!session.authenticated) {
			if (session.revokedSession) {
				setAuthError("当前登录凭证已失效或已被重置，请重新登录");
			}
			setAuthStatus("unauthenticated");
			return false;
		}
		setCurrentUserOverride(session.currentUser);
		if (
			session.accountUser
				? !session.accountUser.canDispatchAi
				: session.currentUser?.permissionRole === "collaborator"
		) {
			setComposerMode("discussion");
		} else {
			setComposerMode("dispatch");
		}
		setAuthStatus("authenticated");
		await refreshBootstrap();
		return true;
	}, [refreshBootstrap]);

	useEffect(() => {
		let cancelled = false;
		const initSession = async () => {
			if (initialLegacyInvite) {
				try {
					const loginRes = await loginWithInviteToken(initialLegacyInvite);
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
							if (!cancelled) {
								setPermissionRequired(s.permissionRequired);
								setNeedsAdminSetup(Boolean(s.needsAdminSetup));
								setPendingApproval(Boolean(s.pendingApproval));
								setRegistrationMode(s.registrationMode ?? "open_auto");
							}
						})
						.catch(() => {});
					return;
				}
			}
			try {
				const ok = await syncSessionAndBootstrap();
				if (cancelled) return;
				if (ok && initialOrgInvite) {
					try {
						const joined = await joinOrganizationByInvite(initialOrgInvite);
						if (!cancelled) {
							setNoticeBanner(`已通过邀请链接加入组织「${joined.organization.name}」`);
							await refreshBootstrap();
						}
					} catch (joinErr: unknown) {
						if (!cancelled) {
							setErrorBanner(joinErr instanceof Error ? joinErr.message : "加入组织失败");
						}
					}
					window.history.replaceState(null, "", `${window.location.pathname}${window.location.hash || "#/chats"}`);
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
	}, [initialLegacyInvite, initialOrgInvite, refreshBootstrap, syncSessionAndBootstrap]);

	const refreshRuntimeOverview = useCallback(async () => {
		setRuntimeLoading(true);
		setRuntimeError(null);
		try {
			const data = await fetchRuntimeOverview();
			setRuntimeOverview(data);
		} catch (err: unknown) {
			setRuntimeError(err instanceof Error ? err.message : String(err));
		} finally {
			setRuntimeLoading(false);
		}
	}, []);

	const refreshAdminOverview = useCallback(async () => {
		setAdminLoading(true);
		setAdminError(null);
		try {
			const data = await fetchAdminOverview();
			setAdminOverview(data);
		} catch (err: unknown) {
			setAdminError(err instanceof Error ? err.message : String(err));
		} finally {
			setAdminLoading(false);
		}
	}, []);

	useEffect(() => {
		if (authStatus !== "authenticated") {
			runtimeAutoFetchedRef.current = false;
			adminAutoFetchedRef.current = false;
			setRuntimeOverview(null);
			setRuntimeError(null);
			setAdminOverview(null);
			setAdminError(null);
			return;
		}
		if (activeTab === "settings" && !runtimeAutoFetchedRef.current) {
			runtimeAutoFetchedRef.current = true;
			void refreshRuntimeOverview();
		}
	}, [authStatus, activeTab, refreshRuntimeOverview]);

	useEffect(() => {
		if (!noticeBanner || noticePaused) return;
		const timer = window.setTimeout(() => {
			setNoticeBanner(null);
			setNoticePaused(false);
		}, 4500);
		return () => window.clearTimeout(timer);
	}, [noticeBanner, noticePaused]);

	useEffect(() => {
		if (!noticeBanner) {
			setNoticePaused(false);
		}
	}, [noticeBanner]);

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
	const draftEffectiveOrgId = selectedWorkspace?.orgId ?? (selectedOrgId || null);
	const initiationScopedMembers = useMemo(() => {
		const all = bootstrap?.members ?? [];
		const enabledIds = draftEffectiveOrgId
			? bootstrap?.orgAiRolesByOrgId?.[draftEffectiveOrgId]?.effectiveMemberIds
			: undefined;
		if (!enabledIds || enabledIds.length === 0) return all;
		return all.filter((m) => enabledIds.includes(m.id) || isArchitectMemberId(m.id, all, templateByRoleId));
	}, [bootstrap, draftEffectiveOrgId, templateByRoleId]);

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

	const composerAttachmentText = useMemo(
		() =>
			composerFiles
				.map((item) => item.content)
				.join("\n")
				.slice(0, 1200),
		[composerFiles],
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

	const handleAddComposerAttachments = useCallback(async (files: FileList | File[]) => {
		const incoming = Array.from(files ?? []);
		if (incoming.length === 0) return;
		const imageFiles: File[] = [];
		const docFiles: File[] = [];
		for (const file of incoming) {
			if (isSupportedImageFile(file)) {
				imageFiles.push(file);
			} else {
				docFiles.push(file);
			}
		}
		const warnings: string[] = [];
		if (imageFiles.length > 0) {
			const res = await prepareComposerImages(imageFiles, composerImagesRef.current.length);
			if (res.attachments.length > 0) {
				setComposerImages((prev) => [...prev, ...res.attachments].slice(0, MAX_COMPOSER_IMAGES));
			}
			warnings.push(...res.warnings);
		}
		if (docFiles.length > 0) {
			const res = await prepareComposerFiles(docFiles, composerFilesRef.current.length);
			if (res.attachments.length > 0) {
				setComposerFiles((prev) => [...prev, ...res.attachments].slice(0, MAX_COMPOSER_FILES));
			}
			warnings.push(...res.warnings);
		}
		if (warnings.length > 0) {
			setErrorBanner(warnings[0]!);
		}
	}, []);

	const handleAddPastedText = useCallback((text: string) => {
		if (composerFilesRef.current.length >= MAX_COMPOSER_FILES) {
			setErrorBanner(`每次最多附带 ${MAX_COMPOSER_FILES} 个文本文件或长文本片段`);
			return;
		}
		const pastedIndex = composerFilesRef.current.filter((item) => item.kind === "pasted_text").length + 1;
		const attachment = createPastedTextAttachment(text, pastedIndex);
		if (attachment.sizeBytes > MAX_COMPOSER_FILE_BYTES) {
			setErrorBanner(`粘贴文本超过 512KB 上限，请分段后再发送`);
			return;
		}
		setComposerFiles((prev) => [...prev, attachment].slice(0, MAX_COMPOSER_FILES));
	}, []);

	const handleRemoveComposerImage = useCallback((imageId: string) => {
		setComposerImages((prev) => prev.filter((item) => item.id !== imageId));
	}, []);

	const handleRemoveComposerFile = useCallback((fileId: string) => {
		setComposerFiles((prev) => prev.filter((item) => item.id !== fileId));
	}, []);

	const handleExpandPastedFile = useCallback((fileId: string) => {
		const target = composerFilesRef.current.find((item) => item.id === fileId);
		if (!target) return;
		setComposerFiles((prev) => prev.filter((item) => item.id !== fileId));
		setComposerText((prev) => (prev.trim() ? `${prev}\n${target.content}` : target.content));
		composerRef.current?.focus();
	}, []);

	const currentUser = bootstrap?.currentUser ?? currentUserOverride ?? null;
	const accountUser = bootstrap?.accountUser ?? sessionAccountUser ?? null;
	const effectiveOrgIdForScope =
		(selectedMatterId ? matterDetail?.matter.orgId : null) ?? selectedWorkspace?.orgId ?? (selectedOrgId || null);
	const effectiveOrg = effectiveOrgIdForScope
		? (bootstrap?.organizations.find((o) => o.id === effectiveOrgIdForScope) ?? null)
		: null;
	const orgEffectiveMemberIds = effectiveOrgIdForScope
		? (bootstrap?.orgAiRolesByOrgId?.[effectiveOrgIdForScope]?.effectiveMemberIds ?? null)
		: null;
	const isSuperAdmin = accountUser
		? accountUser.platformRole === "super_admin"
		: !permissionRequired && currentUser?.permissionRole !== "collaborator";

	useEffect(() => {
		if (authStatus !== "authenticated" || activeTab !== "admin") return;
		if (!isSuperAdmin) {
			navigateRoute({ tab: "chats" }, { replace: true });
			return;
		}
		if (!adminAutoFetchedRef.current) {
			adminAutoFetchedRef.current = true;
			void refreshAdminOverview();
		}
	}, [authStatus, activeTab, isSuperAdmin, navigateRoute, refreshAdminOverview]);
	const canDispatchAi = accountUser
		? accountUser.status === "active" && accountUser.canDispatchAi && effectiveOrg?.orgRole !== "org_viewer"
		: currentUser?.permissionRole !== "collaborator";
	const isOwner = canDispatchAi;
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
			if (initialOrgInvite) {
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
			if (initialOrgInvite) {
				window.history.replaceState(null, "", `${window.location.pathname}${window.location.hash || "#/chats"}`);
			}
			if (res.joinedOrgId) {
				setNoticeBanner("登录成功并已自动加入邀请组织");
			}
		} catch (err: unknown) {
			setAuthError(err instanceof Error ? err.message : "邮箱或密码错误");
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
			setAdminOverview(null);
			adminAutoFetchedRef.current = false;
			setPendingApproval(false);
			setSessionAccountUser(null);
			if (activeTab === "admin") {
				navigateRoute({ tab: "chats" }, { replace: true });
			}
			const session = await fetchAuthSession();
			setPermissionRequired(session.permissionRequired);
			setNeedsAdminSetup(Boolean(session.needsAdminSetup));
			setRegistrationMode(session.registrationMode ?? "open_auto");
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
		composerFiles,
		submitting,
		selectedMatterId,
		selectedMemberId,
		selectedWorkspaceId,
		selectedWorkspace,
		selectedOrgId,
		draftAiMemberIds,
		draftObserverMemberIds: initiation.draftObserverMemberIds,
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
		setDraftObserverMemberIds: initiation.setDraftObserverMemberIds,
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

	if (authStatus === "checking" || authStatus === "unauthenticated") {
		return (
			<AuthGateView
				status={authStatus}
				permissionRequired={permissionRequired}
				needsAdminSetup={needsAdminSetup}
				pendingApproval={pendingApproval}
				registrationMode={registrationMode}
				accountUser={sessionAccountUser}
				authError={authError}
				authTokenInput={authTokenInput}
				orgInviteToken={initialOrgInvite}
				onTokenInputChange={setAuthTokenInput}
				onSubmitInvite={(token) => void handleInviteLogin(token)}
				onSetupAdmin={handleSetupAdmin}
				onLoginEmail={handleLoginEmail}
				onRegisterEmail={handleRegisterEmail}
				onRefreshSession={handleRefreshAuthSession}
				onLogoutPending={handleLogoutOrRestore}
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
				{(errorBanner || noticeBanner) && (
					<div className="app-banners">
						{errorBanner && (
							<div className="approval-card banner-gap" role="alert">
								<div className="banner-row">
									<span>
										<strong>操作提示：</strong> {errorBanner}
									</span>
									<button
										type="button"
										className="btn-inline"
										onClick={() => setErrorBanner(null)}
										aria-label="关闭操作提示"
									>
										关闭
									</button>
								</div>
							</div>
						)}
						{noticeBanner && (
							<output
								className="notice-card banner-gap"
								aria-live="polite"
								onMouseEnter={() => setNoticePaused(true)}
								onMouseLeave={() => setNoticePaused(false)}
								onFocus={() => setNoticePaused(true)}
								onBlur={() => setNoticePaused(false)}
							>
								<div className="banner-row">
									<span>{noticeBanner}</span>
									<button
										type="button"
										className="btn-inline"
										onClick={() => {
											setNoticePaused(false);
											setNoticeBanner(null);
										}}
									>
										知道了
									</button>
								</div>
							</output>
						)}
					</div>
				)}
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
						canDispatchAi={canDispatchAi}
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
						observerMemberIds={
							matterDetail ? (matterDetail.matter.observerMemberIds ?? []) : initiation.draftObserverMemberIds
						}
						observersEnabled={observersEnabled}
						draftPresetMode={initiation.draftPresetMode}
						draftAiMemberIds={draftAiMemberIds}
						draftCollaboratorIds={initiation.draftCollaboratorIds}
						draftVisibility={draftMatterVisibility}
						initiationAssessment={initiation.assessment}
						initiationAssessing={initiation.assessing}
						initiationAssessmentError={initiation.assessmentError}
						initiationModelAssessing={initiation.modelAssessing}
						initiationModelAssessmentError={initiation.modelAssessmentError}
						onChangeLeadMember={actions.handleChangeLeadMember}
						onUpdateMatterAiMembers={actions.handleUpdateMatterAiMembers}
						onUpdateDraftAiMemberIds={setDraftAiMemberIds}
						onUpdateDraftCollaboratorIds={initiation.setDraftCollaboratorIds}
						onUpdateDraftVisibility={setDraftMatterVisibility}
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
						currentUser={currentUser}
						activeSection={settingsSection}
						overview={runtimeOverview}
						loading={runtimeLoading}
						error={runtimeError}
						onSelectSection={(section) => navigateRoute({ tab: "settings", settingsSection: section })}
						onRefresh={refreshRuntimeOverview}
						onOpenTeam={() => navigateRoute({ tab: "team" })}
					/>
				)}

				{activeTab === "admin" && isSuperAdmin && (
					<AdminView
						overview={adminOverview}
						loading={adminLoading}
						error={adminError}
						currentUserId={accountUser?.id ?? null}
						onRefresh={refreshAdminOverview}
						onSaveSettings={async (input) => {
							await updateAdminSettings(input);
							await refreshAdminOverview();
							await refreshBootstrap();
						}}
						onUpdateUser={async (userId, input) => {
							await updateAdminUser(userId, input);
							await refreshAdminOverview();
						}}
						onAbortMatter={async (matterId) => {
							await abortAdminMatter(matterId);
							await refreshAdminOverview();
							await refreshBootstrap();
						}}
					/>
				)}
			</main>

			<RoleArchitectModal
				open={initiation.architectOpen}
				seedGap={initiation.architectSeed}
				members={bootstrap?.members ?? []}
				templateByRoleId={templateByRoleId}
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
		</div>
	);
}
