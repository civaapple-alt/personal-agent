import { type KeyboardEvent, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import {
	type DeliverableDto,
	type MatterDetailPayload,
	type MatterProgressDto,
	type PendingDialogDto,
	type RoleTemplateDto,
	respondToDialog,
	type TeamMemberDto,
	type WorkspaceDto,
} from "../api.ts";
import { MarkdownView } from "../MarkdownView.tsx";
import {
	type DelegationSummaryItem,
	formatClockTime,
	formatNoticeEventLine,
	mapDelegationsToMessages,
	mapDeliverablesToMessages,
	type StarterTask,
} from "../utils.ts";
import { BotFaceIcon } from "./BotFaceIcon.tsx";
import { ExploringStatus } from "./ExploringStatus.tsx";

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
	memberName: (id: string) => string;
	previewUrlFor: (deliverable: DeliverableDto | null) => string | null;
	onComposerTextChange: (value: string) => void;
	onSelectWorkspace: (workspaceId: string) => void;
	onSelectMember: (memberId: string) => void;
	onSendPrompt: () => void;
	onAbortMatter: (matterId: string) => void;
	onNewMatter: () => void;
	onOpenDeliverables: (deliverableId?: string) => void;
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
	memberName,
	previewUrlFor,
	onComposerTextChange,
	onSelectWorkspace,
	onSelectMember,
	onSendPrompt,
	onAbortMatter,
	onNewMatter,
	onOpenDeliverables,
	onDismissError,
	onDismissNotice,
}: ChatStageProps) {
	const [collabOpen, setCollabOpen] = useState(false);
	const [collabTab, setCollabTab] = useState<"delegations" | "events">("delegations");
	const [expandedDelegations, setExpandedDelegations] = useState<Record<string, boolean>>({});
	const [starterMenuOpen, setStarterMenuOpen] = useState(false);
	const [dialogInput, setDialogInput] = useState("");
	const messagesEndRef = useRef<HTMLDivElement | null>(null);

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

	const resolveDelegationTarget = (item: DelegationSummaryItem) =>
		item.targetLabel || (item.toMemberId ? memberName(item.toMemberId) : "团队成员");

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
						{items.map((item) => (
							<div key={item.id} className="delegation-detail-item">
								<div className="delegation-detail-head">
									<span>
										{memberName(item.fromMemberId)} → <strong>{resolveDelegationTarget(item)}</strong>
									</span>
									<span className={`delegation-status-tag ${item.status}`}>
										{item.status === "running" ? "协同中" : item.status === "completed" ? "已完成" : "未完成"}
									</span>
								</div>
								<div className="delegation-detail-question">{item.question}</div>
								{item.answer && <div className="delegation-detail-answer">{item.answer}</div>}
							</div>
						))}
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
						<button
							type="button"
							className={`btn-pill-outline btn-xs ${collabOpen ? "active" : ""}`}
							title="查看团队内部委托记录及底层工具调用事件"
							onClick={() => {
								setCollabOpen((open) => {
									const next = !open;
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
				<div className="collab-dock-panel">
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
							</div>
							<button type="button" className="btn-inline" onClick={() => setCollabOpen(false)}>
								收起
							</button>
						</div>
						<div className="collab-log">
							{collabTab === "delegations" ? (
								delegationsPlacement.all.length === 0 ? (
									<p className="muted-hint">当前事项暂无团队内部委托记录。</p>
								) : (
									<div className="collab-section">
										{delegationsPlacement.all.map((item) => (
											<div key={item.id} className="delegation-detail-item">
												<div className="delegation-detail-head">
													<span>
														{memberName(item.fromMemberId)} →{" "}
														<strong>{resolveDelegationTarget(item)}</strong> ·{" "}
														{formatClockTime(item.createdAt)}
													</span>
													<span className={`delegation-status-tag ${item.status}`}>
														{item.status === "running"
															? "协同中"
															: item.status === "completed"
																? "已完成"
																: "未完成"}
													</span>
												</div>
												<div className="delegation-detail-question">{item.question}</div>
												{item.answer && <div className="delegation-detail-answer">{item.answer}</div>}
											</div>
										))}
									</div>
								)
							) : matterDetail.noticeMessages.length === 0 ? (
								<p className="muted-hint">当前事项暂无底层工具或过程事件。</p>
							) : (
								<div className="collab-events-list">
									{matterDetail.noticeMessages.map((entry) => (
										<div key={entry.id}>
											<strong>{memberName(entry.senderId)}</strong> · {formatClockTime(entry.createdAt)}：
											{formatNoticeEventLine(entry.content)}
										</div>
									))}
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
								const attachedDeliverables = deliverablesPlacement.byMessageId.get(msg.id) ?? [];
								const attachedDelegations = delegationsPlacement.byMessageId.get(msg.id) ?? [];
								return (
									<div key={msg.id} className={`stream-msg ${isUser ? "from-user" : "from-member"}`}>
										{!isUser && (
											<div className="stream-sender">
												{isSystem ? "系统提示" : memberName(msg.senderId)} ·{" "}
												{formatClockTime(msg.createdAt)}
											</div>
										)}
										<div className={`stream-bubble ${isUser ? "user" : isSystem ? "system" : "member"}`}>
											{isUser ? msg.content : <MarkdownView content={msg.content} />}
										</div>
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
						{selectedMatterId && (
							<button type="button" className="select-pill action" onClick={onNewMatter}>
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
