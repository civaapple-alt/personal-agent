import { isCurrentHumanDecision, listCompletedHumanDecisions, readHumanDecision } from "@pa/contracts/human-decision";
import { hasRoleProposalActions } from "@pa/contracts/role-proposal-state";
import { readSkillProposals } from "@pa/contracts/skill-proposal";
import { type RefObject, type UIEvent, useEffect, useMemo, useRef, useState } from "react";
import { createSpaceDocument, listSpaces, type SpaceDto } from "../../api/space.ts";
import {
	type AccountUserDto,
	type ApplyMatterRoleProposalsPayload,
	type CollaboratorDto,
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
import { writeTextToClipboard } from "../../clipboard.ts";
import { MarkdownView } from "../../MarkdownView.tsx";
import { BotFaceIcon } from "../../primitives/BotFaceIcon.tsx";
import type { MatterDelegations } from "../../utils/matterDelegations.ts";
import { collectTurnToolCalls } from "../../utils/matterStream.ts";
import {
	formatByteSize,
	formatClockTime,
	getMemberThemeById,
	parseMessageFiles,
	parseMessageImages,
	parseProgressSnapshot,
	stripMarkdownFormatting,
} from "../../utils.ts";
import { ExploringStatus, ProgressSnapshotCard } from "../ExploringStatus.tsx";
import type { PreviewableTextAttachment } from "./ComposerDock.tsx";
import { DecisionDemo } from "./DecisionDemo.tsx";
import { DelegationSummaryCard } from "./DelegationSummaryCard.tsx";
import { HumanDecisionCard } from "./HumanDecisionCard.tsx";
import type { DelegationScope, DelegationView } from "./MatterDelegationPanel.tsx";
import { RoleProposalCard } from "./RoleProposalCard.tsx";
import { SkillProposalCard } from "./SkillProposalCard.tsx";
import { type ChatSpaceDocumentItem, SpaceDocumentCard } from "./SpaceDocumentCard.tsx";

interface MessageFeedProps {
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
	floatingClarificationMessageId?: string | null;
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
	delegations: MatterDelegations;
	onOpenDelegations: (scope: DelegationScope, view?: DelegationView) => void;
	onOpenLightbox: (img: { src: string; alt: string }) => void;
	onPreviewFile: (file: PreviewableTextAttachment) => void;
	onOpenDeliverables: (deliverableId?: string) => void;
	onOpenSideDoc?: (docId: string, options?: { showDiff?: boolean }) => void;
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
	onLaunchWithNewRoles?: (memberIds: string[]) => void;
	onSkillProposalDone?: () => void;
	onOpenSkillTrust?: () => void;
	onNotice?: (message: string) => void;
	onAbortMatter: (matterId: string) => void;
}

/** Scrollable message feed covering the empty-state welcome hero, chat messages, inline approvals, and live run status. */
export function MessageFeed({
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
	floatingClarificationMessageId = null,
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
	delegations,
	onOpenDelegations,
	onOpenLightbox,
	onPreviewFile,
	onOpenDeliverables,
	onOpenSideDoc,
	onApproveAiRequest,
	onDismissAiRequest,
	onApplyRoleProposals,
	onDismissRoleProposals,
	onSendQuickPrompt,
	onFillComposer,
	onLaunchWithNewRoles,
	onSkillProposalDone,
	onOpenSkillTrust,
	onNotice,
	onAbortMatter,
}: MessageFeedProps) {
	const [collapsedSnapshots, setCollapsedSnapshots] = useState<Record<string, boolean>>({});
	const [dialogInput, setDialogInput] = useState("");
	const [spaceSaveError, setSpaceSaveError] = useState<{ id: string; message: string } | null>(null);
	const [savingSpaceMessage, setSavingSpaceMessage] = useState<string | null>(null);
	const [saveDraft, setSaveDraft] = useState<{ messageId: string; spaceId: string; title: string } | null>(null);
	const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
	const copyResetTimerRef = useRef<number | null>(null);

	useEffect(() => {
		return () => {
			if (copyResetTimerRef.current !== null) {
				window.clearTimeout(copyResetTimerRef.current);
			}
		};
	}, []);

	const handleCopyMessage = async (messageId: string, content: string) => {
		const ok = await writeTextToClipboard(content);
		if (!ok) return;
		setCopiedMessageId(messageId);
		if (copyResetTimerRef.current !== null) {
			window.clearTimeout(copyResetTimerRef.current);
		}
		copyResetTimerRef.current = window.setTimeout(() => {
			setCopiedMessageId((prev) => (prev === messageId ? null : prev));
			copyResetTimerRef.current = null;
		}, 1800);
	};
	const [writableSpaces, setWritableSpaces] = useState<SpaceDto[] | null>(null);
	const [savedDocsByMsg, setSavedDocsByMsg] = useState<Record<string, ChatSpaceDocumentItem>>({});

	const spaceKindLabel = (kind: SpaceDto["kind"]) => {
		if (kind === "user") return "个人";
		if (kind === "org") return "组织";
		if (kind === "workspace") return "仓库";
		if (kind === "member") return "角色";
		return "自定义";
	};

	function openSaveToSpaceDraft(messageId: string, content: string) {
		const rawLine = content.split("\n").find((line) => line.trim()) ?? "";
		const cleanedTitle =
			stripMarkdownFormatting(rawLine)
				.replace(/^#+\s*/, "")
				.trim()
				.slice(0, 60) || "对话记录";
		const defaultSpaceId = matterDetail?.defaultSpace?.id ?? writableSpaces?.[0]?.id ?? "";
		setSpaceSaveError(null);
		setSaveDraft({ messageId, spaceId: defaultSpaceId, title: cleanedTitle });
		if (writableSpaces === null) {
			void listSpaces()
				.then(({ spaces }) => {
					const editable = spaces.filter((space) => space.canWrite !== false);
					setWritableSpaces(editable);
					setSaveDraft((prev) => {
						if (!prev || prev.messageId !== messageId) return prev;
						if (prev.spaceId && editable.some((space) => space.id === prev.spaceId)) return prev;
						return { ...prev, spaceId: editable[0]?.id ?? prev.spaceId };
					});
				})
				.catch(() => {
					setWritableSpaces([]);
				});
		}
	}

	async function confirmSaveMessageToSpace(matterId: string, id: string, content: string) {
		if (!saveDraft || saveDraft.messageId !== id) return;
		const targetSpaceId = saveDraft.spaceId || matterDetail?.defaultSpace?.id;
		if (!targetSpaceId) {
			setSpaceSaveError({ id, message: "未找到可写入的目标资料空间" });
			return;
		}
		setSavingSpaceMessage(id);
		setSpaceSaveError(null);
		try {
			const title = saveDraft.title.trim().slice(0, 120) || "对话记录";
			const result = await createSpaceDocument(targetSpaceId, {
				matterId,
				sourceMessageId: id,
				title,
				content,
			});
			const matchedSpace =
				writableSpaces?.find((space) => space.id === targetSpaceId) ??
				(matterDetail?.defaultSpace?.id === targetSpaceId ? matterDetail.defaultSpace : undefined);
			setSavedDocsByMsg((prev) => ({
				...prev,
				[id]: {
					id: result.document.id,
					spaceId: result.document.spaceId,
					spaceName: matchedSpace?.name,
					title: result.document.title,
					docType: result.document.docType,
					revision: result.document.revision,
					headCommit: result.document.headCommit,
				},
			}));
			setSaveDraft(null);
			onNotice?.(`已保存到「${matchedSpace?.name ?? "资料空间"}」`);
		} catch (error) {
			setSpaceSaveError({ id, message: error instanceof Error ? error.message : String(error) });
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
	const noticesByTurn = useMemo(() => {
		const grouped = new Map<string, NonNullable<typeof matterDetail>["noticeMessages"]>();
		for (const notice of matterDetail?.noticeMessages ?? []) {
			const id = notice.metadata?.sourceUserMessageId;
			if (typeof id !== "string") continue;
			const entries = grouped.get(id) ?? [];
			entries.push(notice);
			grouped.set(id, entries);
		}
		return grouped;
	}, [matterDetail?.noticeMessages]);

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
						)}
					</div>
				) : (
					<>
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
								!isUser && !isSystem && !isObserverIntervention && msg.metadata?.discussionTurn === true;
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
									{isUser && msg.content.trim().length > 0 && (
										<div className="stream-msg-actions">
											<button
												type="button"
												className={`stream-msg-copy-btn${copiedMessageId === msg.id ? " is-copied" : ""}`}
												title="复制消息内容"
												aria-label="复制消息内容"
												onClick={() => void handleCopyMessage(msg.id, msg.content)}
											>
												{copiedMessageId === msg.id ? "✓ 已复制" : "复制"}
											</button>
										</div>
									)}
									{!isUser && !isSystem && !hidePlaceholderDecisionBubble && msg.content.trim().length > 0 && (
										<div className="stream-msg-actions">
											<button
												type="button"
												className={`stream-msg-copy-btn${copiedMessageId === msg.id ? " is-copied" : ""}`}
												title="复制原始 Markdown 内容"
												aria-label="复制原始 Markdown 内容"
												onClick={() => void handleCopyMessage(msg.id, msg.content)}
											>
												{copiedMessageId === msg.id ? "✓ 已复制 Markdown" : "复制 Markdown"}
											</button>
											{canSaveSpace &&
												!decision &&
												msg.content.trim().length >= 80 &&
												!(
													(Array.isArray(msg.metadata?.spaceDocuments) &&
														msg.metadata.spaceDocuments.length > 0) ||
													Boolean(savedDocsByMsg[msg.id])
												) &&
												saveDraft?.messageId !== msg.id && (
													<button
														type="button"
														className="btn-inline"
														disabled={savingSpaceMessage !== null}
														onClick={() => openSaveToSpaceDraft(msg.id, msg.content)}
													>
														保存文字到资料空间
													</button>
												)}
										</div>
									)}
									{canSaveSpace &&
										!isSystem &&
										!isUser &&
										!decision &&
										msg.content.trim().length >= 80 &&
										!(
											(Array.isArray(msg.metadata?.spaceDocuments) &&
												msg.metadata.spaceDocuments.length > 0) ||
											Boolean(savedDocsByMsg[msg.id])
										) &&
										(saveDraft?.messageId === msg.id || spaceSaveError?.id === msg.id) && (
											<div className="space-message-action">
												{saveDraft?.messageId === msg.id && (
													<form
														className="space-message-save-form"
														onSubmit={(event) => {
															event.preventDefault();
															void confirmSaveMessageToSpace(
																matterDetail.matter.id,
																msg.id,
																msg.content,
															);
														}}
													>
														<select
															className="input-field"
															aria-label="选择目标资料空间"
															value={saveDraft.spaceId}
															disabled={savingSpaceMessage === msg.id}
															onChange={(event) =>
																setSaveDraft((prev) =>
																	prev ? { ...prev, spaceId: event.target.value } : prev,
																)
															}
														>
															{(writableSpaces && writableSpaces.length > 0
																? writableSpaces
																: matterDetail.defaultSpace
																	? [matterDetail.defaultSpace]
																	: []
															).map((space) => (
																<option key={space.id} value={space.id}>
																	[{spaceKindLabel(space.kind)}] {space.name}
																</option>
															))}
														</select>
														<input
															type="text"
															className="input-field"
															aria-label="资料标题"
															placeholder="资料标题"
															value={saveDraft.title}
															disabled={savingSpaceMessage === msg.id}
															onChange={(event) =>
																setSaveDraft((prev) =>
																	prev ? { ...prev, title: event.target.value } : prev,
																)
															}
														/>
														<button
															type="submit"
															className="btn-pill-dark btn-xs"
															disabled={savingSpaceMessage !== null || !saveDraft.spaceId}
														>
															{savingSpaceMessage === msg.id ? "正在保存…" : "确认保存"}
														</button>
														<button
															type="button"
															className="btn-inline btn-xs"
															disabled={savingSpaceMessage === msg.id}
															onClick={() => {
																setSaveDraft(null);
																setSpaceSaveError(null);
															}}
														>
															取消
														</button>
													</form>
												)}
												{spaceSaveError?.id === msg.id && <output>{spaceSaveError.message}</output>}
											</div>
										)}
									{(msg.metadata?.workbenchHelpTopic === "decisions" ||
										(isWorkbenchHelp && msg.metadata?.humanDecisionHelp === true)) && <DecisionDemo />}
									{progressSnapshot && (
										<ProgressSnapshotCard
											snapshot={progressSnapshot}
											toolCalls={collectTurnToolCalls(
												noticesByTurn.get(String(msg.metadata?.sourceUserMessageId ?? "")) ?? [],
												msg,
												progressSnapshot,
											)}
											expanded={
												collapsedSnapshots[msg.id] !== undefined
													? !collapsedSnapshots[msg.id]
													: progressSnapshot.outcome !== "completed"
											}
											members={members}
											fallbackLeadName={leadFallback}
											onToggle={() =>
												setCollapsedSnapshots((prev) => {
													const currentlyExpanded =
														prev[msg.id] !== undefined
															? !prev[msg.id]
															: progressSnapshot.outcome !== "completed";
													return {
														...prev,
														[msg.id]: currentlyExpanded,
													};
												})
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
											handledInFloatingDock={floatingClarificationMessageId === msg.id}
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
									{matterDetail && readSkillProposals(msg.metadata).length > 0 && (
										<SkillProposalCard
											matterId={matterDetail.matter.id}
											messageId={msg.id}
											proposals={readSkillProposals(msg.metadata)}
											hasWorkspace={Boolean(matterDetail.matter.workspaceId)}
											onDone={onSkillProposalDone}
											onOpenSkillTrust={onOpenSkillTrust}
											onNotice={onNotice}
										/>
									)}
									{(() => {
										const persistedDocs = Array.isArray(msg.metadata?.spaceDocuments)
											? (msg.metadata.spaceDocuments as ChatSpaceDocumentItem[])
											: [];
										const localDoc = savedDocsByMsg[msg.id];
										const docs =
											localDoc && !persistedDocs.some((doc) => doc.id === localDoc.id)
												? [...persistedDocs, localDoc]
												: persistedDocs;
										return docs.map((doc) => {
											const isLatestMessage =
												Boolean(matterDetail) && messageIndex === matterDetail!.userMessages.length - 1;
											const canProceed =
												isLatestMessage && !isTurnRunning && isOwner && Boolean(onSendQuickPrompt);
											return (
												<SpaceDocumentCard
													key={doc.id}
													doc={doc}
													canProceed={canProceed}
													onOpen={(showDiff) =>
														onOpenSideDoc
															? onOpenSideDoc(doc.id, { showDiff })
															: onOpenDeliverables(doc.id)
													}
													onProceed={() =>
														void onSendQuickPrompt?.(
															`确认方案「${doc.title}」(rev ${doc.revision})，请按此方案继续推进。`,
														)
													}
												/>
											);
										});
									})()}
								</div>
							);
						})}

						{activeDialogs.map((dlg) => {
							const titleLines = dlg.request.title.split("\n").filter((line) => line.trim().length > 0);
							const heading = titleLines[0] ?? dlg.request.title;
							const commandLine = titleLines.find((line) => line.startsWith("命令："));
							const commandText = commandLine ? commandLine.slice("命令：".length).trim() : null;
							const extraLines = titleLines.slice(1).filter((line) => line !== commandLine);
							return (
								<div key={dlg.id} className="inline-approval-card">
									<div className="approval-eyebrow">需要你确认 · 来自【{dlg.memberName}】</div>
									<h3>{heading}</h3>
									{commandText && (
										<pre className="pa-viz-code" style={{ margin: "6px 0 10px" }}>
											<code>{commandText}</code>
										</pre>
									)}
									{extraLines.map((line) => (
										<p key={line}>{line}</p>
									))}
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
													{dlg.request.options.map((opt) => {
														const isPrimary = opt.includes("信任") || opt.includes("自主执行");
														const isDeny = opt.includes("拒绝") || opt.includes("取消");
														const btnClass = isPrimary
															? "btn-pill-dark"
															: isDeny
																? "btn-pill-ghost"
																: "btn-pill-outline";
														return (
															<button
																key={opt}
																type="button"
																className={btnClass}
																style={isDeny ? { color: "var(--danger, #b91c1c)" } : undefined}
																onClick={() => void respondToDialog(dlg.id, { value: opt })}
															>
																{opt}
															</button>
														);
													})}
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
							);
						})}

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
