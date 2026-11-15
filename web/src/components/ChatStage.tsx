import { type KeyboardEvent, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import {
	type DeliverableDto,
	type DistillRsiResult,
	type MatterDetailPayload,
	type MatterProgressDto,
	type MemberMemoryDto,
	type PendingDialogDto,
	type RoleTemplateDto,
	respondToDialog,
	type TeamMemberDto,
	type WorkspaceDto,
} from "../api.ts";
import { MarkdownView } from "../MarkdownView.tsx";
import {
	collectMatterMemories,
	collectMatterParticipantIds,
	type DelegationSummaryItem,
	formatClockTime,
	formatNoticeEventLine,
	getMemberThemeById,
	isKeyNoticeEvent,
	mapDelegationsToMessages,
	mapDeliverablesToMessages,
	parseProgressSnapshot,
	type StarterTask,
} from "../utils.ts";
import { BotFaceIcon } from "./BotFaceIcon.tsx";
import { InlineExperienceReviewSection } from "./ExperienceReviewPanel.tsx";
import { ExploringStatus, ProgressSnapshotCard } from "./ExploringStatus.tsx";

interface ChatStageProps {
	composerRef: RefObject<HTMLTextAreaElement | null>;
	selectedWorkspace: WorkspaceDto | null;
	selectedWorkspaceId: string;
	workspaces: WorkspaceDto[];
	members: TeamMemberDto[];
	selectedMemberId: string;
	headerContact: TeamMemberDto | null;
	headerTheme: { bg: string; tilt: string };
	selectedMatterId: string | null;
	matterDetail: MatterDetailPayload | null;
	activeDialogs: PendingDialogDto[];
	activeChatDeliverable: DeliverableDto | null;
	deliverablesCount: number;
	selectedDeliverableId: string | null;
	activeMatterProgress: MatterProgressDto | null;
	elapsedSeconds: number;
	streamingDelta: string;
	submitting: boolean;
	composerText: string;
	errorBanner: string | null;
	noticeBanner: string | null;
	starterTasks: StarterTask[];
	templateByRoleId: Map<string, RoleTemplateDto>;
	memoriesByMember: Record<string, MemberMemoryDto[]>;
	memberName: (id: string) => string;
	workspaceName: (id: string | null) => string | null;
	previewUrlFor: (deliverable: DeliverableDto | null) => string | null;
	onComposerTextChange: (value: string) => void;
	onSelectWorkspace: (workspaceId: string) => void;
	onSelectMember: (memberId: string) => void;
	activeObserverIds: string[];
	onUpdateObservers: (observerIds: string[]) => void;
	onSendPrompt: () => void;
	onAbortMatter: (matterId: string) => void;
	onNewMatter: () => void;
	onOpenDeliverables: (deliverableId?: string) => void;
	onOpenTeam: () => void;
	onDistillMatter: (matterId: string) => Promise<DistillRsiResult | undefined>;
	onCancelDistillMatter?: (matterId: string) => void;
	onRefresh: () => Promise<void>;
	onNotice: (message: string) => void;
	onError: (message: string) => void;
	onDismissError: () => void;
	onDismissNotice: () => void;
}

export function ChatStage({
	composerRef,
	selectedWorkspace,
	selectedWorkspaceId,
	workspaces,
	members,
	selectedMemberId,
	headerContact,
	headerTheme,
	selectedMatterId,
	matterDetail,
	activeDialogs,
	activeChatDeliverable,
	deliverablesCount,
	selectedDeliverableId,
	activeMatterProgress,
	elapsedSeconds,
	streamingDelta,
	submitting,
	composerText,
	errorBanner,
	noticeBanner,
	starterTasks,
	templateByRoleId,
	memoriesByMember,
	memberName,
	workspaceName,
	previewUrlFor,
	onComposerTextChange,
	onSelectWorkspace,
	onSelectMember,
	activeObserverIds,
	onUpdateObservers,
	onSendPrompt,
	onAbortMatter,
	onNewMatter,
	onOpenDeliverables,
	onOpenTeam,
	onDistillMatter,
	onCancelDistillMatter,
	onRefresh,
	onNotice,
	onError,
	onDismissError,
	onDismissNotice,
}: ChatStageProps) {
	const [collabOpen, setCollabOpen] = useState(false);
	const [collabTab, setCollabTab] = useState<"delegations" | "events" | "experiences">("delegations");
	const [distillingMatter, setDistillingMatter] = useState(false);
	const [distillNoteByMatter, setDistillNoteByMatter] = useState<Record<string, string>>({});
	const [expandedDelegations, setExpandedDelegations] = useState<Record<string, boolean>>({});
	const [expandedDelegationTexts, setExpandedDelegationTexts] = useState<Record<string, boolean>>({});
	const [eventsKeyOnly, setEventsKeyOnly] = useState(false);
	const [showAllEvents, setShowAllEvents] = useState(false);
	const [collapsedSnapshots, setCollapsedSnapshots] = useState<Record<string, boolean>>({});
	const [starterMenuOpen, setStarterMenuOpen] = useState(false);
	const [observerMenuOpen, setObserverMenuOpen] = useState(false);
	const [dialogInput, setDialogInput] = useState("");
	const messagesEndRef = useRef<HTMLDivElement | null>(null);
	const collabTriggerRef = useRef<HTMLSpanElement | null>(null);
	const collabPanelRef = useRef<HTMLDivElement | null>(null);
	const composerDockRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (!collabOpen && !starterMenuOpen && !observerMenuOpen) return;
		const onMouseDown = (event: MouseEvent) => {
			const target = event.target as Node | null;
			if (!target) return;
			if (collabOpen && !collabPanelRef.current?.contains(target) && !collabTriggerRef.current?.contains(target)) {
				setCollabOpen(false);
			}
			if ((starterMenuOpen || observerMenuOpen) && !composerDockRef.current?.contains(target)) {
				setStarterMenuOpen(false);
				setObserverMenuOpen(false);
			}
		};
		const onKeyDown = (event: globalThis.KeyboardEvent) => {
			if (event.key === "Escape") {
				setCollabOpen(false);
				setStarterMenuOpen(false);
				setObserverMenuOpen(false);
			}
		};
		document.addEventListener("mousedown", onMouseDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("mousedown", onMouseDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [collabOpen, starterMenuOpen, observerMenuOpen]);

	const matterMemories = useMemo(
		() => (matterDetail ? collectMatterMemories(memoriesByMember, matterDetail.matter.id) : []),
		[memoriesByMember, matterDetail],
	);
	const pendingMatterMemoriesCount = useMemo(
		() => matterMemories.filter((m) => (m.status ?? (m.verified ? "verified" : "candidate")) === "candidate").length,
		[matterMemories],
	);
	const matterParticipantIds = useMemo(
		() =>
			matterDetail
				? collectMatterParticipantIds({
						matter: matterDetail.matter,
						userMessages: matterDetail.userMessages,
						internalCollabMessages: matterDetail.internalCollabMessages,
						deliverables: matterDetail.deliverables,
					})
				: [],
		[matterDetail],
	);

	const handleDistillCurrentMatter = async () => {
		if (!matterDetail) return;
		const targetMatterId = matterDetail.matter.id;
		setDistillingMatter(true);
		try {
			const res = await onDistillMatter(targetMatterId);
			if (res) {
				const note = res.aborted
					? "已取消本次 AI 经验复盘。"
					: res.createdMemories.length > 0
						? `AI 复盘完成：已从协同轨迹为 ${Array.from(new Set(res.createdMemories.map((m) => memberName(m.memberId)))).join("、")} 提炼 ${res.createdMemories.length} 条经验。`
						: res.skippedDuplicates > 0
							? `AI 复盘完成：未新增重复条目（跳过 ${res.skippedDuplicates} 条相似经验）。`
							: `AI 复盘完成：${res.summary}`;
				setDistillNoteByMatter((prev) => ({ ...prev, [targetMatterId]: note }));
			}
		} finally {
			setDistillingMatter(false);
		}
	};

	const isTurnRunning = Boolean(selectedMatterId && activeMatterProgress);
	const messageCount = matterDetail?.userMessages.length ?? 0;
	const streamLen = streamingDelta.length;
	useEffect(() => {
		if (messageCount > 0 || streamLen > 0) {
			messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
		}
	}, [messageCount, streamLen]);

	const handleComposerKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
			e.preventDefault();
			if (!isTurnRunning && !submitting) {
				onSendPrompt();
			}
		}
	};

	const deliverablesPlacement = useMemo(
		() => mapDeliverablesToMessages(matterDetail?.userMessages ?? [], matterDetail?.deliverables ?? []),
		[matterDetail],
	);

	const delegationsPlacement = useMemo(
		() =>
			mapDelegationsToMessages(
				matterDetail?.userMessages ?? [],
				matterDetail?.internalCollabMessages ?? [],
				isTurnRunning,
			),
		[matterDetail, isTurnRunning],
	);

	const filteredNotices = useMemo(() => {
		const raw = matterDetail?.noticeMessages ?? [];
		const ordered = [...raw].reverse();
		return eventsKeyOnly ? ordered.filter((entry) => isKeyNoticeEvent(entry.content)) : ordered;
	}, [matterDetail?.noticeMessages, eventsKeyOnly]);

	const visibleNotices = useMemo(
		() => (showAllEvents ? filteredNotices : filteredNotices.slice(0, 80)),
		[filteredNotices, showAllEvents],
	);

	const resolveDelegationTarget = (item: DelegationSummaryItem) =>
		item.targetLabel || (item.toMemberId ? memberName(item.toMemberId) : "团队成员");

	const renderDelegationItemCard = (item: DelegationSummaryItem, keyPrefix: string, showTime: boolean) => {
		const itemKey = `${keyPrefix}:${item.id}`;
		const totalLen = item.question.length + (item.answer?.length ?? 0);
		const isLong = totalLen > 220 || item.question.split("\n").length > 4;
		const isTextExpanded = Boolean(expandedDelegationTexts[itemKey]);
		const compactPreview = !isTextExpanded && isLong;

		return (
			<div key={item.id} className="delegation-detail-item">
				<div className="delegation-detail-head">
					<span>
						{memberName(item.fromMemberId)} → <strong>{resolveDelegationTarget(item)}</strong>
						{showTime ? ` · ${formatClockTime(item.createdAt)}` : ""}
					</span>
					<span className={`delegation-status-tag ${item.status}`}>
						{item.status === "running" ? "协同中" : item.status === "completed" ? "已完成" : "未完成"}
					</span>
				</div>
				<div className={`delegation-md-body ${compactPreview ? "is-collapsed" : ""}`}>
					<MarkdownView content={item.question} />
				</div>
				{item.answer && (
					<div className={`delegation-detail-answer delegation-md-body ${compactPreview ? "is-collapsed" : ""}`}>
						<MarkdownView content={item.answer} />
					</div>
				)}
				{isLong && (
					<div className="delegation-collapse-row">
						<button
							type="button"
							className="btn-inline btn-xs"
							onClick={() =>
								setExpandedDelegationTexts((prev) => ({
									...prev,
									[itemKey]: !prev[itemKey],
								}))
							}
						>
							{isTextExpanded ? "收起内容" : "展开完整内容 →"}
						</button>
					</div>
				)}
			</div>
		);
	};

	const renderDelegationSummary = (anchorKey: string, items: DelegationSummaryItem[]) => {
		if (items.length === 0) return null;
		const expanded = Boolean(expandedDelegations[anchorKey]);
		const targets = [...new Set(items.map((item) => resolveDelegationTarget(item)))];
		const runningCount = items.filter((item) => item.status === "running").length;
		const failedCount = items.filter((item) => item.status === "failed").length;
		const statusSummary =
			runningCount > 0
				? `${runningCount} 项协同中`
				: failedCount === items.length
					? `${items.length} 项未完成`
					: failedCount > 0
						? `${items.length - failedCount} 项完成 · ${failedCount} 项未完成`
						: `${items.length} 项已完成`;
		return (
			<div className={`delegation-inline-card ${runningCount > 0 ? "is-running" : ""}`}>
				<button
					type="button"
					className="delegation-inline-toggle"
					onClick={() => setExpandedDelegations((prev) => ({ ...prev, [anchorKey]: !prev[anchorKey] }))}
				>
					<span className="delegation-pill-info">
						<span className="delegation-pill-badge">团队委托</span>
						<span>
							已委托 <strong>{targets.join("、")}</strong> · {statusSummary}
						</span>
					</span>
					<span className="delegation-toggle-text">{expanded ? "收起详情" : "查看详情"}</span>
				</button>
				{expanded && (
					<div className="delegation-detail-list">
						{items.map((item) => renderDelegationItemCard(item, `inline-${anchorKey}`, false))}
					</div>
				)}
			</div>
		);
	};

	const renderDeliverablePill = (deliv: DeliverableDto) => {
		const url = previewUrlFor(deliv);
		return (
			<div key={deliv.id} className="deliverable-inline-pill">
				<span className="deliverable-pill-info">
					<span className="deliverable-pill-check">✓</span>
					<span>
						已归档至成果库 · <strong>V{deliv.version}</strong>
					</span>
				</span>
				<span className="deliverable-pill-actions">
					{url && (
						<a className="btn-inline" href={url} target="_blank" rel="noreferrer">
							打开预览 →
						</a>
					)}
					<button type="button" className="btn-inline" onClick={() => onOpenDeliverables(deliv.id)}>
						在成果库查看
					</button>
				</span>
			</div>
		);
	};

	return (
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
					<BotFaceIcon
						bg={headerTheme.bg}
						size="sm"
						mood={isTurnRunning && activeMatterProgress ? activeMatterProgress.stage : "idle"}
					/>
					<span className="stage-center-name">{headerContact ? headerContact.displayName : "AI 团队"}</span>
					{matterDetail && <span className="stage-center-matter">· {matterDetail.matter.title}</span>}
				</div>
				<div className="stage-header-right">
					{matterDetail && (
						<span ref={collabTriggerRef} className="collab-header-triggers">
							<button
								type="button"
								aria-expanded={collabOpen && collabTab !== "experiences"}
								className={`btn-pill-outline btn-xs ${collabOpen && collabTab !== "experiences" ? "active" : ""}`}
								title="查看团队内部委托记录及底层工具调用事件"
								onClick={() => {
									setCollabOpen((open) => {
										const next = !open || collabTab === "experiences";
										if (
											next &&
											delegationsPlacement.all.length === 0 &&
											matterDetail.noticeMessages.length > 0
										) {
											setCollabTab("events");
										} else if (next) {
											setCollabTab("delegations");
										}
										return next;
									});
								}}
							>
								{delegationsPlacement.all.length > 0
									? `团队委托 (${delegationsPlacement.all.length}) · 事件 ${matterDetail.noticeMessages.length}`
									: `过程事件 (${matterDetail.noticeMessages.length})`}
							</button>
							<button
								type="button"
								aria-expanded={collabOpen && collabTab === "experiences"}
								className={`btn-pill-outline btn-xs ${collabOpen && collabTab === "experiences" ? "active" : ""}`}
								title="在本事项上下文中提炼、查看并核验各岗位协同经验"
								onClick={() => {
									setCollabOpen((open) => !(open && collabTab === "experiences"));
									setCollabTab("experiences");
								}}
							>
								经验复盘 ({matterMemories.length})
								{pendingMatterMemoriesCount > 0 ? ` · ${pendingMatterMemoriesCount} 待核验` : ""}
							</button>
						</span>
					)}
					<button
						type="button"
						className="btn-pill-outline btn-xs"
						onClick={() => onOpenDeliverables(activeChatDeliverable?.id ?? selectedDeliverableId ?? undefined)}
					>
						成果库 ({deliverablesCount})
					</button>
				</div>
			</header>

			{collabOpen && matterDetail && (
				<div ref={collabPanelRef} role="dialog" aria-label="团队委托与过程事件" className="collab-dock-panel">
					<div className="collab-dock-inner">
						<div className="collab-dock-head">
							<div className="collab-tabs">
								<button
									type="button"
									className={`collab-tab-btn ${collabTab === "delegations" ? "active" : ""}`}
									onClick={() => setCollabTab("delegations")}
								>
									团队内部委托 ({delegationsPlacement.all.length})
								</button>
								<button
									type="button"
									className={`collab-tab-btn ${collabTab === "events" ? "active" : ""}`}
									onClick={() => setCollabTab("events")}
								>
									过程与工具事件 ({matterDetail.noticeMessages.length})
								</button>
								<button
									type="button"
									className={`collab-tab-btn ${collabTab === "experiences" ? "active" : ""}`}
									onClick={() => setCollabTab("experiences")}
								>
									经验复盘 ({matterMemories.length})
								</button>
							</div>
							<button type="button" className="btn-inline" onClick={() => setCollabOpen(false)}>
								收起
							</button>
						</div>
						<div className="collab-log">
							{collabTab === "experiences" ? (
								<InlineExperienceReviewSection
									matterId={matterDetail.matter.id}
									defaultMemberId={matterDetail.matter.leadMemberId ?? selectedMemberId}
									workspaceId={matterDetail.matter.workspaceId}
									participantIds={matterParticipantIds}
									memories={matterMemories}
									members={members}
									workspaces={workspaces}
									memberName={memberName}
									workspaceName={workspaceName}
									title="本事项团队经验复盘"
									lastDistillNote={distillNoteByMatter[matterDetail.matter.id] ?? null}
									distilling={distillingMatter}
									onDistill={() => void handleDistillCurrentMatter()}
									onCancelDistill={
										onCancelDistillMatter ? () => onCancelDistillMatter(matterDetail.matter.id) : undefined
									}
									onOpenTeam={onOpenTeam}
									onRefresh={onRefresh}
									onNotice={onNotice}
									onError={onError}
								/>
							) : collabTab === "delegations" ? (
								delegationsPlacement.all.length === 0 ? (
									<p className="muted-hint">当前事项暂无团队内部委托记录。</p>
								) : (
									<div className="collab-section">
										{delegationsPlacement.all.map((item) => renderDelegationItemCard(item, "dock", true))}
									</div>
								)
							) : matterDetail.noticeMessages.length === 0 ? (
								<p className="muted-hint">当前事项暂无底层工具或过程事件。</p>
							) : (
								<div className="collab-section">
									<div className="collab-events-toolbar">
										<div className="memory-filter-tabs">
											<button
												type="button"
												className={`choice-chip ${!eventsKeyOnly ? "active" : ""}`}
												onClick={() => setEventsKeyOnly(false)}
											>
												全部事件 ({matterDetail.noticeMessages.length})
											</button>
											<button
												type="button"
												className={`choice-chip ${eventsKeyOnly ? "active" : ""}`}
												onClick={() => setEventsKeyOnly(true)}
											>
												仅看关键/异常事件
											</button>
										</div>
										<span className="inline-participants-note">按最新时间倒序</span>
									</div>
									{visibleNotices.length === 0 ? (
										<p className="muted-hint">当前过滤条件下暂无关键或异常事件。</p>
									) : (
										<div className="collab-events-list">
											{visibleNotices.map((entry) => {
												const line = formatNoticeEventLine(entry.content);
												const isError = /异常|失败/.test(line);
												return (
													<div key={entry.id} className={`collab-event-row ${isError ? "is-error" : ""}`}>
														<span className="collab-event-meta">
															<strong>{memberName(entry.senderId)}</strong>
															<span>{formatClockTime(entry.createdAt)}</span>
														</span>
														<span className="collab-event-text">{line}</span>
													</div>
												);
											})}
											{!showAllEvents && filteredNotices.length > visibleNotices.length && (
												<button
													type="button"
													className="btn-pill-outline btn-xs"
													onClick={() => setShowAllEvents(true)}
												>
													展开更早事件（剩余 {filteredNotices.length - visibleNotices.length} 条）
												</button>
											)}
										</div>
									)}
								</div>
							)}
						</div>
					</div>
				</div>
			)}

			<div className="chat-stream-scroll">
				<div className="chat-stream-inner">
					{errorBanner && (
						<div className="approval-card banner-gap">
							<div className="banner-row">
								<span>
									<strong>操作提示：</strong> {errorBanner}
								</span>
								<button type="button" className="btn-inline" onClick={onDismissError}>
									关闭
								</button>
							</div>
						</div>
					)}
					{noticeBanner && (
						<div className="notice-card banner-gap">
							<div className="banner-row">
								<span>{noticeBanner}</span>
								<button type="button" className="btn-inline" onClick={onDismissNotice}>
									知道了
								</button>
							</div>
						</div>
					)}

					{!selectedMatterId || (!matterDetail && !activeMatterProgress) ? (
						<div className="welcome-hero">
							<BotFaceIcon bg={headerTheme.bg} size="lg" />
							<h2>{selectedMemberId === "auto" ? "有什么可以帮你？" : memberName(selectedMemberId)}</h2>
							<p>
								{selectedMemberId === "auto"
									? "直接描述目标，系统会自动分配最合适的同事推进"
									: (templateByRoleId.get(headerContact?.templateId ?? "")?.responsibilities.split("\n")[0] ??
										"直接输入任务开始协作")}
							</p>
						</div>
					) : (
						<>
							{matterDetail?.userMessages.map((msg) => {
								const isUser = msg.senderType === "user";
								const isSystem = msg.senderType === "system";
								const isObserverIntervention = msg.metadata?.observerIntervention === true;
								const speakerTheme = getMemberThemeById(members, msg.senderId);
								const attachedDeliverables = deliverablesPlacement.byMessageId.get(msg.id) ?? [];
								const attachedDelegations = delegationsPlacement.byMessageId.get(msg.id) ?? [];
								const progressSnapshot = parseProgressSnapshot(msg.metadata);
								const leadFallback =
									!isSystem && msg.senderId
										? memberName(msg.senderId)
										: matterDetail?.matter.leadMemberId
											? memberName(matterDetail.matter.leadMemberId)
											: undefined;
								return (
									<div key={msg.id} className={`stream-msg ${isUser ? "from-user" : "from-member"}`}>
										{!isUser && (
											<div className="stream-sender">
												{!isSystem && (
													<BotFaceIcon
														bg={speakerTheme.bg}
														tilt={speakerTheme.tilt}
														size="xs"
														mood="idle"
													/>
												)}
												<span>
													{isSystem ? "系统提示" : memberName(msg.senderId)} ·{" "}
													{formatClockTime(msg.createdAt)}
												</span>
												{isObserverIntervention && <span className="observer-badge">旁听补充</span>}
											</div>
										)}
										<div
											className={`stream-bubble ${isUser ? "user" : isSystem ? "system" : "member"}${isObserverIntervention ? " observer" : ""}`}
										>
											{isUser ? msg.content : <MarkdownView content={msg.content} />}
										</div>
										{progressSnapshot && (
											<ProgressSnapshotCard
												snapshot={progressSnapshot}
												expanded={!collapsedSnapshots[msg.id]}
												members={members}
												fallbackLeadName={leadFallback}
												onToggle={() =>
													setCollapsedSnapshots((prev) => ({
														...prev,
														[msg.id]: !prev[msg.id],
													}))
												}
											/>
										)}
										{renderDelegationSummary(msg.id, attachedDelegations)}
										{attachedDeliverables.map((deliv) => renderDeliverablePill(deliv))}
									</div>
								);
							})}

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

							{deliverablesPlacement.unattached.map((deliv) => renderDeliverablePill(deliv))}
							{renderDelegationSummary("unattached", delegationsPlacement.unattached)}

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
									elapsedSeconds={elapsedSeconds}
									members={members}
									leadMemberId={matterDetail?.matter.leadMemberId ?? headerContact?.id}
									leadDisplayName={
										matterDetail?.matter.leadMemberId
											? memberName(matterDetail.matter.leadMemberId)
											: headerContact?.displayName
									}
									onAbort={() => onAbortMatter(selectedMatterId)}
								/>
							)}
						</>
					)}
					<div ref={messagesEndRef} />
				</div>
			</div>

			<div className="composer-dock">
				<div ref={composerDockRef} className="composer-dock-inner">
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
											if (task.memberId) onSelectMember(task.memberId);
											onComposerTextChange(task.prompt);
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

					{observerMenuOpen && (
						<div className="quick-prompts-popover observer-popover">
							<div className="banner-row">
								<div>
									<strong>会议旁听成员</strong>
									<span className="observer-hint">
										主负责人答复后，旁听同事从本职角度审视（运行中调整也会对即将评估的旁听/下一轮生效）
									</span>
								</div>
								<div className="observer-quick-actions">
									<button
										type="button"
										className="btn-inline"
										onClick={() => {
											onUpdateObservers(members.filter((m) => m.id !== headerContact?.id).map((m) => m.id));
										}}
									>
										全员旁听
									</button>
									<button type="button" className="btn-inline" onClick={() => onUpdateObservers([])}>
										清空
									</button>
									<button type="button" className="btn-inline" onClick={() => setObserverMenuOpen(false)}>
										完成
									</button>
								</div>
							</div>
							<div className="observer-peer-list">
								{members
									.filter((m) => m.id !== headerContact?.id)
									.map((peer) => {
										const checked = activeObserverIds.includes(peer.id);
										const theme = getMemberThemeById(members, peer.id);
										return (
											<button
												key={peer.id}
												type="button"
												className={`observer-peer-chip ${checked ? "active" : ""}`}
												onClick={() => {
													const next = checked
														? activeObserverIds.filter((id) => id !== peer.id)
														: [...activeObserverIds, peer.id];
													onUpdateObservers(next);
												}}
											>
												<BotFaceIcon bg={theme.bg} tilt={theme.tilt} size="xs" mood="idle" />
												<span className="observer-peer-text">
													<strong>{peer.displayName}</strong>
													<small>{peer.roleTitle}</small>
												</span>
												<span className="observer-peer-check">{checked ? "✓" : "+"}</span>
											</button>
										);
									})}
							</div>
						</div>
					)}

					<div className="composer-meta-bar">
						<select
							className="select-pill"
							value={selectedWorkspaceId}
							disabled={isTurnRunning}
							title={isTurnRunning ? "当前回合正在执行，请先停止后再切换仓库" : undefined}
							onChange={(e) => onSelectWorkspace(e.target.value)}
						>
							<option value="">不绑定仓库</option>
							{workspaces.map((ws) => (
								<option key={ws.id} value={ws.id}>
									仓库：{ws.name}
								</option>
							))}
						</select>
						<select
							className="select-pill"
							value={selectedMemberId}
							disabled={isTurnRunning}
							title={isTurnRunning ? "当前回合正在执行，完成后可调整下一轮负责人" : undefined}
							onChange={(e) => onSelectMember(e.target.value)}
						>
							<option value="auto">
								{selectedMatterId
									? `继续由负责人跟进（${headerContact?.displayName ?? "自动"}）`
									: `按事找人（主联系：${headerContact?.displayName ?? "自动"}）`}
							</option>
							{members.map((m) => (
								<option key={m.id} value={m.id}>
									指定：{m.displayName}
								</option>
							))}
						</select>
						<button
							type="button"
							aria-expanded={observerMenuOpen}
							className={`select-pill action ${activeObserverIds.length > 0 ? "observer-active" : ""}`}
							onClick={() => {
								setStarterMenuOpen(false);
								setObserverMenuOpen((v) => !v);
							}}
						>
							{activeObserverIds.length > 0
								? `旁听：${activeObserverIds.map((id) => memberName(id)).join("、")}`
								: "旁听：仅主负责人"}
						</button>
						{selectedMatterId && (
							<button type="button" className="select-pill action" onClick={onNewMatter}>
								+ 切到新事项
							</button>
						)}
					</div>

					<div className="pill-composer">
						<button
							type="button"
							aria-expanded={starterMenuOpen}
							className="pill-plus-btn"
							aria-label="插入示范任务"
							onClick={() => {
								setObserverMenuOpen(false);
								setStarterMenuOpen((v) => !v);
							}}
						>
							+
						</button>
						<textarea
							ref={composerRef}
							rows={1}
							className="pill-textarea"
							value={composerText}
							onChange={(e) => onComposerTextChange(e.target.value)}
							onKeyDown={handleComposerKeyDown}
							placeholder={
								isTurnRunning
									? "当前回合仍在推进，完成后可继续（或点击 ■ 停止）..."
									: selectedMatterId
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
								onClick={() => onAbortMatter(selectedMatterId)}
							>
								■
							</button>
						)}
						<button
							type="button"
							className="pill-send-btn"
							aria-label="发送"
							disabled={submitting || isTurnRunning || !composerText.trim()}
							onClick={onSendPrompt}
						>
							{submitting ? "…" : "↑"}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}
