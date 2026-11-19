import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import type {
	AccountUserDto,
	ApplyMatterRoleProposalsPayload,
	CollaborationPresetMode,
	CollaboratorDto,
	ComposerFileAttachment,
	ComposerImageAttachment,
	DeliverableDto,
	DistillRsiResult,
	InnerMatterStep,
	MatterDetailPayload,
	MatterInitiationAssessmentDto,
	MatterProgressDto,
	MatterVisibility,
	MemberMemoryDto,
	OrganizationDto,
	OrganizationMemberDto,
	PendingDialogDto,
	RoleGapSuggestionDto,
	RoleTemplateDto,
	TeamMemberDto,
	WorkspaceDto,
} from "../api.ts";
import { filterBusinessMembers } from "../architectApi.ts";
import { useChatScroll } from "../hooks/useChatScroll.ts";
import { useChatStageParticipants } from "../hooks/useChatStageParticipants.ts";
import {
	collectMatterMemories,
	collectMatterParticipantIds,
	mapDelegationsToMessages,
	mapDeliverablesToMessages,
} from "../utils/matterStream.ts";
import { AttachmentPreviewModals, useAttachmentPreview } from "./chat/AttachmentPreviewModals.tsx";
import { ChatStageHeader } from "./chat/ChatStageHeader.tsx";
import { ComposerDock } from "./chat/ComposerDock.tsx";
import { MatterCollabDrawer } from "./chat/MatterCollabDrawer.tsx";
import { MatterInitiationPanel } from "./chat/MatterInitiationPanel.tsx";
import { MatterRosterPopover } from "./chat/MatterRosterPopover.tsx";
import { MessageFeed } from "./chat/MessageFeed.tsx";

interface ChatStageProps {
	onOpenDemo?: () => void;
	demoOpening?: boolean;
	onDemoStep?: (step: InnerMatterStep) => void;
	demoStepBusy?: boolean;
	composerRef: RefObject<HTMLTextAreaElement | null>;
	currentUser?: CollaboratorDto | null;
	accountUser?: AccountUserDto | null;
	isSuperAdmin?: boolean;
	canDispatchAi?: boolean;
	canManageMatter: boolean;
	collaborators?: CollaboratorDto[];
	orgMembersByOrgId?: Record<string, OrganizationMemberDto[]>;
	orgEffectiveMemberIds?: string[] | null;
	composerMode: "discussion" | "dispatch";
	onComposerModeChange: (mode: "discussion" | "dispatch") => void;
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
	activeChatDeliverable: DeliverableDto | null;
	deliverablesCount: number;
	selectedDeliverableId: string | null;
	activeMatterProgress: MatterProgressDto | null;
	elapsedSeconds: number;
	streamingDelta: string;
	submitting: boolean;
	composerText: string;
	pendingImages: ComposerImageAttachment[];
	pendingFiles: ComposerFileAttachment[];
	templateByRoleId: Map<string, RoleTemplateDto>;
	memoriesByMember: Record<string, MemberMemoryDto[]>;
	memberName: (id: string) => string;
	workspaceName: (id: string | null) => string | null;
	organizationName: (id: string | null) => string | null;
	previewUrlFor: (deliverable: DeliverableDto | null) => string | null;
	onComposerTextChange: (value: string) => void;
	onAddAttachments: (files: FileList | File[]) => void;
	onAddPastedText: (text: string) => void;
	onRemoveImage: (imageId: string) => void;
	onRemoveFile: (fileId: string) => void;
	onExpandPastedFile: (fileId: string) => void;
	onSelectOrganization: (orgId: string) => void;
	onSelectWorkspace: (workspaceId: string) => void;
	matterAiMemberIds: string[];
	matterConsultMemberIds?: string[] | null;
	observerMemberIds: string[];
	observersEnabled: boolean;
	discussionAiEnabled?: boolean;
	draftAiMemberIds: string[] | null;
	draftConsultMemberIds?: string[] | null;
	draftCollaboratorIds: string[];
	draftVisibility?: MatterVisibility;
	initiationAssessment: MatterInitiationAssessmentDto | null;
	initiationAssessing: boolean;
	initiationAssessmentError?: string | null;
	initiationModelAssessing?: boolean;
	initiationModelAssessmentError?: string | null;
	onChangeLeadMember: (memberId: string) => void;
	onUpdateMatterAiMembers: (aiMemberIds: string[]) => void;
	onUpdateMatterConsultMembers?: (consultMemberIds: string[] | null) => void;
	onToggleDiscussionAiEnabled?: (enabled: boolean) => void;
	onUpdateDraftAiMemberIds: (ids: string[] | null) => void;
	onUpdateDraftCollaboratorIds: (ids: string[]) => void;
	onUpdateDraftVisibility?: (visibility: MatterVisibility) => void;
	onSetScopeMode?: (scope: "solo" | "team") => void;
	onToggleObserverPreset?: () => void;
	onToggleDraftMemberConsult?: (memberId: string, enabled: boolean) => void;
	onToggleDraftMemberObserver?: (memberId: string, enabled: boolean) => void;
	onApplyPresetMode: (mode: CollaborationPresetMode, leadId?: string | null) => void;
	onApplyInitiationRecommendation: () => void;
	onRequestModelAssessment?: (options?: { readRepo?: boolean }) => void;
	onCancelModelAssessment?: () => void;
	onOpenArchitect: (gap?: RoleGapSuggestionDto) => void;
	onToggleObserversEnabled: (enabled: boolean) => void;
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
	onSendQuickPrompt?: (prompt: string, options?: { preferredMemberId?: string }) => void;
	onConsultArchitect?: () => void;
	onStartArchitectMatter?: (seedText?: string) => void;
	onLaunchWithNewRoles?: (memberIds: string[]) => void;
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
	onOpenDemo,
	demoOpening,
	onDemoStep,
	demoStepBusy,
	composerRef,
	currentUser,
	accountUser = null,
	isSuperAdmin = false,
	canDispatchAi,
	canManageMatter,
	collaborators = [],
	orgMembersByOrgId = {},
	orgEffectiveMemberIds = null,
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
	pendingFiles,
	templateByRoleId,
	memoriesByMember,
	memberName,
	workspaceName,
	organizationName,
	previewUrlFor,
	onComposerTextChange,
	onAddAttachments,
	onAddPastedText,
	onRemoveImage,
	onRemoveFile,
	onExpandPastedFile,
	onSelectOrganization,
	onSelectWorkspace,
	matterAiMemberIds,
	matterConsultMemberIds = null,
	observerMemberIds,
	observersEnabled,
	discussionAiEnabled = false,
	draftAiMemberIds,
	draftConsultMemberIds = null,
	draftCollaboratorIds,
	draftVisibility = "org",
	initiationAssessment,
	initiationAssessing,
	initiationAssessmentError,
	initiationModelAssessing = false,
	initiationModelAssessmentError,
	onChangeLeadMember,
	onUpdateMatterAiMembers,
	onUpdateMatterConsultMembers,
	onToggleDiscussionAiEnabled,
	onUpdateDraftAiMemberIds,
	onUpdateDraftCollaboratorIds,
	onUpdateDraftVisibility,
	onSetScopeMode,
	onToggleObserverPreset,
	onToggleDraftMemberConsult,
	onToggleDraftMemberObserver,
	onApplyPresetMode,
	onApplyInitiationRecommendation,
	onRequestModelAssessment,
	onCancelModelAssessment,
	onOpenArchitect,
	onToggleObserversEnabled,
	onUpdateMatterObservers,
	onUpdateMatterCollaborators,
	onApproveAiRequest,
	onDismissAiRequest,
	onApplyRoleProposals,
	onDismissRoleProposals,
	onSendQuickPrompt,
	onConsultArchitect,
	onStartArchitectMatter,
	onLaunchWithNewRoles,
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
	const [collabOpen, setCollabOpen] = useState(false);
	const [collabTab, setCollabTab] = useState<"delegations" | "events" | "experiences">("delegations");
	const [distillingMatter, setDistillingMatter] = useState(false);
	const [distillNoteByMatter, setDistillNoteByMatter] = useState<Record<string, string>>({});
	const [rosterOpen, setRosterOpen] = useState(false);
	const [rosterMode, setRosterMode] = useState<"view" | "add" | "remove">("view");
	const [rosterSearch, setRosterSearch] = useState("");
	const [moreMenuOpen, setMoreMenuOpen] = useState(false);

	const moreMenuWrapRef = useRef<HTMLDivElement | null>(null);
	const collabPanelRef = useRef<HTMLDivElement | null>(null);
	const composerDockRef = useRef<HTMLDivElement | null>(null);
	const rosterPanelRef = useRef<HTMLDivElement | null>(null);
	const headerHumansBtnRef = useRef<HTMLButtonElement | null>(null);

	const { lightboxImage, setLightboxImage, previewFile, openFilePreview, closeFilePreview } = useAttachmentPreview();
	const isOwner = canDispatchAi ?? currentUser?.permissionRole !== "collaborator";

	const closeRoster = () => {
		setRosterOpen(false);
		setRosterMode("view");
		setRosterSearch("");
	};

	useEffect(() => {
		if (!collabOpen && !rosterOpen && !moreMenuOpen) return;
		const onMouseDown = (event: MouseEvent) => {
			const target = event.target as Node | null;
			if (!target) return;
			if (collabOpen && !collabPanelRef.current?.contains(target) && !moreMenuWrapRef.current?.contains(target)) {
				setCollabOpen(false);
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
				setRosterOpen(false);
				setMoreMenuOpen(false);
				setRosterMode("view");
				setRosterSearch("");
			}
		};
		document.addEventListener("mousedown", onMouseDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("mousedown", onMouseDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [collabOpen, rosterOpen, moreMenuOpen]);

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

	const { chatScrollRef, chatStreamInnerRef, messagesEndRef, handleStreamScroll } = useChatScroll({
		activeLoadedId,
		messageCount,
		streamLen,
	});

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
		specialistIds,
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
		draftCollaboratorIds,
		delegations: delegationsPlacement.all,
	});

	return (
		<div className={`chat-stage${!selectedMatterId && !isArchitectMode ? " is-new-matter" : ""}`}>
			<ChatStageHeader
				selectedOrganization={selectedOrganization}
				selectedWorkspace={selectedWorkspace}
				headerTheme={headerTheme}
				headerContact={headerContact}
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
				delegationsCount={delegationsPlacement.all.length}
				deliverablesCount={deliverablesCount}
				activeChatDeliverableId={activeChatDeliverable?.id ?? null}
				selectedDeliverableId={selectedDeliverableId}
				headerHumansBtnRef={headerHumansBtnRef}
				moreMenuWrapRef={moreMenuWrapRef}
				onToggleRoster={() => {
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
				onToggleMoreMenu={() => {
					closeRoster();
					setMoreMenuOpen((open) => !open);
				}}
				onSelectMoreCollab={() => {
					setMoreMenuOpen(false);
					const willOpen = !(collabOpen && collabTab !== "experiences");
					if (
						willOpen &&
						delegationsPlacement.all.length === 0 &&
						(matterDetail?.noticeMessages.length ?? 0) > 0
					) {
						setCollabTab("events");
					} else if (willOpen) {
						setCollabTab("delegations");
					}
					setCollabOpen(willOpen);
				}}
				onSelectMoreExperiences={() => {
					setMoreMenuOpen(false);
					const willOpen = !(collabOpen && collabTab === "experiences");
					setCollabTab("experiences");
					setCollabOpen(willOpen);
				}}
				onOpenDeliverables={onOpenDeliverables}
				onCloseMenus={() => setMoreMenuOpen(false)}
			/>

			{rosterOpen && (
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
					discussionAiEnabled={discussionAiEnabled}
					observerAis={observerAis}
					specialistIds={specialistIds}
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
					onToggleDiscussionAiEnabled={onToggleDiscussionAiEnabled}
					onToggleObserversEnabled={onToggleObserversEnabled}
					onUpdateMatterObservers={onUpdateMatterObservers}
					onUpdateMatterCollaborators={onUpdateMatterCollaborators}
					onConsultArchitect={onConsultArchitect}
				/>
			)}

			{collabOpen && matterDetail && (
				<MatterCollabDrawer
					panelRef={collabPanelRef}
					collabTab={collabTab}
					matterDetail={matterDetail}
					selectedMemberId={selectedMemberId}
					delegations={delegationsPlacement.all}
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
					onClose={() => setCollabOpen(false)}
					onDistill={() => void handleDistillCurrentMatter()}
					onCancelDistill={onCancelDistillMatter ? () => onCancelDistillMatter(matterDetail.matter.id) : undefined}
					onOpenTeam={onOpenTeam}
					onRefresh={onRefresh}
					onNotice={onNotice}
					onError={onError}
				/>
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
				elapsedSeconds={elapsedSeconds}
				streamingDelta={streamingDelta}
				isOwner={isOwner}
				isSuperAdmin={isSuperAdmin}
				accountUser={accountUser}
				currentUser={currentUser}
				organizations={organizations}
				isTurnRunning={isTurnRunning}
				members={members}
				memberName={memberName}
				previewUrlFor={previewUrlFor}
				deliverablesPlacement={deliverablesPlacement}
				delegationsPlacement={delegationsPlacement}
				onOpenLightbox={setLightboxImage}
				onPreviewFile={openFilePreview}
				onOpenDeliverables={onOpenDeliverables}
				onApproveAiRequest={onApproveAiRequest}
				onDismissAiRequest={onDismissAiRequest}
				onApplyRoleProposals={onApplyRoleProposals}
				onDismissRoleProposals={onDismissRoleProposals}
				onSendQuickPrompt={onSendQuickPrompt}
				onFillComposer={(text) => {
					onComposerTextChange(text);
					composerRef.current?.focus();
				}}
				onOpenQuickCreator={() => onOpenArchitect()}
				onLaunchWithNewRoles={onLaunchWithNewRoles}
				onAbortMatter={onAbortMatter}
			/>

			<ComposerDock
				initiationPanel={
					!selectedMatterId ? (
						<MatterInitiationPanel
							isOwner={isOwner}
							composerMode={composerMode}
							hasWorkspace={Boolean(selectedWorkspaceId)}
							hasPromptText={Boolean(composerText.trim() || pendingFiles.length > 0)}
							members={scopedMembers}
							nonOwnerCollaborators={nonOwnerCollaborators}
							orgMembers={orgMembers}
							draftVisibility={draftVisibility}
							templateByRoleId={templateByRoleId}
							selectedMemberId={selectedMemberId}
							draftAiMemberIds={draftAiMemberIds}
							draftConsultMemberIds={draftConsultMemberIds}
							draftObserverMemberIds={observerMemberIds}
							discussionAiEnabled={discussionAiEnabled}
							draftCollaboratorIds={draftCollaboratorIds}
							assessment={initiationAssessment}
							assessing={initiationAssessing}
							assessmentError={initiationAssessmentError}
							modelAssessing={initiationModelAssessing}
							modelAssessmentError={initiationModelAssessmentError}
							onSelectLeadMember={onChangeLeadMember}
							onSetScopeMode={onSetScopeMode}
							onToggleObserverPreset={onToggleObserverPreset}
							onToggleDraftMemberConsult={onToggleDraftMemberConsult}
							onToggleDraftMemberObserver={onToggleDraftMemberObserver}
							onApplyPresetMode={(mode) => onApplyPresetMode(mode)}
							onUpdateDraftAiMemberIds={onUpdateDraftAiMemberIds}
							onUpdateDraftObserverIds={onUpdateMatterObservers}
							onUpdateDraftCollaboratorIds={onUpdateDraftCollaboratorIds}
							onUpdateDraftVisibility={onUpdateDraftVisibility}
							onApplyRecommendation={onApplyInitiationRecommendation}
							onRequestModelAssessment={onRequestModelAssessment}
							onCancelModelAssessment={onCancelModelAssessment}
							onOpenArchitect={onOpenArchitect}
							onStartArchitectMatter={onStartArchitectMatter}
						/>
					) : undefined
				}
				composerDockRef={composerDockRef}
				composerRef={composerRef}
				composerMode={composerMode}
				isOwner={isOwner}
				discussionAiEnabled={discussionAiEnabled}
				canToggleDiscussionAi={isOwner && canManageMatter}
				onToggleDiscussionAiEnabled={onToggleDiscussionAiEnabled}
				mentionMembers={filterBusinessMembers(inGroupAiMembers, templateByRoleId)}
				leadMemberId={leadAi?.id ?? null}
				observerMemberIds={observerMemberIds}
				allowUnboundOrg={isSuperAdmin || organizations.length === 0}
				isArchitectMode={isArchitectMode}
				isTurnRunning={isTurnRunning}
				sendBlockedByTurn={sendBlockedByTurn}
				submitting={submitting}
				composerText={composerText}
				pendingImages={pendingImages}
				pendingFiles={pendingFiles}
				effectiveOrgId={effectiveOrgId}
				selectedWorkspaceId={selectedWorkspaceId}
				selectedMatterId={selectedMatterId}
				activeMatterProgress={activeMatterProgress}
				elapsedSeconds={elapsedSeconds}
				organizations={organizations}
				orgFilteredWorkspaces={orgFilteredWorkspaces}
				onCloseRoster={closeRoster}
				onComposerModeChange={onComposerModeChange}
				onSelectOrganization={onSelectOrganization}
				onSelectWorkspace={onSelectWorkspace}
				onNewMatter={onNewMatter}
				onComposerTextChange={onComposerTextChange}
				onAddAttachments={onAddAttachments}
				onAddPastedText={onAddPastedText}
				onRemoveImage={onRemoveImage}
				onRemoveFile={onRemoveFile}
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
