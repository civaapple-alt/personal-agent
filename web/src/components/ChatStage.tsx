import {
	type ClipboardEvent,
	type DragEvent,
	type KeyboardEvent,
	type RefObject,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	type CollaboratorDto,
	type ComposerImageAttachment,
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
import { MAX_COMPOSER_IMAGES } from "../imageAttachments.ts";
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
	parseMessageImages,
	parseProgressSnapshot,
	type StarterTask,
} from "../utils.ts";
import { BotFaceIcon } from "./BotFaceIcon.tsx";
import { InlineExperienceReviewSection } from "./ExperienceReviewPanel.tsx";
import { ExploringStatus, ProgressSnapshotCard } from "./ExploringStatus.tsx";

interface ChatStageProps {
	composerRef: RefObject<HTMLTextAreaElement | null>;
	currentUser?: CollaboratorDto | null;
	collaborators?: CollaboratorDto[];
	composerMode: "discussion" | "dispatch";
	onComposerModeChange: (mode: "discussion" | "dispatch") => void;
	selectedWorkspace: WorkspaceDto | null;
	selectedWorkspaceId: string;
	selectedOrgId: string;
	workspaces: WorkspaceDto[];
	organizations: import("../api.ts").OrganizationDto[];
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
	pendingImages: ComposerImageAttachment[];
	errorBanner: string | null;
	noticeBanner: string | null;
	starterTasks: StarterTask[];
	templateByRoleId: Map<string, RoleTemplateDto>;
	memoriesByMember: Record<string, MemberMemoryDto[]>;
	memberName: (id: string) => string;
	workspaceName: (id: string | null) => string | null;
	organizationName: (id: string | null) => string | null;
	previewUrlFor: (deliverable: DeliverableDto | null) => string | null;
	onComposerTextChange: (value: string) => void;
	onAddImages: (files: FileList | File[]) => void;
	onRemoveImage: (imageId: string) => void;
	onSelectOrganization: (orgId: string) => void;
	onSelectWorkspace: (workspaceId: string) => void;
	matterAiMemberIds: string[];
	observersEnabled: boolean;
	onChangeLeadMember: (memberId: string) => void;
	onUpdateMatterAiMembers: (aiMemberIds: string[]) => void;
	onToggleObserversEnabled: (enabled: boolean) => void;
	onUpdateMatterCollaborators?: (collaboratorIds: string[]) => void;
	onApproveAiRequest?: (matterId: string, messageId: string) => void;
	onDismissAiRequest?: (matterId: string, messageId: string) => void;
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

const chatScrollMemory = new Map<string, { scrollTop: number; atBottom: boolean }>();

export function ChatStage({
	composerRef,
	currentUser,
	collaborators = [],
	composerMode,
	onComposerModeChange,
	selectedWorkspace,
	selectedWorkspaceId,
	selectedOrgId,
	workspaces,
	organizations,
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
	pendingImages,
	errorBanner,
	noticeBanner,
	starterTasks,
	templateByRoleId,
	memoriesByMember,
	memberName,
	workspaceName,
	organizationName,
	previewUrlFor,
	onComposerTextChange,
	onAddImages,
	onRemoveImage,
	onSelectOrganization,
	onSelectWorkspace,
	matterAiMemberIds,
	observersEnabled,
	onChangeLeadMember,
	onUpdateMatterAiMembers,
	onToggleObserversEnabled,
	onUpdateMatterCollaborators,
	onApproveAiRequest,
	onDismissAiRequest,
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
	const [dragOverComposer, setDragOverComposer] = useState(false);
	const [lightboxImage, setLightboxImage] = useState<{ src: string; alt: string } | null>(null);
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const dragDepthRef = useRef(0);
	const [collabTab, setCollabTab] = useState<"delegations" | "events" | "experiences">("delegations");
	const [distillingMatter, setDistillingMatter] = useState(false);
	const [distillNoteByMatter, setDistillNoteByMatter] = useState<Record<string, string>>({});
	const [expandedDelegations, setExpandedDelegations] = useState<Record<string, boolean>>({});
	const [expandedDelegationTexts, setExpandedDelegationTexts] = useState<Record<string, boolean>>({});
	const [eventsKeyOnly, setEventsKeyOnly] = useState(false);
	const [showAllEvents, setShowAllEvents] = useState(false);
	const [collapsedSnapshots, setCollapsedSnapshots] = useState<Record<string, boolean>>({});
	const [starterMenuOpen, setStarterMenuOpen] = useState(false);
	const [rosterOpen, setRosterOpen] = useState(false);
	const [rosterMode, setRosterMode] = useState<"view" | "add" | "remove">("view");
	const [rosterSearch, setRosterSearch] = useState("");
	const [moreMenuOpen, setMoreMenuOpen] = useState(false);
	const [dialogInput, setDialogInput] = useState("");
	const chatScrollRef = useRef<HTMLDivElement | null>(null);
	const chatStreamInnerRef = useRef<HTMLDivElement | null>(null);
	const messagesEndRef = useRef<HTMLDivElement | null>(null);
	const lastScrolledMatterIdRef = useRef<string | null>(null);
	const prevMessageCountRef = useRef(0);
	const prevStreamLenRef = useRef(0);
	const moreMenuWrapRef = useRef<HTMLDivElement | null>(null);
	const collabPanelRef = useRef<HTMLDivElement | null>(null);
	const composerDockRef = useRef<HTMLDivElement | null>(null);
	const rosterPanelRef = useRef<HTMLDivElement | null>(null);
	const headerHumansBtnRef = useRef<HTMLButtonElement | null>(null);

	const isOwner = currentUser?.permissionRole !== "collaborator";

	const closeRoster = () => {
		setRosterOpen(false);
		setRosterMode("view");
		setRosterSearch("");
	};

	useEffect(() => {
		if (!collabOpen && !starterMenuOpen && !rosterOpen && !moreMenuOpen) return;
		const onMouseDown = (event: MouseEvent) => {
			const target = event.target as Node | null;
			if (!target) return;
			if (collabOpen && !collabPanelRef.current?.contains(target) && !moreMenuWrapRef.current?.contains(target)) {
				setCollabOpen(false);
			}
			if (starterMenuOpen && !composerDockRef.current?.contains(target)) {
				setStarterMenuOpen(false);
			}
			if (rosterOpen && !rosterPanelRef.current?.contains(target) && !headerHumansBtnRef.current?.contains(target)) {
				setRosterOpen(false);
				setRosterMode("view");
				setRosterSearch("");
			}
			if (moreMenuOpen && !moreMenuWrapRef.current?.contains(target)) {
				setMoreMenuOpen(false);
			}
		};
		const onKeyDown = (event: globalThis.KeyboardEvent) => {
			if (event.key === "Escape") {
				setCollabOpen(false);
				setStarterMenuOpen(false);
				setRosterOpen(false);
				setMoreMenuOpen(false);
				setRosterMode("view");
				setRosterSearch("");
				setLightboxImage(null);
			}
		};
		document.addEventListener("mousedown", onMouseDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("mousedown", onMouseDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [collabOpen, starterMenuOpen, rosterOpen, moreMenuOpen]);

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
	const sendBlockedByTurn = isTurnRunning && isOwner && composerMode === "dispatch";
	const loadedMatterId = matterDetail?.matter.id ?? null;
	const activeLoadedId = selectedMatterId && loadedMatterId === selectedMatterId ? loadedMatterId : null;
	const messageCount = matterDetail?.userMessages.length ?? 0;
	const streamLen = streamingDelta.length;
	useLayoutEffect(() => {
		const el = chatScrollRef.current;
		if (!el || !activeLoadedId) {
			lastScrolledMatterIdRef.current = null;
			prevMessageCountRef.current = 0;
			prevStreamLenRef.current = 0;
			return;
		}
		if (lastScrolledMatterIdRef.current !== activeLoadedId) {
			lastScrolledMatterIdRef.current = activeLoadedId;
			prevMessageCountRef.current = messageCount;
			prevStreamLenRef.current = streamLen;
			const saved = chatScrollMemory.get(activeLoadedId);
			if (saved && !saved.atBottom) {
				el.scrollTop = saved.scrollTop;
			} else {
				el.scrollTop = el.scrollHeight;
				chatScrollMemory.set(activeLoadedId, { scrollTop: el.scrollTop, atBottom: true });
			}
			return;
		}
		const hadNewMessage = messageCount > prevMessageCountRef.current;
		const hadStreamGrowth = streamLen > prevStreamLenRef.current;
		prevMessageCountRef.current = messageCount;
		prevStreamLenRef.current = streamLen;
		if (!hadNewMessage && !hadStreamGrowth) return;
		const saved = chatScrollMemory.get(activeLoadedId);
		if (saved && !saved.atBottom) return;
		if (hadNewMessage) {
			messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
			chatScrollMemory.set(activeLoadedId, { scrollTop: el.scrollHeight, atBottom: true });
		} else if (hadStreamGrowth) {
			el.scrollTop = el.scrollHeight;
			chatScrollMemory.set(activeLoadedId, { scrollTop: el.scrollTop, atBottom: true });
		}
	}, [activeLoadedId, messageCount, streamLen]);

	useEffect(() => {
		const el = chatScrollRef.current;
		const inner = chatStreamInnerRef.current;
		if (!el || !inner || !activeLoadedId || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => {
			if (lastScrolledMatterIdRef.current !== activeLoadedId) return;
			const saved = chatScrollMemory.get(activeLoadedId);
			if (saved && !saved.atBottom) return;
			el.scrollTop = el.scrollHeight;
			chatScrollMemory.set(activeLoadedId, { scrollTop: el.scrollTop, atBottom: true });
		});
		observer.observe(inner);
		return () => observer.disconnect();
	}, [activeLoadedId]);

	const handleComposerKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
			e.preventDefault();
			if (!sendBlockedByTurn && !submitting && (composerText.trim() || pendingImages.length > 0)) {
				onSendPrompt();
			}
		}
	};

	const hasDraggedFiles = (dataTransfer: DataTransfer | null): boolean => {
		if (!dataTransfer) return false;
		if (dataTransfer.files && dataTransfer.files.length > 0) return true;
		return Array.from(dataTransfer.types ?? []).includes("Files");
	};

	const handleComposerDragEnter = (e: DragEvent<HTMLDivElement>) => {
		if (!hasDraggedFiles(e.dataTransfer)) return;
		e.preventDefault();
		e.stopPropagation();
		dragDepthRef.current += 1;
		setDragOverComposer(true);
	};

	const handleComposerDragOver = (e: DragEvent<HTMLDivElement>) => {
		if (!hasDraggedFiles(e.dataTransfer)) return;
		e.preventDefault();
		e.stopPropagation();
		e.dataTransfer.dropEffect = "copy";
		if (!dragOverComposer) setDragOverComposer(true);
	};

	const handleComposerDragLeave = (e: DragEvent<HTMLDivElement>) => {
		if (!hasDraggedFiles(e.dataTransfer)) return;
		e.preventDefault();
		e.stopPropagation();
		dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
		if (dragDepthRef.current === 0) {
			setDragOverComposer(false);
		}
	};

	const handleComposerDrop = (e: DragEvent<HTMLDivElement>) => {
		e.preventDefault();
		e.stopPropagation();
		dragDepthRef.current = 0;
		setDragOverComposer(false);
		if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
			onAddImages(e.dataTransfer.files);
			composerRef.current?.focus();
		}
	};

	const handleComposerPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
		const clipboard = e.clipboardData;
		if (!clipboard) return;
		const imageFiles: File[] = [];
		for (const item of Array.from(clipboard.items ?? [])) {
			if (item.kind === "file" && item.type.startsWith("image/")) {
				const file = item.getAsFile();
				if (file) imageFiles.push(file);
			}
		}
		if (imageFiles.length === 0) {
			for (const file of Array.from(clipboard.files ?? [])) {
				if (file.type.startsWith("image/")) imageFiles.push(file);
			}
		}
		if (imageFiles.length > 0) {
			if (!clipboard.getData("text/plain")) {
				e.preventDefault();
			}
			onAddImages(imageFiles);
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

	const effectiveOrgId = selectedWorkspace ? selectedWorkspace.orgId : selectedOrgId || null;
	const selectedOrganization = useMemo(
		() => (effectiveOrgId ? (organizations.find((org) => org.id === effectiveOrgId) ?? null) : null),
		[effectiveOrgId, organizations],
	);
	const orgFilteredWorkspaces = useMemo(
		() =>
			effectiveOrgId ? workspaces.filter((ws) => ws.orgId === effectiveOrgId) : workspaces.filter((ws) => !ws.orgId),
		[effectiveOrgId, workspaces],
	);

	const ownerCollab = collaborators.find((c) => c.permissionRole === "owner") ?? null;
	const nonOwnerCollaborators = collaborators.filter((c) => c.permissionRole !== "owner");
	const assignedCollabIds = matterDetail?.matter.collaboratorIds ?? [];
	const messageHumanAuthorIds = useMemo(() => {
		const ids = new Set<string>();
		for (const msg of matterDetail?.userMessages ?? []) {
			if (msg.senderType === "user" && msg.senderId && msg.senderId !== "user") {
				ids.add(msg.senderId);
			}
		}
		return ids;
	}, [matterDetail?.userMessages]);
	const matterHumanParticipants = nonOwnerCollaborators.filter(
		(c) => assignedCollabIds.includes(c.id) || messageHumanAuthorIds.has(c.id) || currentUser?.id === c.id,
	);
	const allActiveHumans = useMemo(() => {
		const list: CollaboratorDto[] = [];
		if (ownerCollab) list.push(ownerCollab);
		for (const col of matterHumanParticipants) list.push(col);
		return list;
	}, [ownerCollab, matterHumanParticipants]);
	const leadAi =
		(matterDetail?.matter.leadMemberId ? members.find((m) => m.id === matterDetail.matter.leadMemberId) : null) ??
		headerContact;
	const inGroupAiMembers = useMemo(() => {
		const idSet = new Set(matterAiMemberIds);
		if (leadAi) idSet.add(leadAi.id);
		const filtered = members.filter((m) => idSet.has(m.id));
		if (leadAi && filtered.some((m) => m.id === leadAi.id)) {
			return [leadAi, ...filtered.filter((m) => m.id !== leadAi.id)];
		}
		return filtered.length > 0 ? filtered : members;
	}, [leadAi, matterAiMemberIds, members]);
	const nonLeadGroupAiMembers = inGroupAiMembers.filter((m) => m.id !== leadAi?.id);
	const removedAiMembers = members.filter((m) => !inGroupAiMembers.some((g) => g.id === m.id));
	const observerAis = observersEnabled ? nonLeadGroupAiMembers : [];
	const specialistIds = Array.from(new Set(delegationsPlacement.all.map((d) => d.toMemberId).filter(Boolean))).filter(
		(id) => id !== leadAi?.id && !observerAis.some((obs) => obs.id === id),
	);
	const copyCollabInvite = async (col: CollaboratorDto) => {
		if (!col.token) return;
		const url = `${window.location.origin}/?invite=${encodeURIComponent(col.token)}`;
		try {
			await navigator.clipboard.writeText(url);
			const localWarn =
				window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost"
					? "（提示：本机启动时需设置 PA_HOST=0.0.0.0 并替换为局域网 IP 给同事访问）"
					: "";
			onNotice(`已复制「${col.name}」的邀请链接${localWarn}`);
		} catch {
			onNotice(`邀请链接：${url}`);
		}
	};

	return (
		<div className="chat-stage">
			<header className="stage-header">
				<div className="stage-header-left">
					{selectedOrganization && (
						<span
							className="pill org-pill"
							title={
								selectedOrganization.description ||
								`所属组织：${selectedOrganization.name}（同组织共享组织记忆与默认 Git 域名）`
							}
						>
							组织：{selectedOrganization.name}
						</span>
					)}
					{selectedWorkspace ? (
						<span
							className="pill"
							title={
								selectedWorkspace.repoGitUser
									? `Git Committer（真实用户保留）：${selectedWorkspace.repoGitUser.name} <${selectedWorkspace.repoGitUser.email}>`
									: selectedWorkspace.repoPath
							}
						>
							仓库：{selectedWorkspace.name}
						</span>
					) : (
						<span className="pill">{selectedOrganization ? "未绑定仓库" : "通用工作区"}</span>
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
					<button
						ref={headerHumansBtnRef}
						type="button"
						aria-expanded={rosterOpen}
						className={`btn-pill-outline btn-xs header-humans-btn ${rosterOpen ? "active" : ""}`}
						title={[
							`人类成员（${allActiveHumans.length || 1}人）：${allActiveHumans.length > 0 ? allActiveHumans.map((h) => `${h.name}·${h.permissionRole === "owner" ? "所有者" : h.roleTitle}`).join("、") : "当前用户"}`,
							`协作 AI（${inGroupAiMembers.length}/${members.length}）：${leadAi ? `负责人 ${leadAi.displayName}` : ""}${nonLeadGroupAiMembers.length > 0 ? `、${nonLeadGroupAiMembers.map((m) => m.displayName).join("、")}` : ""}`,
							`AI 旁听：${observersEnabled ? `已开启（${observerAis.length} 位）` : "未开启"}`,
						]
							.filter(Boolean)
							.join("\n")}
						onClick={() => {
							setCollabOpen(false);
							setMoreMenuOpen(false);
							if (rosterOpen) {
								closeRoster();
							} else {
								setRosterMode("view");
								setRosterSearch("");
								setRosterOpen(true);
							}
						}}
					>
						<span className="header-humans-avatars" aria-hidden="true">
							{allActiveHumans.slice(0, 3).map((person, idx) => (
								<span
									key={person.id}
									className={`header-human-avatar ${person.permissionRole === "owner" ? "is-owner" : ""} idx-${idx}`}
								>
									{person.name.slice(0, 1).toUpperCase()}
								</span>
							))}
						</span>
						<span className="header-humans-text">
							{allActiveHumans.length > 0
								? `协作成员 · ${allActiveHumans
										.slice(0, 2)
										.map((h) => h.name)
										.join("、")}${allActiveHumans.length > 2 ? ` +${allActiveHumans.length - 2}` : ""}`
								: "协作成员 (1)"}
						</span>
						{observersEnabled && (
							<span className="header-observer-badge">
								{observerAis.length > 0 ? `旁听 ${observerAis.length}` : "旁听开"}
							</span>
						)}
					</button>
					<div ref={moreMenuWrapRef} className="header-more-wrap">
						<button
							type="button"
							aria-label={
								pendingMatterMemoriesCount > 0
									? `更多功能（${pendingMatterMemoriesCount} 条待核验经验）`
									: "更多功能"
							}
							aria-haspopup="menu"
							aria-expanded={moreMenuOpen}
							className={`btn-pill-outline btn-xs header-more-btn ${moreMenuOpen || collabOpen ? "active" : ""}`}
							title={
								pendingMatterMemoriesCount > 0
									? `团队委托、经验复盘（${pendingMatterMemoriesCount} 待核验）与成果库`
									: "团队委托、经验复盘与成果库"
							}
							onClick={() => {
								closeRoster();
								setMoreMenuOpen((open) => !open);
							}}
						>
							<span aria-hidden="true">···</span>
							{pendingMatterMemoriesCount > 0 && <span className="header-more-dot" aria-hidden="true" />}
						</button>
						{moreMenuOpen && (
							<div role="menu" aria-label="更多功能" className="header-more-menu">
								{matterDetail && (
									<>
										<button
											type="button"
											role="menuitem"
											className={`header-more-item ${collabOpen && collabTab !== "experiences" ? "active" : ""}`}
											onClick={() => {
												setMoreMenuOpen(false);
												const willOpen = !(collabOpen && collabTab !== "experiences");
												if (
													willOpen &&
													delegationsPlacement.all.length === 0 &&
													matterDetail.noticeMessages.length > 0
												) {
													setCollabTab("events");
												} else if (willOpen) {
													setCollabTab("delegations");
												}
												setCollabOpen(willOpen);
											}}
										>
											<span className="header-more-label">
												{delegationsPlacement.all.length > 0 ? "团队委托与事件" : "过程事件"}
											</span>
											<span className="header-more-meta">
												{delegationsPlacement.all.length > 0
													? `${delegationsPlacement.all.length} / ${matterDetail.noticeMessages.length}`
													: matterDetail.noticeMessages.length}
											</span>
										</button>
										<button
											type="button"
											role="menuitem"
											className={`header-more-item ${collabOpen && collabTab === "experiences" ? "active" : ""}`}
											onClick={() => {
												setMoreMenuOpen(false);
												const willOpen = !(collabOpen && collabTab === "experiences");
												setCollabTab("experiences");
												setCollabOpen(willOpen);
											}}
										>
											<span className="header-more-label">经验复盘</span>
											<span className="header-more-meta">
												{matterMemories.length}
												{pendingMatterMemoriesCount > 0 && (
													<span className="header-more-pending">
														· {pendingMatterMemoriesCount} 待核验
													</span>
												)}
											</span>
										</button>
									</>
								)}
								<button
									type="button"
									role="menuitem"
									className="header-more-item"
									onClick={() => {
										setMoreMenuOpen(false);
										onOpenDeliverables(activeChatDeliverable?.id ?? selectedDeliverableId ?? undefined);
									}}
								>
									<span className="header-more-label">成果库</span>
									<span className="header-more-meta">{deliverablesCount}</span>
								</button>
							</div>
						)}
					</div>
				</div>
			</header>

			{rosterOpen &&
				(() => {
					const query = rosterSearch.trim().toLowerCase();
					const matchesQuery = (...parts: Array<string | undefined>) =>
						!query || parts.some((part) => (part ?? "").toLowerCase().includes(query));
					const ownerLabel = ownerCollab?.name ?? "我";
					const showOwnerTile = matchesQuery(ownerLabel, "所有者");
					const filteredHumanTiles = matterHumanParticipants.filter((col) =>
						matchesQuery(col.name, col.roleTitle, "同事"),
					);
					const filteredAiTiles = inGroupAiMembers.filter((ai) => {
						const isLead = ai.id === leadAi?.id;
						const roleLabel = isLead
							? "负责人"
							: observersEnabled
								? "旁听"
								: specialistIds.includes(ai.id)
									? "协同"
									: "协作成员";
						return matchesQuery(ai.displayName, ai.roleTitle, roleLabel);
					});
					const hasRemovable =
						Boolean(selectedMatterId && onUpdateMatterCollaborators && matterHumanParticipants.length > 0) ||
						nonLeadGroupAiMembers.length > 0;
					const filteredCollabCandidates = nonOwnerCollaborators.filter((col) =>
						matchesQuery(col.name, col.roleTitle),
					);
					const filteredRemovedAi = removedAiMembers.filter((ai) => matchesQuery(ai.displayName, ai.roleTitle));
					return (
						<div
							ref={rosterPanelRef}
							role="dialog"
							aria-label="协作成员"
							className="collab-dock-panel unified-roster-panel wechat-roster-panel"
						>
							{rosterMode === "add" && isOwner ? (
								<>
									<div className="wechat-roster-nav">
										<button
											type="button"
											className="wechat-nav-btn"
											onClick={() => {
												setRosterMode("view");
												setRosterSearch("");
											}}
										>
											‹ 返回
										</button>
										<strong className="wechat-nav-title">添加协作成员</strong>
										<button
											type="button"
											className="wechat-nav-btn primary"
											onClick={() => {
												setRosterMode("view");
												setRosterSearch("");
											}}
										>
											完成
										</button>
									</div>

									<input
										type="search"
										className="wechat-roster-search"
										placeholder="搜索同事或 AI 角色"
										value={rosterSearch}
										onChange={(e) => setRosterSearch(e.target.value)}
									/>

									<div className="wechat-add-scroll">
										<div className="wechat-add-group">
											<div className="wechat-add-head">
												<span>人类同事</span>
												<button
													type="button"
													className="btn-inline"
													onClick={() => {
														closeRoster();
														onOpenTeam();
													}}
												>
													团队页新增 ›
												</button>
											</div>
											{filteredCollabCandidates.length === 0 ? (
												<div className="wechat-empty-row">
													{nonOwnerCollaborators.length === 0
														? "暂无协同同事，可在团队页新增"
														: "无匹配同事"}
												</div>
											) : (
												filteredCollabCandidates.map((col) => {
													const inMatter = assignedCollabIds.includes(col.id);
													const canToggle = Boolean(selectedMatterId && onUpdateMatterCollaborators);
													return (
														<div key={col.id} className="wechat-pick-row">
															{canToggle ? (
																<button
																	type="button"
																	className="wechat-pick-main wechat-pick-toggle"
																	aria-pressed={inMatter}
																	aria-label={`邀请 ${col.name} 参与本事项`}
																	onClick={() => {
																		if (!onUpdateMatterCollaborators) return;
																		const nextIds = inMatter
																			? assignedCollabIds.filter((id) => id !== col.id)
																			: [...assignedCollabIds, col.id];
																		onUpdateMatterCollaborators(nextIds);
																	}}
																>
																	<span className={`wechat-check-box ${inMatter ? "checked" : ""}`}>
																		{inMatter ? "✓" : ""}
																	</span>
																	<span className="wechat-mini-avatar human">
																		{col.name.slice(0, 1).toUpperCase()}
																	</span>
																	<span className="wechat-pick-text">
																		<strong>{col.name}</strong>
																		<small>{col.roleTitle}</small>
																	</span>
																</button>
															) : (
																<div className="wechat-pick-main">
																	<span className="wechat-mini-avatar human">
																		{col.name.slice(0, 1).toUpperCase()}
																	</span>
																	<span className="wechat-pick-text">
																		<strong>{col.name}</strong>
																		<small>{col.roleTitle}</small>
																	</span>
																</div>
															)}
															{col.token && (
																<button
																	type="button"
																	className="wechat-copy-link"
																	onClick={() => void copyCollabInvite(col)}
																>
																	复制链接
																</button>
															)}
														</div>
													);
												})
											)}
										</div>

										<div className="wechat-add-group">
											<div className="wechat-add-head">
												<span>可添回的 AI 角色</span>
												{removedAiMembers.length > 0 && (
													<button
														type="button"
														className="btn-inline"
														onClick={() => onUpdateMatterAiMembers(members.map((m) => m.id))}
													>
														全部添回
													</button>
												)}
											</div>
											{removedAiMembers.length === 0 ? (
												<div className="wechat-empty-row">全部 AI 角色已参与当前事项</div>
											) : filteredRemovedAi.length === 0 ? (
												<div className="wechat-empty-row">无匹配 AI 角色</div>
											) : (
												filteredRemovedAi.map((peer) => {
													const theme = getMemberThemeById(members, peer.id);
													return (
														<button
															key={peer.id}
															type="button"
															className="wechat-pick-row clickable"
															onClick={() => onUpdateMatterAiMembers([...matterAiMemberIds, peer.id])}
														>
															<span className="wechat-pick-main">
																<span className="wechat-check-box">+</span>
																<BotFaceIcon bg={theme.bg} tilt={theme.tilt} size="xs" mood="idle" />
																<span className="wechat-pick-text">
																	<strong>{peer.displayName}</strong>
																	<small>{peer.roleTitle}</small>
																</span>
															</span>
														</button>
													);
												})
											)}
										</div>
									</div>
								</>
							) : (
								<>
									<input
										type="search"
										className="wechat-roster-search"
										placeholder="搜索协作成员 / AI"
										value={rosterSearch}
										onChange={(e) => setRosterSearch(e.target.value)}
									/>

									<div className="wechat-member-grid">
										{showOwnerTile && (
											<div className="wechat-member-tile" title={`${ownerLabel} · 所有者`}>
												<div className="wechat-avatar-box owner">
													{ownerLabel.slice(0, 1).toUpperCase()}
												</div>
												<span className="wechat-tile-name">{ownerLabel}</span>
												<span className="wechat-tile-tag">
													所有者{!ownerCollab || currentUser?.id === ownerCollab.id ? " · 我" : ""}
												</span>
											</div>
										)}

										{filteredHumanTiles.map((col) => {
											const canRemoveHuman =
												rosterMode === "remove" &&
												isOwner &&
												Boolean(selectedMatterId && onUpdateMatterCollaborators);
											return (
												<button
													key={`human-${col.id}`}
													type="button"
													className={`wechat-member-tile ${canRemoveHuman || (isOwner && col.token) ? "interactive" : ""}`}
													title={
														canRemoveHuman
															? `移出 ${col.name}`
															: isOwner && col.token
																? `${col.name} · ${col.roleTitle}（点击复制邀请链接）`
																: `${col.name} · ${col.roleTitle}`
													}
													onClick={() => {
														if (canRemoveHuman && onUpdateMatterCollaborators) {
															onUpdateMatterCollaborators(
																assignedCollabIds.filter((id) => id !== col.id),
															);
														} else if (isOwner && col.token) {
															void copyCollabInvite(col);
														}
													}}
												>
													<div className="wechat-avatar-box human">
														{col.name.slice(0, 1).toUpperCase()}
														{canRemoveHuman && <span className="wechat-remove-badge">−</span>}
													</div>
													<span className="wechat-tile-name">{col.name}</span>
													<span className="wechat-tile-tag">
														{currentUser?.id === col.id ? "我" : col.roleTitle}
													</span>
												</button>
											);
										})}

										{filteredAiTiles.map((ai) => {
											const theme = getMemberThemeById(members, ai.id);
											const isLead = ai.id === leadAi?.id;
											const canRemoveAi = rosterMode === "remove" && isOwner && !isLead;
											const canPromoteLead = rosterMode === "view" && isOwner && !isLead && !isTurnRunning;
											const tagLabel = isLead
												? "负责人"
												: observersEnabled
													? "旁听"
													: specialistIds.includes(ai.id)
														? "协同"
														: "协作成员";
											const tagClass = isLead ? "lead" : observersEnabled ? "observer" : "";
											return (
												<button
													key={`ai-${ai.id}`}
													type="button"
													className={`wechat-member-tile ${canRemoveAi || canPromoteLead ? "interactive" : ""}`}
													title={
														canRemoveAi
															? `移出 ${ai.displayName}`
															: isLead
																? `${ai.displayName} · 当前事项负责人`
																: isTurnRunning
																	? `${ai.displayName}（当前回合执行中，完成后可切换负责人）`
																	: isOwner
																		? `点击将「${ai.displayName}」设为当前事项负责人`
																		: `${ai.displayName} · ${tagLabel}`
													}
													onClick={() => {
														if (canRemoveAi) {
															onUpdateMatterAiMembers(
																inGroupAiMembers.map((m) => m.id).filter((id) => id !== ai.id),
															);
														} else if (canPromoteLead) {
															onChangeLeadMember(ai.id);
														}
													}}
												>
													<div className={`wechat-avatar-box ai ${isLead ? "is-lead" : ""}`}>
														<BotFaceIcon bg={theme.bg} tilt={theme.tilt} size="md" mood="idle" />
														{canRemoveAi && <span className="wechat-remove-badge">−</span>}
													</div>
													<span className="wechat-tile-name">{ai.displayName}</span>
													<span className={`wechat-tile-tag ${tagClass}`}>{tagLabel}</span>
												</button>
											);
										})}

										{isOwner && !query && (
											<button
												type="button"
												className="wechat-member-tile interactive"
												title="邀请同事或添回已移出的 AI 角色"
												onClick={() => {
													setRosterSearch("");
													setRosterMode("add");
												}}
											>
												<div className="wechat-avatar-box action">+</div>
												<span className="wechat-tile-name">添加</span>
											</button>
										)}

										{isOwner && !query && hasRemovable && (
											<button
												type="button"
												className="wechat-member-tile interactive"
												title={rosterMode === "remove" ? "完成移出" : "移出协同同事或非负责人 AI"}
												onClick={() => setRosterMode((mode) => (mode === "remove" ? "view" : "remove"))}
											>
												<div
													className={`wechat-avatar-box action ${rosterMode === "remove" ? "active" : ""}`}
												>
													−
												</div>
												<span className="wechat-tile-name">
													{rosterMode === "remove" ? "完成" : "移出"}
												</span>
											</button>
										)}
									</div>

									<div className="wechat-roster-rows">
										<div className="wechat-roster-row">
											<span>事项负责人</span>
											{isOwner ? (
												<select
													className="wechat-row-select"
													aria-label="事项负责人"
													value={leadAi?.id ?? ""}
													disabled={isTurnRunning}
													title={
														isTurnRunning ? "当前回合执行中，完成后可更换负责人" : "切换当前事项负责人"
													}
													onChange={(e) => onChangeLeadMember(e.target.value)}
												>
													{inGroupAiMembers.map((ai) => (
														<option key={ai.id} value={ai.id}>
															{ai.displayName}
														</option>
													))}
												</select>
											) : (
												<span className="wechat-row-val">{leadAi?.displayName ?? "默认"}</span>
											)}
										</div>
										<div className="wechat-roster-row">
											<span>
												AI 旁听
												{observersEnabled && observerAis.length > 0 && (
													<small className="wechat-row-sub">（{observerAis.length} 位）</small>
												)}
											</span>
											{isOwner ? (
												<button
													type="button"
													role="switch"
													aria-checked={observersEnabled}
													aria-label="开启或关闭事项 AI 旁听"
													className={`wechat-switch ${observersEnabled ? "on" : ""}`}
													title={
														observersEnabled
															? "开启中：本事项内非负责人 AI 将自动旁听补充"
															: "已关闭：仅当前事项负责人跟进答复"
													}
													onClick={() => onToggleObserversEnabled(!observersEnabled)}
												>
													<span className="wechat-switch-thumb" />
												</button>
											) : (
												<span className="wechat-row-val">
													{observersEnabled ? `已开启（${observerAis.length} 位）` : "未开启"}
												</span>
											)}
										</div>
										{isOwner ? (
											<div className="wechat-roster-row">
												<span>团队同事</span>
												<button
													type="button"
													className="wechat-row-action"
													onClick={() => {
														if (nonOwnerCollaborators.length > 0) {
															setRosterSearch("");
															setRosterMode("add");
														} else {
															closeRoster();
															onOpenTeam();
														}
													}}
												>
													{nonOwnerCollaborators.length > 0
														? `${matterHumanParticipants.length}/${nonOwnerCollaborators.length} 人`
														: "去团队页新增"}{" "}
													›
												</button>
											</div>
										) : (
											<div className="wechat-roster-row">
												<span>协同权限</span>
												<span className="wechat-row-val">AI 执行需所有者确认</span>
											</div>
										)}
									</div>
								</>
							)}
						</div>
					);
				})()}

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
									organizations={organizations}
									memberName={memberName}
									workspaceName={workspaceName}
									organizationName={organizationName}
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

			<div
				ref={chatScrollRef}
				className="chat-stream-scroll"
				onScroll={(e) => {
					if (!activeLoadedId || lastScrolledMatterIdRef.current !== activeLoadedId) return;
					const el = e.currentTarget;
					const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 100;
					chatScrollMemory.set(activeLoadedId, { scrollTop: el.scrollTop, atBottom });
				}}
			>
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
						</div>
					) : (
						<>
							{matterDetail?.userMessages.map((msg) => {
								const isUser = msg.senderType === "user";
								const isSystem = msg.senderType === "system";
								const isObserverIntervention = msg.metadata?.observerIntervention === true;
								const msgMode =
									isUser && typeof msg.metadata?.mode === "string" ? msg.metadata.mode : "dispatch";
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
										{(() => {
											const userImages = isUser ? parseMessageImages(msg.metadata) : [];
											const bubbleModeClass = isUser
												? isDiscussion
													? " discussion"
													: isAiRequest
														? " ai-request"
														: " dispatch"
												: "";
											return (
												<div
													className={`stream-bubble ${isUser ? "user" : isSystem ? "system" : "member"}${bubbleModeClass}${isObserverIntervention ? " observer" : ""}`}
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
																					setLightboxImage({
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
															{isAiRequest &&
																aiRequestStatus === "pending" &&
																isOwner &&
																matterDetail && (
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
																			onClick={() =>
																				onApproveAiRequest?.(matterDetail.matter.id, msg.id)
																			}
																		>
																			确认并派发 AI
																		</button>
																		<button
																			type="button"
																			className="btn-pill-outline btn-xs"
																			onClick={() =>
																				onDismissAiRequest?.(matterDetail.matter.id, msg.id)
																			}
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
											);
										})()}
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
									{!isOwner ? (
										<p className="muted-hint" style={{ margin: "6px 0 0" }}>
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
				<section
					ref={composerDockRef}
					aria-label="消息与图片输入区"
					className={`composer-dock-inner${dragOverComposer ? " drag-over" : ""}`}
					onDragEnter={handleComposerDragEnter}
					onDragOver={handleComposerDragOver}
					onDragLeave={handleComposerDragLeave}
					onDrop={handleComposerDrop}
				>
					{dragOverComposer && (
						<div className="composer-drop-overlay" aria-hidden="true">
							<strong>松开即可添加图片附件</strong>
							<span>支持 PNG / JPG / WebP / GIF（最多 {MAX_COMPOSER_IMAGES} 张）</span>
						</div>
					)}
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
											if (task.memberId) onChangeLeadMember(task.memberId);
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

					<div className="composer-mode-bar">
						<div className="composer-mode-tabs" role="tablist" aria-label="发言模式切换">
							<button
								type="button"
								role="tab"
								aria-selected={composerMode === "discussion"}
								className={`composer-mode-tab discussion ${composerMode === "discussion" ? "active" : ""}`}
								onClick={() => onComposerModeChange("discussion")}
							>
								团队聊天讨论
							</button>
							<button
								type="button"
								role="tab"
								aria-selected={composerMode === "dispatch"}
								className={`composer-mode-tab dispatch ${composerMode === "dispatch" ? "active" : ""}`}
								onClick={() => onComposerModeChange("dispatch")}
							>
								{isOwner ? "给 AI 安排事项" : "提请 AI 处理"}
							</button>
						</div>
						<span className="composer-mode-hint">
							{composerMode === "discussion"
								? "成员间自由同步想法，不触发 AI 执行（下次派发 AI 时会自动参考这段讨论）"
								: isOwner
									? "正式指派 AI 团队分析、修改并生成交付成果"
									: "发送 AI 提请卡片，待团队所有者一键确认后派发执行"}
						</span>
					</div>

					<div className="composer-meta-bar">
						<select
							className="select-pill"
							aria-label="所属组织"
							value={effectiveOrgId ?? ""}
							disabled={isTurnRunning || !isOwner}
							title={
								!isOwner
									? "仅团队所有者可切换组织"
									: isTurnRunning
										? "当前回合正在执行，请先停止后再切换组织"
										: "选择本次事项所属组织"
							}
							onChange={(e) => onSelectOrganization(e.target.value)}
						>
							{organizations.map((org) => (
								<option key={org.id} value={org.id}>
									组织：{org.name}
									{org.isDefault ? "（默认）" : ""}
								</option>
							))}
							<option value="">不归属组织</option>
						</select>
						<select
							className="select-pill"
							aria-label="项目仓库"
							value={selectedWorkspaceId}
							disabled={isTurnRunning || !isOwner}
							title={
								!isOwner
									? "仅团队所有者可切换项目仓库"
									: isTurnRunning
										? "当前回合正在执行，请先停止后再切换仓库"
										: undefined
							}
							onChange={(e) => onSelectWorkspace(e.target.value)}
						>
							<option value="">
								{effectiveOrgId && orgFilteredWorkspaces.length === 0
									? "不绑定仓库（该组织暂无仓库）"
									: "不绑定仓库"}
							</option>
							{orgFilteredWorkspaces.map((ws) => (
								<option key={ws.id} value={ws.id}>
									仓库：{ws.name}
								</option>
							))}
						</select>
						{selectedMatterId && (
							<button type="button" className="select-pill action" onClick={onNewMatter}>
								+ 切到新事项
							</button>
						)}
					</div>

					{pendingImages.length > 0 && (
						<ul className="composer-image-strip" aria-label="待发送图片">
							{pendingImages.map((img) => (
								<li key={img.id} className="composer-image-chip" title={img.name}>
									<button
										type="button"
										className="composer-image-preview"
										onClick={() => setLightboxImage({ src: img.previewUrl, alt: img.name })}
										aria-label={`预览图片 ${img.name}`}
									>
										<img src={img.previewUrl} alt={img.name} />
									</button>
									<button
										type="button"
										className="composer-image-remove"
										onClick={() => onRemoveImage(img.id)}
										aria-label={`移除图片 ${img.name}`}
										title="移除图片"
									>
										×
									</button>
								</li>
							))}
							<li className="composer-image-hint">
								已选 {pendingImages.length}/{MAX_COMPOSER_IMAGES} 张 · 可继续拖拽或粘贴图片
							</li>
						</ul>
					)}

					<div className="pill-composer">
						<input
							ref={fileInputRef}
							type="file"
							accept="image/png,image/jpeg,image/webp,image/gif"
							multiple
							hidden
							onChange={(e) => {
								if (e.target.files?.length) {
									onAddImages(e.target.files);
									composerRef.current?.focus();
								}
								e.target.value = "";
							}}
						/>
						<button
							type="button"
							aria-expanded={starterMenuOpen}
							className="pill-plus-btn"
							aria-label="插入示范任务"
							title="插入示范任务"
							onClick={() => {
								closeRoster();
								setStarterMenuOpen((v) => !v);
							}}
						>
							+
						</button>
						<button
							type="button"
							className="pill-upload-btn"
							aria-label="上传图片"
							title="上传图片（也可直接拖拽或 Ctrl/Cmd+V 粘贴图片）"
							disabled={submitting || pendingImages.length >= MAX_COMPOSER_IMAGES}
							onClick={() => fileInputRef.current?.click()}
						>
							<svg
								width="16"
								height="16"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.9"
								strokeLinecap="round"
								strokeLinejoin="round"
								aria-hidden="true"
							>
								<rect x="3" y="4" width="18" height="16" rx="2.5" />
								<circle cx="8.5" cy="9.5" r="1.5" />
								<path d="m21 15-4.5-4.5a1.5 1.5 0 0 0-2.1 0L6 19" />
							</svg>
						</button>
						<textarea
							ref={composerRef}
							rows={1}
							className="pill-textarea"
							value={composerText}
							onChange={(e) => onComposerTextChange(e.target.value)}
							onKeyDown={handleComposerKeyDown}
							onPaste={handleComposerPaste}
							placeholder={
								composerMode === "discussion"
									? "和团队成员同步想法、附带截图讨论（不触发 AI 执行，Enter 发送）..."
									: !isOwner
										? "写下希望 AI 协助处理的内容，提交后由团队所有者一键确认并派发..."
										: isTurnRunning
											? "当前 AI 回合仍在推进，可切到「团队聊天讨论」或等待完成后继续..."
											: selectedMatterId
												? "继续给 AI 团队安排工作、拖拽或粘贴图片，或提出修改（Enter 发送）..."
												: "向你的 AI 团队布置任务，支持上传/拖拽/粘贴图片（Enter 发送）..."
							}
						/>
						{activeMatterProgress && selectedMatterId && isOwner && (
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
							className={`pill-send-btn pill-send-labeled ${composerMode === "discussion" ? "discussion" : isOwner ? "dispatch" : "ai-request"}`}
							aria-label={composerMode === "discussion" ? "发送讨论" : isOwner ? "派发 AI" : "提请 AI"}
							disabled={sendBlockedByTurn || submitting || (!composerText.trim() && pendingImages.length === 0)}
							onClick={onSendPrompt}
						>
							{submitting
								? "发送中..."
								: composerMode === "discussion"
									? "发讨论"
									: isOwner
										? "派发 AI"
										: "提请 AI"}
						</button>
					</div>
				</section>
			</div>

			{lightboxImage && (
				<div className="image-lightbox-backdrop">
					<button
						type="button"
						className="image-lightbox-scrim"
						aria-label="关闭预览"
						onClick={() => setLightboxImage(null)}
					/>
					<div className="image-lightbox-dialog" role="dialog" aria-modal="true" aria-label="图片预览">
						<img src={lightboxImage.src} alt={lightboxImage.alt} />
						<div className="image-lightbox-footer">
							<span>{lightboxImage.alt}</span>
							<button type="button" className="btn-inline" onClick={() => setLightboxImage(null)}>
								关闭
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
