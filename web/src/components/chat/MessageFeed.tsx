import { type RefObject, type UIEvent, useState } from "react";
import {
	isCurrentHumanDecision,
	listCompletedHumanDecisions,
	readHumanDecision,
} from "../../../../src/orchestrator/human-decision.ts";
import { hasRoleProposalActions } from "../../../../src/roles/role-proposal-state.ts";
import { createSpaceDocument } from "../../api/space.ts";
import {
	type AccountUserDto,
	type ApplyMatterRoleProposalsPayload,
	type CollaboratorDto,
	type DeliverableDto,
	type InnerMatterStep,
	type MatterDetailPayload,
	type MatterProgressDto,
	type OrganizationDto,
	type OrganizationMemberDto,
	type PendingDialogDto,
	type RoleTemplateDto,
	respondToDialog,
	type TeamMemberDto,
	type WorkspaceDto,
} from "../../api.ts";
import { isArchitectMemberId, parseRoleProposalsFromMetadata, ROLE_ARCHITECT_MEMBER_ID } from "../../architectApi.ts";
import { MarkdownView } from "../../MarkdownView.tsx";
import type { MatterDelegations } from "../../utils/matterDelegations.ts";
import {
	formatByteSize,
	formatClockTime,
	getMemberThemeById,
	parseMessageFiles,
	parseMessageImages,
	parseProgressSnapshot,
	stripMarkdownFormatting,
} from "../../utils.ts";
import { BotFaceIcon } from "../BotFaceIcon.tsx";
import { ExploringStatus, ProgressSnapshotCard } from "../ExploringStatus.tsx";
import type { PreviewableTextAttachment } from "./ComposerDock.tsx";
import { DecisionDemo } from "./DecisionDemo.tsx";
import { DelegationSummaryCard } from "./DelegationSummaryCard.tsx";
import { HumanDecisionCard } from "./HumanDecisionCard.tsx";
import { InnerDemoGuide } from "./InnerDemoGuide.tsx";
import type { DelegationScope, DelegationView } from "./MatterDelegationPanel.tsx";
import { RoleProposalCard } from "./RoleProposalCard.tsx";

interface MessageFeedProps {
	onOpenDemo?: () => void;
	demoOpening?: boolean;
	onDemoStep?: (step: InnerMatterStep) => void;
	demoStepBusy?: boolean;
	chatScrollRef: RefObject<HTMLDivElement | null>;
	chatStreamInnerRef: RefObject<HTMLDivElement | null>;
	messagesEndRef: RefObject<HTMLDivElement | null>;
	onScroll: (e: UIEvent<HTMLDivElement>) => void;
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
	progressStartedAt: number | null;
	streamingDelta: string;
	isOwner: boolean;
	canManageMatter: boolean;
	decisionAssignees: OrganizationMemberDto[];
	isSuperAdmin?: boolean;
	accountUser?: AccountUserDto | null;
	currentUser?: CollaboratorDto | null;
	organizations?: OrganizationDto[];
	isTurnRunning: boolean;
	members: TeamMemberDto[];
	memberName: (id: string) => string;
	previewUrlFor: (deliverable: DeliverableDto | null) => string | null;
	deliverablesPlacement: {
		byMessageId: Map<string, DeliverableDto[]>;
		unattached: DeliverableDto[];
	};
	delegations: MatterDelegations;
	onOpenDelegations: (scope: DelegationScope, view?: DelegationView) => void;
	onOpenLightbox: (img: { src: string; alt: string }) => void;
	onPreviewFile: (file: PreviewableTextAttachment) => void;
	onOpenDeliverables: (deliverableId?: string) => void;
	onApproveAiRequest?: (matterId: string, messageId: string) => void;
	onDismissAiRequest?: (matterId: string, messageId: string) => void;
	onApplyRoleProposals?: (
		matterId: string,
		messageId: string,
		payload: ApplyMatterRoleProposalsPayload,
	) => Promise<void>;
	onDismissRoleProposals?: (matterId: string, messageId: string) => Promise<void>;
	onSendQuickPrompt?: (prompt: string, options?: { preferredMemberId?: string }) => Promise<boolean>;
	onFillComposer?: (text: string) => void;
	onOpenQuickCreator?: () => void;
	onLaunchWithNewRoles?: (memberIds: string[]) => void;
	onAbortMatter: (matterId: string) => void;
}

/** Scrollable message feed covering the empty-state welcome hero, chat messages, inline approvals, and live run status. */
export function MessageFeed({
	onOpenDemo,
	demoOpening,
	onDemoStep,
	demoStepBusy,
	chatScrollRef,
	chatStreamInnerRef,
	messagesEndRef,
	onScroll,
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
	progressStartedAt,
	streamingDelta,
	isOwner,
	canManageMatter,
	decisionAssignees,
	isSuperAdmin = false,
	accountUser = null,
	currentUser = null,
	organizations = [],
	isTurnRunning,
	members,
	memberName,
	previewUrlFor,
	deliverablesPlacement,
	delegations,
	onOpenDelegations,
	onOpenLightbox,
	onPreviewFile,
	onOpenDeliverables,
	onApproveAiRequest,
	onDismissAiRequest,
	onApplyRoleProposals,
	onDismissRoleProposals,
	onSendQuickPrompt,
	onFillComposer,
	onOpenQuickCreator,
	onLaunchWithNewRoles,
	onAbortMatter,
}: MessageFeedProps) {
	const [collapsedSnapshots, setCollapsedSnapshots] = useState<Record<string, boolean>>({});
	const [dialogInput, setDialogInput] = useState("");
	const [spaceSave, setSpaceSave] = useState<{ id: string; message: string; pageId?: string } | null>(null);
	const [savingSpaceMessage, setSavingSpaceMessage] = useState<string | null>(null);

	async function saveMessageToSpace(matterId: string, id: string, content: string) {
		const targetSpaceId = matterDetail?.defaultSpace?.id;
		if (!targetSpaceId) {
			setSpaceSave({ id, message: "未找到当前事项的默认资料空间" });
			return;
		}
		setSavingSpaceMessage(id);
		setSpaceSave(null);
		try {
			const title =
				content
					.split("\n")
					.find((line) => line.trim())
					?.replace(/^#+\s*/, "")
					.trim()
					.slice(0, 60) || "对话记录";
			const result = await createSpaceDocument(targetSpaceId, { matterId, title, content });
			setSpaceSave({ id, message: "已保存到资料空间", pageId: result.document.id });
		} catch (error) {
			setSpaceSave({ id, message: error instanceof Error ? error.message : String(error) });
		} finally {
			setSavingSpaceMessage(null);
		}
	}
	const selectedIsArchitect = isArchitectMemberId(selectedMemberId, members, templateByRoleId);
	const isArchitectMatter = Boolean(
		matterDetail && isArchitectMemberId(matterDetail.matter.leadMemberId, members, templateByRoleId),
	);
	const latestRolePlanIndices = new Map<string, number>();
	matterDetail?.userMessages.forEach((message, index) => {
		if (
			message.senderType === "member" &&
			(hasRoleProposalActions(message.metadata?.roleProposals) ||
				readHumanDecision(message.metadata)?.kind === "role_clarification")
		) {
			latestRolePlanIndices.set(message.senderId, index);
		}
	});
	const completedDecisions = listCompletedHumanDecisions(matterDetail?.userMessages ?? []);
	const matterOrgRole = organizations?.find(({ id }) => id === matterDetail?.matter.orgId)?.orgRole;
	const canSaveSpace =
		!accountUser || isSuperAdmin || (accountUser.status === "active" && matterOrgRole !== "org_viewer");
	const canParticipateInDecisions = isSuperAdmin || matterOrgRole !== "org_viewer";
	const canOperateRoleProposals = accountUser ? accountUser.status === "active" && canParticipateInDecisions : isOwner;
	const activeSpeakerId =
		activeMatterProgress?.speakerMemberId ?? matterDetail?.matter.leadMemberId ?? headerContact?.id;
	const activeTurnId = activeMatterProgress?.sourceUserMessageId;

	const renderDeliverablePill = (deliv: DeliverableDto) => {
		const url = previewUrlFor(deliv);
		return (
			<div key={deliv.id} className="deliverable-inline-pill">
				<span className="deliverable-pill-info">
					<span className="deliverable-pill-check">✓</span>
					<span>
						已记录至资料空间 · <strong>V{deliv.version}</strong>
					</span>
				</span>
				<span className="deliverable-pill-actions">
					{url && (
						<a className="btn-inline" href={url} target="_blank" rel="noreferrer">
							打开预览 →
						</a>
					)}
					<button type="button" className="btn-inline" onClick={() => onOpenDeliverables(deliv.id)}>
						在资料空间查看
					</button>
				</span>
			</div>
		);
	};

	return (
		<div ref={chatScrollRef} className="chat-stream-scroll" onScroll={onScroll}>
			<div ref={chatStreamInnerRef} className="chat-stream-inner">
				{!selectedMatterId || (!matterDetail && !activeMatterProgress) ? (
					<div className="welcome-hero">
						<BotFaceIcon bg={headerTheme.bg} size={!selectedMatterId && !selectedIsArchitect ? "md" : "lg"} />
						<h1>{selectedMemberId === "auto" ? "今天要推进什么事？" : memberName(selectedMemberId)}</h1>
						<p>
							{selectedMemberId === "auto"
								? "描述目标和希望得到的结果，参与方式可以按需调整。"
								: selectedIsArchitect
									? "描述你们的真实工作流或协作卡点，我来帮你拆解出职责单一、边界清晰的 AI 角色与人机配合方式"
									: stripMarkdownFormatting(
											templateByRoleId
												.get(headerContact?.templateId ?? "")
												?.responsibilities.split("\n")[0] ?? "直接输入任务开始协作",
										)}
						</p>
						{!selectedIsArchitect && selectedMatterId && (
							<div className="hero-context-bar">
								{selectedOrganization && (
									<span className="pill org-pill">组织：{selectedOrganization.name}</span>
								)}
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
						)}
						{isOwner && selectedIsArchitect && (
							<>
								<div className="architect-workflow-chips">
									{[
										"我们做新产品验证，想拆 1 个只梳理用户反馈痛点、1 个上线前只读挑漏洞且平时静默的角色",
										"平时开发经常到验收才发现遗漏，帮我按现有成员配一套前置把关角色和参与边界",
									].map((sample) => (
										<button
											key={sample}
											type="button"
											className="choice-chip"
											onClick={() => onFillComposer?.(sample)}
										>
											{sample}
										</button>
									))}
								</div>
								{onOpenQuickCreator && (
									<div className="architect-quick-alt">
										<span>只需新增 1 个明确分工的小角色？</span>
										<button type="button" className="btn-inline" onClick={onOpenQuickCreator}>
											打开快速创建卡片 →
										</button>
									</div>
								)}
							</>
						)}
						{isOwner && !selectedIsArchitect && onOpenDemo && (
							<div className="inner-demo-entry">
								<button type="button" className="btn-inline" disabled={demoOpening} onClick={onOpenDemo}>
									{demoOpening ? "正在准备演示…" : "体验内置演示"}
								</button>
							</div>
						)}
					</div>
				) : (
					<>
						{matterDetail?.demoGuide && (
							<InnerDemoGuide
								detail={matterDetail}
								disabled={isTurnRunning || Boolean(demoStepBusy)}
								onChooseStep={isOwner ? onDemoStep : undefined}
							/>
						)}
						{matterDetail?.userMessages.map((msg, messageIndex) => {
							const decision = readHumanDecision(msg.metadata);
							const isUser = msg.senderType === "user";
							const isSystem = msg.senderType === "system";
							const isRosterSnapshot = isSystem && msg.metadata?.matterRosterSnapshot === true;
							const isWorkbenchHelp =
								isSystem &&
								(typeof msg.metadata?.workbenchHelpTopic === "string" ||
									msg.metadata?.humanDecisionHelp === true);
							const isObserverIntervention = msg.metadata?.observerIntervention === true;
							const isLeadReply = msg.senderType === "member" && msg.metadata?.matterLeadReply === true;
							const isDiscussionReply =
								!isUser &&
								!isSystem &&
								!isObserverIntervention &&
								msg.metadata?.discussionTurn === true &&
								decision?.kind !== "execution_confirmation";
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
							const attachedDelegations = delegations.byTurn.get(msg.id)?.assignments;
							const progressSnapshot = parseProgressSnapshot(msg.metadata);
							const roleProposals = !isUser && !isSystem ? parseRoleProposalsFromMetadata(msg.metadata) : null;
							const leadFallback =
								!isSystem && msg.senderId
									? memberName(msg.senderId)
									: matterDetail?.matter.leadMemberId
										? memberName(matterDetail.matter.leadMemberId)
										: undefined;
							const userImages = isUser ? parseMessageImages(msg.metadata) : [];
							const userFiles = isUser ? parseMessageFiles(msg.metadata) : [];
							const isConversationMessage =
								msg.metadata?.mode === "conversation" || msg.metadata?.conversationRouted === true;
							const hidePlaceholderDecisionBubble =
								!isUser && !isSystem && Boolean(decision) && msg.content.trim() === "等待你在卡片里提交决定。";
							const bubbleModeClass =
								isUser && !isConversationMessage
									? isDiscussion
										? " discussion"
										: isAiRequest
											? " ai-request"
											: " dispatch"
									: "";

							return (
								<div
									key={msg.id}
									id={`matter-message-${msg.id}`}
									tabIndex={isUser || decision || roleProposals ? -1 : undefined}
									className={`stream-msg ${isUser ? "from-user" : "from-member"}`}
								>
									{isUser ? (
										<div className="stream-sender user-sender">
											{!isConversationMessage && (
												<span
													className={`msg-mode-badge ${isDiscussion ? "discussion" : isAiRequest ? "ai-request" : "dispatch"}`}
												>
													{isDiscussion
														? "团队讨论"
														: isAiRequest
															? "提请 AI"
															: msg.metadata?.humanDecisionSourceId
																? "人类答复"
																: "AI 安排"}
												</span>
											)}
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
												{isRosterSnapshot
													? "事项名册"
													: isWorkbenchHelp
														? "功能说明"
														: isSystem
															? "系统提示"
															: memberName(msg.senderId)}{" "}
												· {formatClockTime(msg.createdAt)}
											</span>
											{isLeadReply && <span className="discussion-ai-badge">主责</span>}
											{!isLeadReply && isDiscussionReply && (
												<span className="discussion-ai-badge">讨论参与</span>
											)}
											{isObserverIntervention && <span className="observer-badge">旁听补充</span>}
										</div>
									)}
									{!hidePlaceholderDecisionBubble && (
										<div
											className={`stream-bubble ${isUser ? "user" : isSystem && !isRosterSnapshot && !isWorkbenchHelp ? "system" : "member"}${bubbleModeClass}${isObserverIntervention ? " observer" : ""}`}
										>
											{isUser ? (
												<>
													{userImages.length > 0 && (
														<div
															className={`stream-msg-images${userImages.length === 1 ? " single" : ""}`}
														>
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
																			width={112}
																			height={112}
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
													{userFiles.length > 0 && (
														<div className="stream-msg-files">
															{userFiles.map((file, idx) => {
																const isPasted = file.kind === "pasted_text";
																return (
																	<button
																		key={`${msg.id}-file-${file.url ?? file.name}-${idx}`}
																		type="button"
																		className={`stream-msg-file-chip${isPasted ? " is-pasted" : ""}`}
																		title="点击查看附件内容"
																		onClick={() =>
																			onPreviewFile({
																				kind: isPasted ? "pasted_text" : "file",
																				name: file.name,
																				url: file.url,
																				content: file.url ? undefined : file.previewText,
																				lineCount: file.lineCount,
																				charCount: file.charCount,
																				sizeBytes: file.sizeBytes,
																			})
																		}
																	>
																		<span aria-hidden="true">{isPasted ? "¶" : "📄"}</span>
																		<span className="stream-msg-file-meta">
																			<strong>
																				{isPasted
																					? `粘贴文本${file.lineCount ? ` · ${file.lineCount} 行` : ""}`
																					: file.name}
																			</strong>
																			<small>
																				{file.sizeBytes !== undefined
																					? formatByteSize(file.sizeBytes)
																					: ""}
																				{file.charCount !== undefined
																					? `${file.sizeBytes !== undefined ? " · " : ""}${file.charCount} 字`
																					: ""}
																				{file.previewText ? ` · ${file.previewText}` : ""}
																			</small>
																		</span>
																	</button>
																);
															})}
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
									)}
									{canSaveSpace &&
										!isSystem &&
										!isUser &&
										!decision &&
										msg.content.trim().length >= 80 &&
										!(
											Array.isArray(msg.metadata?.spaceDocuments) && msg.metadata.spaceDocuments.length > 0
										) && (
											<div className="space-message-action">
												<button
													type="button"
													className="btn-inline"
													disabled={savingSpaceMessage !== null}
													onClick={() =>
														void saveMessageToSpace(matterDetail.matter.id, msg.id, msg.content)
													}
												>
													{savingSpaceMessage === msg.id ? "正在保存…" : "保存文字到资料空间"}
												</button>
												{spaceSave?.id === msg.id && <output>{spaceSave.message}</output>}
												{spaceSave?.id === msg.id && spaceSave.pageId && (
													<button
														type="button"
														className="btn-inline"
														onClick={() => onOpenDeliverables(spaceSave.pageId)}
													>
														查看资料
													</button>
												)}
											</div>
										)}
									{(msg.metadata?.workbenchHelpTopic === "decisions" ||
										(isWorkbenchHelp && msg.metadata?.humanDecisionHelp === true)) && <DecisionDemo />}
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
									{attachedDelegations && (
										<DelegationSummaryCard
											items={attachedDelegations}
											onOpen={() => onOpenDelegations(`turn:${msg.id}`)}
										/>
									)}
									{decision && (
										<HumanDecisionCard
											matter={matterDetail.matter}
											messageId={msg.id}
											decision={decision}
											current={isCurrentHumanDecision(
												msg,
												decision,
												matterDetail.matter,
												matterDetail.userMessages.slice(messageIndex + 1),
											)}
											completed={completedDecisions.has(msg.id)}
											isRunning={isTurnRunning}
											canDispatch={isOwner}
											canManage={canManageMatter}
											canParticipate={canParticipateInDecisions}
											accountUser={accountUser}
											currentUser={currentUser}
											candidates={decisionAssignees}
											requestedBy={memberName(msg.senderId)}
											sourceName={
												decision.source
													? `${memberName(decision.source.memberId)}（委托 #${decision.source.assignmentNumber}）`
													: undefined
											}
										/>
									)}
									{roleProposals && matterDetail && onApplyRoleProposals && onDismissRoleProposals && (
										<RoleProposalCard
											matterId={matterDetail.matter.id}
											messageId={msg.id}
											proposals={roleProposals}
											structuredClarification={decision?.kind === "role_clarification"}
											current={messageIndex >= (latestRolePlanIndices.get(msg.senderId) ?? -1)}
											isArchitectMatter={isArchitectMatter}
											isOwner={canOperateRoleProposals}
											isSuperAdmin={isSuperAdmin}
											accountUser={accountUser}
											currentUser={currentUser}
											organizations={organizations}
											matterOrgId={matterDetail.matter.orgId ?? null}
											isTurnRunning={isTurnRunning}
											members={members}
											memberName={memberName}
											onApply={onApplyRoleProposals}
											onDismiss={onDismissRoleProposals}
											onQuickReply={
												onSendQuickPrompt
													? (text) =>
															onSendQuickPrompt(text, { preferredMemberId: ROLE_ARCHITECT_MEMBER_ID })
													: undefined
											}
											onLaunchWithNewRoles={onLaunchWithNewRoles}
										/>
									)}
									{Array.isArray(msg.metadata?.spaceDocuments) &&
										(
											msg.metadata.spaceDocuments as Array<{
												id: string;
												spaceId: string;
												title: string;
												revision: number;
												headCommit?: string;
											}>
										).map((doc) => (
											<div key={doc.id} className="deliverable-inline-pill">
												<span className="deliverable-pill-info">
													<span className="deliverable-pill-check">✓</span>
													<span>
														已提交至资料空间 · <strong>{doc.title}</strong> (rev {doc.revision})
													</span>
												</span>
												<span className="deliverable-pill-actions">
													<button
														type="button"
														className="btn-inline"
														onClick={() => onOpenDeliverables(doc.id)}
													>
														在资料空间查看
													</button>
												</span>
											</div>
										))}
									{attachedDeliverables.map((deliv) => renderDeliverablePill(deliv))}
								</div>
							);
						})}

						{activeDialogs.map((dlg) => (
							<div key={dlg.id} className="inline-approval-card">
								<div className="approval-eyebrow">需要你确认 · 来自【{dlg.memberName}】</div>
								<h3>{dlg.request.title}</h3>
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
													placeholder={dlg.request.placeholder ?? "输入答复…"}
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
							items={delegations.history.assignments}
							history
							onOpen={() => onOpenDelegations("history")}
						/>

						{streamingDelta && (
							<div className="stream-msg from-member">
								<div className="stream-sender">正在整理回复…</div>
								<div className="stream-bubble member">
									<MarkdownView content={streamingDelta} />
								</div>
							</div>
						)}

						{activeMatterProgress && selectedMatterId && (
							<ExploringStatus
								progress={activeMatterProgress}
								startedAt={progressStartedAt}
								members={members}
								leadMemberId={activeSpeakerId}
								leadDisplayName={activeSpeakerId ? memberName(activeSpeakerId) : undefined}
								onOpenDelegations={
									activeTurnId ? () => onOpenDelegations(`turn:${activeTurnId}`, "graph") : undefined
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
