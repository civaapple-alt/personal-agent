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
import {
	Badge,
	type BadgeTone,
	Banner,
	Button,
	EmptyState,
	FieldGroup,
	ModalDialog,
	Select,
	type TabItem,
	Tabs,
} from "../../primitives/index.ts";
import { cn } from "../../utils/cn.ts";
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

function eventTypeTone(eventType: MatterEventType): BadgeTone {
	switch (eventType) {
		case "monitor_alert":
			return "danger";
		case "tool_start":
		case "tool_end":
			return "info";
		case "capability_ready":
		case "turn_summary":
			return "success";
	}
}

function summaryBadgeTone(tone: "working" | "blocked" | "idle"): BadgeTone {
	if (tone === "working") return "success";
	if (tone === "blocked") return "warn";
	return "neutral";
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

	const tabItems = useMemo<TabItem[]>(
		() => [
			{
				id: "members",
				label:
					retiredCount > 0 ? (
						<span className="inline-flex items-center gap-1.5">
							<span>成员</span>
							<span className="px-1.5 py-0.5 text-micro rounded-pill bg-subtle text-ink-muted leading-none tabular-nums">
								{activeMemberCount}/{members.length}
							</span>
						</span>
					) : (
						"成员"
					),
				count: retiredCount > 0 ? undefined : members.length,
			},
			{ id: "board", label: "公告板", count: posts.length },
			{ id: "graph", label: "关系图" },
			{ id: "events", label: "事件轨迹" },
		],
		[activeMemberCount, members.length, posts.length, retiredCount],
	);

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
		<aside
			aria-label="团队公告板面板"
			className="flex flex-col min-w-0 min-h-0 h-full border-l border-line bg-stage overflow-hidden max-[960px]:absolute max-[960px]:inset-0 max-[960px]:z-25 max-[960px]:border-l-0 max-[960px]:shadow-lg"
		>
			<header className="flex items-start justify-between gap-2.5 px-3.5 pt-3 pb-2.5 border-b border-line bg-stage shrink-0">
				<div className="flex flex-col gap-0.5 min-w-0">
					<div className="flex items-center gap-2 flex-wrap">
						<h2 className="m-0 text-md font-semibold text-ink leading-snug">团队公告板</h2>
						<Badge tone={summaryBadgeTone(statusSummary.tone)} dot size="xs">
							{statusSummary.label}
						</Badge>
					</div>
					<span className="text-xs text-ink-muted truncate" title={matterTitle}>
						{collaborationMode === "board" ? "Board 异步协作" : "Lead 模式（只读看板）"} · {matterTitle}
					</span>
				</div>
				<div className="flex items-center gap-1.5 shrink-0">
					<Button variant="secondary" size="xs" disabled={loading} onClick={onRefreshBoard}>
						{loading ? "刷新中…" : "刷新"}
					</Button>
					<Button variant="inline" size="xs" onClick={onClose}>
						关闭
					</Button>
				</div>
			</header>

			<Tabs
				items={tabItems}
				value={activeTab}
				onChange={(tabId) => onSelectTab(tabId as BoardPaneTab)}
				variant="underline"
				size="sm"
				ariaLabel="看板视图"
				className="px-3 bg-surface shrink-0"
			/>

			{error && (
				<div className="px-3.5 pt-2.5 shrink-0">
					<Banner
						tone="danger"
						actions={
							<Button variant="inline" size="xs" onClick={onRefreshBoard}>
								重试
							</Button>
						}
					>
						加载看板失败：{error}
					</Banner>
				</div>
			)}

			<div className="flex-1 min-h-0 overflow-y-auto px-3.5 pt-3 pb-4 flex flex-col gap-3">
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
					<div className="flex flex-col gap-2.5">
						<div className="flex items-center justify-between gap-2 flex-wrap">
							<Select
								size="sm"
								aria-label="按成员筛选事件"
								value={eventFilterAgentId}
								onChange={(event) => onChangeEventFilterAgentId(event.target.value)}
								className="flex-1 min-w-0"
							>
								<option value="">全部成员</option>
								{members.map((member) => (
									<option key={member.agentId} value={member.agentId}>
										{member.displayName} (@{member.agentId})
									</option>
								))}
							</Select>
							<Button variant="secondary" size="xs" disabled={eventsLoading} onClick={onRefreshEvents}>
								{eventsLoading ? "加载中…" : "刷新事件"}
							</Button>
						</div>

						<fieldset className="flex flex-wrap gap-1 m-0 p-0 border-0" aria-label="按事件类型筛选">
							{EVENT_TYPE_FILTERS.map((item) => {
								const active = eventFilterType === item.value;
								return (
									<button
										key={item.value}
										type="button"
										aria-pressed={active}
										onClick={() => onChangeEventFilterType(item.value)}
										className={cn(
											"px-2.5 py-0.5 rounded-pill text-micro border transition-colors cursor-pointer",
											active
												? "border-accent bg-accent-soft text-accent font-semibold"
												: "border-line bg-stage text-ink-secondary font-medium hover:border-line-strong hover:text-ink",
										)}
									>
										{item.label}
									</button>
								);
							})}
						</fieldset>

						{eventsError && (
							<Banner
								tone="danger"
								actions={
									<Button variant="inline" size="xs" onClick={onRefreshEvents}>
										重试
									</Button>
								}
							>
								加载事件失败：{eventsError}
							</Banner>
						)}

						<div className="flex flex-col gap-1.5">
							{events.length === 0 && !eventsLoading ? (
								<EmptyState compact title="暂无匹配的事件轨迹。" />
							) : (
								events.map((event) => {
									const isAlert = event.eventType === "monitor_alert";
									return (
										<div
											key={event.id}
											className={cn(
												"board-event-row flex flex-col gap-1 px-2.5 py-2 border rounded-sm",
												isAlert ? "is-alert border-warn-border bg-warn-bg" : "border-line bg-card",
											)}
										>
											<div className="flex items-center gap-1.5 flex-wrap">
												<Badge tone={eventTypeTone(event.eventType)} size="xs" className="rounded-xs">
													{eventTypeLabel(event.eventType)}
												</Badge>
												{event.agentId && (
													<span className="font-mono text-micro text-accent font-semibold">
														@{event.agentId}
													</span>
												)}
												{event.boardPostNo !== null && (
													<span className="font-mono text-xs font-semibold text-ink">
														#{event.boardPostNo}
													</span>
												)}
												<span className="text-micro text-ink-muted ml-auto tabular-nums">
													{formatTime(event.createdAt)}
												</span>
											</div>
											<p className="m-0 text-xs text-ink leading-normal break-words">
												{formatBoardEventPayload(event)}
											</p>
										</div>
									);
								})
							)}
						</div>

						{eventsHasMore && (
							<div className="flex justify-center py-1">
								<Button variant="secondary" size="xs" disabled={eventsLoading} onClick={onLoadMoreEvents}>
									{eventsLoading ? "加载中…" : "加载更多"}
								</Button>
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
						<Button variant="secondary" size="sm" disabled={swapSaving} onClick={() => setSwapTargetMember(null)}>
							取消
						</Button>
						<Button variant="primary" size="sm" disabled={swapSaving} onClick={() => void handleSaveModelSwap()}>
							{swapSaving ? "保存中…" : "确认切换"}
						</Button>
					</>
				}
			>
				<div className="flex flex-col gap-3">
					<FieldGroup label="模型选择" htmlFor="board-swap-model-select">
						<Select
							id="board-swap-model-select"
							size="md"
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
						</Select>
					</FieldGroup>
					{swapModelKey && selectedSwapModelOption && selectedSwapModelOption.thinkingLevels.length > 0 && (
						<FieldGroup label="思考等级（可选）" htmlFor="board-swap-thinking-select">
							<Select
								id="board-swap-thinking-select"
								size="md"
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
							</Select>
						</FieldGroup>
					)}
					{swapError && <Banner tone="danger">{swapError}</Banner>}
				</div>
			</ModalDialog>
		</aside>
	);
}
