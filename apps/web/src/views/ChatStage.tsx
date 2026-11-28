import { isCurrentHumanDecision, readHumanDecision } from "@pa/contracts/human-decision";
import { readNextStepsFromMetadata } from "@pa/contracts/next-steps";
import { hasRoleProposalActions } from "@pa/contracts/role-proposal-state";
import type { ReactNode } from "react";
import { type ComponentProps, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	AccountUserDto,
	ApplyMatterRoleProposalsPayload,
	CollaboratorDto,
	MatterCollaborationMode,
	MatterDetailPayload,
	MatterEventType,
	MatterProgressDto,
	OrganizationDto,
	OrganizationMemberDto,
	PendingDialogDto,
	RoleTemplateDto,
	TeamMemberDto,
	WorkspaceDto,
} from "../api.ts";
import { filterBusinessMembers } from "../architectApi.ts";
import { AttachmentPreviewModals, useAttachmentPreview } from "../components/chat/AttachmentPreviewModals.tsx";
import { ChatStageHeader } from "../components/chat/ChatStageHeader.tsx";
import { ComposerDock } from "../components/chat/ComposerDock.tsx";
import { FloatingClarificationDock } from "../components/chat/FloatingClarificationDock.tsx";
import { type BoardPaneTab, MatterBoardPane } from "../components/chat/MatterBoardPane.tsx";
import { MatterCollabDrawer, type MatterCollabTab } from "../components/chat/MatterCollabDrawer.tsx";
import {
	type DelegationScope,
	type DelegationView,
	MatterDelegationPanel,
} from "../components/chat/MatterDelegationPanel.tsx";
import { MatterDocSidePane } from "../components/chat/MatterDocSidePane.tsx";
import { MatterInitiationPanel } from "../components/chat/MatterInitiationPanel.tsx";
import { MatterRosterPopover } from "../components/chat/MatterRosterPopover.tsx";
import { MessageFeed } from "../components/chat/MessageFeed.tsx";
import { useActiveClarification } from "../hooks/useActiveClarification.ts";
import { useChatScroll } from "../hooks/useChatScroll.ts";
import { useChatStageParticipants } from "../hooks/useChatStageParticipants.ts";
import { summarizeBoardStatus, useMatterBoard } from "../hooks/useMatterBoard.ts";
import { useMatterSideDocs } from "../hooks/useMatterSideDocs.ts";
import { Badge, Button } from "../primitives/index.ts";
import { ViewFade } from "../primitives/ViewTransitions.tsx";
import { cn } from "../utils/cn.ts";
import { buildMatterDelegations } from "../utils/matterDelegations.ts";
import { transitionView } from "../viewTransitions.ts";

function collectPendingDecisions(matterDetail: MatterDetailPayload | null): Array<{ id: string; label: string }> {
	if (!matterDetail || matterDetail.matter.status === "archived") return [];
	const items: Array<{ id: string; label: string }> = [];
	const seenRoleProposals = new Set<string>();
	const messages = matterDetail.userMessages;
	for (const [index, message] of messages.entries()) {
		if (message.senderType !== "member") continue;
		const decision = readHumanDecision(message.metadata);
		if (
			decision?.status === "pending" &&
			isCurrentHumanDecision(message, decision, matterDetail.matter, messages.slice(index + 1))
		) {
			items.push({ id: message.id, label: decision.requests[0]?.question ?? "答复澄清" });
		}
	}
	for (const message of messages.toReversed()) {
		if (message.senderType !== "member" || seenRoleProposals.has(message.senderId)) continue;
		const roleProposals = message.metadata?.roleProposals;
		const hasActions = hasRoleProposalActions(roleProposals);
		const hasClarification = readHumanDecision(message.metadata)?.kind === "role_clarification";
		if (!hasActions && !hasClarification) continue;
		seenRoleProposals.add(message.senderId);
		if (
			hasActions &&
			!hasClarification &&
			roleProposals &&
			typeof roleProposals === "object" &&
			"status" in roleProposals &&
			roleProposals.status === "pending" &&
			message.metadata?.orgId === (matterDetail.matter.orgId ?? null) &&
			message.metadata?.workspaceId === matterDetail.matter.workspaceId
		) {
			items.push({ id: message.id, label: "确认角色提案" });
		}
	}
	return items;
}

const BOARD_PILL_BASE_CLASSES =
	"inline-flex items-center gap-1.5 px-2.5 py-1 rounded-pill border text-xs font-semibold cursor-pointer shrink-0 transition-colors hover:border-accent hover:bg-accent-soft hover:text-accent";
const NEXT_STEP_CHIP_BASE_CLASSES =
	"px-2.5 py-1 rounded-pill border bg-stage text-ink text-xs leading-snug cursor-pointer transition-colors hover:border-accent hover:bg-accent-soft disabled:opacity-45 disabled:pointer-events-none";
const BOARD_PILL_TONES: Record<"working" | "blocked" | "idle", string> = {
	working: "border-accent-border bg-surface-accent text-accent",
	blocked: "border-warn-border bg-warn-bg text-warn-text",
	idle: "border-line bg-stage text-ink-secondary",
};
const BOARD_DOT_TONES: Record<"working" | "blocked" | "idle", string> = {
	working: "bg-accent",
	blocked: "bg-warn-text",
	idle: "bg-ink-muted",
};

type ComposerDraftProps = Pick<
	ComponentProps<typeof ComposerDock>,
	| "composerRef"
	| "composerText"
	| "pendingImages"
	| "pendingFiles"
	| "onComposerTextChange"
	| "onAddAttachments"
	| "onAddPastedText"
	| "onRemoveImage"
	| "onRemoveFile"
> & { onExpandPastedFile: (fileId: string) => void };

type MatterInitiationProps = Pick<
	ComponentProps<typeof MatterInitiationPanel>,
	| "draftAiMemberIds"
	| "draftConsultMemberIds"
	| "draftCollaboratorIds"
	| "draftVisibility"
	| "draftCollaborationMode"
	| "assessment"
	| "modelAssessing"
	| "modelAssessmentError"
	| "onUpdateDraftAiMemberIds"
	| "onUpdateDraftCollaboratorIds"
	| "onUpdateDraftVisibility"
	| "onUpdateDraftCollaborationMode"
	| "onSetScopeMode"
	| "onToggleObserverPreset"
	| "onToggleDraftMemberConsult"
	| "onToggleDraftMemberObserver"
	| "onApplyPresetMode"
	| "onApplyRecommendation"
	| "onRequestModelAssessment"
	| "onCancelModelAssessment"
	| "onStartArchitectMatter"
>;

interface ChatStageProps {
	composerDraft: ComposerDraftProps;
	initiation: MatterInitiationProps;
	currentUser?: CollaboratorDto | null;
	accountUser?: AccountUserDto | null;
	isSuperAdmin?: boolean;
	canDispatchAi?: boolean;
	canManageMatter: boolean;
	orgMembersByOrgId?: Record<string, OrganizationMemberDto[]>;
	orgEffectiveMemberIds?: string[] | null;
	selectedWorkspace: WorkspaceDto | null;
	selectedWorkspaceId: string;
	selectedOrgId: string;
	workspaces: WorkspaceDto[];
	organizations: OrganizationDto[];
	members: TeamMemberDto[];
	selectedMemberId: string;
	headerContact: TeamMemberDto | null;
	headerTheme: { bg: string; tilt: string };
	selectedMatterId: string | null;
	matterDetail: MatterDetailPayload | null;
	activeDialogs: PendingDialogDto[];
	activeMatterProgress: MatterProgressDto | null;
	progressStartedAt: number | null;
	streamingDelta: string;
	submitting: boolean;
	templateByRoleId: Map<string, RoleTemplateDto>;
	memberName: (id: string) => string;
	onSelectOrganization: (orgId: string) => void;
	onSelectWorkspace: (workspaceId: string) => void;
	matterAiMemberIds: string[];
	matterConsultMemberIds?: string[] | null;
	observerMemberIds: string[];
	observersEnabled: boolean;
	onChangeLeadMember: (memberId: string) => void;
	onUpdateMatterAiMembers: (aiMemberIds: string[]) => void;
	onUpdateMatterConsultMembers?: (consultMemberIds: string[] | null) => void;
	onToggleObserversEnabled?: (enabled: boolean) => void;
	onUpdateMatterObservers: (observerIds: string[]) => void;
	onUpdateMatterCollaborators?: (collaboratorIds: string[]) => void;
	onUpdateCollaborationMode?: (mode: MatterCollaborationMode, coordinatorMemberId?: string | null) => void;
	onToggleArchiveMatter?: (matterId: string, archived: boolean) => void;
	onApproveAiRequest?: (matterId: string, messageId: string) => void;
	onDismissAiRequest?: (matterId: string, messageId: string) => void;
	onApplyRoleProposals?: (
		matterId: string,
		messageId: string,
		payload: ApplyMatterRoleProposalsPayload,
	) => Promise<void>;
	onDismissRoleProposals?: (matterId: string, messageId: string) => Promise<void>;
	onSendQuickPrompt?: (prompt: string, options?: { preferredMemberId?: string }) => Promise<boolean>;
	onConsultArchitect?: () => void;
	onLaunchWithNewRoles?: (memberIds: string[]) => void;
	modelControl?: ReactNode;
	onSendPrompt: () => void;
	onAbortMatter: (matterId: string) => void;
	onNewMatter: () => void;
	onOpenDeliverables: (deliverableId?: string) => void;
	onOpenTeam: () => void;
	onOpenSkillTrust?: () => void;
	onRefresh: () => Promise<void>;
	onNotice: (message: string) => void;
}

/** Coordinates the active matter workspace: header bar, participant/collab popovers, scrollable stream, and composer. */
export function ChatStage(props: ChatStageProps) {
	const {
		composerDraft,
		initiation,
		currentUser,
		accountUser = null,
		isSuperAdmin = false,
		canDispatchAi,
		canManageMatter,
		orgMembersByOrgId = {},
		orgEffectiveMemberIds = null,
		selectedWorkspace,
		selectedWorkspaceId,
		selectedOrgId,
		workspaces,
		organizations,
		members,
		selectedMemberId,
		headerContact,
		selectedMatterId,
		matterDetail,
		activeMatterProgress,
		templateByRoleId,
		memberName,
		matterAiMemberIds,
		observerMemberIds,
		observersEnabled,
		onChangeLeadMember,
		onUpdateMatterObservers,
		onSendQuickPrompt,
		onOpenDeliverables,
		onRefresh,
	} = props;
	const { onExpandPastedFile, ...dockDraft } = composerDraft;
	const { composerText, pendingFiles } = dockDraft;
	const [collabMatterId, setCollabMatterId] = useState<string | null>(null);
	const collabOpen = collabMatterId !== null && collabMatterId === selectedMatterId;
	const [collabTab, setCollabTab] = useState<MatterCollabTab>("delegations");
	const [delegationScope, setDelegationScope] = useState<DelegationScope>("latest");
	const [delegationView, setDelegationView] = useState<DelegationView>("board");
	const [rosterOpen, setRosterOpen] = useState(false);
	const [rosterMode, setRosterMode] = useState<"view" | "add" | "remove">("view");
	const [rosterSearch, setRosterSearch] = useState("");
	const [moreMenuOpen, setMoreMenuOpen] = useState(false);
	const [boardPaneOpen, setBoardPaneOpen] = useState(false);
	const [boardPaneTab, setBoardPaneTab] = useState<BoardPaneTab>("members");
	const [boardEventAgentId, setBoardEventAgentId] = useState("");
	const [boardEventType, setBoardEventType] = useState<MatterEventType | "all">("all");
	const handleSideDocOpened = useCallback(() => {
		setCollabMatterId(null);
		setBoardPaneOpen(false);
		collabTriggerRef.current = null;
	}, []);
	const sideDocs = useMatterSideDocs({
		selectedMatterId,
		matterDetail,
		onOpened: handleSideDocOpened,
	});

	useEffect(() => {
		setBoardPaneOpen(false);
		setBoardPaneTab("members");
		setBoardEventAgentId("");
		setBoardEventType("all");
	}, [selectedMatterId]);

	const matterCollaborationMode: MatterCollaborationMode = matterDetail?.matter.collaborationMode ?? "lead";
	const board = useMatterBoard({
		matterId: selectedMatterId,
		collaborationMode: matterCollaborationMode,
		paneOpen: boardPaneOpen,
		eventsTabActive: boardPaneOpen && boardPaneTab === "events",
		eventFilterAgentId: boardEventAgentId,
		eventFilterType: boardEventType,
	});
	const boardStatus = useMemo(
		() => summarizeBoardStatus(board.snapshot?.members ?? [], board.snapshot?.posts.length ?? 0),
		[board.snapshot],
	);
	const hasBoardActivity =
		matterCollaborationMode === "board" ||
		(board.snapshot?.members.length ?? 0) > 0 ||
		(board.snapshot?.posts.length ?? 0) > 0;
	const showBoardPane = Boolean(boardPaneOpen && selectedMatterId && matterDetail && !sideDocs.activeDocId);
	const toggleBoardPane = useCallback(
		(targetTab?: BoardPaneTab) => {
			if (targetTab) {
				sideDocs.closePane();
				setCollabMatterId(null);
				setBoardPaneTab(targetTab);
				setBoardPaneOpen(true);
				return;
			}
			setBoardPaneOpen((open) => {
				const next = !open;
				if (next) {
					sideDocs.closePane();
					setCollabMatterId(null);
				}
				return next;
			});
		},
		[sideDocs],
	);

	const moreMenuWrapRef = useRef<HTMLDivElement | null>(null);
	const collabPanelRef = useRef<HTMLDivElement | null>(null);
	const collabTriggerRef = useRef<HTMLElement | null>(null);
	const composerDockRef = useRef<HTMLDivElement | null>(null);
	const rosterPanelRef = useRef<HTMLDivElement | null>(null);
	const headerHumansBtnRef = useRef<HTMLButtonElement | null>(null);

	const { lightboxImage, setLightboxImage, previewFile, openFilePreview, closeFilePreview } = useAttachmentPreview();
	const isOwner = canDispatchAi ?? currentUser?.permissionRole !== "collaborator";

	const resetRoster = useCallback((open: boolean) => {
		setRosterOpen(open);
		setRosterMode("view");
		setRosterSearch("");
	}, []);
	const closeRoster = () => transitionView("panel", () => resetRoster(false));
	const closeCollab = useCallback(() => {
		setCollabMatterId(null);
		const trigger = collabTriggerRef.current;
		collabTriggerRef.current = null;
		if (trigger) requestAnimationFrame(() => trigger.focus({ preventScroll: true }));
	}, []);
	const openCollab = (
		tab: MatterCollabTab,
		trigger: Element | null,
		scope: DelegationScope = "latest",
		view: DelegationView = "board",
	) => {
		if (!selectedMatterId) return;
		if (trigger instanceof HTMLElement && !collabPanelRef.current?.contains(trigger)) {
			collabTriggerRef.current = trigger;
		}
		transitionView("panel", () => {
			if (tab === "delegations") {
				setDelegationScope(scope);
				setDelegationView(view);
			}
			setCollabTab(tab);
			setCollabMatterId(selectedMatterId);
			collabPanelRef.current?.focus({ preventScroll: true });
		});
	};

	const openDelegations = (scope: DelegationScope, view: DelegationView = "board") =>
		openCollab("delegations", document.activeElement, scope, view);
	const toggleMorePanel = (tab: Exclude<MatterCollabTab, "events">) => {
		setMoreMenuOpen(false);
		if (collabOpen && (collabTab === tab || (tab === "delegations" && collabTab === "events"))) {
			transitionView("panel", closeCollab);
		} else {
			openCollab(tab, moreMenuWrapRef.current?.querySelector("button") ?? null);
		}
	};

	useEffect(() => {
		if (!collabOpen && !rosterOpen && !moreMenuOpen) return;
		const onMouseDown = (event: MouseEvent) => {
			const target = event.target as Node | null;
			if (!target) return;
			if (
				collabOpen &&
				!collabPanelRef.current?.contains(target) &&
				!moreMenuWrapRef.current?.contains(target) &&
				!(target instanceof Element && target.closest("[data-open-delegations]"))
			) {
				transitionView("panel", () => {
					setCollabMatterId(null);
					collabTriggerRef.current = null;
				});
			}
			if (rosterOpen && !rosterPanelRef.current?.contains(target) && !headerHumansBtnRef.current?.contains(target)) {
				transitionView("panel", () => resetRoster(false));
			}
			if (moreMenuOpen && !moreMenuWrapRef.current?.contains(target)) {
				setMoreMenuOpen(false);
			}
		};
		const onKeyDown = (event: globalThis.KeyboardEvent) => {
			if (event.key === "Escape") {
				setMoreMenuOpen(false);
				transitionView("panel", () => {
					closeCollab();
					resetRoster(false);
				});
			}
		};
		document.addEventListener("mousedown", onMouseDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("mousedown", onMouseDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [closeCollab, collabOpen, rosterOpen, moreMenuOpen, resetRoster]);

	const isTurnRunning = Boolean(selectedMatterId && activeMatterProgress);
	const loadedMatterId = matterDetail?.matter.id ?? null;
	const activeLoadedId = selectedMatterId && loadedMatterId === selectedMatterId ? loadedMatterId : null;
	const messageCount = matterDetail?.userMessages.length ?? 0;
	const streamLen = props.streamingDelta.length;

	const { chatScrollRef, chatStreamInnerRef, messagesEndRef, handleStreamScroll } = useChatScroll({
		activeLoadedId,
		messageCount,
		streamLen,
	});

	const delegationMessages = matterDetail?.internalCollabMessages;
	const conversationMessages = matterDetail?.userMessages;
	const activeTurnId = activeMatterProgress?.sourceUserMessageId;
	const delegations = useMemo(
		() => buildMatterDelegations(conversationMessages ?? [], delegationMessages ?? [], activeTurnId),
		[conversationMessages, delegationMessages, activeTurnId],
	);

	const {
		effectiveOrgId,
		selectedOrganization,
		orgFilteredWorkspaces,
		orgMembers,
		scopedMembers,
		ownerCollab,
		humanPeerCandidates,
		assignedCollabIds,
		matterHumanParticipants,
		allActiveHumans,
		leadAi,
		inGroupAiMembers,
		nonLeadGroupAiMembers,
		removedAiMembers,
		observerAis,
		isArchitectMode,
		businessCount,
	} = useChatStageParticipants({
		isSuperAdmin,
		currentUser,
		orgMembersByOrgId,
		orgEffectiveMemberIds,
		selectedWorkspace,
		selectedOrgId,
		workspaces,
		organizations,
		members,
		selectedMemberId,
		headerContact,
		selectedMatterId,
		matterDetail,
		templateByRoleId,
		matterAiMemberIds,
		observerMemberIds,
		observersEnabled,
		draftCollaboratorIds: initiation.draftCollaboratorIds,
	});

	const decisionAssignees = matterDetail
		? (orgMembersByOrgId[matterDetail.matter.orgId ?? ""] ?? []).filter(
				({ userId, orgRole, userStatus }) =>
					orgRole !== "org_viewer" &&
					(!userStatus || userStatus === "active") &&
					(userId === matterDetail.matter.createdByUserId ||
						matterDetail.matter.collaboratorIds?.includes(userId)),
			)
		: [];
	const pendingDecisions = collectPendingDecisions(matterDetail);

	const activeFloatingClarification = useActiveClarification({
		matterDetail,
		organizations,
		isSuperAdmin,
		accountUser,
		canManageMatter,
		currentUser,
		memberName,
	});

	const isNewMatter = !selectedMatterId && !isArchitectMode;
	const latestBoardPost = board.snapshot?.posts.at(-1);
	const stageClass = cn(
		"relative flex-1 min-h-0",
		sideDocs.activeDocId
			? "grid grid-cols-1 min-[960px]:grid-cols-[minmax(380px,1fr)_minmax(360px,1fr)] h-full overflow-hidden"
			: showBoardPane
				? "grid grid-cols-1 min-[960px]:grid-cols-[minmax(380px,1fr)_minmax(380px,460px)] h-full overflow-hidden"
				: isNewMatter
					? "flex flex-col overflow-y-auto pb-10"
					: "flex flex-col",
	);
	const boardPillToneClass = showBoardPane
		? "border-accent bg-accent-soft text-accent"
		: BOARD_PILL_TONES[boardStatus.tone];
	const boardDotToneClass = BOARD_DOT_TONES[boardStatus.tone];
	const isArchived = matterDetail?.matter.status === "archived";
	const nextSteps =
		!activeFloatingClarification && !isTurnRunning && matterDetail?.userMessages.at(-1)?.senderType === "member"
			? readNextStepsFromMetadata(matterDetail.userMessages.at(-1)!.metadata)
			: [];
	const canSwitchBoardMode = Boolean(
		canManageMatter &&
			!isTurnRunning &&
			!isArchitectMode &&
			matterDetail &&
			!isArchived &&
			props.onUpdateCollaborationMode,
	);
	const showBoardStrip = Boolean(
		activeLoadedId && matterDetail && (hasBoardActivity || (canManageMatter && !isArchitectMode && !isArchived)),
	);
	const mentionMembers = [
		...filterBusinessMembers(inGroupAiMembers, templateByRoleId).map(({ id, displayName, roleTitle }) => ({
			id,
			displayName,
			roleTitle,
			kind: "ai" as const,
		})),
		...allActiveHumans
			.filter(
				(person) =>
					person.id !== currentUser?.id &&
					(person.id === matterDetail?.matter.createdByUserId ||
						assignedCollabIds.includes(person.id) ||
						(person.id === ownerCollab?.id &&
							(matterDetail?.matter.visibility ?? initiation.draftVisibility) !== "private")),
			)
			.map(({ id, name }) => ({ id, displayName: name, kind: "human" as const })),
	];

	return (
		<div className={stageClass}>
			<div className={cn("flex flex-col flex-1 min-w-0 min-h-0 relative", isNewMatter ? "h-auto" : "h-full")}>
				<ChatStageHeader
					selectedOrganization={selectedOrganization}
					selectedWorkspace={selectedWorkspace}
					headerTheme={props.headerTheme}
					contactLabel={
						!selectedMatterId && selectedMemberId === "auto"
							? "新事项"
							: (headerContact?.displayName ?? "AI 团队")
					}
					matterDetail={matterDetail}
					isArchitectMode={isArchitectMode}
					isTurnRunning={isTurnRunning}
					activeMatterProgress={activeMatterProgress}
					allActiveHumans={allActiveHumans}
					inGroupAiMembers={inGroupAiMembers}
					totalAiMembersCount={businessCount}
					leadAi={leadAi}
					nonLeadGroupAiMembers={nonLeadGroupAiMembers}
					observerAis={observerAis}
					observersEnabled={observersEnabled}
					rosterOpen={rosterOpen}
					collabOpen={collabOpen}
					collabTab={collabTab}
					moreMenuOpen={moreMenuOpen}
					deliverablesCount={matterDetail?.spaceDocuments?.length ?? 0}
					headerHumansBtnRef={headerHumansBtnRef}
					moreMenuWrapRef={moreMenuWrapRef}
					onToggleRoster={() => {
						transitionView("panel", () => {
							setMoreMenuOpen(false);
							closeCollab();
							resetRoster(!rosterOpen);
						});
					}}
					onToggleMoreMenu={() => {
						closeRoster();
						setMoreMenuOpen((open) => !open);
					}}
					onSelectMorePanel={toggleMorePanel}
				/>

				{showBoardStrip && matterDetail && (
					<section
						className="flex items-center justify-between gap-2.5 px-4 py-1.5 border-b border-line bg-subtle shrink-0 min-h-[38px]"
						aria-label="公告板协作状态"
					>
						<div className="flex items-center gap-2.5 min-w-0 flex-1">
							{hasBoardActivity ? (
								<>
									<button
										type="button"
										className={cn(BOARD_PILL_BASE_CLASSES, boardPillToneClass)}
										aria-expanded={showBoardPane}
										onClick={() => toggleBoardPane()}
									>
										<span
											className={cn("size-2 rounded-full shrink-0", boardDotToneClass)}
											aria-hidden="true"
										/>
										<span>{boardStatus.label}</span>
									</button>
									{latestBoardPost && (
										<button
											type="button"
											className="border-0 bg-transparent px-1 py-0.5 text-xs text-ink-secondary text-left truncate min-w-0 cursor-pointer hover:text-ink hover:underline"
											title="打开公告板查看最新交接"
											onClick={() => toggleBoardPane("board")}
										>
											#{latestBoardPost.postNo} @{latestBoardPost.authorId} · {latestBoardPost.summary}
										</button>
									)}
								</>
							) : (
								<span className="text-xs text-ink-muted truncate">当前为轻量主责模式（Lead）</span>
							)}
						</div>
						<div className="flex items-center gap-2 shrink-0">
							{canSwitchBoardMode && (
								<Button
									variant="inline"
									size="xs"
									title={
										matterCollaborationMode === "board"
											? "保留已有看板交付与结论，切回轻量主责继续追问或微调"
											: "保留当前对话与资料空间文档，升级交由总控动态组建 Builder/Verifier 异步交付"
									}
									onClick={() =>
										props.onUpdateCollaborationMode?.(
											matterCollaborationMode === "board" ? "lead" : "board",
											matterCollaborationMode === "board"
												? null
												: (matterDetail.matter.coordinatorMemberId ??
														matterDetail.matter.leadMemberId ??
														null),
										)
									}
								>
									{matterCollaborationMode === "board" ? "切回轻量主责" : "升级为 Board 团队交付"}
								</Button>
							)}
							{hasBoardActivity && (
								<Button
									variant="secondary"
									size="xs"
									className={cn("rounded-pill", showBoardPane && "border-accent bg-accent-soft text-accent")}
									aria-expanded={showBoardPane}
									onClick={() => toggleBoardPane()}
								>
									{showBoardPane ? "收起看板" : "打开看板"}
								</Button>
							)}
						</div>
					</section>
				)}

				<div className="relative flex-1 min-h-0 flex flex-col">
					{rosterOpen && (
						<ViewFade type="panel">
							<MatterRosterPopover
								panelRef={rosterPanelRef}
								rosterMode={rosterMode}
								rosterSearch={rosterSearch}
								isOwner={isOwner && canManageMatter}
								isTurnRunning={isTurnRunning}
								selectedMatterId={selectedMatterId}
								currentUser={currentUser}
								ownerCollab={ownerCollab}
								nonOwnerCollaborators={humanPeerCandidates}
								matterHumanParticipants={matterHumanParticipants}
								assignedCollabIds={assignedCollabIds}
								members={scopedMembers}
								inGroupAiMembers={inGroupAiMembers}
								nonLeadGroupAiMembers={nonLeadGroupAiMembers}
								removedAiMembers={removedAiMembers}
								leadAi={leadAi}
								observersEnabled={observersEnabled}
								observerAis={observerAis}
								matterAiMemberIds={matterAiMemberIds}
								matterConsultMemberIds={props.matterConsultMemberIds ?? null}
								onSearchChange={setRosterSearch}
								onModeChange={setRosterMode}
								onClose={closeRoster}
								onOpenTeam={props.onOpenTeam}
								onChangeLeadMember={onChangeLeadMember}
								onUpdateMatterAiMembers={props.onUpdateMatterAiMembers}
								onUpdateMatterConsultMembers={props.onUpdateMatterConsultMembers}
								onToggleObserversEnabled={props.onToggleObserversEnabled}
								onUpdateMatterObservers={onUpdateMatterObservers}
								onUpdateMatterCollaborators={props.onUpdateMatterCollaborators}
								onConsultArchitect={props.onConsultArchitect}
							/>
						</ViewFade>
					)}

					{collabOpen && activeLoadedId && matterDetail && (
						<ViewFade type="panel">
							<MatterCollabDrawer
								panelRef={collabPanelRef}
								collabTab={collabTab}
								matterDetail={matterDetail}
								onOpenDeliverable={(targetId) => {
									if (targetId && (targetId.startsWith("doc_") || targetId.startsWith("page_"))) {
										sideDocs.openDoc(targetId);
									} else {
										onOpenDeliverables(targetId);
									}
								}}
								delegationPanel={
									<MatterDelegationPanel
										delegations={delegations}
										messages={matterDetail.userMessages}
										progress={activeMatterProgress}
										scope={delegationScope}
										view={delegationView}
										memberName={memberName}
										onSelectScope={setDelegationScope}
										onSelectView={setDelegationView}
										onLocateTurn={(id) => {
											setCollabMatterId(null);
											collabTriggerRef.current = null;
											requestAnimationFrame(() => {
												const message = document.getElementById(`matter-message-${id}`);
												message?.focus({ preventScroll: true });
												message?.scrollIntoView({ block: "center" });
											});
										}}
									/>
								}
								memberName={memberName}
								onSelectTab={setCollabTab}
								onClose={() => transitionView("panel", closeCollab)}
							/>
						</ViewFade>
					)}

					{pendingDecisions.length > 0 && (
						<details className="px-4 py-1 border-b border-line bg-stage" key={selectedMatterId}>
							<summary className="cursor-pointer w-fit py-1 text-sm font-semibold text-ink">
								待人类决定 · {pendingDecisions.length}
							</summary>
							<ul className="list-none p-0 m-0 mb-1.5 max-h-40 overflow-y-auto">
								{pendingDecisions.map(({ id, label }) => (
									<li key={id}>
										<Button
											variant="inline"
											size="xs"
											className="text-left"
											onClick={() => {
												const target = document.getElementById(`matter-message-${id}`);
												target?.focus({ preventScroll: true });
												target?.scrollIntoView({ block: "start" });
											}}
										>
											{label}
										</Button>
									</li>
								))}
							</ul>
						</details>
					)}

					<MessageFeed
						chatScrollRef={chatScrollRef}
						chatStreamInnerRef={chatStreamInnerRef}
						messagesEndRef={messagesEndRef}
						onScroll={handleStreamScroll}
						selectedMatterId={selectedMatterId}
						selectedMemberId={selectedMemberId}
						headerContact={headerContact}
						headerTheme={props.headerTheme}
						selectedOrganization={selectedOrganization}
						selectedWorkspace={selectedWorkspace}
						templateByRoleId={templateByRoleId}
						matterDetail={matterDetail}
						activeMatterProgress={activeMatterProgress}
						activeDialogs={props.activeDialogs}
						floatingClarificationMessageId={activeFloatingClarification?.messageId ?? null}
						progressStartedAt={props.progressStartedAt}
						streamingDelta={props.streamingDelta}
						isNewMatter={isNewMatter}
						isOwner={isOwner}
						canManageMatter={canManageMatter}
						decisionAssignees={decisionAssignees}
						isSuperAdmin={isSuperAdmin}
						accountUser={accountUser}
						currentUser={currentUser}
						organizations={organizations}
						isTurnRunning={isTurnRunning}
						members={members}
						memberName={memberName}
						delegations={delegations}
						onOpenDelegations={openDelegations}
						onOpenLightbox={setLightboxImage}
						onPreviewFile={openFilePreview}
						onOpenDeliverables={onOpenDeliverables}
						onOpenSideDoc={sideDocs.openDoc}
						onApproveAiRequest={isArchived ? undefined : props.onApproveAiRequest}
						onDismissAiRequest={isArchived ? undefined : props.onDismissAiRequest}
						onApplyRoleProposals={isArchived ? undefined : props.onApplyRoleProposals}
						onDismissRoleProposals={isArchived ? undefined : props.onDismissRoleProposals}
						onSendQuickPrompt={isArchived ? undefined : onSendQuickPrompt}
						onFillComposer={(text) => {
							dockDraft.onComposerTextChange(text);
							dockDraft.composerRef.current?.focus();
						}}
						onLaunchWithNewRoles={props.onLaunchWithNewRoles}
						onSkillProposalDone={() => void onRefresh()}
						onOpenSkillTrust={props.onOpenSkillTrust}
						onNotice={props.onNotice}
						onAbortMatter={props.onAbortMatter}
					/>

					{isArchived && matterDetail ? (
						<div className="w-[min(760px,calc(100%-32px))] mx-auto mb-4 px-4 py-3 border border-line rounded-lg bg-subtle flex items-center justify-between gap-3 flex-wrap shrink-0">
							<div className="inline-flex items-center gap-2.5 text-xs text-ink-secondary">
								<Badge tone="neutral" size="sm">
									已归档
								</Badge>
								<span>该事项已归档，当前为只读状态，不能继续发送消息。</span>
							</div>
							<div className="inline-flex items-center gap-2 shrink-0">
								{props.onToggleArchiveMatter && (
									<Button
										variant="primary"
										size="xs"
										className="rounded-pill"
										onClick={() => props.onToggleArchiveMatter?.(matterDetail.matter.id, false)}
									>
										恢复事项
									</Button>
								)}
								<Button variant="secondary" size="xs" className="rounded-pill" onClick={props.onNewMatter}>
									+ 新建事项
								</Button>
							</div>
						</div>
					) : (
						<>
							{activeFloatingClarification && matterDetail && (
								<FloatingClarificationDock
									key={`${activeFloatingClarification.messageId}:${activeFloatingClarification.decision.revision}`}
									matter={matterDetail.matter}
									messageId={activeFloatingClarification.messageId}
									decision={activeFloatingClarification.decision}
									requestedBy={activeFloatingClarification.requestedBy}
									isRunning={isTurnRunning}
									onAnswered={() => void onRefresh()}
								/>
							)}

							{nextSteps.length > 0 && (
								<section
									className="flex items-center gap-2 flex-wrap max-w-[820px] w-full mx-auto mb-2 px-3"
									aria-label="建议的下一步"
								>
									<span className="text-micro font-semibold text-ink-muted whitespace-nowrap">下一步</span>
									<div className="flex items-center gap-1.5 flex-wrap">
										{nextSteps.map((item) => (
											<button
												key={item.prompt}
												type="button"
												className={cn(
													NEXT_STEP_CHIP_BASE_CLASSES,
													item.kind === "capture"
														? "border-success-border"
														: item.kind === "verify"
															? "border-observer-border"
															: "border-line",
												)}
												title={`${item.prompt}\n（点击直接发送，Shift+点击填入输入框编辑）`}
												disabled={props.submitting}
												onClick={(ev) => {
													if (ev.shiftKey || !onSendQuickPrompt) {
														dockDraft.onComposerTextChange(item.prompt);
														dockDraft.composerRef.current?.focus();
														return;
													}
													void onSendQuickPrompt(item.prompt);
												}}
											>
												{item.label}
											</button>
										))}
									</div>
								</section>
							)}

							<ComposerDock
								{...dockDraft}
								modelControl={props.modelControl}
								initiationPanel={
									!selectedMatterId ? (
										<MatterInitiationPanel
											{...initiation}
											isOwner={isOwner}
											observersEnabled={observersEnabled}
											hasWorkspace={Boolean(selectedWorkspaceId)}
											hasPromptText={Boolean(
												composerText.trim() || pendingFiles.some((file) => file.content.trim()),
											)}
											members={scopedMembers}
											orgMembers={orgMembers}
											initiatorId={accountUser?.id ?? currentUser?.id}
											initiatorName={accountUser?.displayName ?? currentUser?.name}
											templateByRoleId={templateByRoleId}
											selectedMemberId={selectedMemberId}
											draftObserverMemberIds={observerMemberIds}
											onSelectLeadMember={onChangeLeadMember}
											onUpdateDraftObserverIds={onUpdateMatterObservers}
										/>
									) : undefined
								}
								composerDockRef={composerDockRef}
								isOwner={isOwner}
								mentionMembers={mentionMembers}
								leadMemberId={leadAi?.id ?? null}
								observerMemberIds={observerAis.map(({ id }) => id)}
								allowUnboundOrg={isSuperAdmin || organizations.length === 0}
								isArchitectMode={isArchitectMode}
								isTurnRunning={isTurnRunning}
								submitting={props.submitting}
								effectiveOrgId={effectiveOrgId}
								selectedWorkspaceId={selectedWorkspaceId}
								selectedMatterId={selectedMatterId}
								activeMatterProgress={activeMatterProgress}
								progressStartedAt={props.progressStartedAt}
								organizations={organizations}
								orgFilteredWorkspaces={orgFilteredWorkspaces}
								onCloseRoster={closeRoster}
								onSelectOrganization={props.onSelectOrganization}
								onSelectWorkspace={props.onSelectWorkspace}
								onNewMatter={props.onNewMatter}
								onSendPrompt={props.onSendPrompt}
								onAbortMatter={props.onAbortMatter}
								onOpenLightbox={setLightboxImage}
								onPreviewFile={openFilePreview}
							/>
						</>
					)}

					<AttachmentPreviewModals
						lightboxImage={lightboxImage}
						previewFile={previewFile}
						onCloseLightbox={() => setLightboxImage(null)}
						onCloseFilePreview={closeFilePreview}
						onExpandPastedFile={onExpandPastedFile}
						onNotice={props.onNotice}
					/>
				</div>
			</div>
			{showBoardPane && activeLoadedId && matterDetail && (
				<MatterBoardPane
					matterId={activeLoadedId}
					matterTitle={matterDetail.matter.title}
					collaborationMode={matterCollaborationMode}
					canControlMembers={Boolean(isOwner || canManageMatter)}
					canPostToBoard={!isArchived}
					snapshot={board.snapshot}
					loading={board.loading}
					error={board.error}
					activeTab={boardPaneTab}
					onSelectTab={setBoardPaneTab}
					onClose={() => setBoardPaneOpen(false)}
					onRefreshBoard={() => void board.refreshBoard()}
					postBodiesByNo={board.postBodiesByNo}
					loadingPostNos={board.loadingPostNos}
					postBodyErrors={board.postBodyErrors}
					onLoadPostBody={board.loadPostBody}
					onSubmitPost={board.submitPost}
					onControlMember={board.controlMember}
					events={board.events}
					eventsHasMore={board.eventsHasMore}
					eventsLoading={board.eventsLoading}
					eventsError={board.eventsError}
					eventFilterAgentId={boardEventAgentId}
					eventFilterType={boardEventType}
					onChangeEventFilterAgentId={setBoardEventAgentId}
					onChangeEventFilterType={setBoardEventType}
					onRefreshEvents={board.refreshEvents}
					onLoadMoreEvents={() => void board.loadMoreEvents()}
					onNotice={props.onNotice}
				/>
			)}
			{sideDocs.activeDocId && (
				<MatterDocSidePane
					openDocIds={sideDocs.openDocIds}
					activeDocId={sideDocs.activeDocId}
					autoExpandDiff={sideDocs.autoDiff}
					openNonce={sideDocs.openNonce}
					docTitlesById={sideDocs.docTitlesById}
					workspaces={workspaces}
					memberName={memberName}
					onSelectDoc={sideDocs.selectDoc}
					onCloseDoc={sideDocs.closeDoc}
					onClosePane={sideDocs.closePane}
					onOpenFullSpace={(docId) => onOpenDeliverables(docId)}
				/>
			)}
		</div>
	);
}
