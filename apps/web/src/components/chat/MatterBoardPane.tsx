import { useMemo, useState } from "react";
import type { ModelSelection } from "../../api/models.ts";
import type {
	BoardMemberDto,
	BoardMemberStatus,
	BoardPostDto,
	BoardPostKind,
	BoardRole,
	CreateBoardPostInput,
	MatterBoardSnapshotDto,
	MatterCollaborationMode,
	MatterEventDto,
	MatterEventType,
	UpdateBoardMemberControlInput,
} from "../../api.ts";
import {
	buildActiveMentionCandidates,
	canSwapBoardMemberModel,
	filterBoardPosts,
	filterVisibleBoardMembers,
	formatBoardEventPayload,
	groupBoardMembers,
	summarizeBoardStatus,
} from "../../hooks/useMatterBoard.ts";
import { MarkdownView } from "../../MarkdownView.tsx";
import { BotFaceIcon } from "../../primitives/BotFaceIcon.tsx";
import { ModalDialog } from "../../primitives/ModalDialog.tsx";
import { getBotTheme, type RoleMood } from "../../utils.ts";
import { useModelCatalog } from "../ModelPicker.tsx";
import { BoardMentionGraph } from "./BoardMentionGraph.tsx";

type ModelThinkingLevel = NonNullable<ModelSelection["thinkingLevel"]>;

function formatTime(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export type BoardPaneTab = "members" | "board" | "graph" | "events";

interface MatterBoardPaneProps {
	matterId: string;
	matterTitle: string;
	collaborationMode: MatterCollaborationMode;
	canControlMembers: boolean;
	canPostToBoard: boolean;
	snapshot: MatterBoardSnapshotDto | null;
	loading: boolean;
	error: string | null;
	activeTab: BoardPaneTab;
	onSelectTab: (tab: BoardPaneTab) => void;
	onClose: () => void;
	onRefreshBoard: () => void;
	postBodiesByNo: Record<number, BoardPostDto>;
	loadingPostNos: Record<number, boolean>;
	postBodyErrors: Record<number, string>;
	onLoadPostBody: (postNo: number) => Promise<BoardPostDto | null>;
	onSubmitPost: (input: CreateBoardPostInput) => Promise<BoardPostDto>;
	onControlMember: (agentId: string, input: UpdateBoardMemberControlInput) => Promise<BoardMemberDto>;
	events: MatterEventDto[];
	eventsHasMore: boolean;
	eventsLoading: boolean;
	eventsError: string | null;
	eventFilterAgentId: string;
	eventFilterType: MatterEventType | "all";
	onChangeEventFilterAgentId: (agentId: string) => void;
	onChangeEventFilterType: (eventType: MatterEventType | "all") => void;
	onRefreshEvents: () => void;
	onLoadMoreEvents: () => void;
	onNotice?: (message: string) => void;
}

const POST_KIND_FILTERS: ReadonlyArray<{ value: BoardPostKind | "all"; label: string }> = [
	{ value: "all", label: "全部" },
	{ value: "assign", label: "分派" },
	{ value: "handoff", label: "交接" },
	{ value: "verify_pass", label: "验收通过" },
	{ value: "verify_rework", label: "验收打回" },
	{ value: "clarification", label: "澄清" },
	{ value: "escalate", label: "升级" },
	{ value: "summary", label: "总结" },
];

const COMPOSER_KIND_OPTIONS: ReadonlyArray<{ value: BoardPostKind; label: string }> = [
	{ value: "clarification", label: "澄清 / 指令" },
	{ value: "assign", label: "任务分派" },
	{ value: "handoff", label: "交接补充" },
	{ value: "escalate", label: "升级纠偏" },
	{ value: "progress", label: "进展同步" },
	{ value: "summary", label: "阶段总结" },
];

const EVENT_TYPE_FILTERS: ReadonlyArray<{ value: MatterEventType | "all"; label: string }> = [
	{ value: "all", label: "全部事件" },
	{ value: "tool_start", label: "工具开始" },
	{ value: "tool_end", label: "工具完成" },
	{ value: "monitor_alert", label: "停滞告警" },
	{ value: "turn_summary", label: "轮次摘要" },
];

function boardRoleLabel(role: BoardRole): string {
	if (role === "coordinator") return "Coordinator";
	if (role === "verifier") return "Verifier";
	return "Builder";
}

function boardStatusLabel(status: BoardMemberStatus): string {
	switch (status) {
		case "working":
			return "执行中";
		case "waiting":
			return "待命";
		case "blocked_human":
			return "待人工确认";
		case "stopped":
			return "已暂停";
		case "retired":
			return "已退场";
	}
}

function boardStatusMood(status: BoardMemberStatus): RoleMood {
	if (status === "working") return "tool";
	if (status === "blocked_human") return "waiting_user";
	return "idle";
}

function postKindLabel(kind: BoardPostKind): string {
	switch (kind) {
		case "assign":
			return "分派";
		case "progress":
			return "进展";
		case "handoff":
			return "交接";
		case "verify_pass":
			return "验收通过";
		case "verify_rework":
			return "验收打回";
		case "escalate":
			return "升级";
		case "clarification":
			return "澄清";
		case "summary":
			return "总结";
	}
}

function eventTypeLabel(eventType: MatterEventType): string {
	switch (eventType) {
		case "tool_start":
			return "工具开始";
		case "tool_end":
			return "工具完成";
		case "capability_ready":
			return "能力就绪";
		case "monitor_alert":
			return "停滞告警";
		case "turn_summary":
			return "轮次摘要";
	}
}

function formatModelBadge(model: ModelSelection | null): string | null {
	if (!model) return null;
	return `${model.provider}/${model.model}${model.thinkingLevel ? ` (${model.thinkingLevel})` : ""}`;
}

/** Right-side split pane / drawer for 0.9.0 Board observability (Members, Board posts, and Events). */
export function MatterBoardPane({
	matterTitle,
	collaborationMode,
	canControlMembers,
	canPostToBoard,
	snapshot,
	loading,
	error,
	activeTab,
	onSelectTab,
	onClose,
	onRefreshBoard,
	postBodiesByNo,
	loadingPostNos,
	postBodyErrors,
	onLoadPostBody,
	onSubmitPost,
	onControlMember,
	events,
	eventsHasMore,
	eventsLoading,
	eventsError,
	eventFilterAgentId,
	eventFilterType,
	onChangeEventFilterAgentId,
	onChangeEventFilterType,
	onRefreshEvents,
	onLoadMoreEvents,
	onNotice,
}: MatterBoardPaneProps) {
	const { catalog, reload: reloadModels } = useModelCatalog();
	const [postQuery, setPostQuery] = useState("");
	const [postKindFilter, setPostKindFilter] = useState<BoardPostKind | "all">("all");
	const [expandedPostNos, setExpandedPostNos] = useState<Record<number, boolean>>({});
	const [hideInactive, setHideInactive] = useState(false);
	const [showRetiredGroup, setShowRetiredGroup] = useState(false);

	// Board direct-post composer state
	const [composeKind, setComposeKind] = useState<BoardPostKind>("clarification");
	const [composeMentions, setComposeMentions] = useState<string[]>([]);
	const [composeSummary, setComposeSummary] = useState("");
	const [composeBody, setComposeBody] = useState("");
	const [composeShowBody, setComposeShowBody] = useState(false);
	const [composeSubmitting, setComposeSubmitting] = useState(false);
	const [composeError, setComposeError] = useState<string | null>(null);

	// Member control & model hot-swap modal state
	const [busyAgentId, setBusyAgentId] = useState<string | null>(null);
	const [memberActionError, setMemberActionError] = useState<string | null>(null);
	const [swapTargetMember, setSwapTargetMember] = useState<BoardMemberDto | null>(null);
	const [swapModelKey, setSwapModelKey] = useState<string>("");
	const [swapThinking, setSwapThinking] = useState<ModelThinkingLevel | "">("");
	const [swapSaving, setSwapSaving] = useState(false);
	const [swapError, setSwapError] = useState<string | null>(null);

	const members = snapshot?.members ?? [];
	const posts = snapshot?.posts ?? [];
	const retiredCount = useMemo(() => members.filter((member) => member.status === "retired").length, [members]);
	const activeMemberCount = members.length - retiredCount;
	const visibleMembers = useMemo(() => filterVisibleBoardMembers(members, { hideInactive }), [members, hideInactive]);
	const statusSummary = useMemo(() => summarizeBoardStatus(members, posts.length), [members, posts.length]);
	const { coordinator, groups } = useMemo(() => groupBoardMembers(visibleMembers), [visibleMembers]);
	const filteredPosts = useMemo(
		() => filterBoardPosts(posts, { query: postQuery, kind: postKindFilter }),
		[posts, postQuery, postKindFilter],
	);

	const mentionCandidates = useMemo(() => buildActiveMentionCandidates(members), [members]);

	const modelOptions = catalog?.models ?? [];
	const selectedSwapModelOption = useMemo(() => {
		if (!swapModelKey) return null;
		const [provider, ...rest] = swapModelKey.split("::");
		const model = rest.join("::");
		return modelOptions.find((item) => item.provider === provider && item.model === model) ?? null;
	}, [modelOptions, swapModelKey]);

	const openSwapModal = (member: BoardMemberDto) => {
		reloadModels();
		setSwapTargetMember(member);
		setSwapModelKey(member.modelOverride ? `${member.modelOverride.provider}::${member.modelOverride.model}` : "");
		setSwapThinking(member.modelOverride?.thinkingLevel ?? "");
		setSwapError(null);
	};

	const handleTogglePause = async (member: BoardMemberDto) => {
		if (busyAgentId) return;
		const action = member.status === "stopped" ? "resume" : "pause";
		setBusyAgentId(member.agentId);
		setMemberActionError(null);
		try {
			await onControlMember(member.agentId, { action });
			onNotice?.(action === "pause" ? `已暂停成员 @${member.agentId}` : `已恢复成员 @${member.agentId} 为待命`);
		} catch (err: unknown) {
			setMemberActionError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusyAgentId(null);
		}
	};

	const handleRetireMember = async (member: BoardMemberDto) => {
		if (busyAgentId || member.boardRole === "coordinator" || member.status === "working") return;
		setBusyAgentId(member.agentId);
		setMemberActionError(null);
		try {
			await onControlMember(member.agentId, { status: "retired" });
			onNotice?.(`已将成员 @${member.agentId} 标记为退场`);
		} catch (err: unknown) {
			setMemberActionError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusyAgentId(null);
		}
	};

	const handleSaveModelSwap = async () => {
		if (!swapTargetMember || swapSaving) return;
		setSwapSaving(true);
		setSwapError(null);
		try {
			let nextOverride: ModelSelection | null = null;
			if (swapModelKey) {
				const [provider, ...rest] = swapModelKey.split("::");
				const model = rest.join("::");
				nextOverride = {
					provider: provider ?? "",
					model,
					...(swapThinking ? { thinkingLevel: swapThinking } : {}),
				};
			}
			await onControlMember(swapTargetMember.agentId, { modelOverride: nextOverride });
			onNotice?.(
				nextOverride
					? `已为 @${swapTargetMember.agentId} 切换模型为 ${nextOverride.provider}/${nextOverride.model}`
					: `已恢复 @${swapTargetMember.agentId} 使用默认模型`,
			);
			setSwapTargetMember(null);
		} catch (err: unknown) {
			setSwapError(err instanceof Error ? err.message : String(err));
		} finally {
			setSwapSaving(false);
		}
	};

	const handleTogglePostBody = async (postNo: number) => {
		const isOpen = Boolean(expandedPostNos[postNo]);
		if (isOpen) {
			setExpandedPostNos((prev) => ({ ...prev, [postNo]: false }));
			return;
		}
		setExpandedPostNos((prev) => ({ ...prev, [postNo]: true }));
		if (!postBodiesByNo[postNo]) {
			await onLoadPostBody(postNo);
		}
	};

	const handleToggleMention = (agentId: string) => {
		setComposeMentions((prev) =>
			prev.includes(agentId) ? prev.filter((item) => item !== agentId) : [...prev, agentId],
		);
	};

	const handleSubmitBoardPost = async () => {
		const summary = composeSummary.trim();
		const body = composeBody.trim();
		if ((!summary && !body) || composeSubmitting) return;
		setComposeSubmitting(true);
		setComposeError(null);
		try {
			await onSubmitPost({
				kind: composeKind,
				mentions: composeMentions,
				summary: summary || body.slice(0, 140),
				body: body || undefined,
			});
			setComposeSummary("");
			setComposeBody("");
			setComposeShowBody(false);
			onNotice?.("已发布公告板帖子");
		} catch (err: unknown) {
			setComposeError(err instanceof Error ? err.message : String(err));
		} finally {
			setComposeSubmitting(false);
		}
	};

	const renderMemberCard = (member: BoardMemberDto, index: number) => {
		const theme = getBotTheme(index);
		const isWaiting = canSwapBoardMemberModel(member);
		const isBusy = busyAgentId === member.agentId;
		const modelLabel = formatModelBadge(member.modelOverride);
		const metrics = member.metrics;
		return (
			<article
				key={member.agentId}
				className={`board-member-card is-${member.status}${member.boardRole === "coordinator" ? " is-coordinator" : ""}`}
			>
				<div className="board-member-head">
					<div className="board-member-identity">
						<BotFaceIcon bg={theme.bg} size="sm" mood={boardStatusMood(member.status)} />
						<div className="board-member-titles">
							<div className="board-member-name-row">
								<strong className="board-member-name">{member.displayName}</strong>
								<span className={`board-role-badge is-${member.boardRole}`}>
									{boardRoleLabel(member.boardRole)}
								</span>
							</div>
							<span className="board-member-id">@{member.agentId}</span>
						</div>
					</div>
					<span className={`board-status-badge is-${member.status}`}>
						<span className={`board-status-dot is-${member.status}`} aria-hidden="true" />
						{boardStatusLabel(member.status)}
					</span>
				</div>

				{member.ownedScope.length > 0 && (
					<div className="board-scope-chips">
						{member.ownedScope.map((scope) => (
							<span key={scope} className="board-scope-chip" title={scope}>
								{scope}
							</span>
						))}
					</div>
				)}

				<div className="board-member-metrics">
					<span className="board-metric-chip">已读 #{member.lastReadPostNo}</span>
					{member.activePostNo !== null && (
						<span className="board-metric-chip is-active">处理中 #{member.activePostNo}</span>
					)}
					{metrics?.linesAdded !== undefined && (
						<span className="board-metric-chip is-positive">+{metrics.linesAdded} 行</span>
					)}
					{metrics?.linesDeleted !== undefined && metrics.linesDeleted > 0 && (
						<span className="board-metric-chip">-{metrics.linesDeleted} 行</span>
					)}
					{metrics?.testsPassed !== undefined && (
						<span className="board-metric-chip is-positive">
							测试 {metrics.testsPassed}
							{metrics.testsTotal !== undefined ? `/${metrics.testsTotal}` : ""} 通过
						</span>
					)}
					{modelLabel && (
						<span className="board-metric-chip is-model" title={`模型覆盖：${modelLabel}`}>
							{modelLabel}
						</span>
					)}
				</div>

				{metrics?.lastAction && <p className="board-member-last-action">{metrics.lastAction}</p>}

				{canControlMembers && member.status !== "retired" && (
					<div className="board-member-actions">
						<button
							type="button"
							className="btn-pill-outline btn-xs"
							disabled={isBusy}
							onClick={() => void handleTogglePause(member)}
						>
							{isBusy ? "处理中…" : member.status === "stopped" ? "恢复" : "暂停"}
						</button>
						<button
							type="button"
							className="btn-pill-outline btn-xs"
							disabled={!isWaiting || isBusy}
							title={
								isWaiting
									? "在待命状态下原地热切换模型（保留 Pi 会话历史）"
									: `仅在待命（waiting）状态可热切换模型，当前为「${boardStatusLabel(member.status)}」`
							}
							onClick={() => openSwapModal(member)}
						>
							切换模型
						</button>
						{member.boardRole !== "coordinator" && member.status !== "working" && (
							<button
								type="button"
								className="btn-pill-outline btn-xs"
								disabled={isBusy}
								title="将该成员标记为退场，保留历史记录并默认折叠"
								onClick={() => void handleRetireMember(member)}
							>
								退场
							</button>
						)}
						{member.status === "working" && <span className="board-swap-hint">执行中不可换模型</span>}
					</div>
				)}
			</article>
		);
	};

	return (
		<aside className="board-side-pane" aria-label="团队公告板面板">
			<div className="board-pane-header">
				<div className="board-pane-title-group">
					<div className="board-pane-title-row">
						<h2 className="board-pane-title">团队公告板</h2>
						<span className={`board-pill-badge is-${statusSummary.tone}`}>{statusSummary.label}</span>
					</div>
					<span className="board-pane-subtitle" title={matterTitle}>
						{collaborationMode === "board" ? "Board 异步协作" : "Lead 模式（只读看板）"} · {matterTitle}
					</span>
				</div>
				<div className="board-pane-header-actions">
					<button type="button" className="btn-pill-outline btn-xs" disabled={loading} onClick={onRefreshBoard}>
						{loading ? "刷新中…" : "刷新"}
					</button>
					<button type="button" className="btn-inline" onClick={onClose}>
						关闭
					</button>
				</div>
			</div>

			<div className="board-pane-tabs" role="tablist" aria-label="看板视图">
				<button
					type="button"
					role="tab"
					aria-selected={activeTab === "members"}
					className={`board-pane-tab${activeTab === "members" ? " active" : ""}`}
					onClick={() => onSelectTab("members")}
				>
					<span>成员</span>
					<span className="board-tab-count">
						{retiredCount > 0 ? `${activeMemberCount}/${members.length}` : members.length}
					</span>
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={activeTab === "board"}
					className={`board-pane-tab${activeTab === "board" ? " active" : ""}`}
					onClick={() => onSelectTab("board")}
				>
					<span>公告板</span>
					<span className="board-tab-count">{posts.length}</span>
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={activeTab === "graph"}
					className={`board-pane-tab${activeTab === "graph" ? " active" : ""}`}
					onClick={() => onSelectTab("graph")}
				>
					<span>关系图</span>
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={activeTab === "events"}
					className={`board-pane-tab${activeTab === "events" ? " active" : ""}`}
					onClick={() => onSelectTab("events")}
				>
					<span>事件轨迹</span>
				</button>
			</div>

			{error && (
				<div className="board-inline-error" role="alert">
					<span>加载看板失败：{error}</span>
					<button type="button" className="btn-inline" onClick={onRefreshBoard}>
						重试
					</button>
				</div>
			)}

			<div className="board-pane-body">
				{activeTab === "members" && (
					<div className="board-members-tab">
						{memberActionError && (
							<div className="board-inline-error" role="alert">
								<span>{memberActionError}</span>
								<button type="button" className="btn-inline" onClick={() => setMemberActionError(null)}>
									关闭
								</button>
							</div>
						)}

						{!coordinator && groups.length === 0 ? (
							<div className="board-empty-state">
								<p>当前尚未组建公告板成员。</p>
								<p className="board-empty-hint">
									在 Board 模式下发送目标后，Coordinator 会自动按任务切片组建 Builder 与 Verifier。
								</p>
							</div>
						) : (
							<>
								<div className="board-members-toolbar">
									<span className="board-pane-subtitle">
										活跃 {activeMemberCount} 人{retiredCount > 0 ? ` · 已退场 ${retiredCount} 人` : ""}
									</span>
									<button
										type="button"
										className={`board-filter-pill${hideInactive ? " active" : ""}`}
										aria-pressed={hideInactive}
										onClick={() => setHideInactive((prev) => !prev)}
									>
										{hideInactive ? "已隐藏非活跃成员" : "隐藏非活跃"}
									</button>
								</div>
								{coordinator && (
									<section className="board-member-group" aria-label="交付总控">
										<header className="board-group-header">
											<span>交付总控 · Coordinator（常驻）</span>
										</header>
										<div className="board-member-grid">{renderMemberCard(coordinator, 0)}</div>
									</section>
								)}
								{groups.map((group) => {
									const isRetiredGroup = group.status === "retired";
									const collapsed = isRetiredGroup && !showRetiredGroup && activeMemberCount > 1;
									return (
										<section key={group.status} className="board-member-group" aria-label={group.label}>
											<header className="board-group-header">
												<span>{group.label}</span>
												<div className="board-group-header-right">
													<span className="board-group-count">{group.members.length}</span>
													{isRetiredGroup && activeMemberCount > 1 && (
														<button
															type="button"
															className="btn-inline"
															onClick={() => setShowRetiredGroup((prev) => !prev)}
														>
															{collapsed ? "展开" : "收起"}
														</button>
													)}
												</div>
											</header>
											{!collapsed && (
												<div className="board-member-grid">
													{group.members.map((member, idx) => renderMemberCard(member, idx + 1))}
												</div>
											)}
										</section>
									);
								})}
							</>
						)}

						{posts.length > 0 && (
							<section className="board-shared-strip" aria-label="最新公告板交接">
								<div className="board-shared-strip-head">
									<span className="board-shared-strip-label">SHARED BOARD · 最新动态</span>
									<button type="button" className="btn-inline" onClick={() => onSelectTab("board")}>
										查看全部 ({posts.length})
									</button>
								</div>
								<div className="board-shared-strip-list">
									{posts
										.slice(-3)
										.reverse()
										.map((post) => (
											<button
												key={post.postNo}
												type="button"
												className="board-shared-strip-item"
												onClick={() => onSelectTab("board")}
											>
												<span className="board-post-no">#{post.postNo}</span>
												<span className="board-strip-author">@{post.authorId}</span>
												<span className="board-strip-summary">{post.summary}</span>
											</button>
										))}
								</div>
							</section>
						)}
					</div>
				)}

				{activeTab === "board" && (
					<div className="board-posts-tab">
						<div className="board-posts-toolbar">
							<input
								type="search"
								className="input-field board-search-input"
								aria-label="搜索公告板帖子"
								placeholder="搜索 #帖号、作者、@提及或摘要…"
								value={postQuery}
								onChange={(event) => setPostQuery(event.target.value)}
							/>
							<fieldset className="board-filter-pills" aria-label="按类型筛选板帖">
								{POST_KIND_FILTERS.map((item) => (
									<button
										key={item.value}
										type="button"
										className={`board-filter-pill${postKindFilter === item.value ? " active" : ""}`}
										aria-pressed={postKindFilter === item.value}
										onClick={() => setPostKindFilter(item.value)}
									>
										{item.label}
									</button>
								))}
							</fieldset>
						</div>

						<div className="board-posts-list">
							{filteredPosts.length === 0 ? (
								<div className="board-empty-state">
									<p>{posts.length === 0 ? "公告板暂无帖子。" : "没有匹配当前筛选条件的板帖。"}</p>
								</div>
							) : (
								filteredPosts.map((post) => {
									const isExpanded = Boolean(expandedPostNos[post.postNo]);
									const fullPost = postBodiesByNo[post.postNo];
									const isLoadingBody = Boolean(loadingPostNos[post.postNo]);
									const bodyError = postBodyErrors[post.postNo];
									const canExpandBody = Boolean(post.hasBody || fullPost);
									return (
										<article key={post.postNo} className={`board-post-card is-${post.kind}`}>
											<header className="board-post-head">
												<div className="board-post-meta-left">
													<span className="board-post-no">#{post.postNo}</span>
													<span className={`board-kind-badge is-${post.kind}`}>
														{postKindLabel(post.kind)}
													</span>
													{post.verification && (
														<span className={`board-verdict-badge is-${post.verification.verdict}`}>
															验收：{post.verification.verdict}
														</span>
													)}
												</div>
												<span className="board-post-time">{formatTime(post.createdAt)}</span>
											</header>

											<div className="board-post-routing">
												<span className="board-post-author">
													@{post.authorId}
													{post.authorType === "user"
														? " (用户)"
														: post.authorType === "monitor"
															? " (巡检)"
															: ""}
												</span>
												{post.mentions.length > 0 && (
													<>
														<span className="board-post-arrow" aria-hidden="true">
															→
														</span>
														<span className="board-post-mentions">
															{post.mentions.map((m) => `@${m}`).join(" ")}
														</span>
													</>
												)}
												{post.refPostNos.length > 0 && (
													<span className="board-post-refs">
														引用 {post.refPostNos.map((n) => `#${n}`).join(", ")}
													</span>
												)}
											</div>

											<p className="board-post-summary">{post.summary}</p>

											{canExpandBody && (
												<div className="board-post-actions">
													<button
														type="button"
														className="btn-inline"
														aria-expanded={isExpanded}
														onClick={() => void handleTogglePostBody(post.postNo)}
													>
														{isLoadingBody ? "加载正文中…" : isExpanded ? "收起正文" : "查看正文"}
													</button>
												</div>
											)}

											{bodyError && (
												<p className="board-post-body-error" role="alert">
													加载正文失败：{bodyError}
												</p>
											)}

											{isExpanded && fullPost && (
												<div className="board-post-body">
													{fullPost.body ? (
														<MarkdownView content={fullPost.body} />
													) : (
														<p className="board-empty-hint">该板帖无额外正文。</p>
													)}
													{fullPost.artifacts && (
														<div className="board-post-artifacts">
															{fullPost.artifacts.files && fullPost.artifacts.files.length > 0 && (
																<div className="board-artifact-row">
																	<span className="board-artifact-label">变更文件</span>
																	<div className="board-scope-chips">
																		{fullPost.artifacts.files.map((file) => (
																			<span key={file.path} className="board-scope-chip">
																				{file.path}
																				{file.linesAdded !== undefined
																					? ` +${file.linesAdded}`
																					: ""}
																				{file.linesDeleted !== undefined
																					? ` -${file.linesDeleted}`
																					: ""}
																			</span>
																		))}
																	</div>
																</div>
															)}
															{fullPost.artifacts.commits && fullPost.artifacts.commits.length > 0 && (
																<div className="board-artifact-row">
																	<span className="board-artifact-label">Commits</span>
																	<div className="board-scope-chips">
																		{fullPost.artifacts.commits.map((hash) => (
																			<span key={hash} className="board-scope-chip">
																				{hash.slice(0, 8)}
																			</span>
																		))}
																	</div>
																</div>
															)}
															{fullPost.artifacts.commands && fullPost.artifacts.commands.length > 0 && (
																<div className="board-artifact-row">
																	<span className="board-artifact-label">验证命令</span>
																	<div className="board-scope-chips">
																		{fullPost.artifacts.commands.map((cmd) => (
																			<span key={cmd} className="board-scope-chip">
																				{cmd}
																			</span>
																		))}
																	</div>
																</div>
															)}
														</div>
													)}
												</div>
											)}
										</article>
									);
								})
							)}
						</div>

						{canPostToBoard && (
							<form
								className="board-composer"
								onSubmit={(event) => {
									event.preventDefault();
									void handleSubmitBoardPost();
								}}
							>
								<div className="board-composer-top">
									<select
										className="select-sm"
										aria-label="板帖类型"
										value={composeKind}
										onChange={(event) => setComposeKind(event.target.value as BoardPostKind)}
									>
										{COMPOSER_KIND_OPTIONS.map((opt) => (
											<option key={opt.value} value={opt.value}>
												{opt.label}
											</option>
										))}
									</select>
									<fieldset className="board-mention-chips" aria-label="选择唤醒成员">
										{mentionCandidates.map((agentId) => {
											const active = composeMentions.includes(agentId);
											return (
												<button
													key={agentId}
													type="button"
													className={`board-mention-chip${active ? " active" : ""}`}
													aria-pressed={active}
													onClick={() => handleToggleMention(agentId)}
												>
													@{agentId}
												</button>
											);
										})}
									</fieldset>
								</div>

								<input
									type="text"
									className="input-field board-composer-summary"
									aria-label="公告板摘要"
									placeholder="输入摘要直接发帖到公告板（点选上方 @成员 可定向唤醒）…"
									value={composeSummary}
									disabled={composeSubmitting}
									onChange={(event) => setComposeSummary(event.target.value)}
								/>

								{composeShowBody && (
									<textarea
										className="input-field board-composer-textarea"
										aria-label="公告板完整正文"
										rows={3}
										placeholder="可选：补充详细说明或验收要求（支持 Markdown）"
										value={composeBody}
										disabled={composeSubmitting}
										onChange={(event) => setComposeBody(event.target.value)}
									/>
								)}

								{composeError && (
									<div className="board-inline-error" role="alert">
										<span>{composeError}</span>
									</div>
								)}

								<div className="board-composer-foot">
									<button
										type="button"
										className="btn-inline"
										onClick={() => setComposeShowBody((prev) => !prev)}
									>
										{composeShowBody ? "隐藏正文" : "+ 补充正文"}
									</button>
									<button
										type="submit"
										className="btn-pill-dark btn-xs"
										disabled={composeSubmitting || (!composeSummary.trim() && !composeBody.trim())}
									>
										{composeSubmitting ? "发布中…" : "发布板帖"}
									</button>
								</div>
							</form>
						)}
					</div>
				)}

				{activeTab === "graph" && (
					<BoardMentionGraph
						members={members}
						posts={posts}
						hideInactive={hideInactive}
						onToggleHideInactive={() => setHideInactive((prev) => !prev)}
						onSelectAgent={(agentId) => {
							setPostKindFilter("all");
							setPostQuery(`@${agentId}`);
							onSelectTab("board");
						}}
					/>
				)}

				{activeTab === "events" && (
					<div className="board-events-tab">
						<div className="board-events-toolbar">
							<select
								className="select-sm"
								aria-label="按成员筛选事件"
								value={eventFilterAgentId}
								onChange={(event) => onChangeEventFilterAgentId(event.target.value)}
							>
								<option value="">全部成员</option>
								{members.map((member) => (
									<option key={member.agentId} value={member.agentId}>
										{member.displayName} (@{member.agentId})
									</option>
								))}
							</select>
							<button
								type="button"
								className="btn-pill-outline btn-xs"
								disabled={eventsLoading}
								onClick={onRefreshEvents}
							>
								{eventsLoading ? "加载中…" : "刷新事件"}
							</button>
						</div>

						<fieldset className="board-filter-pills" aria-label="按事件类型筛选">
							{EVENT_TYPE_FILTERS.map((item) => (
								<button
									key={item.value}
									type="button"
									className={`board-filter-pill${eventFilterType === item.value ? " active" : ""}`}
									aria-pressed={eventFilterType === item.value}
									onClick={() => onChangeEventFilterType(item.value)}
								>
									{item.label}
								</button>
							))}
						</fieldset>

						{eventsError && (
							<div className="board-inline-error" role="alert">
								<span>加载事件失败：{eventsError}</span>
								<button type="button" className="btn-inline" onClick={onRefreshEvents}>
									重试
								</button>
							</div>
						)}

						<div className="board-events-list">
							{events.length === 0 && !eventsLoading ? (
								<div className="board-empty-state">
									<p>暂无匹配的事件轨迹。</p>
								</div>
							) : (
								events.map((event) => (
									<div
										key={event.id}
										className={`board-event-row${event.eventType === "monitor_alert" ? " is-alert" : ""}`}
									>
										<div className="board-event-head">
											<span className={`board-event-type is-${event.eventType}`}>
												{eventTypeLabel(event.eventType)}
											</span>
											{event.agentId && <span className="board-event-agent">@{event.agentId}</span>}
											{event.boardPostNo !== null && (
												<span className="board-post-no">#{event.boardPostNo}</span>
											)}
											<span className="board-post-time">{formatTime(event.createdAt)}</span>
										</div>
										<p className="board-event-summary">{formatBoardEventPayload(event)}</p>
									</div>
								))
							)}
						</div>

						{eventsHasMore && (
							<div className="board-events-more">
								<button
									type="button"
									className="btn-pill-outline btn-xs"
									disabled={eventsLoading}
									onClick={onLoadMoreEvents}
								>
									{eventsLoading ? "加载中…" : "加载更多"}
								</button>
							</div>
						)}
					</div>
				)}
			</div>

			<ModalDialog
				open={Boolean(swapTargetMember)}
				title={swapTargetMember ? `为 @${swapTargetMember.agentId} 热切换模型` : "切换模型"}
				subtitle="仅在成员处于待命（waiting）状态时允许原地切换模型，下一轮唤醒将继续保留原有 Pi 会话历史。"
				size="sm"
				closeDisabled={swapSaving}
				onClose={() => !swapSaving && setSwapTargetMember(null)}
				footer={
					<>
						<button
							type="button"
							className="btn-pill-outline"
							disabled={swapSaving}
							onClick={() => setSwapTargetMember(null)}
						>
							取消
						</button>
						<button
							type="button"
							className="btn-pill-dark"
							disabled={swapSaving}
							onClick={() => void handleSaveModelSwap()}
						>
							{swapSaving ? "保存中…" : "确认切换"}
						</button>
					</>
				}
			>
				<div className="board-swap-form">
					<label className="board-swap-field">
						<span>模型选择</span>
						<select
							className="input-field"
							value={swapModelKey}
							disabled={swapSaving}
							onChange={(event) => {
								setSwapModelKey(event.target.value);
								setSwapThinking("");
							}}
						>
							<option value="">使用默认模型（清除覆盖）</option>
							{modelOptions.map((item) => {
								const key = `${item.provider}::${item.model}`;
								return (
									<option key={key} value={key}>
										{item.provider} / {item.model}
									</option>
								);
							})}
						</select>
					</label>
					{swapModelKey && selectedSwapModelOption && selectedSwapModelOption.thinkingLevels.length > 0 && (
						<label className="board-swap-field">
							<span>思考等级（可选）</span>
							<select
								className="input-field"
								value={swapThinking}
								disabled={swapSaving}
								onChange={(event) => setSwapThinking(event.target.value as ModelThinkingLevel | "")}
							>
								<option value="">由 Pi 默认决定</option>
								{selectedSwapModelOption.thinkingLevels.map((level) => (
									<option key={level} value={level}>
										{level}
									</option>
								))}
							</select>
						</label>
					)}
					{swapError && (
						<div className="board-inline-error" role="alert">
							<span>{swapError}</span>
						</div>
					)}
				</div>
			</ModalDialog>
		</aside>
	);
}
