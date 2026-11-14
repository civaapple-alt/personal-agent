import { type ChangeEvent, type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	addWorkspace,
	type BootstrapPayload,
	createMatter,
	createMember,
	type DeliverableDto,
	exportMemberPackage,
	fetchBootstrap,
	fetchMatterDetail,
	importMemberPackage,
	type MatterDetailPayload,
	type MatterProgressDto,
	postMatterMessage,
	type RoleTemplateDto,
	respondToDialog,
	saveMemberMemory,
	setPrimaryMember,
	stopPreview,
	submitDeliverableFeedback,
} from "./api.ts";
import { formatHashRoute, type HashRoute, type NavTab, parseHashRoute } from "./hashRouter.ts";
import { MarkdownView } from "./MarkdownView.tsx";

const STATUS_LABELS: Record<string, string> = {
	open: "推进中",
	waiting_user: "待你确认",
	delivered: "已交付",
	archived: "已归档",
};

const STAGE_ORDER: MatterProgressDto["stage"][] = ["starting", "thinking", "tool", "waiting_user", "finalizing"];

const STAGE_LABELS: Record<MatterProgressDto["stage"], string> = {
	starting: "准备中",
	thinking: "思考规划",
	tool: "查看/执行",
	waiting_user: "待你确认",
	finalizing: "整理交付",
};

const MEMORY_SCOPE_LABELS: Record<string, string> = {
	role_general: "角色通用经验",
	company_private: "个人私有经验",
	project_private: "当前项目规范",
};

function splitTagsInput(raw: string): string[] {
	return raw
		.split(/[,，、\n]/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

function formatClockTime(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function ProgressCard(props: {
	title: string;
	progress: MatterProgressDto;
	elapsedSeconds: number;
	onOpenChat?: () => void;
}) {
	const activeIndex = STAGE_ORDER.indexOf(props.progress.stage);
	return (
		<div className="progress-card">
			<div className="progress-top">
				<div className="progress-heading">
					<span className="progress-dot" />
					<strong>{props.title}</strong>
				</div>
				<div className="progress-meta">
					<span>{STAGE_LABELS[props.progress.stage]}</span>
					<span>·</span>
					<span>已耗时 {props.elapsedSeconds}s</span>
					{props.onOpenChat && (
						<button type="button" className="btn-inline" onClick={props.onOpenChat}>
							查看详情
						</button>
					)}
				</div>
			</div>
			<div className="progress-label">{props.progress.label}</div>
			<div className="progress-steps">
				{STAGE_ORDER.map((stage, idx) => (
					<div
						key={stage}
						className={`progress-step ${idx < activeIndex ? "done" : idx === activeIndex ? "active" : ""}`}
					>
						<span className="progress-step-bar" />
						<span className="progress-step-text">{STAGE_LABELS[stage]}</span>
					</div>
				))}
			</div>
		</div>
	);
}

export function App() {
	const initialRoute = useMemo(() => parseHashRoute(window.location.hash), []);
	const [activeTab, setActiveTab] = useState<NavTab>(initialRoute.tab);
	const [colleaguesOpen, setColleaguesOpen] = useState(true);
	const [collabOpen, setCollabOpen] = useState(false);
	const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
	const [selectedMatterId, setSelectedMatterId] = useState<string | null>(
		initialRoute.isNewMatter ? null : (initialRoute.matterId ?? null),
	);
	const [matterDetail, setMatterDetail] = useState<MatterDetailPayload | null>(null);
	const [selectedDeliverableId, setSelectedDeliverableId] = useState<string | null>(
		initialRoute.deliverableId ?? null,
	);
	const explicitNewMatterRef = useRef(Boolean(initialRoute.isNewMatter));
	const [selectedMemberId, setSelectedMemberId] = useState<string>("auto");
	const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>("");
	const [composerText, setComposerText] = useState("");
	const [feedbackText, setFeedbackText] = useState("");
	const [dialogInput, setDialogInput] = useState("");
	const [streamingDelta, setStreamingDelta] = useState("");
	const [sseConnected, setSseConnected] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [errorBanner, setErrorBanner] = useState<string | null>(null);
	const [noticeBanner, setNoticeBanner] = useState<string | null>(null);

	const [progressByMatter, setProgressByMatter] = useState<Record<string, MatterProgressDto>>({});
	const [progressStartedAt, setProgressStartedAt] = useState<Record<string, number>>({});
	const [nowMs, setNowMs] = useState(() => Date.now());

	const [newWsName, setNewWsName] = useState("");
	const [newWsPath, setNewWsPath] = useState("");

	const [showAddMember, setShowAddMember] = useState(false);
	const [newMemberName, setNewMemberName] = useState("");
	const [newMemberTitle, setNewMemberTitle] = useState("");
	const [newMemberResp, setNewMemberResp] = useState("");
	const [newMemberKeywords, setNewMemberKeywords] = useState("");
	const [newMemberSkills, setNewMemberSkills] = useState("");
	const [newMemberPrimary, setNewMemberPrimary] = useState(false);

	const [showImportMember, setShowImportMember] = useState(false);
	const [importMarkdown, setImportMarkdown] = useState("");
	const [exportedPackage, setExportedPackage] = useState<{
		id: string;
		filename: string;
		markdown: string;
	} | null>(null);
	const [expandedMemoryMemberId, setExpandedMemoryMemberId] = useState<string | null>(null);

	const [memoryDraftOpen, setMemoryDraftOpen] = useState(false);
	const [memoryDraftText, setMemoryDraftText] = useState("");
	const [memoryDraftScope, setMemoryDraftScope] = useState<"role_general" | "project_private">("role_general");

	const composerRef = useRef<HTMLTextAreaElement | null>(null);
	const activeTabRef = useRef<NavTab>(activeTab);
	activeTabRef.current = activeTab;

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
		setSelectedWorkspaceId((prev) => prev || data.workspaces[0]?.id || "");
		setSelectedDeliverableId((prev) => prev ?? data.deliverables[0]?.id ?? null);
	}, []);

	const refreshDetail = useCallback(async (matterId: string | null) => {
		if (!matterId) {
			setMatterDetail(null);
			return;
		}
		const detail = await fetchMatterDetail(matterId);
		setMatterDetail(detail);
	}, []);

	useEffect(() => {
		void refreshBootstrap().catch((err: unknown) => {
			setErrorBanner(err instanceof Error ? err.message : String(err));
		});
	}, [refreshBootstrap]);

	useEffect(() => {
		void refreshDetail(selectedMatterId).catch(() => {});
	}, [selectedMatterId, refreshDetail]);

	const activeProgressKeys = Object.keys(progressByMatter);
	useEffect(() => {
		if (activeProgressKeys.length === 0) return;
		const timer = setInterval(() => setNowMs(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [activeProgressKeys.length]);

	useEffect(() => {
		const es = new EventSource("/api/events");
		es.addEventListener("connected", () => setSseConnected(true));
		es.addEventListener("text_delta", (ev) => {
			const data = JSON.parse((ev as MessageEvent).data) as { matterId: string; delta: string };
			if (data.matterId === selectedMatterId) {
				setStreamingDelta((prev) => prev + data.delta);
			}
		});
		es.addEventListener("matter_progress", (ev) => {
			const data = JSON.parse((ev as MessageEvent).data) as MatterProgressDto;
			setProgressByMatter((prev) => ({ ...prev, [data.matterId]: data }));
			setProgressStartedAt((prev) => (prev[data.matterId] ? prev : { ...prev, [data.matterId]: Date.now() }));
			if (data.stage === "starting") {
				void refreshBootstrap();
				if (data.matterId === selectedMatterId) {
					void refreshDetail(data.matterId);
				}
			}
		});
		es.addEventListener("matter_settled", (ev) => {
			const data = JSON.parse((ev as MessageEvent).data) as {
				matterId: string;
				deliverable?: { id?: string; title?: string } | null;
			};
			setStreamingDelta("");
			setProgressByMatter((prev) => {
				const next = { ...prev };
				delete next[data.matterId];
				return next;
			});
			setProgressStartedAt((prev) => {
				const next = { ...prev };
				delete next[data.matterId];
				return next;
			});
			if (data.deliverable?.id) {
				setSelectedDeliverableId(data.deliverable.id);
				if (activeTabRef.current === "deliverables") {
					window.history.replaceState(
						null,
						"",
						formatHashRoute({ tab: "deliverables", deliverableId: data.deliverable.id }),
					);
				}
				setNoticeBanner(`✓ 交付已完成：「${data.deliverable.title ?? "新成果"}」已归拢到「交付给我」`);
			}
			void refreshBootstrap();
			if (selectedMatterId === data.matterId) {
				void refreshDetail(data.matterId);
			}
		});
		es.addEventListener("matter_failed", (ev) => {
			const data = JSON.parse((ev as MessageEvent).data) as { matterId: string; error?: string };
			setStreamingDelta("");
			setProgressByMatter((prev) => {
				const next = { ...prev };
				delete next[data.matterId];
				return next;
			});
			setProgressStartedAt((prev) => {
				const next = { ...prev };
				delete next[data.matterId];
				return next;
			});
			if (data.error) {
				setErrorBanner(`执行未完成：${data.error}`);
			}
			void refreshBootstrap();
			if (selectedMatterId === data.matterId) {
				void refreshDetail(data.matterId);
			}
		});
		const handleSync = () => {
			void refreshBootstrap();
			if (selectedMatterId) {
				void refreshDetail(selectedMatterId);
			}
		};
		for (const evtName of [
			"matter_started",
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
	}, [refreshBootstrap, refreshDetail, selectedMatterId]);

	const activeDeliverable: DeliverableDto | null = useMemo(() => {
		if (!bootstrap || bootstrap.deliverables.length === 0) return null;
		return bootstrap.deliverables.find((d) => d.id === selectedDeliverableId) ?? bootstrap.deliverables[0] ?? null;
	}, [bootstrap, selectedDeliverableId]);

	const activeDeliverableWorkspaceId = useMemo(() => {
		if (!bootstrap || !activeDeliverable) return null;
		return bootstrap.matters.find((m) => m.id === activeDeliverable.matterId)?.workspaceId ?? null;
	}, [bootstrap, activeDeliverable]);

	const siblingVersions = useMemo(() => {
		if (!bootstrap || !activeDeliverable) return [];
		return bootstrap.deliverables
			.filter((d) => d.matterId === activeDeliverable.matterId && d.title === activeDeliverable.title)
			.sort((a, b) => a.version - b.version);
	}, [bootstrap, activeDeliverable]);

	const primaryContact = useMemo(() => {
		if (!bootstrap) return null;
		if (matterDetail?.matter.leadMemberId) {
			return bootstrap.members.find((m) => m.id === matterDetail.matter.leadMemberId) ?? null;
		}
		return bootstrap.members.find((m) => m.isPrimaryContact) ?? bootstrap.members[0] ?? null;
	}, [bootstrap, matterDetail]);

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

	const memberName = (id: string) => bootstrap?.members.find((m) => m.id === id)?.displayName ?? id;

	const workspaceName = (id: string | null) =>
		id ? (bootstrap?.workspaces.find((w) => w.id === id)?.name ?? id) : null;

	const starterTasks = useMemo(() => {
		const wsName = selectedWorkspace?.name;
		const engMember = bootstrap?.members.find((m) => m.templateId === "engineering-manager");
		const pmMember = bootstrap?.members.find((m) => m.templateId === "product-manager");
		const qaMember = bootstrap?.members.find((m) => m.templateId === "qa-manager");

		return [
			{
				id: "starter-eng",
				roleLabel: engMember?.displayName ?? "研发经理",
				memberId: engMember?.id,
				title: wsName ? `梳理「${wsName}」代码结构与关键入口` : "规划项目目录结构与模块边界",
				desc: wsName ? "只读分析技术栈、核心目录、模块职责与启动方式" : "输出清晰的工程架构与核心模块划分",
				prompt: wsName
					? `请只读梳理「${wsName}」仓库的目录结构、核心模块、技术栈与本地启动方式，输出一份简明工程概览文档。`
					: "请帮我设计一个 TypeScript 全栈项目的目录结构与核心模块划分方案，说明各目录职责与关键边界。",
			},
			{
				id: "starter-pm",
				roleLabel: pmMember?.displayName ?? "产品经理",
				memberId: pmMember?.id,
				title: wsName ? `分析「${wsName}」现有功能与优化点` : "梳理 MVP 产品方案与优先级",
				desc: wsName ? "总结当前已实现的能力与最值得优先改进的 3 件事" : "拆解首期核心流程、页面结构与验收目标",
				prompt: wsName
					? `请先阅读「${wsName}」仓库文档与主要源码，梳理当前已实现的功能清单，并给出下一步最值得优先推进的 3 个产品改进建议。`
					: "我想做一个面向个人团队的 AI 协作工作台，请帮我梳理 MVP 核心使用流程、关键页面与首期优先级。",
			},
			{
				id: "starter-qa",
				roleLabel: qaMember?.displayName ?? "测试经理",
				memberId: qaMember?.id,
				title: wsName ? `检查「${wsName}」测试覆盖与验收清单` : "制定上线验收清单与测试策略",
				desc: wsName ? "盘点已有测试与运行命令，输出核心链路验收建议" : "涵盖主流程验证、边界条件与回归测试方案",
				prompt: wsName
					? `请检查「${wsName}」仓库现有的测试文件、测试命令与覆盖范围，整理一份关键功能路径验收清单与潜在风险点。`
					: "请帮我制定一套精简可执行的功能上线验收清单，覆盖核心流程、异常恢复与自动化回归检查。",
			},
		];
	}, [bootstrap, selectedWorkspace]);

	const dispatchPromptText = async (
		promptText: string,
		options?: { preferredMemberId?: string; forceNewMatter?: boolean; deliverableTitle?: string },
	) => {
		const text = promptText.trim();
		if (!text || submitting) return;
		setSubmitting(true);
		setErrorBanner(null);
		setNoticeBanner(null);
		try {
			const preferredMemberId =
				options?.preferredMemberId ?? (selectedMemberId === "auto" ? undefined : selectedMemberId);
			const shouldCreateNew = options?.forceNewMatter || !selectedMatterId;
			let targetMatterId = selectedMatterId;

			if (!shouldCreateNew && targetMatterId) {
				await postMatterMessage(targetMatterId, {
					prompt: text,
					preferredMemberId,
					deliverableTitle: options?.deliverableTitle,
				});
			} else {
				const created = await createMatter({
					prompt: text,
					preferredMemberId,
					workspaceId: selectedWorkspaceId || undefined,
				});
				targetMatterId = created.matter.id;
				explicitNewMatterRef.current = false;
				setSelectedMatterId(created.matter.id);
				if (activeTab === "chats") {
					window.history.replaceState(null, "", formatHashRoute({ tab: "chats", matterId: created.matter.id }));
				}
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

	const handleSendPrompt = async () => {
		const isModifyingDeliverable =
			Boolean(selectedMatterId && activeDeliverable) && composerText.trim().startsWith("修改");
		await dispatchPromptText(composerText, {
			deliverableTitle: isModifyingDeliverable ? activeDeliverable?.title : undefined,
		});
	};

	const handleComposerKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
			e.preventDefault();
			void handleSendPrompt();
		}
	};

	const handleDeliverableFeedback = async () => {
		if (!activeDeliverable || !feedbackText.trim()) return;
		await submitDeliverableFeedback(activeDeliverable.id, feedbackText.trim());
		setFeedbackText("");
		setNoticeBanner("验收反馈已保存");
		await refreshBootstrap();
	};

	const handleSaveMemoryFromDeliverable = async () => {
		if (!activeDeliverable || !memoryDraftText.trim()) return;
		await saveMemberMemory({
			memberId: activeDeliverable.memberId,
			content: memoryDraftText.trim(),
			scope: memoryDraftScope,
			workspaceId: memoryDraftScope === "project_private" ? (activeDeliverableWorkspaceId ?? undefined) : undefined,
			sourceMatterId: activeDeliverable.matterId,
		});
		setMemoryDraftText("");
		setMemoryDraftOpen(false);
		setNoticeBanner(`已沉淀为「${memberName(activeDeliverable.memberId)}」的经验记忆`);
		await refreshBootstrap();
	};

	const handleAddWorkspace = async () => {
		if (!newWsName.trim() || !newWsPath.trim()) return;
		setErrorBanner(null);
		try {
			await addWorkspace({ name: newWsName.trim(), repoPath: newWsPath.trim() });
			setNewWsName("");
			setNewWsPath("");
			setNoticeBanner("项目工作区已绑定");
			await refreshBootstrap();
		} catch (err: unknown) {
			setErrorBanner(err instanceof Error ? err.message : String(err));
		}
	};

	const handleCreateMember = async () => {
		if (!newMemberName.trim() || !newMemberTitle.trim()) return;
		setErrorBanner(null);
		try {
			const res = await createMember({
				name: newMemberName.trim(),
				title: newMemberTitle.trim(),
				responsibilities: newMemberResp.trim() || undefined,
				keywords: splitTagsInput(newMemberKeywords),
				skills: splitTagsInput(newMemberSkills),
				isPrimaryContact: newMemberPrimary,
			});
			setNewMemberName("");
			setNewMemberTitle("");
			setNewMemberResp("");
			setNewMemberKeywords("");
			setNewMemberSkills("");
			setNewMemberPrimary(false);
			setShowAddMember(false);
			setNoticeBanner(`新同事「${res.member.displayName}」已加入团队`);
			await refreshBootstrap();
		} catch (err: unknown) {
			setErrorBanner(err instanceof Error ? err.message : String(err));
		}
	};

	const handleSetPrimary = async (memberId: string) => {
		await setPrimaryMember(memberId);
		setNoticeBanner(`已将「${memberName(memberId)}」设为默认主联系人`);
		await refreshBootstrap();
	};

	const handleExportMember = async (memberId: string) => {
		const pkg = await exportMemberPackage(memberId);
		setExportedPackage(pkg);
	};

	const handleImportMember = async () => {
		if (!importMarkdown.trim()) return;
		setErrorBanner(null);
		try {
			const res = await importMemberPackage(importMarkdown);
			setImportMarkdown("");
			setShowImportMember(false);
			setNoticeBanner(`已导入角色「${res.member.displayName}」`);
			await refreshBootstrap();
		} catch (err: unknown) {
			setErrorBanner(err instanceof Error ? err.message : String(err));
		}
	};

	const handleImportFileChange = (e: ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (!file) return;
		const reader = new FileReader();
		reader.onload = () => {
			if (typeof reader.result === "string") {
				setImportMarkdown(reader.result);
			}
		};
		reader.readAsText(file);
	};

	const handleDownloadExportedPackage = () => {
		if (!exportedPackage) return;
		const blob = new Blob([exportedPackage.markdown], { type: "text/markdown;charset=utf-8" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = exportedPackage.filename;
		a.click();
		URL.revokeObjectURL(url);
	};

	const linkedPreview = useMemo(() => {
		if (!bootstrap || !activeDeliverable) return null;
		return bootstrap.previews.find((p) => p.deliverableId === activeDeliverable.id) ?? null;
	}, [bootstrap, activeDeliverable]);

	const viewUrl = activeDeliverable?.serviceUrl ?? linkedPreview?.url ?? null;
	const activeMatterProgress = selectedMatterId ? (progressByMatter[selectedMatterId] ?? null) : null;
	const runningProgressList = Object.entries(progressByMatter);

	return (
		<div className="app-shell">
			<header className="topbar">
				<div className="brand">
					<span className="brand-mark">PA</span>
					<span>Personal Agent</span>
				</div>
				<div className="topbar-meta">
					<span>Pi RPC · kimi-for-coding</span>
					<span className={`pill ${sseConnected ? "live" : ""}`}>
						{sseConnected ? "实时连接中" : "连接恢复中"}
					</span>
				</div>
			</header>

			<div className="workspace-grid">
				<aside className="left-nav">
					<div className="nav-items">
						<button
							type="button"
							className={`nav-btn ${activeTab === "deliverables" ? "active" : ""}`}
							onClick={() =>
								navigateRoute({ tab: "deliverables", deliverableId: selectedDeliverableId ?? undefined })
							}
						>
							<span>交付给我</span>
							<span className="pill">{bootstrap?.deliverables.length ?? 0}</span>
						</button>
						<button
							type="button"
							className={`nav-btn ${activeTab === "chats" ? "active" : ""}`}
							onClick={() =>
								navigateRoute({
									tab: "chats",
									matterId: selectedMatterId ?? undefined,
									isNewMatter: explicitNewMatterRef.current && selectedMatterId === null,
								})
							}
						>
							<span>和同事聊</span>
							<span className="pill">{bootstrap?.matters.length ?? 0}</span>
						</button>
						<button
							type="button"
							className={`nav-btn ${activeTab === "team" ? "active" : ""}`}
							onClick={() => navigateRoute({ tab: "team" })}
						>
							<span>我的团队</span>
							<span className="pill">{bootstrap?.members.length ?? 0}</span>
						</button>
						<button
							type="button"
							className={`nav-btn ${activeTab === "materials" ? "active" : ""}`}
							onClick={() => navigateRoute({ tab: "materials" })}
						>
							<span>已有资料</span>
							<span className="pill">{bootstrap?.workspaces.length ?? 0}</span>
						</button>
					</div>

					<div className="colleagues-drawer">
						<button type="button" className="colleagues-toggle" onClick={() => setColleaguesOpen((v) => !v)}>
							<span>我的同事 · {bootstrap?.members.length ?? 0} 位</span>
							<span>{colleaguesOpen ? "▾" : "▸"}</span>
						</button>
						{colleaguesOpen && bootstrap && (
							<div className="colleague-list">
								{bootstrap.members.map((member) => (
									<button
										key={member.id}
										type="button"
										className={`colleague-item ${selectedMemberId === member.id ? "active" : ""}`}
										onClick={() => setSelectedMemberId(member.id)}
									>
										<div className="colleague-name">
											{member.displayName} {member.isPrimaryContact ? "· 主联系" : ""}
										</div>
										<div className="colleague-sub">{member.model}</div>
									</button>
								))}
							</div>
						)}
					</div>
				</aside>

				<main className="center-pane">
					{errorBanner && (
						<div className="approval-card banner-gap">
							<div className="banner-row">
								<span>
									<strong>操作提示：</strong> {errorBanner}
								</span>
								<button type="button" className="btn-inline" onClick={() => setErrorBanner(null)}>
									关闭
								</button>
							</div>
						</div>
					)}
					{noticeBanner && (
						<div className="notice-card banner-gap">
							<div className="banner-row">
								<span>{noticeBanner}</span>
								<button type="button" className="btn-inline" onClick={() => setNoticeBanner(null)}>
									知道了
								</button>
							</div>
						</div>
					)}

					{runningProgressList.length > 0 && (
						<div className="progress-stack">
							{runningProgressList.map(([mId, prog]) => {
								const matterTitle = bootstrap?.matters.find((m) => m.id === mId)?.title ?? "正在推进的事项";
								const started = progressStartedAt[mId] ?? nowMs;
								const elapsed = Math.max(0, Math.floor((nowMs - started) / 1000));
								return (
									<ProgressCard
										key={mId}
										title={matterTitle}
										progress={prog}
										elapsedSeconds={elapsed}
										onOpenChat={() => navigateRoute({ tab: "chats", matterId: mId })}
									/>
								);
							})}
						</div>
					)}

					{activeTab === "deliverables" && (
						<>
							<div className="pane-header">
								<h1>交付给我</h1>
								<p>成果和反馈留在一起，默认收起内部过程细节</p>
							</div>

							{activeDeliverable ? (
								<div className="featured-card">
									<div className="success-banner">
										<span>✓ 已完成交付 · 由【{memberName(activeDeliverable.memberId)}】产出</span>
										<div className="success-tags">
											{workspaceName(activeDeliverableWorkspaceId) && (
												<span className="pill">仓库：{workspaceName(activeDeliverableWorkspaceId)}</span>
											)}
											<span className="pill">{formatClockTime(activeDeliverable.createdAt)}</span>
										</div>
									</div>

									<h2 className="featured-title">{activeDeliverable.title}</h2>
									<div className="featured-meta">
										<span>{memberName(activeDeliverable.memberId)} 交付</span>
										<span>·</span>
										<span>V{activeDeliverable.version}</span>
										<span>·</span>
										<span className="pill">{activeDeliverable.type}</span>
									</div>

									<div className="deliverable-body">
										<MarkdownView content={activeDeliverable.contentOrPath} />
									</div>

									<div className="actions-row">
										{viewUrl && (
											<a className="btn-primary" href={viewUrl} target="_blank" rel="noreferrer">
												打开查看 →
											</a>
										)}
										<button
											type="button"
											className="btn-secondary"
											onClick={() => {
												setSelectedMatterId(activeDeliverable.matterId);
												setComposerText(`修改「${activeDeliverable.title}」：`);
												composerRef.current?.focus();
											}}
										>
											继续修改
										</button>
										<button
											type="button"
											className="btn-secondary"
											onClick={() => {
												setMemoryDraftOpen((prev) => !prev);
												if (!memoryDraftText) {
													setMemoryDraftText(
														`关于「${activeDeliverable.title}」的做法总结：${activeDeliverable.summary}`,
													);
												}
											}}
										>
											{memoryDraftOpen ? "收起经验沉淀" : "沉淀为角色经验"}
										</button>
									</div>

									{memoryDraftOpen && (
										<div className="memory-draft-box">
											<div className="memory-draft-head">
												<strong>沉淀为「{memberName(activeDeliverable.memberId)}」的后续工作习惯</strong>
												<select
													className="select-sm"
													value={memoryDraftScope}
													onChange={(e) =>
														setMemoryDraftScope(e.target.value as "role_general" | "project_private")
													}
												>
													<option value="role_general">角色通用经验（跨项目可用）</option>
													<option value="project_private">当前项目规范（仅当前仓库生效）</option>
												</select>
											</div>
											<div className="feedback-row">
												<input
													className="input-field"
													value={memoryDraftText}
													onChange={(e) => setMemoryDraftText(e.target.value)}
													placeholder="例如：交付工程文档时优先列出可直接执行的启动命令..."
												/>
												<button
													type="button"
													className="btn-primary"
													onClick={() => void handleSaveMemoryFromDeliverable()}
												>
													保存经验
												</button>
											</div>
										</div>
									)}

									{siblingVersions.length > 1 && (
										<div className="version-bar">
											<span>此前版本</span>
											{siblingVersions.map((ver) => (
												<button
													key={ver.id}
													type="button"
													className={`version-chip ${ver.id === activeDeliverable.id ? "active" : ""}`}
													onClick={() => navigateRoute({ tab: "deliverables", deliverableId: ver.id })}
												>
													V{ver.version}
												</button>
											))}
										</div>
									)}

									<div className="feedback-row">
										<input
											className="input-field"
											value={feedbackText}
											onChange={(e) => setFeedbackText(e.target.value)}
											placeholder={
												activeDeliverable.feedback
													? `上次反馈：${activeDeliverable.feedback}`
													: "记录这条交付的验收反馈..."
											}
										/>
										<button
											type="button"
											className="btn-secondary"
											onClick={() => void handleDeliverableFeedback()}
										>
											保存反馈
										</button>
									</div>
								</div>
							) : (
								<div className="featured-card onboarding-card">
									<div className="onboarding-head">
										<h2>3 步开始让 AI 团队为你工作</h2>
										<p>
											选好项目仓库后，点下面任意一个示范任务即可立即开始；或者在右下角用自然语言直接向团队布置工作。
										</p>
									</div>

									<div className="onboarding-steps">
										<div className="onboarding-step">
											<div className="step-num">1</div>
											<div className="step-body">
												<div className="step-title">
													团队已就绪（{bootstrap?.members.length ?? 0} 位成员）
												</div>
												<div className="step-desc">
													默认主联系人：{primaryContact?.displayName ?? "产品经理"}
													；发送任务时会自动按事找人，也可以随时调整团队成员。
												</div>
											</div>
											<button
												type="button"
												className="btn-secondary"
												onClick={() => navigateRoute({ tab: "team" })}
											>
												管理团队
											</button>
										</div>

										<div className="onboarding-step">
											<div className="step-num">2</div>
											<div className="step-body">
												<div className="step-title">选择目标项目仓库</div>
												<div className="step-desc">
													{bootstrap && bootstrap.workspaces.length > 0
														? "点选下方已绑定的仓库，任务会在对应目录中隔离执行："
														: "当前还没有绑定项目仓库，可先绑定一个本地 Git 仓库，或不绑仓库直接对话。"}
												</div>
												{bootstrap && bootstrap.workspaces.length > 0 && (
													<div className="chip-row">
														{bootstrap.workspaces.map((ws) => (
															<button
																key={ws.id}
																type="button"
																className={`choice-chip ${selectedWorkspaceId === ws.id ? "active" : ""}`}
																onClick={() => setSelectedWorkspaceId(ws.id)}
															>
																{ws.name}
															</button>
														))}
														<button
															type="button"
															className={`choice-chip ${selectedWorkspaceId === "" ? "active" : ""}`}
															onClick={() => setSelectedWorkspaceId("")}
														>
															不绑定仓库
														</button>
													</div>
												)}
											</div>
											<button
												type="button"
												className="btn-secondary"
												onClick={() => navigateRoute({ tab: "materials" })}
											>
												+ 绑定仓库
											</button>
										</div>

										<div className="onboarding-step onboarding-step-col">
											<div className="onboarding-step-top">
												<div className="step-num">3</div>
												<div className="step-body">
													<div className="step-title">一键试跑或填入需求</div>
													<div className="step-desc">
														任务派发后，页面顶部与右侧对话栏会实时展示执行进度；完成后成果会自动归拢到这里。
													</div>
												</div>
											</div>

											<div className="starter-grid">
												{starterTasks.map((task) => (
													<div key={task.id} className="starter-card">
														<div className="starter-role">{task.roleLabel}</div>
														<div className="starter-title">{task.title}</div>
														<div className="starter-desc">{task.desc}</div>
														<div className="starter-actions">
															<button
																type="button"
																className="btn-primary btn-sm"
																disabled={submitting}
																onClick={() =>
																	void dispatchPromptText(task.prompt, {
																		preferredMemberId: task.memberId,
																		forceNewMatter: true,
																	})
																}
															>
																立即执行
															</button>
															<button
																type="button"
																className="btn-secondary btn-sm"
																onClick={() => {
																	if (task.memberId) setSelectedMemberId(task.memberId);
																	setSelectedMatterId(null);
																	setComposerText(task.prompt);
																	composerRef.current?.focus();
																}}
															>
																填入微调
															</button>
														</div>
													</div>
												))}
											</div>
										</div>
									</div>
								</div>
							)}

							{bootstrap && bootstrap.deliverables.length > 1 && (
								<div className="list-section">
									{bootstrap.deliverables
										.filter((d) => d.id !== activeDeliverable?.id)
										.map((item) => (
											<button
												type="button"
												key={item.id}
												className="compact-row"
												onClick={() => {
													navigateRoute({ tab: "deliverables", deliverableId: item.id });
													setSelectedMatterId(item.matterId);
												}}
											>
												<div>
													<div style={{ fontWeight: 600, fontSize: 14 }}>
														{item.title} · V{item.version}
													</div>
													<div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
														{memberName(item.memberId)} · {item.summary.slice(0, 80)}
													</div>
												</div>
												<span className="pill">{item.type}</span>
											</button>
										))}
								</div>
							)}

							{bootstrap && bootstrap.previews.length > 0 && (
								<div className="list-section">
									<h3 style={{ margin: "12px 0 4px", fontSize: 14 }}>独立预览服务</h3>
									{bootstrap.previews.map((prev) => (
										<div key={prev.id} className="compact-row" style={{ cursor: "default" }}>
											<div>
												<div style={{ fontWeight: 600, fontSize: 14 }}>{prev.title}</div>
												<div style={{ fontSize: 12, color: "var(--text-muted)" }}>
													{prev.url} · 状态：{prev.status}
												</div>
											</div>
											<div style={{ display: "flex", gap: 8 }}>
												{prev.status === "running" && (
													<>
														<a className="btn-secondary" href={prev.url} target="_blank" rel="noreferrer">
															打开
														</a>
														<button
															type="button"
															className="btn-secondary"
															onClick={() => void stopPreview(prev.id).then(refreshBootstrap)}
														>
															停止
														</button>
													</>
												)}
											</div>
										</div>
									))}
								</div>
							)}
						</>
					)}

					{activeTab === "chats" && (
						<>
							<div className="pane-header">
								<h1>和同事聊</h1>
								<p>按事项组织跨项目推进，不把微信式群聊信息直接堆给用户</p>
							</div>
							{bootstrap && bootstrap.matters.length === 0 ? (
								<div className="featured-card">
									<p style={{ margin: 0, color: "var(--text-secondary)" }}>
										还没有正在推进的事项。在右侧输入框直接描述需求，或回到「交付给我」选择一个示范任务即可开始。
									</p>
								</div>
							) : (
								<div className="list-section">
									{bootstrap?.matters.map((matter) => {
										const prog = progressByMatter[matter.id];
										return (
											<button
												type="button"
												key={matter.id}
												className="compact-row"
												onClick={() => navigateRoute({ tab: "chats", matterId: matter.id })}
												style={{
													borderColor: matter.id === selectedMatterId ? "var(--accent)" : undefined,
												}}
											>
												<div>
													<div style={{ fontWeight: 600, fontSize: 14 }}>{matter.title}</div>
													<div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
														牵头：{matter.leadMemberId ? memberName(matter.leadMemberId) : "自动路由"}
														{prog ? ` · ${prog.label}` : ""}
													</div>
												</div>
												<span className="pill">
													{prog
														? STAGE_LABELS[prog.stage]
														: (STATUS_LABELS[matter.status] ?? matter.status)}
												</span>
											</button>
										);
									})}
								</div>
							)}
						</>
					)}

					{activeTab === "team" && (
						<>
							<div className="pane-header-row">
								<div className="pane-header">
									<h1>我的团队</h1>
									<p>查看角色分工与积累经验，也可以新增自定义角色，或导入导出脱敏角色能力包</p>
								</div>
								<div className="actions-row" style={{ marginTop: 0 }}>
									<button
										type="button"
										className="btn-primary"
										onClick={() => {
											setShowAddMember((v) => !v);
											setShowImportMember(false);
										}}
									>
										+ 新增角色
									</button>
									<button
										type="button"
										className="btn-secondary"
										onClick={() => {
											setShowImportMember((v) => !v);
											setShowAddMember(false);
										}}
									>
										导入角色包
									</button>
								</div>
							</div>

							{showAddMember && (
								<div className="featured-card form-card">
									<h3 className="section-title">组建新角色</h3>
									<div className="form-grid">
										<input
											className="input-field"
											placeholder="角色名称（如：架构师）"
											value={newMemberName}
											onChange={(e) => setNewMemberName(e.target.value)}
										/>
										<input
											className="input-field"
											placeholder="职位头衔（如：System Architect）"
											value={newMemberTitle}
											onChange={(e) => setNewMemberTitle(e.target.value)}
										/>
									</div>
									<textarea
										rows={2}
										className="composer-input"
										placeholder="核心职责描述（例如：负责系统架构选型、模块解耦和性能瓶颈排查）"
										value={newMemberResp}
										onChange={(e) => setNewMemberResp(e.target.value)}
									/>
									<div className="form-grid">
										<input
											className="input-field"
											placeholder="路由关键词（逗号分隔，如：架构,性能,重构）"
											value={newMemberKeywords}
											onChange={(e) => setNewMemberKeywords(e.target.value)}
										/>
										<input
											className="input-field"
											placeholder="能力技能（逗号分隔，如：architecture-review,rfc）"
											value={newMemberSkills}
											onChange={(e) => setNewMemberSkills(e.target.value)}
										/>
									</div>
									<div className="form-footer">
										<label className="checkbox-label">
											<input
												type="checkbox"
												checked={newMemberPrimary}
												onChange={(e) => setNewMemberPrimary(e.target.checked)}
											/>
											<span>设为默认主联系人</span>
										</label>
										<div style={{ display: "flex", gap: 8 }}>
											<button
												type="button"
												className="btn-secondary"
												onClick={() => setShowAddMember(false)}
											>
												取消
											</button>
											<button
												type="button"
												className="btn-primary"
												onClick={() => void handleCreateMember()}
											>
												加入团队
											</button>
										</div>
									</div>
								</div>
							)}

							{showImportMember && (
								<div className="featured-card form-card">
									<h3 className="section-title">导入团队成员能力包（.md）</h3>
									<p className="muted-hint">
										支持粘贴或选择导出的角色 Markdown 模板。导入后立即注册到当前团队，不包含他人私有项目记忆。
									</p>
									<label className="file-upload-label">
										<span>选择本地 .md 文件：</span>
										<input type="file" accept=".md,text/markdown" onChange={handleImportFileChange} />
									</label>
									<textarea
										rows={6}
										className="composer-input mono-input"
										placeholder="粘贴角色模板 Markdown（含 --- frontmatter ---）..."
										value={importMarkdown}
										onChange={(e) => setImportMarkdown(e.target.value)}
									/>
									<div className="actions-row">
										<button type="button" className="btn-primary" onClick={() => void handleImportMember()}>
											确认导入
										</button>
										<button
											type="button"
											className="btn-secondary"
											onClick={() => setShowImportMember(false)}
										>
											取消
										</button>
									</div>
								</div>
							)}

							{exportedPackage && (
								<div className="featured-card form-card">
									<div className="banner-row">
										<h3 className="section-title">已导出脱敏能力包：{exportedPackage.filename}</h3>
										<button type="button" className="btn-inline" onClick={() => setExportedPackage(null)}>
											关闭
										</button>
									</div>
									<p className="muted-hint">
										已自动剥离公司私有规范与项目私有记忆，仅保留角色职责、技能与工作原则。
									</p>
									<textarea
										rows={7}
										readOnly
										className="composer-input mono-input"
										value={exportedPackage.markdown}
									/>
									<div className="actions-row">
										<button type="button" className="btn-primary" onClick={handleDownloadExportedPackage}>
											下载 .md 文件
										</button>
										<button
											type="button"
											className="btn-secondary"
											onClick={() => {
												void navigator.clipboard.writeText(exportedPackage.markdown);
												setNoticeBanner("能力包 Markdown 已复制到剪贴板");
											}}
										>
											复制内容
										</button>
									</div>
								</div>
							)}

							<div className="team-grid">
								{bootstrap?.members.map((member) => {
									const tpl = templateByRoleId.get(member.templateId);
									const memories = bootstrap.memoriesByMember[member.id] ?? [];
									const isExpanded = expandedMemoryMemberId === member.id;
									return (
										<div key={member.id} className="member-card">
											<div className="member-card-top">
												<div className="member-ident">
													<div className="member-avatar">{member.displayName.slice(0, 1)}</div>
													<div>
														<div className="member-name-row">
															<strong>{member.displayName}</strong>
															{member.isPrimaryContact && <span className="pill live">默认主联系</span>}
														</div>
														<div className="member-sub">
															{member.roleTitle} · {member.model}
														</div>
													</div>
												</div>
												<span className="pill">{memories.length} 条经验</span>
											</div>

											{tpl?.responsibilities && (
												<p className="member-resp">{tpl.responsibilities.split("\n")[0]}</p>
											)}

											{tpl && (tpl.keywords.length > 0 || tpl.skills.length > 0) && (
												<div className="tag-list">
													{tpl.keywords.slice(0, 4).map((kw) => (
														<span key={kw} className="tag-chip">
															#{kw}
														</span>
													))}
													{tpl.skills.map((sk) => (
														<span key={sk} className="tag-chip skill">
															{sk}
														</span>
													))}
												</div>
											)}

											<div className="actions-row">
												<button
													type="button"
													className="btn-primary btn-sm"
													onClick={() => {
														setSelectedMemberId(member.id);
														explicitNewMatterRef.current = true;
														setSelectedMatterId(null);
														composerRef.current?.focus();
													}}
												>
													向 TA 派活
												</button>
												{!member.isPrimaryContact && (
													<button
														type="button"
														className="btn-secondary btn-sm"
														onClick={() => void handleSetPrimary(member.id)}
													>
														设为主联系
													</button>
												)}
												<button
													type="button"
													className="btn-secondary btn-sm"
													onClick={() => void handleExportMember(member.id)}
												>
													导出能力包
												</button>
												{memories.length > 0 && (
													<button
														type="button"
														className="btn-inline"
														onClick={() => setExpandedMemoryMemberId(isExpanded ? null : member.id)}
													>
														{isExpanded ? "收起经验" : `查看经验 (${memories.length})`}
													</button>
												)}
											</div>

											{isExpanded && memories.length > 0 && (
												<div className="memory-list">
													{memories.map((mem) => (
														<div key={mem.id} className="memory-item">
															<span className="pill">{MEMORY_SCOPE_LABELS[mem.scope] ?? mem.scope}</span>
															<span>{mem.content}</span>
														</div>
													))}
												</div>
											)}
										</div>
									);
								})}
							</div>
						</>
					)}

					{activeTab === "materials" && (
						<>
							<div className="pane-header">
								<h1>已有资料与工作区</h1>
								<p>仓库自身维护的信息以仓库为准；角色私有记忆与可分享模板物理隔离</p>
							</div>

							<div className="featured-card">
								<h3 style={{ margin: "0 0 10px", fontSize: 15 }}>登记项目 Git 工作区</h3>
								<div className="feedback-row">
									<input
										className="input-field"
										placeholder="项目名称（如 order-service）"
										value={newWsName}
										onChange={(e) => setNewWsName(e.target.value)}
									/>
									<input
										className="input-field"
										placeholder="本地仓库绝对路径"
										value={newWsPath}
										onChange={(e) => setNewWsPath(e.target.value)}
									/>
									<button type="button" className="btn-primary" onClick={() => void handleAddWorkspace()}>
										绑定
									</button>
								</div>
							</div>

							<div className="list-section">
								{bootstrap?.workspaces.map((ws) => (
									<div key={ws.id} className="compact-row" style={{ cursor: "default" }}>
										<div>
											<div style={{ fontWeight: 600, fontSize: 14 }}>
												{ws.name} ({ws.defaultBranch})
											</div>
											<div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
												{ws.repoPath}
											</div>
										</div>
										<button
											type="button"
											className="btn-secondary btn-sm"
											onClick={() => {
												setSelectedWorkspaceId(ws.id);
												setSelectedMatterId(null);
												explicitNewMatterRef.current = true;
												navigateRoute({
													tab: "deliverables",
													deliverableId: selectedDeliverableId ?? undefined,
												});
												composerRef.current?.focus();
											}}
										>
											{selectedWorkspaceId === ws.id ? "当前已选中" : "在此仓库派活"}
										</button>
									</div>
								))}
							</div>
						</>
					)}
				</main>

				<aside className="right-pane">
					<div className="contact-header">
						<div>
							<div className="contact-title">
								{primaryContact ? `${primaryContact.displayName} · ${primaryContact.roleTitle}` : "主要联系人"}
							</div>
							<div className="contact-sub">
								{matterDetail ? `当前事项：${matterDetail.matter.title}` : "新事项：发送后将自动按事找人"}
							</div>
						</div>
						<select
							className="select-sm"
							value={selectedMemberId}
							onChange={(e) => setSelectedMemberId(e.target.value)}
						>
							<option value="auto">按事找人</option>
							{bootstrap?.members.map((m) => (
								<option key={m.id} value={m.id}>
									指定：{m.displayName}
								</option>
							))}
						</select>
					</div>

					<div className="messages-scroll">
						{activeMatterProgress && selectedMatterId && (
							<ProgressCard
								title="正在执行中"
								progress={activeMatterProgress}
								elapsedSeconds={Math.max(
									0,
									Math.floor((nowMs - (progressStartedAt[selectedMatterId] ?? nowMs)) / 1000),
								)}
							/>
						)}

						{activeDialogs.map((dlg) => (
							<div key={dlg.id} className="approval-card">
								<h4>
									{dlg.memberName} 请求确认：{dlg.request.title}
								</h4>
								{dlg.request.message && <p style={{ margin: "0 0 8px" }}>{dlg.request.message}</p>}
								{dlg.request.method === "confirm" && (
									<div style={{ display: "flex", gap: 8 }}>
										<button
											type="button"
											className="btn-primary"
											onClick={() => void respondToDialog(dlg.id, { confirmed: true })}
										>
											允许继续
										</button>
										<button
											type="button"
											className="btn-secondary"
											onClick={() => void respondToDialog(dlg.id, { confirmed: false })}
										>
											拒绝
										</button>
									</div>
								)}
								{dlg.request.method === "select" && dlg.request.options && (
									<div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
										{dlg.request.options.map((opt) => (
											<button
												key={opt}
												type="button"
												className="btn-secondary"
												onClick={() => void respondToDialog(dlg.id, { value: opt })}
											>
												{opt}
											</button>
										))}
									</div>
								)}
								{(dlg.request.method === "input" || dlg.request.method === "editor") && (
									<div style={{ display: "flex", gap: 6 }}>
										<input
											className="input-field"
											value={dialogInput}
											onChange={(e) => setDialogInput(e.target.value)}
											placeholder={dlg.request.placeholder ?? "输入答复..."}
										/>
										<button
											type="button"
											className="btn-primary"
											onClick={() => {
												void respondToDialog(dlg.id, { value: dialogInput });
												setDialogInput("");
											}}
										>
											提交
										</button>
									</div>
								)}
							</div>
						))}

						{(!matterDetail || matterDetail.userMessages.length === 0) && !activeMatterProgress && (
							<div className="chat-empty-hint">
								<div className="chat-empty-title">准备就绪</div>
								<p>
									在下方输入你的需求（支持 <strong>Enter 发送</strong>，Shift+Enter
									换行）。系统会根据任务内容自动路由最合适的同事，在右侧实时汇报进度，并在完成后将最终结果归拢到左侧「交付给我」。
								</p>
							</div>
						)}

						{matterDetail?.userMessages.map((msg) => (
							<div key={msg.id} className={`bubble ${msg.senderType === "user" ? "user" : "member"}`}>
								<div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>
									{msg.senderType === "user" ? "我" : memberName(msg.senderId)} ·{" "}
									{formatClockTime(msg.createdAt)}
								</div>
								{msg.senderType === "member" ? <MarkdownView content={msg.content} /> : msg.content}
							</div>
						))}

						{streamingDelta && (
							<div className="bubble member">
								<div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>正在整理回复...</div>
								<MarkdownView content={streamingDelta} />
							</div>
						)}
					</div>

					<div className="collab-collapse">
						<button type="button" className="collab-toggle" onClick={() => setCollabOpen((v) => !v)}>
							协作对话与过程通知（
							{(matterDetail?.internalCollabMessages.length ?? 0) + (matterDetail?.noticeMessages.length ?? 0)}）{" "}
							{collabOpen ? "▾" : "▸"}
						</button>
						{collabOpen && matterDetail && (
							<div className="collab-log">
								{[...matterDetail.internalCollabMessages, ...matterDetail.noticeMessages].map((entry) => (
									<div key={entry.id}>
										<strong>[{entry.channel}]</strong> {memberName(entry.senderId)}：{entry.content}
									</div>
								))}
							</div>
						)}
					</div>

					<div className="composer">
						<div className="composer-controls">
							<select
								className="select-sm"
								value={selectedWorkspaceId}
								onChange={(e) => setSelectedWorkspaceId(e.target.value)}
							>
								<option value="">不绑定仓库</option>
								{bootstrap?.workspaces.map((ws) => (
									<option key={ws.id} value={ws.id}>
										仓库：{ws.name}
									</option>
								))}
							</select>
							<button
								type="button"
								className={`btn-secondary btn-sm ${selectedMatterId === null ? "btn-active" : ""}`}
								onClick={() => {
									explicitNewMatterRef.current = true;
									setSelectedMatterId(null);
									if (activeTab === "chats") {
										navigateRoute({ tab: "chats", isNewMatter: true });
									}
								}}
							>
								{selectedMatterId === null ? "新事项模式" : "+ 切到新事项"}
							</button>
							<span className="composer-target">
								{selectedMemberId === "auto" ? "自动找人" : `指定：${memberName(selectedMemberId)}`}
							</span>
						</div>
						<div className="composer-row">
							<textarea
								ref={composerRef}
								rows={2}
								className="composer-input"
								value={composerText}
								onChange={(e) => setComposerText(e.target.value)}
								onKeyDown={handleComposerKeyDown}
								placeholder={
									selectedMatterId
										? "继续补充要求或修改意见（Enter 发送）..."
										: "描述要交付的事，如：帮我梳理这个项目的模块结构（Enter 发送）..."
								}
							/>
							<button
								type="button"
								className="btn-primary"
								disabled={submitting || !composerText.trim()}
								onClick={() => void handleSendPrompt()}
							>
								{submitting ? "派发中" : "发送"}
							</button>
						</div>
					</div>
				</aside>
			</div>
		</div>
	);
}
