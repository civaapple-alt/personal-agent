import type { ReactNode } from "react";
import { type ComponentProps, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isCurrentHumanDecision, readHumanDecision } from "../../../src/orchestrator/human-decision.ts";
import { hasRoleProposalActions } from "../../../src/roles/role-proposal-state.ts";
import type {
	AccountUserDto,
	ApplyMatterRoleProposalsPayload,
	CollaboratorDto,
	DeliverableDto,
	DistillRsiResult,
	InnerMatterStep,
	MatterDetailPayload,
	MatterProgressDto,
	MemberMemoryDto,
	OrganizationDto,
	OrganizationMemberDto,
	PendingDialogDto,
	RoleTemplateDto,
	TeamMemberDto,
	WorkspaceDto,
} from "../api.ts";
import { filterBusinessMembers } from "../architectApi.ts";
import { useChatScroll } from "../hooks/useChatScroll.ts";
import { useChatStageParticipants } from "../hooks/useChatStageParticipants.ts";
import { groupDeliverableSeries } from "../utils/deliverableSeries.ts";
import { buildMatterDelegations } from "../utils/matterDelegations.ts";
import {
	collectMatterMemories,
	collectMatterParticipantIds,
	mapDeliverablesToMessages,
} from "../utils/matterStream.ts";
import { transitionView } from "../viewTransitions.ts";
import { AttachmentPreviewModals, useAttachmentPreview } from "./chat/AttachmentPreviewModals.tsx";
import { ChatStageHeader } from "./chat/ChatStageHeader.tsx";
import { ComposerDock } from "./chat/ComposerDock.tsx";
import { MatterCollabDrawer, type MatterCollabTab } from "./chat/MatterCollabDrawer.tsx";
import { type DelegationScope, type DelegationView, MatterDelegationPanel } from "./chat/MatterDelegationPanel.tsx";
import { MatterInitiationPanel } from "./chat/MatterInitiationPanel.tsx";
import { MatterRosterPopover } from "./chat/MatterRosterPopover.tsx";
import { MessageFeed } from "./chat/MessageFeed.tsx";
import { ViewFade } from "./ViewTransitions.tsx";

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
	| "assessment"
	| "modelAssessing"
	| "modelAssessmentError"
	| "onUpdateDraftAiMemberIds"
	| "onUpdateDraftCollaboratorIds"
	| "onUpdateDraftVisibility"
	| "onSetScopeMode"
	| "onToggleObserverPreset"
	| "onToggleDraftMemberConsult"
	| "onToggleDraftMemberObserver"
	| "onApplyPresetMode"
	| "onApplyRecommendation"
	| "onRequestModelAssessment"
	| "onCancelModelAssessment"
	| "onOpenArchitect"
	| "onStartArchitectMatter"
>;

interface ChatStageProps {
	composerDraft: ComposerDraftProps;
	initiation: MatterInitiationProps;
	onOpenDemo?: () => void;
	demoOpening?: boolean;
	onDemoStep?: (step: InnerMatterStep) => void;
	demoStepBusy?: boolean;
	currentUser?: CollaboratorDto | null;
	accountUser?: AccountUserDto | null;
	isSuperAdmin?: boolean;
	canDispatchAi?: boolean;
	canManageMatter: boolean;
	collaborators?: CollaboratorDto[];
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
	memoriesByMember: Record<string, MemberMemoryDto[]>;
	memberName: (id: string) => string;
	workspaceName: (id: string | null) => string | null;
	organizationName: (id: string | null) => string | null;
	previewUrlFor: (deliverable: DeliverableDto | null) => string | null;
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
	onDistillMatter: (matterId: string) => Promise<DistillRsiResult | undefined>;
	onCancelDistillMatter?: (matterId: string) => void;
	onRefresh: () => Promise<void>;
	onNotice: (message: string) => void;
	onError: (message: string) => void;
}

/** Coordinates the active matter workspace: header bar, participant/collab popovers, scrollable stream, and composer. */
export function ChatStage({
	composerDraft,
	initiation,
	onOpenDemo,
	demoOpening,
	onDemoStep,
	demoStepBusy,
	currentUser,
	accountUser = null,
	isSuperAdmin = false,
	canDispatchAi,
	canManageMatter,
	collaborators = [],
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
	headerTheme,
	selectedMatterId,
	matterDetail,
	activeDialogs,
	activeMatterProgress,
	progressStartedAt,
	streamingDelta,
	submitting,
	templateByRoleId,
	memoriesByMember,
	memberName,
	workspaceName,
	organizationName,
	previewUrlFor,
	onSelectOrganization,
	onSelectWorkspace,
	matterAiMemberIds,
	matterConsultMemberIds = null,
	observerMemberIds,
	observersEnabled,
	onChangeLeadMember,
	onUpdateMatterAiMembers,
	onUpdateMatterConsultMembers,
	onToggleObserversEnabled,
	onUpdateMatterObservers,
	onUpdateMatterCollaborators,
	onApproveAiRequest,
	onDismissAiRequest,
	onApplyRoleProposals,
	onDismissRoleProposals,
	onSendQuickPrompt,
	onConsultArchitect,
	onLaunchWithNewRoles,
	modelControl,
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
}: ChatStageProps) {
	const { onExpandPastedFile, ...dockDraft } = composerDraft;
	const { composerText, pendingFiles } = dockDraft;
	const [collabMatterId, setCollabMatterId] = useState<string | null>(null);
	const collabOpen = collabMatterId !== null && collabMatterId === selectedMatterId;
	const [collabTab, setCollabTab] = useState<MatterCollabTab>("delegations");
	const [delegationScope, setDelegationScope] = useState<DelegationScope>("latest");
	const [delegationView, setDelegationView] = useState<DelegationView>("board");
	const [distillingMatter, setDistillingMatter] = useState(false);
	const [distillNoteByMatter, setDistillNoteByMatter] = useState<Record<string, string>>({});
	const [rosterOpen, setRosterOpen] = useState(false);
	const [rosterMode, setRosterMode] = useState<"view" | "add" | "remove">("view");
	const [rosterSearch, setRosterSearch] = useState("");
	const [moreMenuOpen, setMoreMenuOpen] = useState(false);

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

	const matterMemories = useMemo(
		() => (matterDetail ? collectMatterMemories(memoriesByMember, matterDetail.matter.id) : []),
		[memoriesByMember, matterDetail],
	);
	const matterDeliverables = matterDetail?.deliverables;
	const deliverableSeries = useMemo(() => groupDeliverableSeries(matterDeliverables ?? []), [matterDeliverables]);
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
	const loadedMatterId = matterDetail?.matter.id ?? null;
	const activeLoadedId = selectedMatterId && loadedMatterId === selectedMatterId ? loadedMatterId : null;
	const messageCount = matterDetail?.userMessages.length ?? 0;
	const streamLen = streamingDelta.length;

	const { chatScrollRef, chatStreamInnerRef, messagesEndRef, handleStreamScroll } = useChatScroll({
		activeLoadedId,
		messageCount,
		streamLen,
	});

	const deliverablesPlacement = useMemo(
		() => mapDeliverablesToMessages(matterDetail?.userMessages ?? [], matterDetail?.deliverables ?? []),
		[matterDetail],
	);

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
		nonOwnerCollaborators,
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
		collaborators,
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
	const pendingDecisions: Array<{ id: string; label: string; isConfirmation?: boolean }> = [];
	if (matterDetail && matterDetail.matter.status !== "archived") {
		const seenRoleProposals = new Set<string>();
		const messages = matterDetail.userMessages;
		for (const [index, message] of messages.entries()) {
			if (message.senderType !== "member") continue;
			const decision = readHumanDecision(message.metadata);
			if (
				decision?.status === "pending" &&
				isCurrentHumanDecision(message, decision, matterDetail.matter, messages.slice(index + 1))
			) {
				const isConfirmation = decision.kind === "execution_confirmation";
				pendingDecisions.push({
					id: message.id,
					isConfirmation,
					label: isConfirmation
						? (decision.requests[0]?.context ?? "确认开始执行")
						: (decision.requests[0]?.question ?? "答复澄清"),
				});
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
				pendingDecisions.push({ id: message.id, label: "确认角色提案" });
			}
		}
	}

	return (
		<div className={`chat-stage${!selectedMatterId && !isArchitectMode ? " is-new-matter" : ""}`}>
			<ChatStageHeader
				selectedOrganization={selectedOrganization}
				selectedWorkspace={selectedWorkspace}
				headerTheme={headerTheme}
				contactLabel={
					!selectedMatterId && selectedMemberId === "auto" ? "新事项" : (headerContact?.displayName ?? "AI 团队")
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
				pendingMatterMemoriesCount={pendingMatterMemoriesCount}
				matterMemoriesCount={matterMemories.length}
				deliverablesCount={deliverableSeries.length}
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
						matterConsultMemberIds={matterConsultMemberIds}
						onSearchChange={setRosterSearch}
						onModeChange={setRosterMode}
						onClose={closeRoster}
						onOpenTeam={onOpenTeam}
						onNotice={onNotice}
						onChangeLeadMember={onChangeLeadMember}
						onUpdateMatterAiMembers={onUpdateMatterAiMembers}
						onUpdateMatterConsultMembers={onUpdateMatterConsultMembers}
						onToggleObserversEnabled={onToggleObserversEnabled}
						onUpdateMatterObservers={onUpdateMatterObservers}
						onUpdateMatterCollaborators={onUpdateMatterCollaborators}
						onConsultArchitect={onConsultArchitect}
					/>
				</ViewFade>
			)}

			{collabOpen && activeLoadedId && matterDetail && (
				<ViewFade type="panel">
					<MatterCollabDrawer
						panelRef={collabPanelRef}
						collabTab={collabTab}
						matterDetail={matterDetail}
						deliverableSeries={deliverableSeries}
						onOpenDeliverable={onOpenDeliverables}
						selectedMemberId={selectedMemberId}
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
						matterMemories={matterMemories}
						matterParticipantIds={matterParticipantIds}
						members={members}
						workspaces={workspaces}
						organizations={organizations}
						distillingMatter={distillingMatter}
						distillNote={distillNoteByMatter[matterDetail.matter.id] ?? null}
						memberName={memberName}
						workspaceName={workspaceName}
						organizationName={organizationName}
						onSelectTab={setCollabTab}
						onClose={() => transitionView("panel", closeCollab)}
						onDistill={() => void handleDistillCurrentMatter()}
						onCancelDistill={
							onCancelDistillMatter ? () => onCancelDistillMatter(matterDetail.matter.id) : undefined
						}
						onOpenTeam={onOpenTeam}
						onRefresh={onRefresh}
						onNotice={onNotice}
						onError={onError}
					/>
				</ViewFade>
			)}

			{pendingDecisions.length > 0 && (
				<details className="human-decision-jump" key={selectedMatterId}>
					<summary>
						{pendingDecisions.every((item) => item.isConfirmation) ? "待确认执行" : "待人类决定"} ·{" "}
						{pendingDecisions.length}
					</summary>
					<ul>
						{pendingDecisions.map(({ id, label }) => (
							<li key={id}>
								<button
									type="button"
									className="btn-inline"
									onClick={() => {
										const target = document.getElementById(`matter-message-${id}`);
										target?.focus({ preventScroll: true });
										target?.scrollIntoView({ block: "start" });
									}}
								>
									{label}
								</button>
							</li>
						))}
					</ul>
				</details>
			)}

			<MessageFeed
				onOpenDemo={onOpenDemo}
				demoOpening={demoOpening}
				onDemoStep={onDemoStep}
				demoStepBusy={demoStepBusy}
				chatScrollRef={chatScrollRef}
				chatStreamInnerRef={chatStreamInnerRef}
				messagesEndRef={messagesEndRef}
				onScroll={handleStreamScroll}
				selectedMatterId={selectedMatterId}
				selectedMemberId={selectedMemberId}
				headerContact={headerContact}
				headerTheme={headerTheme}
				selectedOrganization={selectedOrganization}
				selectedWorkspace={selectedWorkspace}
				templateByRoleId={templateByRoleId}
				matterDetail={matterDetail}
				activeMatterProgress={activeMatterProgress}
				activeDialogs={activeDialogs}
				progressStartedAt={progressStartedAt}
				streamingDelta={streamingDelta}
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
				previewUrlFor={previewUrlFor}
				deliverablesPlacement={deliverablesPlacement}
				delegations={delegations}
				onOpenDelegations={openDelegations}
				onOpenLightbox={setLightboxImage}
				onPreviewFile={openFilePreview}
				onOpenDeliverables={onOpenDeliverables}
				onApproveAiRequest={onApproveAiRequest}
				onDismissAiRequest={onDismissAiRequest}
				onApplyRoleProposals={onApplyRoleProposals}
				onDismissRoleProposals={onDismissRoleProposals}
				onSendQuickPrompt={onSendQuickPrompt}
				onFillComposer={(text) => {
					dockDraft.onComposerTextChange(text);
					dockDraft.composerRef.current?.focus();
				}}
				onOpenQuickCreator={() => initiation.onOpenArchitect()}
				onLaunchWithNewRoles={onLaunchWithNewRoles}
				onAbortMatter={onAbortMatter}
			/>

			<ComposerDock
				{...dockDraft}
				modelControl={modelControl}
				initiationPanel={
					!selectedMatterId ? (
						<MatterInitiationPanel
							{...initiation}
							isOwner={isOwner}
							observersEnabled={observersEnabled}
							hasWorkspace={Boolean(selectedWorkspaceId)}
							hasPromptText={Boolean(composerText.trim() || pendingFiles.length > 0)}
							members={scopedMembers}
							nonOwnerCollaborators={nonOwnerCollaborators}
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
				mentionMembers={[
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
				]}
				leadMemberId={leadAi?.id ?? null}
				observerMemberIds={observerAis.map(({ id }) => id)}
				allowUnboundOrg={isSuperAdmin || organizations.length === 0}
				isArchitectMode={isArchitectMode}
				isTurnRunning={isTurnRunning}
				submitting={submitting}
				effectiveOrgId={effectiveOrgId}
				selectedWorkspaceId={selectedWorkspaceId}
				selectedMatterId={selectedMatterId}
				activeMatterProgress={activeMatterProgress}
				progressStartedAt={progressStartedAt}
				organizations={organizations}
				orgFilteredWorkspaces={orgFilteredWorkspaces}
				onCloseRoster={closeRoster}
				onSelectOrganization={onSelectOrganization}
				onSelectWorkspace={onSelectWorkspace}
				onNewMatter={onNewMatter}
				onSendPrompt={onSendPrompt}
				onAbortMatter={onAbortMatter}
				onOpenLightbox={setLightboxImage}
				onPreviewFile={openFilePreview}
			/>

			<AttachmentPreviewModals
				lightboxImage={lightboxImage}
				previewFile={previewFile}
				onCloseLightbox={() => setLightboxImage(null)}
				onCloseFilePreview={closeFilePreview}
				onExpandPastedFile={onExpandPastedFile}
				onNotice={onNotice}
			/>
		</div>
	);
}
