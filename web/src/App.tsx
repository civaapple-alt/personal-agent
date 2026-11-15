import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	abortMatter,
	type BootstrapPayload,
	createMatter,
	type DeliverableDto,
	fetchBootstrap,
	fetchMatterDetail,
	type MatterDetailPayload,
	type MatterProgressDto,
	type PreviewServiceDto,
	postMatterMessage,
	type RoleTemplateDto,
	saveMemberMemory,
	stopPreview,
	submitDeliverableFeedback,
	type TeamMemberDto,
	updateMatterObservers,
	updateMatterWorkspace,
} from "./api.ts";
import { ChatStage } from "./components/ChatStage.tsx";
import { DeliverablesView } from "./components/DeliverablesView.tsx";
import { MaterialsView } from "./components/MaterialsView.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { TeamView } from "./components/TeamView.tsx";
import { formatHashRoute, type HashRoute, type NavTab, parseHashRoute } from "./hashRouter.ts";
import { buildStarterTasks, getBotTheme } from "./utils.ts";

export function App() {
	const initialRoute = useMemo(() => parseHashRoute(window.location.hash), []);
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
	const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>(() => {
		try {
			return window.localStorage.getItem("pa.defaultWorkspaceId") ?? "";
		} catch {
			return "";
		}
	});
	const [draftObserverIds, setDraftObserverIds] = useState<string[] | null>(() => {
		try {
			const raw = window.localStorage.getItem("pa.defaultObserverIds");
			if (!raw) return null;
			const parsed: unknown = JSON.parse(raw);
			return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : null;
		} catch {
			return null;
		}
	});
	const [composerText, setComposerText] = useState("");
	const [streamingDelta, setStreamingDelta] = useState("");
	const [sseConnected, setSseConnected] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [errorBanner, setErrorBanner] = useState<string | null>(null);
	const [noticeBanner, setNoticeBanner] = useState<string | null>(null);

	const [progressByMatter, setProgressByMatter] = useState<Record<string, MatterProgressDto>>({});
	const [progressStartedAt, setProgressStartedAt] = useState<Record<string, number>>({});
	const [nowMs, setNowMs] = useState(() => Date.now());

	const composerRef = useRef<HTMLTextAreaElement | null>(null);
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
		setSelectedMatterId((prev) => (explicitNewMatterRef.current ? null : (prev ?? data.matters[0]?.id ?? null)));
		setSelectedWorkspaceId((prev) => {
			if (prev && data.workspaces.some((w) => w.id === prev)) return prev;
			try {
				const saved = window.localStorage.getItem("pa.defaultWorkspaceId");
				if (saved !== null) {
					return saved && data.workspaces.some((w) => w.id === saved) ? saved : "";
				}
			} catch {
				// Ignore storage access errors.
			}
			return data.workspaces[0]?.id || "";
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
	}, []);

	useEffect(() => {
		void refreshBootstrap().catch((err: unknown) => {
			setErrorBanner(err instanceof Error ? err.message : String(err));
		});
	}, [refreshBootstrap]);

	useEffect(() => {
		setStreamingDelta("");
		void refreshDetail(selectedMatterId).catch(() => {});
	}, [selectedMatterId, refreshDetail]);

	const activeProgressKeys = Object.keys(progressByMatter);
	useEffect(() => {
		if (activeProgressKeys.length === 0) return;
		const timer = setInterval(() => setNowMs(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [activeProgressKeys.length]);

	useEffect(() => {
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
			"matter_updated",
			"dialog_requested",
			"dialog_resolved",
			"deliverable_updated",
			"workspace_updated",
			"preview_updated",
			"team_updated",
			"memory_updated",
		]) {
			es.addEventListener(evtName, handleSync);
		}
		es.onerror = () => setSseConnected(false);
		return () => es.close();
	}, [refreshBootstrap, refreshDetail]);

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
		navigateRoute({ tab: "chats", isNewMatter: true });
		composerRef.current?.focus();
	};

	const activeObserverIds: string[] = useMemo(() => {
		const validIds = new Set((bootstrap?.members ?? []).map((m) => m.id));
		if (selectedMatterId && matterDetail) {
			return (matterDetail.matter.observerMemberIds ?? []).filter((id) => validIds.has(id));
		}
		if (draftObserverIds !== null) {
			return draftObserverIds.filter((id) => validIds.has(id));
		}
		return (bootstrap?.members ?? []).filter((m) => !m.isPrimaryContact).map((m) => m.id);
	}, [bootstrap, draftObserverIds, matterDetail, selectedMatterId]);

	const handleSendPrompt = async () => {
		const text = composerText.trim();
		if (!text || submitting) return;
		setSubmitting(true);
		setErrorBanner(null);
		setNoticeBanner(null);
		try {
			const preferredMemberId = selectedMemberId === "auto" ? undefined : selectedMemberId;
			let targetMatterId = selectedMatterId;

			if (targetMatterId) {
				await postMatterMessage(targetMatterId, {
					prompt: text,
					preferredMemberId,
				});
			} else {
				const leadForMatter = preferredMemberId ?? headerContact?.id;
				const observerIds = activeObserverIds.filter((id) => id !== leadForMatter);
				const created = await createMatter({
					prompt: text,
					preferredMemberId,
					workspaceId: selectedWorkspaceId || undefined,
					observerMemberIds: observerIds,
				});
				targetMatterId = created.matter.id;
				explicitNewMatterRef.current = false;
				navigateRoute({ tab: "chats", matterId: created.matter.id });
				setNoticeBanner(`已派发给「${created.assignedMember.displayName}」，正在后台推进`);
			}
			setComposerText("");
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

	const handleAbortMatter = (matterId: string) => {
		void abortMatter(matterId)
			.then(() => {
				setNoticeBanner("已发送停止指令，正在中断当前执行");
			})
			.catch((err: unknown) => {
				setErrorBanner(err instanceof Error ? err.message : String(err));
			});
	};

	const handleSelectWorkspace = (nextId: string) => {
		if (!selectedMatterId) {
			setSelectedWorkspaceId(nextId);
			try {
				window.localStorage.setItem("pa.defaultWorkspaceId", nextId);
			} catch {
				// Ignore storage access errors.
			}
			return;
		}
		const targetMatterId = selectedMatterId;
		void updateMatterWorkspace(targetMatterId, nextId || null)
			.then(async () => {
				setSelectedWorkspaceId(nextId);
				try {
					window.localStorage.setItem("pa.defaultWorkspaceId", nextId);
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

	const handleUpdateObservers = (nextIds: string[]) => {
		const leadId = headerContact?.id;
		const cleaned = [...new Set(nextIds)].filter((id) => id !== leadId);
		try {
			window.localStorage.setItem("pa.defaultObserverIds", JSON.stringify(cleaned));
		} catch {
			// Ignore storage access errors.
		}
		if (!selectedMatterId) {
			setDraftObserverIds(cleaned);
			return;
		}
		const targetMatterId = selectedMatterId;
		void updateMatterObservers(targetMatterId, cleaned)
			.then(async () => {
				setNoticeBanner(cleaned.length ? `已更新会议旁听席（${cleaned.length}位同事）` : "已设为仅主负责人跟进");
				await refreshBootstrap();
				await refreshDetail(targetMatterId);
			})
			.catch((err: unknown) => {
				setErrorBanner(err instanceof Error ? err.message : String(err));
				void refreshDetail(targetMatterId).catch(() => {});
			});
	};

	const handleDeliverableFeedback = async (deliverableId: string, feedback: string) => {
		await submitDeliverableFeedback(deliverableId, feedback);
		setNoticeBanner("验收反馈已保存");
		await refreshBootstrap();
		if (selectedMatterId) {
			await refreshDetail(selectedMatterId);
		}
	};

	const handleSaveMemoryForDeliverable = async (
		deliv: DeliverableDto,
		content: string,
		scope: "role_general" | "project_private",
	) => {
		const matterWsId = bootstrap?.matters.find((m) => m.id === deliv.matterId)?.workspaceId ?? null;
		await saveMemberMemory({
			memberId: deliv.memberId,
			content,
			scope,
			workspaceId: scope === "project_private" ? (matterWsId ?? undefined) : undefined,
			sourceMatterId: deliv.matterId,
		});
		setNoticeBanner(`已沉淀为「${memberName(deliv.memberId)}」的经验记忆`);
		await refreshBootstrap();
	};

	const activeMatterProgress = selectedMatterId ? (progressByMatter[selectedMatterId] ?? null) : null;
	const headerTheme = headerContact ? (memberThemeMap.get(headerContact.id) ?? getBotTheme(0)) : getBotTheme(0);
	const elapsedSeconds = selectedMatterId
		? Math.max(0, Math.floor((nowMs - (progressStartedAt[selectedMatterId] ?? nowMs)) / 1000))
		: 0;

	return (
		<div className="bot-shell">
			<Sidebar
				activeTab={activeTab}
				bootstrap={bootstrap}
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
			/>

			<main className="main-stage">
				{activeTab === "chats" && (
					<ChatStage
						composerRef={composerRef}
						selectedWorkspace={selectedWorkspace}
						selectedWorkspaceId={selectedWorkspaceId}
						workspaces={bootstrap?.workspaces ?? []}
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
						errorBanner={errorBanner}
						noticeBanner={noticeBanner}
						starterTasks={starterTasks}
						templateByRoleId={templateByRoleId}
						memberName={memberName}
						previewUrlFor={previewUrlFor}
						onComposerTextChange={setComposerText}
						onSelectWorkspace={handleSelectWorkspace}
						onSelectMember={setSelectedMemberId}
						activeObserverIds={activeObserverIds}
						onUpdateObservers={handleUpdateObservers}
						onSendPrompt={() => void handleSendPrompt()}
						onAbortMatter={handleAbortMatter}
						onNewMatter={startNewMatter}
						onOpenDeliverables={(deliverableId) => navigateRoute({ tab: "deliverables", deliverableId })}
						onDismissError={() => setErrorBanner(null)}
						onDismissNotice={() => setNoticeBanner(null)}
					/>
				)}

				{activeTab === "deliverables" && (
					<DeliverablesView
						bootstrap={bootstrap}
						activeDeliverable={activeDeliverable}
						filteredDeliverables={filteredDeliverables}
						siblingVersions={siblingVersionsFor(activeDeliverable)}
						previewUrlFor={previewUrlFor}
						memberName={memberName}
						workspaceName={workspaceName}
						onSubmitFeedback={handleDeliverableFeedback}
						onSaveMemory={handleSaveMemoryForDeliverable}
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
						onNewTask={startNewMatter}
					/>
				)}

				{activeTab === "team" && (
					<TeamView
						members={bootstrap?.members ?? []}
						memoriesByMember={bootstrap?.memoriesByMember ?? {}}
						templateByRoleId={templateByRoleId}
						memberName={memberName}
						workspaceName={workspaceName}
						onRefresh={refreshBootstrap}
						onNotice={(msg) => setNoticeBanner(msg)}
						onError={(msg) => setErrorBanner(msg)}
						onAssignTask={(memberId) => {
							setSelectedMemberId(memberId);
							startNewMatter();
						}}
					/>
				)}

				{activeTab === "materials" && (
					<MaterialsView
						workspaces={bootstrap?.workspaces ?? []}
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
