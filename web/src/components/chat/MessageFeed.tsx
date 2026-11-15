import { type RefObject, type UIEvent, useState } from "react";
import {
	type DeliverableDto,
	type MatterDetailPayload,
	type MatterProgressDto,
	type OrganizationDto,
	type PendingDialogDto,
	type RoleTemplateDto,
	respondToDialog,
	type TeamMemberDto,
	type WorkspaceDto,
} from "../../api.ts";
import { MarkdownView } from "../../MarkdownView.tsx";
import {
	type DelegationSummaryItem,
	formatClockTime,
	getMemberThemeById,
	parseMessageImages,
	parseProgressSnapshot,
} from "../../utils.ts";
import { BotFaceIcon } from "../BotFaceIcon.tsx";
import { ExploringStatus, ProgressSnapshotCard } from "../ExploringStatus.tsx";
import { DelegationSummaryCard } from "./DelegationSummaryCard.tsx";

interface MessageFeedProps {
	chatScrollRef: RefObject<HTMLDivElement | null>;
	chatStreamInnerRef: RefObject<HTMLDivElement | null>;
	messagesEndRef: RefObject<HTMLDivElement | null>;
	onScroll: (e: UIEvent<HTMLDivElement>) => void;
	errorBanner: string | null;
	noticeBanner: string | null;
	onDismissError: () => void;
	onDismissNotice: () => void;
	selectedMatterId: string | null;
	selectedMemberId: string;
	headerContact: TeamMemberDto | null;
	headerTheme: { bg: string; tilt: string };
	selectedOrganization: OrganizationDto | null;
	selectedWorkspace: WorkspaceDto | null;
	templateByRoleId: Map<string, RoleTemplateDto>;
	matterDetail: MatterDetailPayload | null;
	activeMatterProgress: MatterProgressDto | null;
	activeDialogs: PendingDialogDto[];
	elapsedSeconds: number;
	streamingDelta: string;
	isOwner: boolean;
	isTurnRunning: boolean;
	members: TeamMemberDto[];
	memberName: (id: string) => string;
	previewUrlFor: (deliverable: DeliverableDto | null) => string | null;
	deliverablesPlacement: {
		byMessageId: Map<string, DeliverableDto[]>;
		unattached: DeliverableDto[];
	};
	delegationsPlacement: {
		byMessageId: Map<string, DelegationSummaryItem[]>;
		unattached: DelegationSummaryItem[];
	};
	onOpenLightbox: (img: { src: string; alt: string }) => void;
	onOpenDeliverables: (deliverableId?: string) => void;
	onApproveAiRequest?: (matterId: string, messageId: string) => void;
	onDismissAiRequest?: (matterId: string, messageId: string) => void;
	onAbortMatter: (matterId: string) => void;
}

/** Scrollable message feed covering the empty-state welcome hero, chat messages, inline approvals, and live run status. */
export function MessageFeed({
	chatScrollRef,
	chatStreamInnerRef,
	messagesEndRef,
	onScroll,
	errorBanner,
	noticeBanner,
	onDismissError,
	onDismissNotice,
	selectedMatterId,
	selectedMemberId,
	headerContact,
	headerTheme,
	selectedOrganization,
	selectedWorkspace,
	templateByRoleId,
	matterDetail,
	activeMatterProgress,
	activeDialogs,
	elapsedSeconds,
	streamingDelta,
	isOwner,
	isTurnRunning,
	members,
	memberName,
	previewUrlFor,
	deliverablesPlacement,
	delegationsPlacement,
	onOpenLightbox,
	onOpenDeliverables,
	onApproveAiRequest,
	onDismissAiRequest,
	onAbortMatter,
}: MessageFeedProps) {
	const [collapsedSnapshots, setCollapsedSnapshots] = useState<Record<string, boolean>>({});
	const [dialogInput, setDialogInput] = useState("");

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
		<div ref={chatScrollRef} className="chat-stream-scroll" onScroll={onScroll}>
			<div ref={chatStreamInnerRef} className="chat-stream-inner">
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
						<div className="hero-context-bar">
							{selectedOrganization && <span className="pill org-pill">组织：{selectedOrganization.name}</span>}
							<span className="pill">
								{selectedWorkspace ? `仓库：${selectedWorkspace.name}` : "通用工作区（不绑定仓库）"}
							</span>
							{selectedWorkspace?.repoGitUser && (
								<span
									className="pill"
									title="执行 Git 提交时以角色署名作 Author，同时保留此仓库真实 Git 用户作 Committer"
								>
									Git 真实提交者：{selectedWorkspace.repoGitUser.name}
								</span>
							)}
						</div>
					</div>
				) : (
					<>
						{matterDetail?.userMessages.map((msg) => {
							const isUser = msg.senderType === "user";
							const isSystem = msg.senderType === "system";
							const isObserverIntervention = msg.metadata?.observerIntervention === true;
							const msgMode = isUser && typeof msg.metadata?.mode === "string" ? msg.metadata.mode : "dispatch";
							const isDiscussion = isUser && msgMode === "discussion";
							const isAiRequest = isUser && msgMode === "ai_request";
							const authorName =
								isUser && typeof msg.metadata?.authorName === "string" ? msg.metadata.authorName : null;
							const authorRole =
								isUser && typeof msg.metadata?.authorRole === "string" ? msg.metadata.authorRole : null;
							const aiRequestStatus =
								isAiRequest && typeof msg.metadata?.aiRequestStatus === "string"
									? msg.metadata.aiRequestStatus
									: "pending";
							const approvedByName =
								isAiRequest && typeof msg.metadata?.approvedByName === "string"
									? msg.metadata.approvedByName
									: "所有者";
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
							const userImages = isUser ? parseMessageImages(msg.metadata) : [];
							const bubbleModeClass = isUser
								? isDiscussion
									? " discussion"
									: isAiRequest
										? " ai-request"
										: " dispatch"
								: "";

							return (
								<div key={msg.id} className={`stream-msg ${isUser ? "from-user" : "from-member"}`}>
									{isUser ? (
										<div className="stream-sender user-sender">
											<span
												className={`msg-mode-badge ${isDiscussion ? "discussion" : isAiRequest ? "ai-request" : "dispatch"}`}
											>
												{isDiscussion ? "团队讨论" : isAiRequest ? "提请 AI" : "AI 安排"}
											</span>
											<span>
												{authorName ?? (isDiscussion ? "成员" : "团队所有者")}
												{authorRole ? ` · ${authorRole}` : ""}
											</span>
											<span>· {formatClockTime(msg.createdAt)}</span>
											{isAiRequest && (
												<span className={`ai-request-status-badge status-${aiRequestStatus}`}>
													{aiRequestStatus === "approved"
														? `已由${approvedByName}确认派发`
														: aiRequestStatus === "dismissed"
															? "已忽略"
															: "待所有者确认"}
												</span>
											)}
										</div>
									) : (
										<div className="stream-sender">
											{!isSystem && (
												<BotFaceIcon bg={speakerTheme.bg} tilt={speakerTheme.tilt} size="xs" mood="idle" />
											)}
											<span>
												{isSystem ? "系统提示" : memberName(msg.senderId)} ·{" "}
												{formatClockTime(msg.createdAt)}
											</span>
											{isObserverIntervention && <span className="observer-badge">旁听补充</span>}
										</div>
									)}
									<div
										className={`stream-bubble ${isUser ? "user" : isSystem ? "system" : "member"}${bubbleModeClass}${isObserverIntervention ? " observer" : ""}`}
									>
										{isUser ? (
											<>
												{userImages.length > 0 && (
													<div className={`stream-msg-images${userImages.length === 1 ? " single" : ""}`}>
														{userImages.map((img, idx) =>
															img.url ? (
																<button
																	key={img.url}
																	type="button"
																	className="stream-msg-image-btn"
																	title={img.name ?? "点击查看大图"}
																	onClick={() =>
																		onOpenLightbox({
																			src: img.url!,
																			alt: img.name ?? `附件图片 ${idx + 1}`,
																		})
																	}
																>
																	<img
																		src={img.url}
																		alt={img.name ?? `附件图片 ${idx + 1}`}
																		loading="lazy"
																	/>
																</button>
															) : (
																<span
																	key={`${msg.id}-missing-${img.name ?? img.mimeType}`}
																	className="stream-msg-image-fallback"
																>
																	[图片：{img.name ?? `附件 ${idx + 1}`}]
																</span>
															),
														)}
													</div>
												)}
												{msg.content && <div className="stream-bubble-text">{msg.content}</div>}
												{isAiRequest && aiRequestStatus === "pending" && isOwner && matterDetail && (
													<div className="ai-request-actions">
														<button
															type="button"
															className="btn-pill-dark btn-xs"
															disabled={isTurnRunning}
															title={
																isTurnRunning
																	? "请等待当前 AI 回合完成后确认派发"
																	: "确认此提请并立即派发给 AI 执行"
															}
															onClick={() => onApproveAiRequest?.(matterDetail.matter.id, msg.id)}
														>
															确认并派发 AI
														</button>
														<button
															type="button"
															className="btn-pill-outline btn-xs"
															onClick={() => onDismissAiRequest?.(matterDetail.matter.id, msg.id)}
														>
															忽略提请
														</button>
													</div>
												)}
											</>
										) : (
											<MarkdownView content={msg.content} />
										)}
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
									<DelegationSummaryCard
										anchorKey={msg.id}
										items={attachedDelegations}
										memberName={memberName}
									/>
									{attachedDeliverables.map((deliv) => renderDeliverablePill(deliv))}
								</div>
							);
						})}

						{activeDialogs.map((dlg) => (
							<div key={dlg.id} className="inline-approval-card">
								<div className="approval-eyebrow">需要你确认 · 来自【{dlg.memberName}】</div>
								<h4>{dlg.request.title}</h4>
								{dlg.request.message && <p>{dlg.request.message}</p>}
								{!isOwner ? (
									<p className="muted-hint compact">
										当前处于协同成员受限模式，工具/操作确认弹窗仅可由团队所有者处理。
									</p>
								) : (
									<>
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
									</>
								)}
							</div>
						))}

						{deliverablesPlacement.unattached.map((deliv) => renderDeliverablePill(deliv))}
						<DelegationSummaryCard
							anchorKey="unattached"
							items={delegationsPlacement.unattached}
							memberName={memberName}
						/>

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
	);
}
