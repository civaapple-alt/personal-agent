import { useMemo, useState } from "react";
import type { ModelSelection } from "../../api/models.ts";
import type {
	BoardMemberDto,
	BoardPostDto,
	BoardPostKind,
	CreateBoardPostInput,
	MatterBoardSnapshotDto,
	MatterCollaborationMode,
	MatterEventDto,
	MatterEventType,
	UpdateBoardMemberControlInput,
} from "../../api.ts";
import {
	buildActiveMentionCandidates,
	filterBoardPosts,
	filterVisibleBoardMembers,
	formatBoardEventPayload,
	groupBoardMembers,
	summarizeBoardStatus,
} from "../../hooks/useMatterBoard.ts";
import { ModalDialog } from "../../primitives/ModalDialog.tsx";
import { useModelCatalog } from "../ModelPicker.tsx";
import { BoardMembersTab } from "./BoardMembersTab.tsx";
import { BoardMentionGraph } from "./BoardMentionGraph.tsx";
import { BoardPostsTab } from "./BoardPostsTab.tsx";

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

const EVENT_TYPE_FILTERS: ReadonlyArray<{ value: MatterEventType | "all"; label: string }> = [
	{ value: "all", label: "全部事件" },
	{ value: "tool_start", label: "工具开始" },
	{ value: "tool_end", label: "工具完成" },
	{ value: "monitor_alert", label: "停滞告警" },
	{ value: "turn_summary", label: "轮次摘要" },
];

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
					<BoardMembersTab
						coordinator={coordinator}
						groups={groups}
						posts={posts}
						activeMemberCount={activeMemberCount}
						retiredCount={retiredCount}
						hideInactive={hideInactive}
						showRetiredGroup={showRetiredGroup}
						canControlMembers={canControlMembers}
						busyAgentId={busyAgentId}
						memberActionError={memberActionError}
						onClearMemberActionError={() => setMemberActionError(null)}
						onToggleHideInactive={() => setHideInactive((prev) => !prev)}
						onToggleRetiredGroup={() => setShowRetiredGroup((prev) => !prev)}
						onTogglePause={(member) => void handleTogglePause(member)}
						onOpenSwapModal={openSwapModal}
						onRetireMember={(member) => void handleRetireMember(member)}
						onOpenBoardTab={() => onSelectTab("board")}
					/>
				)}

				{activeTab === "board" && (
					<BoardPostsTab
						totalPostCount={posts.length}
						filteredPosts={filteredPosts}
						postQuery={postQuery}
						onPostQueryChange={setPostQuery}
						postKindFilter={postKindFilter}
						onPostKindFilterChange={setPostKindFilter}
						expandedPostNos={expandedPostNos}
						postBodiesByNo={postBodiesByNo}
						loadingPostNos={loadingPostNos}
						postBodyErrors={postBodyErrors}
						onTogglePostBody={(postNo) => void handleTogglePostBody(postNo)}
						canPostToBoard={canPostToBoard}
						composeKind={composeKind}
						onComposeKindChange={setComposeKind}
						mentionCandidates={mentionCandidates}
						composeMentions={composeMentions}
						onToggleMention={handleToggleMention}
						composeSummary={composeSummary}
						onComposeSummaryChange={setComposeSummary}
						composeBody={composeBody}
						onComposeBodyChange={setComposeBody}
						composeShowBody={composeShowBody}
						onToggleComposeShowBody={() => setComposeShowBody((prev) => !prev)}
						composeSubmitting={composeSubmitting}
						composeError={composeError}
						onSubmitBoardPost={() => void handleSubmitBoardPost()}
						formatTime={formatTime}
					/>
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
