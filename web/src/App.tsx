import { type ChangeEvent, type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	abortMatter,
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
	type PreviewServiceDto,
	postMatterMessage,
	type RoleTemplateDto,
	respondToDialog,
	saveMemberMemory,
	setPrimaryMember,
	stopPreview,
	submitDeliverableFeedback,
	type TeamMemberDto,
	updateMatterWorkspace,
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

const BOT_PALETTE = [
	{ bg: "#35b49b", tilt: "0deg" },
	{ bg: "#4e6df5", tilt: "-7deg" },
	{ bg: "#8b5cf6", tilt: "6deg" },
	{ bg: "#ec6a2c", tilt: "-4deg" },
	{ bg: "#0891b2", tilt: "5deg" },
];

function getBotTheme(index: number): { bg: string; tilt: string } {
	return BOT_PALETTE[index % BOT_PALETTE.length] ?? { bg: "#35b49b", tilt: "0deg" };
}

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

function BotFaceIcon(props: { bg: string; tilt?: string; size?: "sm" | "md" | "lg" }) {
	const sizeClass = props.size === "sm" ? "bot-avatar-sm" : props.size === "lg" ? "bot-avatar-lg" : "bot-avatar-md";
	return (
		<span
			className={`bot-avatar ${sizeClass}`}
			style={{ background: props.bg, transform: props.tilt ? `rotate(${props.tilt})` : undefined }}
		>
			<svg viewBox="0 0 24 24" className="bot-eyes" aria-hidden="true">
				<rect x="7.5" y="7.5" width="3" height="9" rx="1.5" fill="currentColor" />
				<rect x="13.5" y="7.5" width="3" height="9" rx="1.5" fill="currentColor" />
			</svg>
		</span>
	);
}

function ExploringStatus(props: { progress: MatterProgressDto; elapsedSeconds: number; onAbort?: () => void }) {
	const activeIndex = STAGE_ORDER.indexOf(props.progress.stage);
	return (
		<div className="exploring-block">
			<div className="exploring-row">
				<span className="exploring-ring">
					<span className="exploring-dot" />
				</span>
				<span className="exploring-stage">{STAGE_LABELS[props.progress.stage]}</span>
				<span className="exploring-label">{props.progress.label}</span>
				<span className="exploring-time">{props.elapsedSeconds}s</span>
				{props.onAbort && (
					<button type="button" className="btn-stop-pill" onClick={props.onAbort}>
						停止
					</button>
				)}
			</div>
			<div className="exploring-bar">
				{STAGE_ORDER.map((stage, idx) => (
					<span
						key={stage}
						className={`exploring-seg ${idx < activeIndex ? "done" : idx === activeIndex ? "active" : ""}`}
					/>
				))}
			</div>
		</div>
	);
}

function DeliverableCard(props: {
	deliverable: DeliverableDto;
	siblingVersions: DeliverableDto[];
	memberName: string;
	workspaceName: string | null;
	viewUrl: string | null;
	feedbackText: string;
	onFeedbackTextChange: (value: string) => void;
	onSubmitFeedback: () => void;
	onSelectVersion: (deliverableId: string) => void;
	onRequestRevision: () => void;
	onSaveMemory: (content: string, scope: "role_general" | "project_private") => Promise<void>;
	compact?: boolean;
}) {
	const [memoryOpen, setMemoryOpen] = useState(false);
	const [memoryText, setMemoryText] = useState("");
	const [memoryScope, setMemoryScope] = useState<"role_general" | "project_private">("role_general");

	return (
		<div className={`deliverable-card ${props.compact ? "compact" : ""}`}>
			<div className="success-banner">
				<span>✓ 已完成交付 · 由【{props.memberName}】产出</span>
				<div className="success-tags">
					{props.workspaceName && <span className="pill">仓库：{props.workspaceName}</span>}
					<span className="pill">{formatClockTime(props.deliverable.createdAt)}</span>
				</div>
			</div>

			<div className="deliverable-head-row">
				<div>
					<h3 className="deliverable-title">{props.deliverable.title}</h3>
					<div className="featured-meta">
						<span>{props.memberName}</span>
						<span>·</span>
						<span>V{props.deliverable.version}</span>
						<span>·</span>
						<span className="pill">{props.deliverable.type}</span>
					</div>
				</div>
				{props.siblingVersions.length > 1 && (
					<div className="version-bar" style={{ marginTop: 0 }}>
						{props.siblingVersions.map((ver) => (
							<button
								key={ver.id}
								type="button"
								className={`version-chip ${ver.id === props.deliverable.id ? "active" : ""}`}
								onClick={() => props.onSelectVersion(ver.id)}
							>
								V{ver.version}
							</button>
						))}
					</div>
				)}
			</div>

			<div className="deliverable-body">
				<MarkdownView content={props.deliverable.contentOrPath} />
			</div>

			<div className="actions-row">
				{props.viewUrl && (
					<a className="btn-pill-dark" href={props.viewUrl} target="_blank" rel="noreferrer">
						打开查看 →
					</a>
				)}
				<button type="button" className="btn-pill-outline" onClick={props.onRequestRevision}>
					继续修改
				</button>
				<button
					type="button"
					className="btn-pill-outline"
					onClick={() => {
						setMemoryOpen((prev) => !prev);
						if (!memoryText) {
							setMemoryText(`关于「${props.deliverable.title}」的做法总结：${props.deliverable.summary}`);
						}
					}}
				>
					{memoryOpen ? "收起经验沉淀" : "沉淀为角色经验"}
				</button>
			</div>

			{memoryOpen && (
				<div className="memory-draft-box">
					<div className="memory-draft-head">
						<strong>沉淀为「{props.memberName}」的工作习惯</strong>
						<select
							className="select-sm"
							value={memoryScope}
							onChange={(e) => setMemoryScope(e.target.value as "role_general" | "project_private")}
						>
							<option value="role_general">角色通用经验（跨项目可用）</option>
							<option value="project_private">当前项目规范（仅当前仓库生效）</option>
						</select>
					</div>
					<div className="feedback-row">
						<input
							className="input-field"
							value={memoryText}
							onChange={(e) => setMemoryText(e.target.value)}
							placeholder="例如：交付工程文档时优先列出可直接执行的启动命令..."
						/>
						<button
							type="button"
							className="btn-primary btn-sm"
							onClick={() => {
								if (!memoryText.trim()) return;
								void props.onSaveMemory(memoryText.trim(), memoryScope).then(() => {
									setMemoryText("");
									setMemoryOpen(false);
								});
							}}
						>
							保存经验
						</button>
					</div>
				</div>
			)}

			<div className="feedback-row">
				<input
					className="input-field"
					value={props.feedbackText}
					onChange={(e) => props.onFeedbackTextChange(e.target.value)}
					placeholder={
						props.deliverable.feedback ? `上次反馈：${props.deliverable.feedback}` : "记录这条交付的验收反馈..."
					}
				/>
				<button type="button" className="btn-secondary btn-sm" onClick={props.onSubmitFeedback}>
					保存反馈
				</button>
			</div>
		</div>
	);
}

export function App() {
	const initialRoute = useMemo(() => parseHashRoute(window.location.hash), []);
	const [activeTab, setActiveTab] = useState<NavTab>(initialRoute.tab);
	const [collabOpen, setCollabOpen] = useState(false);
	const [searchOpen, setSearchOpen] = useState(false);
	const [searchQuery, setSearchQuery] = useState("");
	const [starterMenuOpen, setStarterMenuOpen] = useState(false);
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

	const composerRef = useRef<HTMLTextAreaElement | null>(null);
	const messagesEndRef = useRef<HTMLDivElement | null>(null);
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
				const watchingThisChat = activeTabRef.current === "chats" && selectedMatterIdRef.current === data.matterId;
				if (!watchingThisChat) {
					const shortTitle = (data.deliverable.title ?? "新成果").slice(0, 28);
					setNoticeBanner(`✓ 已完成交付：「${shortTitle}」`);
				}
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
		es.addEventListener("matter_aborted", (ev) => {
			const data = JSON.parse((ev as MessageEvent).data) as { matterId: string };
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

	const messageCount = matterDetail?.userMessages.length ?? 0;
	const streamLen = streamingDelta.length;
	useEffect(() => {
		if (activeTab === "chats" && (messageCount > 0 || streamLen > 0)) {
			messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
		}
	}, [activeTab, messageCount, streamLen]);

	const memberThemeMap = useMemo(() => {
		const map = new Map<string, { bg: string; tilt: string }>();
		bootstrap?.members.forEach((member, index) => {
			map.set(member.id, getBotTheme(index));
		});
		return map;
	}, [bootstrap]);

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
		setStarterMenuOpen(false);
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

	const handleSendPrompt = async () => {
		const targetDeliv = activeChatDeliverable ?? activeDeliverable;
		const isModifyingDeliverable = Boolean(selectedMatterId && targetDeliv) && composerText.trim().startsWith("修改");
		await dispatchPromptText(composerText, {
			deliverableTitle: isModifyingDeliverable ? targetDeliv?.title : undefined,
		});
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

	const handleComposerKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
			e.preventDefault();
			void handleSendPrompt();
		}
	};

	const handleDeliverableFeedback = async (deliverableId: string) => {
		if (!feedbackText.trim()) return;
		await submitDeliverableFeedback(deliverableId, feedbackText.trim());
		setFeedbackText("");
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

	const activeMatterProgress = selectedMatterId ? (progressByMatter[selectedMatterId] ?? null) : null;
	const headerTheme = headerContact ? (memberThemeMap.get(headerContact.id) ?? getBotTheme(0)) : getBotTheme(0);

	return (
		<div className="bot-shell">
			<aside className="bot-sidebar">
				<div className="sidebar-top">
					<button
						type="button"
						className="brand-btn"
						onClick={() => navigateRoute({ tab: "chats", matterId: selectedMatterId ?? undefined })}
					>
						<span className="brand-mark">PA</span>
						<span>Personal Agent</span>
					</button>
					<div className="sidebar-tools">
						<button
							type="button"
							className={`icon-btn ${searchOpen ? "active" : ""}`}
							aria-label="搜索事项与交付"
							onClick={() => {
								setSearchOpen((v) => !v);
								if (searchOpen) setSearchQuery("");
							}}
						>
							<svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true">
								<circle cx="9" cy="9" r="5.5" stroke="currentColor" strokeWidth="1.7" />
								<path d="M13.5 13.5L17 17" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
							</svg>
						</button>
						<button
							type="button"
							className="icon-btn"
							aria-label="新建事项"
							onClick={() => {
								navigateRoute({ tab: "chats", isNewMatter: true });
								composerRef.current?.focus();
							}}
						>
							<svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true">
								<path d="M10 4.5v11M4.5 10h11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
							</svg>
						</button>
					</div>
				</div>

				{searchOpen && (
					<div className="sidebar-search">
						<input
							className="input-field"
							placeholder="搜索事项或交付标题..."
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
						/>
					</div>
				)}

				<div className="roster-strip">
					{bootstrap?.members.map((member, idx) => {
						const theme = getBotTheme(idx);
						const isSelected = selectedMemberId === member.id;
						const isWorking = Object.entries(progressByMatter).some(([mId]) => {
							const matter = bootstrap.matters.find((m) => m.id === mId);
							return matter?.leadMemberId === member.id;
						});
						return (
							<button
								key={member.id}
								type="button"
								className={`roster-tile ${isSelected ? "active" : ""}`}
								onClick={() => {
									setSelectedMemberId((prev) => (prev === member.id ? "auto" : member.id));
									if (activeTab !== "chats") {
										navigateRoute({ tab: "chats", isNewMatter: true });
									}
									composerRef.current?.focus();
								}}
								title={`${member.displayName} · ${member.roleTitle}`}
							>
								<span className="roster-avatar-wrap">
									<BotFaceIcon bg={theme.bg} tilt={theme.tilt} size="md" />
									{isWorking && <span className="roster-working-dot" />}
								</span>
								<span className="roster-name">{member.displayName}</span>
							</button>
						);
					})}
				</div>

				<div className="matter-scroll">
					<div className="sidebar-section-label">
						<span>最近事项</span>
						<span>{filteredMatters.length}</span>
					</div>
					{filteredMatters.length === 0 ? (
						<div className="sidebar-empty">暂无事项，可在右侧直接布置任务</div>
					) : (
						filteredMatters.map((matter) => {
							const prog = progressByMatter[matter.id];
							const leadIdx = bootstrap?.members.findIndex((m) => m.id === matter.leadMemberId) ?? 0;
							const theme = getBotTheme(leadIdx >= 0 ? leadIdx : 0);
							const isActive = activeTab === "chats" && selectedMatterId === matter.id;
							const previewLine = prog
								? prog.label
								: matter.status === "waiting_user"
									? "等待你的确认"
									: matter.summary || STATUS_LABELS[matter.status] || matter.status;

							return (
								<button
									key={matter.id}
									type="button"
									className={`matter-item ${isActive ? "active" : ""}`}
									onClick={() => navigateRoute({ tab: "chats", matterId: matter.id })}
								>
									<span className="matter-dot" style={{ background: theme.bg }}>
										{prog && <span className="matter-dot-pulse" style={{ borderColor: theme.bg }} />}
									</span>
									<span className="matter-copy">
										<span className="matter-title">{matter.title}</span>
										<span className="matter-preview">{previewLine}</span>
									</span>
								</button>
							);
						})
					)}
				</div>

				<div className="sidebar-footer">
					<button
						type="button"
						className={`footer-nav-btn ${activeTab === "deliverables" ? "active" : ""}`}
						onClick={() =>
							navigateRoute({ tab: "deliverables", deliverableId: selectedDeliverableId ?? undefined })
						}
					>
						<span>交付成果库</span>
						<span className="pill">{bootstrap?.deliverables.length ?? 0}</span>
					</button>
					<button
						type="button"
						className={`footer-nav-btn ${activeTab === "team" ? "active" : ""}`}
						onClick={() => navigateRoute({ tab: "team" })}
					>
						<span>我的团队 · {bootstrap?.members.length ?? 0} 位</span>
						<span className="pill">能力包</span>
					</button>
					<button
						type="button"
						className={`footer-nav-btn ${activeTab === "materials" ? "active" : ""}`}
						onClick={() => navigateRoute({ tab: "materials" })}
					>
						<span>项目仓库与资料</span>
						<span className="pill">{bootstrap?.workspaces.length ?? 0}</span>
					</button>
					<div className="sidebar-status-row">
						<span className="muted-tiny">Pi RPC · kimi-for-coding</span>
						<span className={`pill ${sseConnected ? "live" : ""}`}>{sseConnected ? "实时" : "重连"}</span>
					</div>
				</div>
			</aside>

			<main className="main-stage">
				{activeTab === "chats" && (
					<div className="chat-stage">
						<header className="stage-header">
							<div className="stage-header-left">
								{selectedWorkspace ? (
									<span className="pill">仓库：{selectedWorkspace.name}</span>
								) : (
									<span className="pill">通用工作区</span>
								)}
							</div>
							<div className="stage-center-pill">
								<BotFaceIcon bg={headerTheme.bg} size="sm" />
								<span className="stage-center-name">
									{headerContact ? headerContact.displayName : "AI 团队"}
								</span>
								{matterDetail && <span className="stage-center-matter">· {matterDetail.matter.title}</span>}
							</div>
							<div className="stage-header-right">
								{matterDetail && (
									<button
										type="button"
										className={`btn-pill-outline btn-xs ${collabOpen ? "active" : ""}`}
										onClick={() => setCollabOpen((v) => !v)}
									>
										协作过程 (
										{matterDetail.internalCollabMessages.length + matterDetail.noticeMessages.length})
									</button>
								)}
								<button
									type="button"
									className="btn-pill-outline btn-xs"
									onClick={() =>
										navigateRoute({
											tab: "deliverables",
											deliverableId: activeChatDeliverable?.id ?? selectedDeliverableId ?? undefined,
										})
									}
								>
									成果库 ({bootstrap?.deliverables.length ?? 0})
								</button>
							</div>
						</header>

						<div className="chat-stream-scroll">
							<div className="chat-stream-inner">
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

								{collabOpen && matterDetail && (
									<div className="collab-drawer-card">
										<div className="banner-row">
											<strong>内部协作交接与过程通知</strong>
											<button type="button" className="btn-inline" onClick={() => setCollabOpen(false)}>
												收起
											</button>
										</div>
										{matterDetail.internalCollabMessages.length + matterDetail.noticeMessages.length === 0 ? (
											<p className="muted-hint">当前事项暂无内部协作记录。</p>
										) : (
											<div className="collab-log">
												{[...matterDetail.internalCollabMessages, ...matterDetail.noticeMessages].map(
													(entry) => (
														<div key={entry.id}>
															<strong>[{entry.channel}]</strong> {memberName(entry.senderId)}：
															{entry.content}
														</div>
													),
												)}
											</div>
										)}
									</div>
								)}

								{!selectedMatterId || (!matterDetail && !activeMatterProgress) ? (
									<div className="welcome-hero">
										<BotFaceIcon bg={headerTheme.bg} size="lg" />
										<h2>{selectedMemberId === "auto" ? "有什么可以帮你？" : memberName(selectedMemberId)}</h2>
										<p>
											{selectedMemberId === "auto"
												? "直接描述目标，系统会自动分配最合适的同事推进"
												: (templateByRoleId
														.get(headerContact?.templateId ?? "")
														?.responsibilities.split("\n")[0] ?? "直接输入任务开始协作")}
										</p>
									</div>
								) : (
									<>
										{matterDetail?.userMessages.map((msg) => (
											<div
												key={msg.id}
												className={`stream-msg ${msg.senderType === "user" ? "from-user" : "from-member"}`}
											>
												{msg.senderType === "member" && (
													<div className="stream-sender">
														{memberName(msg.senderId)} · {formatClockTime(msg.createdAt)}
													</div>
												)}
												<div className={`stream-bubble ${msg.senderType === "user" ? "user" : "member"}`}>
													{msg.senderType === "member" ? (
														<MarkdownView content={msg.content} />
													) : (
														msg.content
													)}
												</div>
											</div>
										))}

										{activeDialogs.map((dlg) => (
											<div key={dlg.id} className="inline-approval-card">
												<div className="approval-eyebrow">需要你确认 · 来自【{dlg.memberName}】</div>
												<h4>{dlg.request.title}</h4>
												{dlg.request.message && <p>{dlg.request.message}</p>}
												{dlg.request.method === "confirm" && (
													<div className="approval-actions">
														<button
															type="button"
															className="btn-pill-dark"
															onClick={() => void respondToDialog(dlg.id, { confirmed: true })}
														>
															允许继续
														</button>
														<button
															type="button"
															className="btn-pill-outline"
															onClick={() => void respondToDialog(dlg.id, { confirmed: false })}
														>
															拒绝
														</button>
													</div>
												)}
												{dlg.request.method === "select" && dlg.request.options && (
													<div className="approval-actions">
														{dlg.request.options.map((opt) => (
															<button
																key={opt}
																type="button"
																className="btn-pill-outline"
																onClick={() => void respondToDialog(dlg.id, { value: opt })}
															>
																{opt}
															</button>
														))}
													</div>
												)}
												{(dlg.request.method === "input" || dlg.request.method === "editor") && (
													<div className="feedback-row">
														<input
															className="input-field"
															value={dialogInput}
															onChange={(e) => setDialogInput(e.target.value)}
															placeholder={dlg.request.placeholder ?? "输入答复..."}
														/>
														<button
															type="button"
															className="btn-pill-dark"
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

										{activeChatDeliverable && (
											<div className="deliverable-inline-pill">
												<span className="deliverable-pill-info">
													<span className="deliverable-pill-check">✓</span>
													<span>
														已归档至成果库 · <strong>V{activeChatDeliverable.version}</strong>
													</span>
												</span>
												<span className="deliverable-pill-actions">
													{previewUrlFor(activeChatDeliverable) && (
														<a
															className="btn-inline"
															href={previewUrlFor(activeChatDeliverable)!}
															target="_blank"
															rel="noreferrer"
														>
															打开预览 →
														</a>
													)}
													<button
														type="button"
														className="btn-inline"
														onClick={() =>
															navigateRoute({
																tab: "deliverables",
																deliverableId: activeChatDeliverable.id,
															})
														}
													>
														在成果库查看
													</button>
												</span>
											</div>
										)}

										{streamingDelta && (
											<div className="stream-msg from-member">
												<div className="stream-sender">正在整理回复...</div>
												<div className="stream-bubble member">
													<MarkdownView content={streamingDelta} />
												</div>
											</div>
										)}

										{activeMatterProgress && selectedMatterId && (
											<ExploringStatus
												progress={activeMatterProgress}
												elapsedSeconds={Math.max(
													0,
													Math.floor((nowMs - (progressStartedAt[selectedMatterId] ?? nowMs)) / 1000),
												)}
												onAbort={() => handleAbortMatter(selectedMatterId)}
											/>
										)}
									</>
								)}
								<div ref={messagesEndRef} />
							</div>
						</div>

						<div className="composer-dock">
							<div className="composer-dock-inner">
								{starterMenuOpen && (
									<div className="quick-prompts-popover">
										<div className="banner-row">
											<strong>快速插入示范需求</strong>
											<button type="button" className="btn-inline" onClick={() => setStarterMenuOpen(false)}>
												关闭
											</button>
										</div>
										<div className="quick-prompts-list">
											{starterTasks.map((task) => (
												<button
													key={task.id}
													type="button"
													className="quick-prompt-item"
													onClick={() => {
														if (task.memberId) setSelectedMemberId(task.memberId);
														setComposerText(task.prompt);
														setStarterMenuOpen(false);
														composerRef.current?.focus();
													}}
												>
													<span className="starter-role">{task.roleLabel}</span>
													<span>{task.title}</span>
												</button>
											))}
										</div>
									</div>
								)}

								<div className="composer-meta-bar">
									<select
										className="select-pill"
										value={selectedWorkspaceId}
										onChange={(e) => {
											const nextId = e.target.value;
											setSelectedWorkspaceId(nextId);
											try {
												window.localStorage.setItem("pa.defaultWorkspaceId", nextId);
											} catch {
												// Ignore storage access errors.
											}
											if (selectedMatterId) {
												void updateMatterWorkspace(selectedMatterId, nextId || null)
													.then(async () => {
														const wsLabel = nextId ? (workspaceName(nextId) ?? nextId) : "不绑定仓库";
														setNoticeBanner(`已切换当前事项仓库为「${wsLabel}」`);
														await refreshBootstrap();
														await refreshDetail(selectedMatterId);
													})
													.catch((err: unknown) => {
														setErrorBanner(err instanceof Error ? err.message : String(err));
													});
											}
										}}
									>
										<option value="">不绑定仓库</option>
										{bootstrap?.workspaces.map((ws) => (
											<option key={ws.id} value={ws.id}>
												仓库：{ws.name}
											</option>
										))}
									</select>
									<select
										className="select-pill"
										value={selectedMemberId}
										onChange={(e) => setSelectedMemberId(e.target.value)}
									>
										<option value="auto">按事找人（主联系：{headerContact?.displayName ?? "自动"}）</option>
										{bootstrap?.members.map((m) => (
											<option key={m.id} value={m.id}>
												指定：{m.displayName}
											</option>
										))}
									</select>
									{selectedMatterId && (
										<button
											type="button"
											className="select-pill action"
											onClick={() => {
												navigateRoute({ tab: "chats", isNewMatter: true });
												composerRef.current?.focus();
											}}
										>
											+ 切到新事项
										</button>
									)}
								</div>

								<div className="pill-composer">
									<button
										type="button"
										className="pill-plus-btn"
										aria-label="插入示范任务"
										onClick={() => setStarterMenuOpen((v) => !v)}
									>
										+
									</button>
									<textarea
										ref={composerRef}
										rows={1}
										className="pill-textarea"
										value={composerText}
										onChange={(e) => setComposerText(e.target.value)}
										onKeyDown={handleComposerKeyDown}
										placeholder={
											selectedMatterId
												? "继续对话，回答问题或提出修改（Enter 发送）..."
												: "向你的 AI 团队布置任务（Enter 发送）..."
										}
									/>
									{activeMatterProgress && selectedMatterId && (
										<button
											type="button"
											className="pill-stop-btn"
											aria-label="停止执行"
											title="停止当前执行"
											onClick={() => handleAbortMatter(selectedMatterId)}
										>
											■
										</button>
									)}
									<button
										type="button"
										className="pill-send-btn"
										aria-label="发送"
										disabled={submitting || !composerText.trim()}
										onClick={() => void handleSendPrompt()}
									>
										{submitting ? "…" : "↑"}
									</button>
								</div>
							</div>
						</div>
					</div>
				)}

				{activeTab === "deliverables" && (
					<div className="subpage-scroll">
						<div className="subpage-inner">
							<div className="pane-header-row">
								<div className="pane-header">
									<h1>交付成果库</h1>
									<p>按版本归拢完成的成果与反馈，也可随时回到对话继续修改</p>
								</div>
								<button
									type="button"
									className="btn-pill-dark"
									onClick={() => {
										navigateRoute({ tab: "chats", isNewMatter: true });
										composerRef.current?.focus();
									}}
								>
									+ 布置新任务
								</button>
							</div>

							{activeDeliverable ? (
								<DeliverableCard
									deliverable={activeDeliverable}
									siblingVersions={siblingVersionsFor(activeDeliverable)}
									memberName={memberName(activeDeliverable.memberId)}
									workspaceName={workspaceName(
										bootstrap?.matters.find((m) => m.id === activeDeliverable.matterId)?.workspaceId ?? null,
									)}
									viewUrl={previewUrlFor(activeDeliverable)}
									feedbackText={feedbackText}
									onFeedbackTextChange={setFeedbackText}
									onSubmitFeedback={() => void handleDeliverableFeedback(activeDeliverable.id)}
									onSelectVersion={(id) => navigateRoute({ tab: "deliverables", deliverableId: id })}
									onRequestRevision={() => {
										navigateRoute({ tab: "chats", matterId: activeDeliverable.matterId });
										setComposerText(`修改「${activeDeliverable.title}」：`);
									}}
									onSaveMemory={(content, scope) =>
										handleSaveMemoryForDeliverable(activeDeliverable, content, scope)
									}
								/>
							) : (
								<div className="deliverable-card">
									<p style={{ margin: 0, color: "var(--text-secondary)" }}>
										暂无交付记录。回到对话工作台发送需求或点选示范任务，完成后成果会自动归拢到这里。
									</p>
								</div>
							)}

							{filteredDeliverables.length > 1 && (
								<div className="list-section">
									{filteredDeliverables
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
						</div>
					</div>
				)}

				{activeTab === "team" && (
					<div className="subpage-scroll">
						<div className="subpage-inner wide">
							<div className="pane-header-row">
								<div className="pane-header">
									<h1>我的团队</h1>
									<p>查看角色分工与积累经验，支持新增自定义角色，或导入导出脱敏角色能力包</p>
								</div>
								<div className="actions-row" style={{ marginTop: 0 }}>
									<button
										type="button"
										className="btn-pill-dark"
										onClick={() => {
											setShowAddMember((v) => !v);
											setShowImportMember(false);
										}}
									>
										+ 新增角色
									</button>
									<button
										type="button"
										className="btn-pill-outline"
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
								<div className="deliverable-card form-card">
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
												className="btn-pill-outline"
												onClick={() => setShowAddMember(false)}
											>
												取消
											</button>
											<button
												type="button"
												className="btn-pill-dark"
												onClick={() => void handleCreateMember()}
											>
												加入团队
											</button>
										</div>
									</div>
								</div>
							)}

							{showImportMember && (
								<div className="deliverable-card form-card">
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
										<button type="button" className="btn-pill-dark" onClick={() => void handleImportMember()}>
											确认导入
										</button>
										<button
											type="button"
											className="btn-pill-outline"
											onClick={() => setShowImportMember(false)}
										>
											取消
										</button>
									</div>
								</div>
							)}

							{exportedPackage && (
								<div className="deliverable-card form-card">
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
										<button type="button" className="btn-pill-dark" onClick={handleDownloadExportedPackage}>
											下载 .md 文件
										</button>
										<button
											type="button"
											className="btn-pill-outline"
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
								{bootstrap?.members.map((member, idx) => {
									const tpl = templateByRoleId.get(member.templateId);
									const memories = bootstrap.memoriesByMember[member.id] ?? [];
									const isExpanded = expandedMemoryMemberId === member.id;
									const theme = getBotTheme(idx);
									return (
										<div key={member.id} className="member-card">
											<div className="member-card-top">
												<div className="member-ident">
													<BotFaceIcon bg={theme.bg} tilt={theme.tilt} size="md" />
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
													className="btn-pill-dark btn-xs"
													onClick={() => {
														setSelectedMemberId(member.id);
														navigateRoute({ tab: "chats", isNewMatter: true });
														composerRef.current?.focus();
													}}
												>
													向 TA 派活
												</button>
												{!member.isPrimaryContact && (
													<button
														type="button"
														className="btn-pill-outline btn-xs"
														onClick={() => void handleSetPrimary(member.id)}
													>
														设为主联系
													</button>
												)}
												<button
													type="button"
													className="btn-pill-outline btn-xs"
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
						</div>
					</div>
				)}

				{activeTab === "materials" && (
					<div className="subpage-scroll">
						<div className="subpage-inner">
							<div className="pane-header">
								<h1>已有资料与项目仓库</h1>
								<p>仓库自身维护的信息以仓库为准；角色私有记忆与可分享模板物理隔离</p>
							</div>

							<div className="deliverable-card">
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
									<button type="button" className="btn-pill-dark" onClick={() => void handleAddWorkspace()}>
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
											className="btn-pill-outline btn-xs"
											onClick={() => {
												setSelectedWorkspaceId(ws.id);
												navigateRoute({ tab: "chats", isNewMatter: true });
											}}
										>
											{selectedWorkspaceId === ws.id ? "当前已选 · 新建任务 →" : "在此仓库派活 →"}
										</button>
									</div>
								))}
							</div>
						</div>
					</div>
				)}
			</main>
		</div>
	);
}
