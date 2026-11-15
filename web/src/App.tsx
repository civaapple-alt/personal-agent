import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	abortMatter,
	abortRsiDistillation,
	approveAiRequest,
	type BootstrapPayload,
	type CollaboratorDto,
	type ComposerImageAttachment,
	createMatter,
	type DeliverableDto,
	type DistillRsiResult,
	dismissAiRequest,
	distillRsiExperiences,
	type FeedbackRating,
	fetchAuthSession,
	fetchBootstrap,
	fetchMatterDetail,
	loginWithInviteToken,
	logoutAuthSession,
	type MatterDetailPayload,
	type MatterProgressDto,
	type MatterSendMode,
	type PreviewServiceDto,
	postMatterMessage,
	type RoleTemplateDto,
	stopPreview,
	submitDeliverableFeedback,
	type TeamMemberDto,
	updateMatterAiMembers,
	updateMatterCollaborators,
	updateMatterLead,
	updateMatterObserversEnabled,
	updateMatterOrganization,
	updateMatterWorkspace,
} from "./api.ts";
import { ChatStage } from "./components/ChatStage.tsx";
import { DeliverablesView } from "./components/DeliverablesView.tsx";
import { MaterialsView } from "./components/MaterialsView.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { TeamView } from "./components/TeamView.tsx";
import { formatHashRoute, type HashRoute, type NavTab, parseHashRoute } from "./hashRouter.ts";
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

export function App() {
	const initialInviteToken = useMemo(() => extractInitialInviteToken(), []);
	const initialRoute = useMemo(() => parseHashRoute(window.location.hash), []);
	const [authStatus, setAuthStatus] = useState<"checking" | "authenticated" | "unauthenticated">("checking");
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
	const [selectedOrgId, setSelectedOrgId] = useState<string>(() => {
		try {
			return window.localStorage.getItem("pa.defaultOrgId") ?? "";
		} catch {
			return "";
		}
	});
	const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>(() => {
		try {
			return window.localStorage.getItem("pa.defaultWorkspaceId") ?? "";
		} catch {
			return "";
		}
	});
	const [draftAiMemberIds, setDraftAiMemberIds] = useState<string[] | null>(null);
	const [draftObserversEnabled, setDraftObserversEnabled] = useState<boolean>(() => {
		try {
			return window.localStorage.getItem("pa.defaultObserversEnabled") === "true";
		} catch {
			return false;
		}
	});
	const [composerText, setComposerText] = useState("");
	const [composerImages, setComposerImages] = useState<ComposerImageAttachment[]>([]);
	const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
	composerImagesRef.current = composerImages;
	const [streamingDelta, setStreamingDelta] = useState("");
	const [sseConnected, setSseConnected] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [errorBanner, setErrorBanner] = useState<string | null>(null);
	const [noticeBanner, setNoticeBanner] = useState<string | null>(null);

	const [progressByMatter, setProgressByMatter] = useState<Record<string, MatterProgressDto>>({});
	const [progressStartedAt, setProgressStartedAt] = useState<Record<string, number>>({});
	const [nowMs, setNowMs] = useState(() => Date.now());

	const composerRef = useRef<HTMLTextAreaElement | null>(null);
	const distillAbortRef = useRef<Map<string, AbortController>>(new Map());
	const explicitNewMatterRef = useRef(Boolean(initialRoute.isNewMatter));
	const activeTabRef = useRef<NavTab>(activeTab);
	activeTabRef.current = activeTab;
	const selectedMatterIdRef = useRef<string | null>(selectedMatterId);
	selectedMatterIdRef.current = selectedMatterId;

	const navigateRoute = useCallback((next: HashRoute, options?: { replace?: boolean }) => {
		setActiveTab(next.tab);
		explicitNewMatterRef.current = Boolean(next.isNewMatter);
		if (next.tab === "deliverables" && next.deliverableId !== undefined) {
			setSelectedDeliverableId(next.deliverableId || null);
		}
		if (next.tab === "chats") {
			if (next.isNewMatter) {
				setSelectedMatterId(null);
			} else if (next.matterId !== undefined) {
				setSelectedMemberId("auto");
				setSelectedMatterId(next.matterId || null);
			}
		}
		const targetHash = formatHashRoute(next);
		if (options?.replace) {
			window.history.replaceState(null, "", targetHash);
		} else if (window.location.hash !== targetHash) {
			window.location.hash = targetHash;
		}
	}, []);

	useEffect(() => {
		const normalized = formatHashRoute(initialRoute);
		if (!window.location.hash || window.location.hash !== normalized) {
			window.history.replaceState(null, "", normalized);
		}
	}, [initialRoute]);

	useEffect(() => {
		const handleHashChange = () => {
			const route = parseHashRoute(window.location.hash);
			setActiveTab(route.tab);
			explicitNewMatterRef.current = Boolean(route.isNewMatter);
			if (route.tab === "deliverables" && route.deliverableId) {
				setSelectedDeliverableId(route.deliverableId);
			} else if (route.tab === "chats") {
				if (route.isNewMatter) {
					setSelectedMatterId(null);
				} else if (route.matterId) {
					setSelectedMatterId(route.matterId);
				}
			}
		};
		window.addEventListener("hashchange", handleHashChange);
		return () => window.removeEventListener("hashchange", handleHashChange);
	}, []);

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
			try {
				const saved = window.localStorage.getItem("pa.defaultWorkspaceId");
				if (saved !== null) {
					resolvedWorkspaceId = saved && data.workspaces.some((w) => w.id === saved) ? saved : "";
					return resolvedWorkspaceId;
				}
			} catch {
				// Ignore storage access errors.
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
			try {
				const savedOrg = window.localStorage.getItem("pa.defaultOrgId");
				if (savedOrg !== null) {
					return savedOrg && data.organizations.some((o) => o.id === savedOrg) ? savedOrg : "";
				}
			} catch {
				// Ignore storage access errors.
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
					return;
				}
			}
			try {
				const session = await fetchAuthSession();
				if (cancelled) return;
				if (!session.authenticated) {
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

	const activeProgressKeys = Object.keys(progressByMatter);
	useEffect(() => {
		if (activeProgressKeys.length === 0) return;
		const timer = setInterval(() => setNowMs(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [activeProgressKeys.length]);

	useEffect(() => {
		if (authStatus !== "authenticated") return;
		const clearMatterProgress = (matterId: string) => {
			if (selectedMatterIdRef.current === matterId) {
				setStreamingDelta("");
			}
			setProgressByMatter((prev) => {
				const next = { ...prev };
				delete next[matterId];
				return next;
			});
			setProgressStartedAt((prev) => {
				const next = { ...prev };
				delete next[matterId];
				return next;
			});
			void refreshBootstrap();
			if (selectedMatterIdRef.current === matterId) {
				void refreshDetail(matterId);
			}
		};

		const es = new EventSource("/api/events");
		es.addEventListener("connected", () => setSseConnected(true));
		es.addEventListener("text_delta", (ev) => {
			const data = JSON.parse((ev as MessageEvent).data) as { matterId: string; delta: string };
			if (data.matterId === selectedMatterIdRef.current) {
				setStreamingDelta((prev) => prev + data.delta);
			}
		});
		es.addEventListener("matter_progress", (ev) => {
			const data = JSON.parse((ev as MessageEvent).data) as MatterProgressDto;
			setProgressByMatter((prev) => ({ ...prev, [data.matterId]: data }));
			setProgressStartedAt((prev) => (prev[data.matterId] ? prev : { ...prev, [data.matterId]: Date.now() }));
			if (data.stage === "starting" || data.collabUpdated) {
				if (data.stage === "starting") {
					void refreshBootstrap();
				}
				if (data.matterId === selectedMatterIdRef.current) {
					void refreshDetail(data.matterId);
				}
			}
		});
		es.addEventListener("matter_settled", (ev) => {
			const data = JSON.parse((ev as MessageEvent).data) as {
				matterId: string;
				deliverable?: { id?: string; title?: string } | null;
			};
			if (data.deliverable?.id) {
				setSelectedDeliverableId(data.deliverable.id);
				if (activeTabRef.current === "deliverables") {
					window.history.replaceState(
						null,
						"",
						formatHashRoute({ tab: "deliverables", deliverableId: data.deliverable.id }),
					);
				}
				const watchingThisChat = activeTabRef.current === "chats" && selectedMatterIdRef.current === data.matterId;
				if (!watchingThisChat) {
					const shortTitle = (data.deliverable.title ?? "新成果").slice(0, 28);
					setNoticeBanner(`✓ 已完成交付：「${shortTitle}」`);
				}
			}
			clearMatterProgress(data.matterId);
		});
		es.addEventListener("matter_failed", (ev) => {
			const data = JSON.parse((ev as MessageEvent).data) as { matterId: string; error?: string };
			if (data.error) {
				setErrorBanner(`执行未完成：${data.error}`);
			}
			clearMatterProgress(data.matterId);
		});
		es.addEventListener("matter_aborted", (ev) => {
			const data = JSON.parse((ev as MessageEvent).data) as { matterId: string };
			clearMatterProgress(data.matterId);
		});

		const handleSync = () => {
			void refreshBootstrap();
			if (selectedMatterIdRef.current) {
				void refreshDetail(selectedMatterIdRef.current);
			}
		};
		for (const evtName of [
			"matter_started",
			"matter_message",
			"matter_updated",
			"collaborator_updated",
			"dialog_requested",
			"dialog_resolved",
			"deliverable_updated",
			"workspace_updated",
			"organization_updated",
			"preview_updated",
			"team_updated",
			"memory_updated",
		]) {
			es.addEventListener(evtName, handleSync);
		}
		es.onerror = () => setSseConnected(false);
		return () => es.close();
	}, [authStatus, refreshBootstrap, refreshDetail]);

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
		if (selectedMemberId !== "auto") {
			return bootstrap.members.find((m) => m.id === selectedMemberId) ?? null;
		}
		if (matterDetail?.matter.leadMemberId) {
			return bootstrap.members.find((m) => m.id === matterDetail.matter.leadMemberId) ?? null;
		}
		return bootstrap.members.find((m) => m.isPrimaryContact) ?? bootstrap.members[0] ?? null;
	}, [bootstrap, matterDetail, selectedMemberId]);

	const memberThemeMap = useMemo(() => {
		const map = new Map<string, { bg: string; tilt: string }>();
		bootstrap?.members.forEach((member, index) => {
			map.set(member.id, getBotTheme(index));
		});
		return map;
	}, [bootstrap]);

	const activeDialogs = useMemo(() => {
		if (!bootstrap) return [];
		if (selectedMatterId) {
			return bootstrap.pendingDialogs.filter((d) => d.matterId === selectedMatterId);
		}
		return bootstrap.pendingDialogs;
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

	const startNewMatter = () => {
		setDraftAiMemberIds(null);
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

	const handleSendPrompt = async () => {
		const text = composerText.trim();
		const imagesPayload = composerImages.map(({ data, mimeType, name }) => ({ data, mimeType, name }));
		if ((!text && imagesPayload.length === 0) || submitting) return;
		const effectiveMode: MatterSendMode =
			composerMode === "discussion" ? "discussion" : isOwner ? "dispatch" : "ai_request";
		setSubmitting(true);
		setErrorBanner(null);
		setNoticeBanner(null);
		try {
			const preferredMemberId = selectedMemberId === "auto" ? undefined : selectedMemberId;
			let targetMatterId = selectedMatterId;

			if (targetMatterId) {
				await postMatterMessage(targetMatterId, {
					mode: effectiveMode,
					prompt: text,
					images: imagesPayload.length > 0 ? imagesPayload : undefined,
					preferredMemberId,
				});
				if (effectiveMode === "ai_request") {
					setNoticeBanner("已提交 AI 提请单，待团队所有者一键确认后派发执行");
				}
			} else {
				const preferredForCreate = selectedMemberId === "auto" ? headerContact?.id : selectedMemberId;
				const created = await createMatter({
					mode: effectiveMode,
					prompt: text,
					images: imagesPayload.length > 0 ? imagesPayload : undefined,
					preferredMemberId: preferredForCreate,
					workspaceId: selectedWorkspaceId || undefined,
					orgId: selectedOrgId || null,
					aiMemberIds: draftAiMemberIds,
					observersEnabled: draftObserversEnabled,
				});
				targetMatterId = created.matter.id;
				explicitNewMatterRef.current = false;
				navigateRoute({ tab: "chats", matterId: created.matter.id });
				if (effectiveMode === "discussion") {
					setNoticeBanner("已创建事项并发送首条团队讨论");
				} else if (effectiveMode === "ai_request") {
					setNoticeBanner("已创建事项并提交 AI 提请，待团队所有者确认后派发");
				} else {
					setNoticeBanner(`已派发给「${created.assignedMember.displayName}」，正在后台推进`);
				}
			}
			setComposerText("");
			setComposerImages([]);
			await refreshBootstrap();
			if (targetMatterId) {
				await refreshDetail(targetMatterId);
			}
		} catch (err: unknown) {
			setErrorBanner(err instanceof Error ? err.message : String(err));
		} finally {
			setSubmitting(false);
		}
	};

	const handleApproveAiRequest = async (matterId: string, messageId: string) => {
		setErrorBanner(null);
		try {
			await approveAiRequest(matterId, messageId);
			setNoticeBanner("已确认同事提请并派发给 AI 团队执行");
			await refreshBootstrap();
			await refreshDetail(matterId);
		} catch (err: unknown) {
			setErrorBanner(err instanceof Error ? err.message : String(err));
		}
	};

	const handleDismissAiRequest = async (matterId: string, messageId: string) => {
		setErrorBanner(null);
		try {
			await dismissAiRequest(matterId, messageId);
			setNoticeBanner("已忽略该条 AI 提请");
			await refreshDetail(matterId);
		} catch (err: unknown) {
			setErrorBanner(err instanceof Error ? err.message : String(err));
		}
	};

	const handleUpdateMatterCollaborators = (collaboratorIds: string[]) => {
		if (!selectedMatterId) return;
		const targetMatterId = selectedMatterId;
		void updateMatterCollaborators(targetMatterId, collaboratorIds)
			.then(async () => {
				setNoticeBanner("已更新本事项参与同事");
				await refreshBootstrap();
				await refreshDetail(targetMatterId);
			})
			.catch((err: unknown) => {
				setErrorBanner(err instanceof Error ? err.message : String(err));
			});
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

	const handleAbortMatter = (matterId: string) => {
		void abortMatter(matterId)
			.then(() => {
				setNoticeBanner("已发送停止指令，正在中断当前执行");
			})
			.catch((err: unknown) => {
				setErrorBanner(err instanceof Error ? err.message : String(err));
			});
	};

	const handleSelectOrganization = (nextOrgId: string) => {
		const targetOrgId = nextOrgId || "";
		const orgWorkspaces = (bootstrap?.workspaces ?? []).filter((w) =>
			targetOrgId ? w.orgId === targetOrgId : !w.orgId,
		);
		if (!selectedMatterId) {
			setSelectedOrgId(targetOrgId);
			try {
				window.localStorage.setItem("pa.defaultOrgId", targetOrgId);
			} catch {
				// Ignore storage access errors.
			}
			const currentStillMatches = selectedWorkspace
				? targetOrgId
					? selectedWorkspace.orgId === targetOrgId
					: !selectedWorkspace.orgId
				: false;
			if (!currentStillMatches) {
				const fallbackWsId = targetOrgId ? (orgWorkspaces[0]?.id ?? "") : "";
				setSelectedWorkspaceId(fallbackWsId);
				try {
					window.localStorage.setItem("pa.defaultWorkspaceId", fallbackWsId);
				} catch {
					// Ignore storage access errors.
				}
			}
			return;
		}
		const targetMatterId = selectedMatterId;
		void updateMatterOrganization(targetMatterId, targetOrgId || null)
			.then(async (res) => {
				setSelectedOrgId(res.matter.orgId ?? "");
				setSelectedWorkspaceId(res.matter.workspaceId ?? "");
				const orgLabel = res.matter.orgId ? (organizationName(res.matter.orgId) ?? res.matter.orgId) : "不归属组织";
				setNoticeBanner(`已切换当前事项组织为「${orgLabel}」`);
				await refreshBootstrap();
				await refreshDetail(targetMatterId);
			})
			.catch((err: unknown) => {
				setErrorBanner(err instanceof Error ? err.message : String(err));
				void refreshDetail(targetMatterId).catch(() => {});
			});
	};

	const handleSelectWorkspace = (nextId: string) => {
		const nextWs = nextId ? (bootstrap?.workspaces.find((w) => w.id === nextId) ?? null) : null;
		if (!selectedMatterId) {
			setSelectedWorkspaceId(nextId);
			try {
				window.localStorage.setItem("pa.defaultWorkspaceId", nextId);
			} catch {
				// Ignore storage access errors.
			}
			if (nextWs) {
				const nextOrgId = nextWs.orgId ?? "";
				setSelectedOrgId(nextOrgId);
				try {
					window.localStorage.setItem("pa.defaultOrgId", nextOrgId);
				} catch {
					// Ignore storage access errors.
				}
			}
			return;
		}
		const targetMatterId = selectedMatterId;
		void updateMatterWorkspace(targetMatterId, nextId || null)
			.then(async (res) => {
				setSelectedWorkspaceId(res.matter.workspaceId ?? "");
				setSelectedOrgId(res.matter.orgId ?? "");
				try {
					window.localStorage.setItem("pa.defaultWorkspaceId", res.matter.workspaceId ?? "");
				} catch {
					// Ignore storage access errors.
				}
				const wsLabel = nextId ? (workspaceName(nextId) ?? nextId) : "不绑定仓库";
				setNoticeBanner(`已切换当前事项仓库为「${wsLabel}」`);
				await refreshBootstrap();
				await refreshDetail(targetMatterId);
			})
			.catch((err: unknown) => {
				setErrorBanner(err instanceof Error ? err.message : String(err));
				void refreshDetail(targetMatterId).catch(() => {});
			});
	};

	const handleChangeLeadMember = (memberId: string) => {
		if (!memberId) return;
		if (!selectedMatterId) {
			setSelectedMemberId(memberId);
			if (draftAiMemberIds !== null && !draftAiMemberIds.includes(memberId)) {
				setDraftAiMemberIds([memberId, ...draftAiMemberIds]);
			}
			setNoticeBanner(`已将「${memberName(memberId)}」设为新事项负责人`);
			return;
		}
		const targetMatterId = selectedMatterId;
		void updateMatterLead(targetMatterId, memberId)
			.then(async () => {
				setSelectedMemberId("auto");
				setNoticeBanner(`已将「${memberName(memberId)}」设为当前事项负责人`);
				await refreshBootstrap();
				await refreshDetail(targetMatterId);
			})
			.catch((err: unknown) => {
				setErrorBanner(err instanceof Error ? err.message : String(err));
				void refreshDetail(targetMatterId).catch(() => {});
			});
	};

	const handleUpdateMatterAiMembers = (nextIds: string[]) => {
		const leadId = headerContact?.id;
		const deduped = [...new Set(nextIds)];
		const ensured = leadId && !deduped.includes(leadId) ? [leadId, ...deduped] : deduped;
		if (ensured.length === 0) return;
		if (!selectedMatterId) {
			const allCount = bootstrap?.members.length ?? 0;
			setDraftAiMemberIds(ensured.length >= allCount ? null : ensured);
			return;
		}
		const targetMatterId = selectedMatterId;
		void updateMatterAiMembers(targetMatterId, ensured)
			.then(async () => {
				await refreshBootstrap();
				await refreshDetail(targetMatterId);
			})
			.catch((err: unknown) => {
				setErrorBanner(err instanceof Error ? err.message : String(err));
				void refreshDetail(targetMatterId).catch(() => {});
			});
	};

	const handleToggleObserversEnabled = (enabled: boolean) => {
		try {
			window.localStorage.setItem("pa.defaultObserversEnabled", enabled ? "true" : "false");
		} catch {
			// Ignore storage access errors.
		}
		if (!selectedMatterId) {
			setDraftObserversEnabled(enabled);
			setNoticeBanner(enabled ? "已开启 AI 旁听（当前协作 AI 将自动参与旁听）" : "已关闭 AI 旁听");
			return;
		}
		const targetMatterId = selectedMatterId;
		void updateMatterObserversEnabled(targetMatterId, enabled)
			.then(async () => {
				setNoticeBanner(enabled ? "已开启 AI 旁听（当前协作 AI 将自动参与旁听）" : "已关闭 AI 旁听");
				await refreshBootstrap();
				await refreshDetail(targetMatterId);
			})
			.catch((err: unknown) => {
				setErrorBanner(err instanceof Error ? err.message : String(err));
				void refreshDetail(targetMatterId).catch(() => {});
			});
	};

	const handleDeliverableFeedback = async (
		deliverableId: string,
		payload: { feedback?: string; rating?: FeedbackRating; autoDistill?: boolean },
	) => {
		try {
			const res = await submitDeliverableFeedback(deliverableId, payload);
			if (res.distillationError) setErrorBanner(`验收已保存，经验复盘未完成：${res.distillationError}`);
			const parts = ["验收记录已保存"];
			if (res.evaluatedMemoryIds.length > 0) {
				parts.push(`已回写 ${res.evaluatedMemoryIds.length} 条关联经验评估`);
			}
			if (res.distilledMemories.length > 0) {
				parts.push(`AI 新提炼 ${res.distilledMemories.length} 条待核验经验`);
			}
			setNoticeBanner(parts.join(" · "));
			await refreshBootstrap();
			if (selectedMatterId) {
				await refreshDetail(selectedMatterId);
			}
		} catch (err) {
			setErrorBanner(err instanceof Error ? err.message : String(err));
		}
	};

	const cancelRsiDistill = (matterId: string) => {
		const controller = distillAbortRef.current.get(matterId);
		if (controller) {
			controller.abort();
			distillAbortRef.current.delete(matterId);
		}
		setNoticeBanner("已取消本次 AI 经验复盘");
		void abortRsiDistillation(matterId).catch(() => {});
	};

	const runRsiDistill = async (input: {
		matterId: string;
		deliverableId?: string;
		feedback?: string;
		rating?: FeedbackRating;
	}): Promise<DistillRsiResult | undefined> => {
		const prevController = distillAbortRef.current.get(input.matterId);
		if (prevController) {
			prevController.abort();
		}
		const controller = new AbortController();
		distillAbortRef.current.set(input.matterId, controller);
		try {
			const res = await distillRsiExperiences(
				{
					matterId: input.matterId,
					deliverableId: input.deliverableId,
					feedback: input.feedback,
					rating: input.rating,
					scopeMode: "team",
				},
				controller.signal,
			);
			if (res.aborted || controller.signal.aborted) {
				setNoticeBanner("已取消本次 AI 经验复盘");
				return { ...res, aborted: true };
			}
			if (res.createdMemories.length > 0) {
				const roleNames = Array.from(new Set(res.createdMemories.map((m) => memberName(m.memberId))));
				setNoticeBanner(
					`已为 ${roleNames.join("、")} 提炼 ${res.createdMemories.length} 条经验，可在当前界面直接核验通过或修改归属`,
				);
			} else {
				setNoticeBanner(
					res.skippedDuplicates > 0
						? `AI 复盘未新增重复经验（跳过 ${res.skippedDuplicates} 条相似经验）`
						: `AI 复盘完成：${res.summary}`,
				);
			}
			await refreshBootstrap();
			if (selectedMatterId) {
				await refreshDetail(selectedMatterId);
			}
			return res;
		} catch (err) {
			if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
				setNoticeBanner("已取消本次 AI 经验复盘");
				return {
					ok: false,
					aborted: true,
					createdMemories: [],
					skippedDuplicates: 0,
					summary: "已取消 AI 经验复盘",
				};
			}
			setErrorBanner(err instanceof Error ? err.message : String(err));
			return undefined;
		} finally {
			if (distillAbortRef.current.get(input.matterId) === controller) {
				distillAbortRef.current.delete(input.matterId);
			}
		}
	};

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

	if (authStatus === "checking") {
		return (
			<div className="auth-gate-shell">
				<div className="auth-gate-card">
					<div className="brand-mark">PA</div>
					<h1>正在连接团队协同工作台...</h1>
					<p className="muted-hint">正在校验访问身份与工作台状态</p>
				</div>
			</div>
		);
	}

	if (authStatus === "unauthenticated") {
		return (
			<div className="auth-gate-shell">
				<div className="auth-gate-card">
					<div className="auth-gate-head">
						<span className="brand-mark">PA</span>
						<div>
							<h1>加入受限协同工作台</h1>
							<p className="muted-hint">
								当前服务运行在内网协同模式，需要团队所有者分享的个人邀请链接或口令方可加入讨论。
							</p>
						</div>
					</div>
					{authError && <div className="approval-card">{authError}</div>}
					<form
						className="auth-gate-form"
						onSubmit={(e) => {
							e.preventDefault();
							void handleInviteLogin(authTokenInput);
						}}
					>
						<input
							className="input-field"
							value={authTokenInput}
							onChange={(e) => setAuthTokenInput(e.target.value)}
							placeholder="粘贴邀请口令（如 inv_xxx）..."
						/>
						<button type="submit" className="btn-pill-dark" disabled={!authTokenInput.trim()}>
							进入协同房间
						</button>
					</form>
				</div>
			</div>
		);
	}

	return (
		<div className="bot-shell">
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
				onSearchQueryChange={setSearchQuery}
				onNavigate={(route) => navigateRoute(route)}
				onToggleMember={(memberId) => {
					setSelectedMemberId((prev) => (prev === memberId ? "auto" : memberId));
					if (activeTab !== "chats") {
						navigateRoute({ tab: "chats", isNewMatter: true });
					}
					composerRef.current?.focus();
				}}
				onNewMatter={startNewMatter}
				onSwitchOrLogout={() => void handleLogoutOrRestore()}
			/>

			<main className="main-stage">
				{activeTab === "chats" && (
					<ChatStage
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
						onSelectOrganization={handleSelectOrganization}
						onSelectWorkspace={handleSelectWorkspace}
						matterAiMemberIds={matterAiMemberIds}
						observersEnabled={observersEnabled}
						onChangeLeadMember={handleChangeLeadMember}
						onUpdateMatterAiMembers={handleUpdateMatterAiMembers}
						onToggleObserversEnabled={handleToggleObserversEnabled}
						onUpdateMatterCollaborators={handleUpdateMatterCollaborators}
						onApproveAiRequest={(matterId, messageId) => void handleApproveAiRequest(matterId, messageId)}
						onDismissAiRequest={(matterId, messageId) => void handleDismissAiRequest(matterId, messageId)}
						onSendPrompt={() => void handleSendPrompt()}
						onAbortMatter={handleAbortMatter}
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
						onSubmitFeedback={handleDeliverableFeedback}
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
		</div>
	);
}
