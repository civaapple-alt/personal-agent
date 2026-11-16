import { type RefObject, type UIEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
	ApplyMatterRoleProposalsPayload,
	CollaborationPresetMode,
	CollaboratorDto,
	ComposerImageAttachment,
	DeliverableDto,
	DistillRsiResult,
	InnerMatterStep,
	MatterDetailPayload,
	MatterInitiationAssessmentDto,
	MatterProgressDto,
	MemberMemoryDto,
	OrganizationDto,
	PendingDialogDto,
	RoleGapSuggestionDto,
	RoleTemplateDto,
	TeamMemberDto,
	WorkspaceDto,
} from "../api.ts";
import {
	collectMatterMemories,
	collectMatterParticipantIds,
	mapDelegationsToMessages,
	mapDeliverablesToMessages,
	type StarterTask,
} from "../utils.ts";
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
	collaborators?: CollaboratorDto[];
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
	observerMemberIds: string[];
	observersEnabled: boolean;
	draftPresetMode: CollaborationPresetMode;
	draftAiMemberIds: string[] | null;
	draftCollaboratorIds: string[];
	initiationAssessment: MatterInitiationAssessmentDto | null;
	initiationAssessing: boolean;
	onChangeLeadMember: (memberId: string) => void;
	onUpdateMatterAiMembers: (aiMemberIds: string[]) => void;
	onUpdateDraftAiMemberIds: (ids: string[] | null) => void;
	onUpdateDraftCollaboratorIds: (ids: string[]) => void;
	onApplyPresetMode: (mode: CollaborationPresetMode, leadId?: string | null) => void;
	onApplyInitiationRecommendation: () => void;
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
	onDismissError: () => void;
	onDismissNotice: () => void;
}

const chatScrollMemory = new Map<string, { scrollTop: number; atBottom: boolean }>();

/** Coordinates the active matter workspace: header bar, participant/collab popovers, scrollable stream, and composer. */
export function ChatStage({
	onOpenDemo,
	demoOpening,
	onDemoStep,
	demoStepBusy,
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
	observerMemberIds,
	observersEnabled,
	draftPresetMode,
	draftAiMemberIds,
	draftCollaboratorIds,
	initiationAssessment,
	initiationAssessing,
	onChangeLeadMember,
	onUpdateMatterAiMembers,
	onUpdateDraftAiMemberIds,
	onUpdateDraftCollaboratorIds,
	onApplyPresetMode,
	onApplyInitiationRecommendation,
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
	onDismissError,
	onDismissNotice,
}: ChatStageProps) {
	const [collabOpen, setCollabOpen] = useState(false);
	const [collabTab, setCollabTab] = useState<"delegations" | "events" | "experiences">("delegations");
	const [distillingMatter, setDistillingMatter] = useState(false);
	const [distillNoteByMatter, setDistillNoteByMatter] = useState<Record<string, string>>({});
	const [starterMenuOpen, setStarterMenuOpen] = useState(false);
	const [rosterOpen, setRosterOpen] = useState(false);
	const [rosterMode, setRosterMode] = useState<"view" | "add" | "remove">("view");
	const [rosterSearch, setRosterSearch] = useState("");
	const [moreMenuOpen, setMoreMenuOpen] = useState(false);
	const [lightboxImage, setLightboxImage] = useState<{ src: string; alt: string } | null>(null);

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

	const handleStreamScroll = (e: UIEvent<HTMLDivElement>) => {
		if (!activeLoadedId || lastScrolledMatterIdRef.current !== activeLoadedId) return;
		const el = e.currentTarget;
		const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 100;
		chatScrollMemory.set(activeLoadedId, { scrollTop: el.scrollTop, atBottom });
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
	const assignedCollabIds = matterDetail ? (matterDetail.matter.collaboratorIds ?? []) : draftCollaboratorIds;
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
	const observerAis = observersEnabled
		? observerMemberIds.length > 0
			? nonLeadGroupAiMembers.filter((m) => observerMemberIds.includes(m.id))
			: matterDetail
				? []
				: nonLeadGroupAiMembers
		: [];
	const specialistIds = Array.from(new Set(delegationsPlacement.all.map((d) => d.toMemberId).filter(Boolean))).filter(
		(id) => id !== leadAi?.id && !observerAis.some((obs) => obs.id === id),
	);

	return (
		<div className="chat-stage">
			<ChatStageHeader
				selectedOrganization={selectedOrganization}
				selectedWorkspace={selectedWorkspace}
				headerTheme={headerTheme}
				headerContact={headerContact}
				matterDetail={matterDetail}
				isTurnRunning={isTurnRunning}
				activeMatterProgress={activeMatterProgress}
				allActiveHumans={allActiveHumans}
				inGroupAiMembers={inGroupAiMembers}
				totalAiMembersCount={members.length}
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
					isOwner={isOwner}
					isTurnRunning={isTurnRunning}
					selectedMatterId={selectedMatterId}
					currentUser={currentUser}
					ownerCollab={ownerCollab}
					nonOwnerCollaborators={nonOwnerCollaborators}
					matterHumanParticipants={matterHumanParticipants}
					assignedCollabIds={assignedCollabIds}
					members={members}
					inGroupAiMembers={inGroupAiMembers}
					nonLeadGroupAiMembers={nonLeadGroupAiMembers}
					removedAiMembers={removedAiMembers}
					leadAi={leadAi}
					observersEnabled={observersEnabled}
					observerAis={observerAis}
					specialistIds={specialistIds}
					matterAiMemberIds={matterAiMemberIds}
					onSearchChange={setRosterSearch}
					onModeChange={setRosterMode}
					onClose={closeRoster}
					onOpenTeam={onOpenTeam}
					onNotice={onNotice}
					onChangeLeadMember={onChangeLeadMember}
					onUpdateMatterAiMembers={onUpdateMatterAiMembers}
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
				errorBanner={errorBanner}
				noticeBanner={noticeBanner}
				onDismissError={onDismissError}
				onDismissNotice={onDismissNotice}
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
				isTurnRunning={isTurnRunning}
				members={members}
				memberName={memberName}
				previewUrlFor={previewUrlFor}
				deliverablesPlacement={deliverablesPlacement}
				delegationsPlacement={delegationsPlacement}
				onOpenLightbox={setLightboxImage}
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
				onLaunchWithNewRoles={onLaunchWithNewRoles}
				onAbortMatter={onAbortMatter}
			/>

			{!selectedMatterId && (
				<MatterInitiationPanel
					isOwner={isOwner}
					members={members}
					nonOwnerCollaborators={nonOwnerCollaborators}
					templateByRoleId={templateByRoleId}
					selectedMemberId={selectedMemberId}
					draftPresetMode={draftPresetMode}
					draftAiMemberIds={draftAiMemberIds}
					draftObserverMemberIds={observerMemberIds}
					draftCollaboratorIds={draftCollaboratorIds}
					assessment={initiationAssessment}
					assessing={initiationAssessing}
					onSelectLeadMember={onChangeLeadMember}
					onApplyPresetMode={(mode) => onApplyPresetMode(mode)}
					onUpdateDraftAiMemberIds={onUpdateDraftAiMemberIds}
					onUpdateDraftObserverIds={onUpdateMatterObservers}
					onUpdateDraftCollaboratorIds={onUpdateDraftCollaboratorIds}
					onApplyRecommendation={onApplyInitiationRecommendation}
					onOpenArchitect={onOpenArchitect}
					onStartArchitectMatter={onStartArchitectMatter}
				/>
			)}

			<ComposerDock
				composerDockRef={composerDockRef}
				composerRef={composerRef}
				composerMode={composerMode}
				isOwner={isOwner}
				isTurnRunning={isTurnRunning}
				sendBlockedByTurn={sendBlockedByTurn}
				submitting={submitting}
				composerText={composerText}
				pendingImages={pendingImages}
				effectiveOrgId={effectiveOrgId}
				selectedWorkspaceId={selectedWorkspaceId}
				selectedMatterId={selectedMatterId}
				activeMatterProgress={activeMatterProgress}
				organizations={organizations}
				orgFilteredWorkspaces={orgFilteredWorkspaces}
				starterTasks={starterTasks}
				starterMenuOpen={starterMenuOpen}
				onToggleStarterMenu={() => setStarterMenuOpen((v) => !v)}
				onCloseStarterMenu={() => setStarterMenuOpen(false)}
				onCloseRoster={closeRoster}
				onComposerModeChange={onComposerModeChange}
				onSelectOrganization={onSelectOrganization}
				onSelectWorkspace={onSelectWorkspace}
				onNewMatter={onNewMatter}
				onChangeLeadMember={onChangeLeadMember}
				onApplyPresetMode={onApplyPresetMode}
				onComposerTextChange={onComposerTextChange}
				onAddImages={onAddImages}
				onRemoveImage={onRemoveImage}
				onSendPrompt={onSendPrompt}
				onAbortMatter={onAbortMatter}
				onOpenLightbox={setLightboxImage}
			/>

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
