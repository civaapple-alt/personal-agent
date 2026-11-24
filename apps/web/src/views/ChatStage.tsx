import { isCurrentHumanDecision, readHumanDecision } from "@pa/contracts/human-decision";
import { readNextStepsFromMetadata } from "@pa/contracts/next-steps";
import { hasRoleProposalActions } from "@pa/contracts/role-proposal-state";
import type { ReactNode } from "react";
import { type ComponentProps, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	AccountUserDto,
	ApplyMatterRoleProposalsPayload,
	CollaboratorDto,
	MatterDetailPayload,
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
import { useMatterSideDocs } from "../hooks/useMatterSideDocs.ts";
import { ViewFade } from "../primitives/ViewTransitions.tsx";
import { buildMatterDelegations } from "../utils/matterDelegations.ts";
import { transitionView } from "../viewTransitions.ts";

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
export function ChatStage({
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
	headerTheme,
	selectedMatterId,
	matterDetail,
	activeDialogs,
	activeMatterProgress,
	progressStartedAt,
	streamingDelta,
	submitting,
	templateByRoleId,
	memberName,
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
	onToggleArchiveMatter,
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
	onOpenSkillTrust,
	onRefresh,
	onNotice,
}: ChatStageProps) {
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
	const handleSideDocOpened = useCallback(() => {
		setCollabMatterId(null);
		collabTriggerRef.current = null;
	}, []);
	const sideDocs = useMatterSideDocs({
		selectedMatterId,
		matterDetail,
		onOpened: handleSideDocOpened,
	});

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
	const streamLen = streamingDelta.length;

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
	const pendingDecisions: Array<{ id: string; label: string }> = [];
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
				pendingDecisions.push({ id: message.id, label: decision.requests[0]?.question ?? "答复澄清" });
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

	const activeFloatingClarification = useActiveClarification({
		matterDetail,
		organizations,
		isSuperAdmin,
		accountUser,
		canManageMatter,
		currentUser,
		memberName,
	});

	return (
		<div
			className={`chat-stage${!selectedMatterId && !isArchitectMode ? " is-new-matter" : ""}${sideDocs.activeDocId ? " has-doc-pane" : ""}`}
		>
			<div className="chat-stage-main">
				<ChatStageHeader
					selectedOrganization={selectedOrganization}
					selectedWorkspace={selectedWorkspace}
					headerTheme={headerTheme}
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
					<details className="human-decision-jump" key={selectedMatterId}>
						<summary>待人类决定 · {pendingDecisions.length}</summary>
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
					delegations={delegations}
					onOpenDelegations={openDelegations}
					onOpenLightbox={setLightboxImage}
					onPreviewFile={openFilePreview}
					onOpenDeliverables={onOpenDeliverables}
					onOpenSideDoc={sideDocs.openDoc}
					onApproveAiRequest={matterDetail?.matter.status === "archived" ? undefined : onApproveAiRequest}
					onDismissAiRequest={matterDetail?.matter.status === "archived" ? undefined : onDismissAiRequest}
					onApplyRoleProposals={matterDetail?.matter.status === "archived" ? undefined : onApplyRoleProposals}
					onDismissRoleProposals={matterDetail?.matter.status === "archived" ? undefined : onDismissRoleProposals}
					onSendQuickPrompt={matterDetail?.matter.status === "archived" ? undefined : onSendQuickPrompt}
					onFillComposer={(text) => {
						dockDraft.onComposerTextChange(text);
						dockDraft.composerRef.current?.focus();
					}}
					onOpenQuickCreator={() => initiation.onOpenArchitect()}
					onLaunchWithNewRoles={onLaunchWithNewRoles}
					onSkillProposalDone={() => void onRefresh()}
					onOpenSkillTrust={onOpenSkillTrust}
					onNotice={onNotice}
					onAbortMatter={onAbortMatter}
				/>

				{matterDetail?.matter.status === "archived" ? (
					<div className="archived-matter-bar">
						<div className="archived-matter-bar-copy">
							<span className="pill">已归档</span>
							<span>该事项已归档，当前为只读状态，不能继续发送消息。</span>
						</div>
						<div className="archived-matter-bar-actions">
							{onToggleArchiveMatter && (
								<button
									type="button"
									className="btn-pill-dark btn-xs"
									onClick={() => onToggleArchiveMatter(matterDetail.matter.id, false)}
								>
									恢复事项
								</button>
							)}
							<button type="button" className="btn-pill-outline btn-xs" onClick={onNewMatter}>
								+ 新建事项
							</button>
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

						{!activeFloatingClarification &&
							!isTurnRunning &&
							matterDetail &&
							(() => {
								const latestMsg = matterDetail.userMessages[matterDetail.userMessages.length - 1];
								const suggestions =
									latestMsg?.senderType === "member" ? readNextStepsFromMetadata(latestMsg.metadata) : [];
								if (suggestions.length === 0) return null;
								return (
									<section className="next-steps-bar" aria-label="建议的下一步">
										<span className="next-steps-label">下一步</span>
										<div className="next-steps-chips">
											{suggestions.map((item) => (
												<button
													key={item.prompt}
													type="button"
													className={`next-step-chip${item.kind ? ` is-${item.kind}` : ""}`}
													title={`${item.prompt}\n（点击直接发送，Shift+点击填入输入框编辑）`}
													disabled={submitting}
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
								);
							})()}

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
							mentionMembers={[
								...filterBusinessMembers(inGroupAiMembers, templateByRoleId).map(
									({ id, displayName, roleTitle }) => ({
										id,
										displayName,
										roleTitle,
										kind: "ai" as const,
									}),
								),
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
					</>
				)}

				<AttachmentPreviewModals
					lightboxImage={lightboxImage}
					previewFile={previewFile}
					onCloseLightbox={() => setLightboxImage(null)}
					onCloseFilePreview={closeFilePreview}
					onExpandPastedFile={onExpandPastedFile}
					onNotice={onNotice}
				/>
			</div>
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
