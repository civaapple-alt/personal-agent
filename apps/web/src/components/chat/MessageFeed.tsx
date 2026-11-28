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
import { Badge, BotFaceIcon, Button, Card, Input, Select } from "../../primitives/index.ts";
import { cn } from "../../utils/cn.ts";
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

const USER_BUBBLE_BASE_CLASSES =
	"px-4 py-2.5 text-sm leading-relaxed break-words min-w-0 rounded-[18px] rounded-br-sm max-w-[78%] sm:max-w-[72%] whitespace-pre-wrap flex flex-col gap-2";
const MEMBER_BUBBLE_BASE_CLASSES =
	"px-4 py-2.5 text-sm leading-relaxed break-words min-w-0 rounded-[18px] rounded-bl-sm max-w-[92%] sm:max-w-[760px] overflow-x-hidden";
const FILE_CHIP_BASE_CLASSES =
	"inline-flex items-center gap-2 max-w-[min(320px,100%)] px-2.5 py-1.5 rounded-md border bg-stage text-ink text-xs text-left cursor-pointer transition-colors hover:bg-hover min-w-0";
const ARCHITECT_SAMPLES = [
	"我们做新产品验证，想拆 1 个只梳理用户反馈痛点、1 个上线前只读挑漏洞且平时静默的角色",
	"平时开发经常到验收才发现遗漏，帮我按现有成员配一套前置把关角色和参与边界",
];

const SPACE_KIND_LABELS: Record<string, string> = { user: "个人", org: "组织", workspace: "仓库", member: "角色" };

function SaveToSpaceForm(p: {
	draft: { messageId: string; spaceId: string; title: string };
	spaces: SpaceDto[];
	saving: boolean;
	saveBlocked: boolean;
	onChange: (next: { spaceId?: string; title?: string }) => void;
	onSubmit: () => void;
	onCancel: () => void;
}) {
	return (
		<form
			className="flex flex-wrap items-center gap-1.5 w-full p-2 border border-line rounded-md bg-surface"
			onSubmit={(e) => {
				e.preventDefault();
				p.onSubmit();
			}}
		>
			<Select
				size="sm"
				className="max-w-[210px]"
				aria-label="选择目标资料空间"
				value={p.draft.spaceId}
				disabled={p.saving}
				onChange={(e) => p.onChange({ spaceId: e.target.value })}
			>
				{p.spaces.map((s) => (
					<option key={s.id} value={s.id}>
						[{SPACE_KIND_LABELS[s.kind] ?? "自定义"}] {s.name}
					</option>
				))}
			</Select>
			<Input
				type="text"
				size="sm"
				className="flex-1 min-w-[140px]"
				aria-label="资料标题"
				placeholder="资料标题"
				value={p.draft.title}
				disabled={p.saving}
				onChange={(e) => p.onChange({ title: e.target.value })}
			/>
			<Button
				type="submit"
				variant="primary"
				size="xs"
				className="rounded-pill"
				disabled={p.saveBlocked || !p.draft.spaceId}
			>
				{p.saving ? "正在保存…" : "确认保存"}
			</Button>
			<Button variant="inline" size="xs" disabled={p.saving} onClick={p.onCancel}>
				取消
			</Button>
		</form>
	);
}

function getMessageDocs(
	msg: NonNullable<MatterDetailPayload["userMessages"]>[number],
	localDoc?: ChatSpaceDocumentItem,
) {
	const persisted = Array.isArray(msg.metadata?.spaceDocuments)
		? (msg.metadata.spaceDocuments as ChatSpaceDocumentItem[])
		: [];
	return localDoc && !persisted.some((doc) => doc.id === localDoc.id) ? [...persisted, localDoc] : persisted;
}

function UserAttachments(p: {
	msgId: string;
	images: ReturnType<typeof parseMessageImages>;
	files: ReturnType<typeof parseMessageFiles>;
	onOpenLightbox: (img: { src: string; alt: string }) => void;
	onPreviewFile: (file: PreviewableTextAttachment) => void;
}) {
	const imgCls =
		p.images.length === 1
			? "block w-auto h-auto max-w-[min(300px,100%)] max-h-[220px] object-contain"
			: "block size-[112px] object-cover";
	return (
		<>
			{p.images.length > 0 && (
				<div className="flex flex-wrap gap-2">
					{p.images.map((img, idx) =>
						img.url ? (
							<button
								key={img.url}
								type="button"
								className="p-0 border border-line rounded-lg overflow-hidden bg-stage cursor-zoom-in block"
								title={img.name ?? "点击查看大图"}
								onClick={() => p.onOpenLightbox({ src: img.url!, alt: img.name ?? `附件图片 ${idx + 1}` })}
							>
								<img
									src={img.url}
									alt={img.name ?? `附件图片 ${idx + 1}`}
									width={112}
									height={112}
									loading="lazy"
									className={imgCls}
								/>
							</button>
						) : (
							<span key={`${p.msgId}-missing-${img.name ?? img.mimeType}`} className="text-xs text-ink-muted">
								[图片：{img.name ?? `附件 ${idx + 1}`}]
							</span>
						),
					)}
				</div>
			)}
			{p.files.length > 0 && (
				<div className="flex flex-wrap gap-1.5 max-w-full min-w-0">
					{p.files.map((file, idx) => {
						const isPasted = file.kind === "pasted_text";
						const meta = [
							file.sizeBytes !== undefined ? formatByteSize(file.sizeBytes) : "",
							file.charCount !== undefined ? `${file.charCount} 字` : "",
							file.previewText ?? "",
						]
							.filter(Boolean)
							.join(" · ");
						return (
							<button
								key={`${p.msgId}-file-${file.url ?? file.name}-${idx}`}
								type="button"
								className={cn(
									FILE_CHIP_BASE_CLASSES,
									isPasted ? "border-dashed border-accent-border" : "border-line hover:border-line-strong",
								)}
								title="点击查看附件内容"
								onClick={() =>
									p.onPreviewFile({
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
								<span className="shrink-0 text-sm leading-none" aria-hidden="true">
									{isPasted ? "¶" : "📄"}
								</span>
								<span className="flex flex-col gap-px min-w-0 overflow-hidden">
									<strong className="font-semibold truncate">
										{isPasted ? `粘贴文本${file.lineCount ? ` · ${file.lineCount} 行` : ""}` : file.name}
									</strong>
									<small className="text-ink-muted text-micro tabular-nums truncate">{meta}</small>
								</span>
							</button>
						);
					})}
				</div>
			)}
		</>
	);
}

function DialogApprovalCard(p: {
	dlg: PendingDialogDto;
	isOwner: boolean;
	dialogInput: string;
	onChangeInput: (val: string) => void;
	onClearInput: () => void;
}) {
	const { dlg } = p;
	const lines = dlg.request.title.split("\n").filter((line) => line.trim().length > 0);
	const heading = lines[0] ?? dlg.request.title;
	const commandLine = lines.find((line) => line.startsWith("命令："));
	const commandText = commandLine ? commandLine.slice("命令：".length).trim() : null;
	const extraLines = lines.slice(1).filter((line) => line !== commandLine);
	const selectVariant = (opt: string) =>
		opt.includes("信任") || opt.includes("自主执行")
			? "primary"
			: opt.includes("拒绝") || opt.includes("取消")
				? "danger"
				: "secondary";
	return (
		<Card padding="md" className="self-start w-full max-w-[520px] shadow-sm">
			<div className="text-xs text-ink-muted">需要你确认 · 来自【{dlg.memberName}】</div>
			<h3 className="mt-1 mb-1.5 text-md font-semibold leading-snug text-ink">{heading}</h3>
			{commandText && (
				<pre className="my-2 p-2.5 rounded-md bg-subtle border border-line overflow-x-auto font-mono text-xs leading-normal text-ink">
					<code>{commandText}</code>
				</pre>
			)}
			{[...extraLines, ...(dlg.request.message ? [dlg.request.message] : [])].map((line) => (
				<p key={line} className="mt-0 mb-2.5 text-sm text-ink-secondary">
					{line}
				</p>
			))}
			{!p.isOwner ? (
				<p className="m-0 text-xs text-ink-muted">
					当前处于协同成员受限模式，工具/操作确认弹窗仅可由团队所有者处理。
				</p>
			) : (
				<div className="flex items-center gap-2 flex-wrap">
					{dlg.request.method === "confirm" &&
						[true, false].map((confirmed) => (
							<Button
								key={String(confirmed)}
								variant={confirmed ? "primary" : "secondary"}
								size="sm"
								className="rounded-pill"
								onClick={() => void respondToDialog(dlg.id, { confirmed })}
							>
								{confirmed ? "允许继续" : "拒绝"}
							</Button>
						))}
					{dlg.request.method === "select" &&
						dlg.request.options?.map((opt) => (
							<Button
								key={opt}
								variant={selectVariant(opt)}
								size="sm"
								className="rounded-pill"
								onClick={() => void respondToDialog(dlg.id, { value: opt })}
							>
								{opt}
							</Button>
						))}
					{(dlg.request.method === "input" || dlg.request.method === "editor") && (
						<div className="flex items-center gap-2 flex-wrap sm:flex-nowrap w-full">
							<Input
								size="sm"
								className="flex-1 min-w-[160px]"
								value={p.dialogInput}
								onChange={(e) => p.onChangeInput(e.target.value)}
								placeholder={dlg.request.placeholder ?? "输入答复…"}
							/>
							<Button
								variant="primary"
								size="sm"
								className="rounded-pill"
								onClick={() => {
									void respondToDialog(dlg.id, { value: p.dialogInput });
									p.onClearInput();
								}}
							>
								提交
							</Button>
						</div>
					)}
				</div>
			)}
		</Card>
	);
}

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
	isNewMatter?: boolean;
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
export function MessageFeed(props: MessageFeedProps) {
	const {
		matterDetail,
		isOwner,
		accountUser = null,
		currentUser = null,
		isTurnRunning,
		members,
		memberName,
		onSendQuickPrompt,
	} = props;
	const selectedIsArchitect = isArchitectMemberId(props.selectedMemberId, members, props.templateByRoleId);
	const isNewMatter = props.isNewMatter ?? false;
	const organizations = props.organizations ?? [];
	const isSuperAdmin = props.isSuperAdmin ?? false;
	const [collapsedSnapshots, setCollapsedSnapshots] = useState<Record<string, boolean>>({});
	const [dialogInput, setDialogInput] = useState("");
	const [spaceSaveError, setSpaceSaveError] = useState<{ id: string; message: string } | null>(null);
	const [savingSpaceMessage, setSavingSpaceMessage] = useState<string | null>(null);
	const [saveDraft, setSaveDraft] = useState<{ messageId: string; spaceId: string; title: string } | null>(null);
	const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
	const copyResetTimerRef = useRef<number | null>(null);

	useEffect(
		() => () => {
			if (copyResetTimerRef.current !== null) window.clearTimeout(copyResetTimerRef.current);
		},
		[],
	);

	const handleCopyMessage = async (messageId: string, content: string) => {
		const ok = await writeTextToClipboard(content);
		if (!ok) return;
		setCopiedMessageId(messageId);
		if (copyResetTimerRef.current !== null) window.clearTimeout(copyResetTimerRef.current);
		copyResetTimerRef.current = window.setTimeout(() => {
			setCopiedMessageId((prev) => (prev === messageId ? null : prev));
			copyResetTimerRef.current = null;
		}, 1800);
	};
	const [writableSpaces, setWritableSpaces] = useState<SpaceDto[] | null>(null);
	const [savedDocsByMsg, setSavedDocsByMsg] = useState<Record<string, ChatSpaceDocumentItem>>({});
	const targetSpaces = writableSpaces?.length
		? writableSpaces
		: matterDetail?.defaultSpace
			? [matterDetail.defaultSpace]
			: [];

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
			props.onNotice?.(`已保存到「${matchedSpace?.name ?? "资料空间"}」`);
		} catch (error) {
			setSpaceSaveError({ id, message: error instanceof Error ? error.message : String(error) });
		} finally {
			setSavingSpaceMessage(null);
		}
	}
	const isArchitectMatter = Boolean(
		matterDetail && isArchitectMemberId(matterDetail.matter.leadMemberId, members, props.templateByRoleId),
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
	const matterOrgRole = organizations.find(({ id }) => id === matterDetail?.matter.orgId)?.orgRole;
	const canSaveSpace =
		!accountUser || isSuperAdmin || (accountUser.status === "active" && matterOrgRole !== "org_viewer");
	const canParticipateInDecisions = isSuperAdmin || matterOrgRole !== "org_viewer";
	const canOperateRoleProposals = accountUser ? accountUser.status === "active" && canParticipateInDecisions : isOwner;
	const activeSpeakerId =
		props.activeMatterProgress?.speakerMemberId ?? matterDetail?.matter.leadMemberId ?? props.headerContact?.id;
	const activeTurnId = props.activeMatterProgress?.sourceUserMessageId;
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

	const welcomeDescription =
		props.selectedMemberId === "auto"
			? "描述目标和希望得到的结果，参与方式可以按需调整。"
			: selectedIsArchitect
				? "描述你们的真实工作流或协作卡点，我来帮你拆解出职责单一、边界清晰的 AI 角色与人机配合方式"
				: stripMarkdownFormatting(
						props.templateByRoleId.get(props.headerContact?.templateId ?? "")?.responsibilities.split("\n")[0] ??
							"直接输入任务开始协作",
					);
	const quickArchitectReply = onSendQuickPrompt
		? (text: string) => onSendQuickPrompt(text, { preferredMemberId: ROLE_ARCHITECT_MEMBER_ID })
		: undefined;

	return (
		<div
			ref={props.chatScrollRef}
			className={cn(
				"px-[var(--page-pad-x)] py-[var(--page-pad-y)] min-h-0",
				isNewMatter ? "flex-none overflow-visible pb-0" : "flex-1 overflow-y-auto pb-4",
			)}
			onScroll={props.onScroll}
		>
			<div ref={props.chatStreamInnerRef} className="max-w-[var(--content-max-w)] mx-auto flex flex-col gap-3.5">
				{!props.selectedMatterId || (!matterDetail && !props.activeMatterProgress) ? (
					<div
						className={cn(
							"flex flex-col items-center text-center px-4",
							isNewMatter ? "pt-[clamp(20px,6vh,56px)] max-sm:pt-5 pb-[18px] gap-2" : "pt-[12vh] pb-6 gap-2.5",
						)}
					>
						<BotFaceIcon
							bg={props.headerTheme.bg}
							size={!props.selectedMatterId && !selectedIsArchitect ? "md" : "lg"}
						/>
						<h1 className="mt-1.5 mb-0 text-xl font-bold leading-snug text-ink">
							{props.selectedMemberId === "auto" ? "今天要推进什么事？" : memberName(props.selectedMemberId)}
						</h1>
						<p className="m-0 text-sm text-ink-muted max-w-[480px] leading-relaxed">{welcomeDescription}</p>
						{!selectedIsArchitect && props.selectedMatterId && (
							<div className="flex flex-wrap items-center justify-center gap-2 mt-3">
								{props.selectedOrganization && (
									<Badge tone="accent" size="sm">
										组织：{props.selectedOrganization.name}
									</Badge>
								)}
								<Badge tone="neutral" size="sm">
									{props.selectedWorkspace
										? `仓库：${props.selectedWorkspace.name}`
										: "通用工作区（不绑定仓库）"}
								</Badge>
								{props.selectedWorkspace?.repoGitUser && (
									<Badge
										tone="neutral"
										size="sm"
										title="执行 Git 提交时以角色署名作 Author，同时保留此仓库真实 Git 用户作 Committer"
									>
										Git 真实提交者：{props.selectedWorkspace.repoGitUser.name}
									</Badge>
								)}
							</div>
						)}
						{isOwner && selectedIsArchitect && (
							<div className="mt-3.5 flex flex-col items-center gap-2 max-w-[560px] mx-auto">
								{ARCHITECT_SAMPLES.map((sample) => (
									<button
										key={sample}
										type="button"
										className="w-full text-left px-3.5 py-2 rounded-lg border border-line bg-stage text-xs text-ink-secondary leading-relaxed hover:border-line-strong hover:bg-hover/50 hover:text-ink transition-colors cursor-pointer"
										onClick={() => props.onFillComposer?.(sample)}
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
							const isObserver = msg.metadata?.observerIntervention === true;
							const isLeadReply = msg.senderType === "member" && msg.metadata?.matterLeadReply === true;
							const isDiscussionReply =
								!isUser && !isSystem && !isObserver && msg.metadata?.discussionTurn === true;
							const msgMode = isUser && typeof msg.metadata?.mode === "string" ? msg.metadata.mode : "dispatch";
							const isDiscussion = isUser && msgMode === "discussion";
							const isAiRequest = isUser && msgMode === "ai_request";
							const authorName =
								isUser && typeof msg.metadata?.authorName === "string" ? msg.metadata.authorName : null;
							const authorRole =
								isUser && typeof msg.metadata?.authorRole === "string" ? msg.metadata.authorRole : null;
							const aiReqStatus =
								isAiRequest && typeof msg.metadata?.aiRequestStatus === "string"
									? msg.metadata.aiRequestStatus
									: "pending";
							const approvedBy =
								isAiRequest && typeof msg.metadata?.approvedByName === "string"
									? msg.metadata.approvedByName
									: "所有者";
							const speakerTheme = getMemberThemeById(members, msg.senderId);
							const attachedDelegations = props.delegations.byTurn.get(msg.id)?.assignments;
							const progressSnapshot = parseProgressSnapshot(msg.metadata);
							const roleProposals = !isUser && !isSystem ? parseRoleProposalsFromMetadata(msg.metadata) : null;
							const leadFallback =
								!isSystem && msg.senderId
									? memberName(msg.senderId)
									: matterDetail?.matter.leadMemberId
										? memberName(matterDetail.matter.leadMemberId)
										: undefined;
							const isConvMsg =
								msg.metadata?.mode === "conversation" || msg.metadata?.conversationRouted === true;
							const hidePlaceholder =
								!isUser && !isSystem && Boolean(decision) && msg.content.trim() === "等待你在卡片里提交决定。";
							const messageDocs = getMessageDocs(msg, savedDocsByMsg[msg.id]);
							const canShowSaveToSpace =
								canSaveSpace &&
								!isSystem &&
								!isUser &&
								!decision &&
								msg.content.trim().length >= 80 &&
								messageDocs.length === 0;
							const userBubbleClass =
								!isConvMsg && isDiscussion
									? "bg-info-bg text-ink border border-info-border"
									: !isConvMsg && isAiRequest
										? "bg-warn-bg text-ink border border-warn-border"
										: "bg-subtle text-ink border border-line";
							const memberBubbleClass =
								isSystem && !isRosterSnapshot && !isWorkbenchHelp
									? "bg-warn-bg text-warn-text border border-warn-border"
									: isObserver
										? "bg-surface-accent text-ink border border-accent-border border-l-[3px] border-l-accent"
										: "bg-sidebar text-ink border border-line";
							const memberLabel = isRosterSnapshot
								? "事项名册"
								: isWorkbenchHelp
									? "功能说明"
									: isSystem
										? "系统提示"
										: memberName(msg.senderId);
							const aiReqTone =
								aiReqStatus === "approved" ? "success" : aiReqStatus === "dismissed" ? "neutral" : "warn";
							const aiReqText =
								aiReqStatus === "approved"
									? `已由${approvedBy}确认派发`
									: aiReqStatus === "dismissed"
										? "已忽略"
										: "待所有者确认";
							const memberRoleBadge = isLeadReply
								? { tone: "info" as const, label: "主责" }
								: isDiscussionReply
									? { tone: "info" as const, label: "讨论参与" }
									: isObserver
										? { tone: "observer" as const, label: "旁听补充" }
										: null;
							const copyLabel = isUser ? "复制" : "复制 Markdown";
							const copyTitle = isUser ? "复制消息内容" : "复制原始 Markdown 内容";
							const isCopied = copiedMessageId === msg.id;
							const snapshotExpanded = progressSnapshot
								? collapsedSnapshots[msg.id] !== undefined
									? !collapsedSnapshots[msg.id]
									: progressSnapshot.outcome !== "completed"
								: false;

							return (
								<div
									key={msg.id}
									id={`matter-message-${msg.id}`}
									tabIndex={isUser || decision || roleProposals ? -1 : undefined}
									className={cn("flex flex-col gap-1 min-w-0", isUser ? "items-end" : "items-start")}
								>
									{isUser ? (
										<div className="inline-flex items-center justify-end gap-1.5 text-xs text-ink-muted px-1 flex-wrap">
											{!isConvMsg && (
												<Badge tone={isDiscussion ? "info" : isAiRequest ? "warn" : "neutral"} size="xs">
													{isDiscussion
														? "团队讨论"
														: isAiRequest
															? "提请 AI"
															: msg.metadata?.humanDecisionSourceId
																? "人类答复"
																: "AI 安排"}
												</Badge>
											)}
											<span>
												{authorName ?? (isDiscussion ? "成员" : "团队所有者")}
												{authorRole ? ` · ${authorRole}` : ""}
											</span>
											<span>· {formatClockTime(msg.createdAt)}</span>
											{isAiRequest && (
												<Badge tone={aiReqTone} size="xs">
													{aiReqText}
												</Badge>
											)}
										</div>
									) : (
										<div className="inline-flex items-center gap-1.5 text-xs text-ink-muted px-1 flex-wrap">
											{!isSystem && (
												<BotFaceIcon bg={speakerTheme.bg} tilt={speakerTheme.tilt} size="xs" mood="idle" />
											)}
											<span>
												{memberLabel} · {formatClockTime(msg.createdAt)}
											</span>
											{memberRoleBadge && (
												<Badge tone={memberRoleBadge.tone} size="xs">
													{memberRoleBadge.label}
												</Badge>
											)}
										</div>
									)}
									{!hidePlaceholder && (
										<div
											className={
												isUser
													? cn(USER_BUBBLE_BASE_CLASSES, userBubbleClass)
													: cn(MEMBER_BUBBLE_BASE_CLASSES, memberBubbleClass)
											}
										>
											{isUser ? (
												<>
													<UserAttachments
														msgId={msg.id}
														images={parseMessageImages(msg.metadata)}
														files={parseMessageFiles(msg.metadata)}
														onOpenLightbox={props.onOpenLightbox}
														onPreviewFile={props.onPreviewFile}
													/>
													{msg.content && (
														<div className="whitespace-pre-wrap break-words">{msg.content}</div>
													)}
													{isAiRequest && aiReqStatus === "pending" && isOwner && matterDetail && (
														<div className="flex items-center gap-2 mt-2.5 pt-2 border-t border-dashed border-warn-border">
															<Button
																variant="primary"
																size="xs"
																className="rounded-pill"
																disabled={isTurnRunning}
																title={
																	isTurnRunning
																		? "请等待当前 AI 回合完成后确认派发"
																		: "确认此提请并立即派发给 AI 执行"
																}
																onClick={() =>
																	props.onApproveAiRequest?.(matterDetail.matter.id, msg.id)
																}
															>
																确认并派发 AI
															</Button>
															<Button
																variant="secondary"
																size="xs"
																className="rounded-pill"
																onClick={() =>
																	props.onDismissAiRequest?.(matterDetail.matter.id, msg.id)
																}
															>
																忽略提请
															</Button>
														</div>
													)}
												</>
											) : (
												<MarkdownView content={msg.content} />
											)}
										</div>
									)}
									{(isUser || (!isSystem && !hidePlaceholder)) && msg.content.trim().length > 0 && (
										<div className="flex items-center gap-2 flex-wrap px-1 text-xs">
											<Button
												variant={isCopied ? "secondary" : "ghost"}
												size="xs"
												className={
													isCopied ? "text-accent border-accent-border bg-accent-soft" : "text-ink-muted"
												}
												title={copyTitle}
												aria-label={copyTitle}
												onClick={() => void handleCopyMessage(msg.id, msg.content)}
											>
												{isCopied ? `✓ 已${copyLabel}` : copyLabel}
											</Button>
											{canShowSaveToSpace && saveDraft?.messageId !== msg.id && (
												<Button
													variant="inline"
													size="xs"
													disabled={savingSpaceMessage !== null}
													onClick={() => openSaveToSpaceDraft(msg.id, msg.content)}
												>
													保存文字到资料空间
												</Button>
											)}
										</div>
									)}
									{canShowSaveToSpace &&
										(saveDraft?.messageId === msg.id || spaceSaveError?.id === msg.id) && (
											<div className="flex items-center gap-2 text-xs flex-wrap w-full">
												{saveDraft?.messageId === msg.id && (
													<SaveToSpaceForm
														draft={saveDraft}
														spaces={targetSpaces}
														saving={savingSpaceMessage === msg.id}
														saveBlocked={savingSpaceMessage !== null}
														onChange={(patch) => setSaveDraft((p) => (p ? { ...p, ...patch } : p))}
														onSubmit={() =>
															void confirmSaveMessageToSpace(matterDetail.matter.id, msg.id, msg.content)
														}
														onCancel={() => {
															setSaveDraft(null);
															setSpaceSaveError(null);
														}}
													/>
												)}
												{spaceSaveError?.id === msg.id && (
													<output className="text-xs text-danger-text">{spaceSaveError.message}</output>
												)}
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
											expanded={snapshotExpanded}
											members={members}
											fallbackLeadName={leadFallback}
											onToggle={() =>
												setCollapsedSnapshots((prev) => ({ ...prev, [msg.id]: snapshotExpanded }))
											}
										/>
									)}
									{attachedDelegations && (
										<DelegationSummaryCard
											items={attachedDelegations}
											onOpen={() => props.onOpenDelegations(`turn:${msg.id}`)}
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
											canManage={props.canManageMatter}
											canParticipate={canParticipateInDecisions}
											accountUser={accountUser}
											currentUser={currentUser}
											candidates={props.decisionAssignees}
											requestedBy={memberName(msg.senderId)}
											sourceName={
												decision.source
													? `${memberName(decision.source.memberId)}（委托 #${decision.source.assignmentNumber}）`
													: undefined
											}
											handledInFloatingDock={(props.floatingClarificationMessageId ?? null) === msg.id}
										/>
									)}
									{roleProposals &&
										matterDetail &&
										props.onApplyRoleProposals &&
										props.onDismissRoleProposals && (
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
												onApply={props.onApplyRoleProposals}
												onDismiss={props.onDismissRoleProposals}
												onQuickReply={quickArchitectReply}
												onLaunchWithNewRoles={props.onLaunchWithNewRoles}
											/>
										)}
									{matterDetail && readSkillProposals(msg.metadata).length > 0 && (
										<SkillProposalCard
											matterId={matterDetail.matter.id}
											messageId={msg.id}
											proposals={readSkillProposals(msg.metadata)}
											hasWorkspace={Boolean(matterDetail.matter.workspaceId)}
											onDone={props.onSkillProposalDone}
											onOpenSkillTrust={props.onOpenSkillTrust}
											onNotice={props.onNotice}
										/>
									)}
									{messageDocs.map((doc) => (
										<SpaceDocumentCard
											key={doc.id}
											doc={doc}
											canProceed={
												Boolean(matterDetail) &&
												messageIndex === matterDetail!.userMessages.length - 1 &&
												!isTurnRunning &&
												isOwner &&
												Boolean(onSendQuickPrompt)
											}
											onOpen={(showDiff) =>
												props.onOpenSideDoc
													? props.onOpenSideDoc(doc.id, { showDiff })
													: props.onOpenDeliverables(doc.id)
											}
											onProceed={() =>
												void onSendQuickPrompt?.(
													`确认方案「${doc.title}」(rev ${doc.revision})，请按此方案继续推进。`,
												)
											}
										/>
									))}
								</div>
							);
						})}

						{props.activeDialogs.map((dlg) => (
							<DialogApprovalCard
								key={dlg.id}
								dlg={dlg}
								isOwner={isOwner}
								dialogInput={dialogInput}
								onChangeInput={setDialogInput}
								onClearInput={() => setDialogInput("")}
							/>
						))}

						<DelegationSummaryCard
							items={props.delegations.history.assignments}
							history
							onOpen={() => props.onOpenDelegations("history")}
						/>

						{props.streamingDelta && (
							<div className="flex flex-col items-start gap-1 min-w-0">
								<div className="inline-flex items-center gap-1.5 text-xs text-ink-muted px-1">
									正在整理回复…
								</div>
								<div className={cn(MEMBER_BUBBLE_BASE_CLASSES, "bg-sidebar text-ink border border-line")}>
									<MarkdownView content={props.streamingDelta} />
								</div>
							</div>
						)}

						{props.activeMatterProgress && props.selectedMatterId && (
							<ExploringStatus
								progress={props.activeMatterProgress}
								startedAt={props.progressStartedAt}
								members={members}
								leadMemberId={activeSpeakerId}
								leadDisplayName={activeSpeakerId ? memberName(activeSpeakerId) : undefined}
								onOpenDelegations={
									activeTurnId ? () => props.onOpenDelegations(`turn:${activeTurnId}`, "graph") : undefined
								}
								onAbort={() => props.onAbortMatter(props.selectedMatterId!)}
							/>
						)}
					</>
				)}
				<div ref={props.messagesEndRef} />
			</div>
		</div>
	);
}
