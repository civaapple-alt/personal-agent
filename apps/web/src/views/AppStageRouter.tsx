import type { ComponentProps, RefObject } from "react";
import { updateMatterModelSelection } from "../api/matters.ts";
import type { ModelSelection } from "../api/models.ts";
import type { AccountUserDto, CollaboratorDto, MatterDto, RoleTemplateDto, WorkspaceDto } from "../api.ts";
import { isArchitectMemberId, isSoloMemberId } from "../architectApi.ts";
import { MatterModelControl } from "../components/ModelPicker.tsx";
import type { HashRoute } from "../hashRouter.ts";
import type { useMatterActions } from "../hooks/useMatterActions.ts";
import type { useMatterInitiationState } from "../hooks/useMatterInitiationState.ts";
import type { useWorkbenchPanels } from "../hooks/useWorkbenchPanels.ts";
import { Button, ErrorBoundary, ModalDialog, ViewFade } from "../primitives/index.ts";
import {
	selectMemberName,
	selectOrganizationName,
	useMatterRuntimeStore,
	useSessionStore,
	useWorkbenchStore,
} from "../stores/index.ts";
import { AccountView } from "./AccountView.tsx";
import { AdminView } from "./AdminView.tsx";
import { ChatStage } from "./ChatStage.tsx";
import { DeliverablesView } from "./DeliverablesView.tsx";
import { MaterialsView } from "./MaterialsView.tsx";
import { OrganizationsView } from "./OrganizationsView.tsx";
import { SettingsView } from "./SettingsView.tsx";
import { TeamView } from "./TeamView.tsx";

export interface AppStageRouterProps {
	currentUser: CollaboratorDto | null;
	accountUser: AccountUserDto | null;
	authKind: ComponentProps<typeof AccountView>["authKind"];
	isSuperAdmin: boolean;
	canDispatchAi: boolean;
	canManageMatter: boolean;
	orgEffectiveMemberIds: string[] | null;
	selectedWorkspace: WorkspaceDto | null;
	effectiveOrgIdForScope: string | null;
	headerContact: ComponentProps<typeof ChatStage>["headerContact"];
	headerTheme: ComponentProps<typeof ChatStage>["headerTheme"];
	currentMatter: MatterDto | null;
	activeDialogs: ComponentProps<typeof ChatStage>["activeDialogs"];
	templateByRoleId: Map<string, RoleTemplateDto>;
	matterAiMemberIds: string[];
	matterConsultMemberIds: string[] | null;
	observersEnabled: boolean;
	orgLeadModel: ModelSelection | null;
	currentLeadId: string | null | undefined;
	composerRef: RefObject<HTMLTextAreaElement | null>;
	composerDraft: ComponentProps<typeof ChatStage>["composerDraft"];
	initiation: ReturnType<typeof useMatterInitiationState>;
	actions: ReturnType<typeof useMatterActions>;
	settingsProps: ReturnType<typeof useWorkbenchPanels>["settingsProps"];
	adminProps: ReturnType<typeof useWorkbenchPanels>["adminProps"];
	navigateRoute: (route: HashRoute, options?: { replace?: boolean }) => void;
	startNewMatter: (preferredLeadId?: string) => void;
	startNewMatterFromCurrent: () => void;
	startArchitectMatter: (seedText?: string) => void;
	launchNewMatterWithMembers: (memberIds: string[]) => void;
	handleSidebarToggleArchiveMatter: (matterId: string, archived: boolean) => void;
	handleSidebarSwitchOrLogout: () => void;
	refreshBootstrap: () => Promise<void>;
	setComposerText: (text: string) => void;
}

/** Routes top-level workbench tabs inside isolated ErrorBoundaries. */
export function AppStageRouter({
	currentUser,
	accountUser,
	authKind,
	isSuperAdmin,
	canDispatchAi,
	canManageMatter,
	orgEffectiveMemberIds,
	selectedWorkspace,
	effectiveOrgIdForScope,
	headerContact,
	headerTheme,
	currentMatter,
	activeDialogs,
	templateByRoleId,
	matterAiMemberIds,
	matterConsultMemberIds,
	observersEnabled,
	orgLeadModel,
	currentLeadId,
	composerRef,
	composerDraft,
	initiation,
	actions,
	settingsProps,
	adminProps,
	navigateRoute,
	startNewMatter,
	startNewMatterFromCurrent,
	startArchitectMatter,
	launchNewMatterWithMembers,
	handleSidebarToggleArchiveMatter,
	handleSidebarSwitchOrLogout,
	refreshBootstrap,
	setComposerText,
}: AppStageRouterProps) {
	const activeTab = useWorkbenchStore((s) => s.activeTab);
	const settingsSection = useWorkbenchStore((s) => s.settingsSection);
	const spaceRoute = useWorkbenchStore((s) => s.spaceRoute);
	const setNoticeBanner = useWorkbenchStore((s) => s.setNoticeBanner);
	const setErrorBanner = useWorkbenchStore((s) => s.setErrorBanner);

	const bootstrap = useSessionStore((s) => s.bootstrap);
	const serverRequireAuth = useSessionStore((s) => s.serverRequireAuth);
	const selectedWorkspaceId = useSessionStore((s) => s.selectedWorkspaceId);
	const selectedOrgId = useSessionStore((s) => s.selectedOrgId);
	const selectedMemberId = useSessionStore((s) => s.selectedMemberId);
	const setSelectedWorkspaceId = useSessionStore((s) => s.setSelectedWorkspaceId);

	const selectedMatterId = useMatterRuntimeStore((s) => s.selectedMatterId);
	const matterDetail = useMatterRuntimeStore((s) => s.matterDetail);
	const setMatterDetail = useMatterRuntimeStore((s) => s.setMatterDetail);
	const streamingDelta = useMatterRuntimeStore((s) => s.streamingDelta);
	const submitting = useMatterRuntimeStore((s) => s.submitting);
	const draftModelSelection = useMatterRuntimeStore((s) => s.draftModelSelection);
	const setDraftModelSelection = useMatterRuntimeStore((s) => s.setDraftModelSelection);
	const draftMatterVisibility = useMatterRuntimeStore((s) => s.draftMatterVisibility);
	const setDraftMatterVisibility = useMatterRuntimeStore((s) => s.setDraftMatterVisibility);
	const setDraftAiMemberIds = useMatterRuntimeStore((s) => s.setDraftAiMemberIds);
	const activeMatterProgress = useMatterRuntimeStore((s) =>
		s.selectedMatterId ? (s.progressByMatter[s.selectedMatterId] ?? null) : null,
	);
	const activeProgressStartedAt = useMatterRuntimeStore((s) =>
		s.selectedMatterId ? (s.progressStartedAt[s.selectedMatterId] ?? null) : null,
	);

	const memberName = (id: string) => selectMemberName(bootstrap, id);
	const organizationName = (id: string | null) => selectOrganizationName(bootstrap, id);

	return (
		<ErrorBoundary key={activeTab} scope={activeTab}>
			{activeTab === "chats" && (
				<ViewFade>
					<ChatStage
						composerDraft={composerDraft}
						initiation={{
							draftAiMemberIds: initiation.draftAiMemberIds,
							draftConsultMemberIds: initiation.draftConsultMemberIds,
							draftCollaboratorIds: initiation.draftCollaboratorIds,
							draftVisibility: draftMatterVisibility,
							draftCollaborationMode: initiation.draftCollaborationMode,
							assessment: initiation.assessment,
							modelAssessing: initiation.modelAssessing,
							modelAssessmentError: initiation.modelAssessmentError,
							onUpdateDraftAiMemberIds: setDraftAiMemberIds,
							onUpdateDraftCollaboratorIds: initiation.setDraftCollaboratorIds,
							onUpdateDraftVisibility: setDraftMatterVisibility,
							onUpdateDraftCollaborationMode: initiation.setDraftCollaborationMode,
							onSetScopeMode: initiation.setScopeMode,
							onToggleObserverPreset: () => actions.handleToggleObserversEnabled(!observersEnabled),
							onToggleDraftMemberConsult: initiation.toggleDraftMemberConsult,
							onToggleDraftMemberObserver: initiation.toggleDraftMemberObserver,
							onApplyPresetMode: (mode) => initiation.applyPresetMode(mode),
							onApplyRecommendation: initiation.applyAssessmentRecommendation,
							onRequestModelAssessment: (opts) => void initiation.requestModelAssessment(opts),
							onCancelModelAssessment: initiation.cancelModelAssessment,
							onStartArchitectMatter: startArchitectMatter,
						}}
						currentUser={currentUser}
						accountUser={accountUser}
						isSuperAdmin={isSuperAdmin}
						canDispatchAi={canDispatchAi}
						canManageMatter={canManageMatter}
						orgMembersByOrgId={bootstrap?.orgMembersByOrgId ?? {}}
						orgEffectiveMemberIds={orgEffectiveMemberIds}
						selectedWorkspace={selectedWorkspace}
						selectedWorkspaceId={selectedWorkspaceId}
						selectedOrgId={selectedOrgId}
						workspaces={bootstrap?.workspaces ?? []}
						organizations={bootstrap?.organizations ?? []}
						members={bootstrap?.members ?? []}
						selectedMemberId={selectedMemberId}
						headerContact={headerContact}
						headerTheme={headerTheme}
						selectedMatterId={selectedMatterId}
						matterDetail={currentMatter ? matterDetail : null}
						activeDialogs={activeDialogs}
						activeMatterProgress={activeMatterProgress}
						progressStartedAt={activeProgressStartedAt}
						streamingDelta={streamingDelta}
						submitting={submitting}
						templateByRoleId={templateByRoleId}
						memberName={memberName}
						onSelectOrganization={actions.handleSelectOrganization}
						onSelectWorkspace={actions.handleSelectWorkspace}
						matterAiMemberIds={matterAiMemberIds}
						matterConsultMemberIds={matterConsultMemberIds}
						observerMemberIds={
							matterDetail ? (matterDetail.matter.observerMemberIds ?? []) : initiation.draftObserverMemberIds
						}
						observersEnabled={observersEnabled}
						onChangeLeadMember={actions.handleChangeLeadMember}
						onUpdateMatterAiMembers={actions.handleUpdateMatterAiMembers}
						onUpdateMatterConsultMembers={actions.handleUpdateMatterConsultMembers}
						onToggleObserversEnabled={actions.handleToggleObserversEnabled}
						onUpdateMatterObservers={actions.handleUpdateMatterObservers}
						onUpdateMatterCollaborators={actions.handleUpdateMatterCollaborators}
						onUpdateCollaborationMode={actions.handleUpdateCollaborationMode}
						onApproveAiRequest={(matterId, messageId) => void actions.handleApproveAiRequest(matterId, messageId)}
						onDismissAiRequest={(matterId, messageId) => void actions.handleDismissAiRequest(matterId, messageId)}
						onApplyRoleProposals={actions.handleApplyRoleProposals}
						onDismissRoleProposals={actions.handleDismissRoleProposals}
						onSendQuickPrompt={actions.handleSendQuickPrompt}
						onConsultArchitect={() => void actions.handleConsultArchitect()}
						onLaunchWithNewRoles={launchNewMatterWithMembers}
						modelControl={
							canDispatchAi && canManageMatter && (!selectedMatterId || currentMatter) ? (
								<MatterModelControl
									key={selectedMatterId ?? "new"}
									label="主责模型"
									value={selectedMatterId ? (currentMatter?.modelSelection ?? null) : draftModelSelection}
									roleModel={orgLeadModel}
									leadKnown={Boolean(currentLeadId)}
									disabled={submitting || Boolean(activeMatterProgress)}
									immediate={!selectedMatterId}
									onSave={async (selection) => {
										if (!selectedMatterId) {
											setDraftModelSelection(selection);
											return;
										}
										const { matter } = await updateMatterModelSelection(selectedMatterId, selection);
										setMatterDetail((detail) =>
											detail?.matter.id === matter.id ? { ...detail, matter } : detail,
										);
									}}
								/>
							) : null
						}
						onSendPrompt={() => void actions.handleSendPrompt()}
						onAbortMatter={actions.handleAbortMatter}
						onNewMatter={startNewMatterFromCurrent}
						onOpenDeliverables={(targetId) => navigateRoute({ tab: "deliverables", spacePageId: targetId })}
						onOpenTeam={() => navigateRoute({ tab: "team" })}
						onOpenSkillTrust={() => navigateRoute({ tab: "settings", settingsSection: "skills" })}
						onToggleArchiveMatter={handleSidebarToggleArchiveMatter}
						onRefresh={refreshBootstrap}
						onNotice={(msg) => setNoticeBanner(msg)}
					/>
				</ViewFade>
			)}

			{activeTab === "deliverables" && (
				<ViewFade>
					<DeliverablesView
						spaceRoute={spaceRoute}
						bootstrap={bootstrap}
						memberName={memberName}
						onOpenMatterChat={(matterId) => navigateRoute({ tab: "chats", matterId })}
					/>
				</ViewFade>
			)}

			{activeTab === "team" && (
				<ViewFade>
					<TeamView
						currentUser={currentUser}
						accountUser={accountUser}
						isSuperAdmin={isSuperAdmin}
						members={bootstrap?.members ?? []}
						workspaces={bootstrap?.workspaces ?? []}
						organizations={bootstrap?.organizations ?? []}
						orgAiRolesByOrgId={bootstrap?.orgAiRolesByOrgId ?? {}}
						matters={bootstrap?.matters ?? []}
						selectedOrgId={effectiveOrgIdForScope}
						defaultWorkspaceId={matterDetail?.matter.workspaceId ?? (selectedWorkspaceId || null)}
						templateByRoleId={templateByRoleId}
						memberName={memberName}
						organizationName={organizationName}
						onRefresh={refreshBootstrap}
						onNotice={(msg) => setNoticeBanner(msg)}
						onError={(msg) => setErrorBanner(msg)}
						onAssignTask={(memberId) => {
							startNewMatter(memberId);
							if (
								isArchitectMemberId(memberId, bootstrap?.members, templateByRoleId) ||
								isSoloMemberId(memberId, bootstrap?.members, templateByRoleId)
							) {
								setDraftAiMemberIds([memberId]);
								initiation.setDraftPresetMode("solo");
							}
						}}
						onOpenArchitectMatter={(seedText) => startArchitectMatter(seedText)}
						onOpenOrganizations={() => navigateRoute({ tab: "organizations" })}
					/>
				</ViewFade>
			)}

			{activeTab === "organizations" && (
				<ViewFade>
					<OrganizationsView
						currentUser={currentUser}
						accountUser={accountUser}
						isSuperAdmin={isSuperAdmin}
						organizations={bootstrap?.organizations ?? []}
						workspaces={bootstrap?.workspaces ?? []}
						members={bootstrap?.members ?? []}
						templateByRoleId={templateByRoleId}
						orgMembersByOrgId={bootstrap?.orgMembersByOrgId ?? {}}
						orgAiRolesByOrgId={bootstrap?.orgAiRolesByOrgId ?? {}}
						selectedOrgId={effectiveOrgIdForScope}
						onOpenSpace={(spaceId) => navigateRoute({ tab: "deliverables", spacePageId: spaceId })}
						onOpenWorkspaces={() => navigateRoute({ tab: "materials" })}
						onRefresh={refreshBootstrap}
						onNotice={(msg) => setNoticeBanner(msg)}
						onError={(msg) => setErrorBanner(msg)}
					/>
				</ViewFade>
			)}

			{activeTab === "materials" && (
				<ViewFade>
					<MaterialsView
						workspaces={bootstrap?.workspaces ?? []}
						organizations={bootstrap?.organizations ?? []}
						orgMembersByOrgId={bootstrap?.orgMembersByOrgId ?? {}}
						matters={bootstrap?.matters ?? []}
						memberName={memberName}
						selectedWorkspaceId={selectedWorkspaceId}
						allowLocalWorkspacePath={bootstrap?.platformPolicy?.allowLocalWorkspacePath ?? true}
						isAccountMode={Boolean(accountUser)}
						onRefresh={refreshBootstrap}
						onNotice={(msg) => setNoticeBanner(msg)}
						onError={(msg) => setErrorBanner(msg)}
						onOpenMatter={(matterId) => navigateRoute({ tab: "chats", matterId })}
						onOpenSpace={(targetId) => navigateRoute({ tab: "deliverables", spacePageId: targetId })}
						onUseWorkspace={(workspaceId) => {
							setSelectedWorkspaceId(workspaceId);
							startNewMatter();
						}}
					/>
				</ViewFade>
			)}

			{activeTab === "settings" && (
				<ViewFade>
					<SettingsView
						{...settingsProps}
						currentUser={currentUser}
						isSuperAdmin={isSuperAdmin}
						organizations={bootstrap?.organizations ?? []}
						workspaces={bootstrap?.workspaces ?? []}
						activeSection={settingsSection}
						onSelectSection={(section) => navigateRoute({ tab: "settings", settingsSection: section })}
						onNotice={(msg) => setNoticeBanner(msg)}
						onError={(msg) => setErrorBanner(msg)}
						onOpenTeam={() => navigateRoute({ tab: "team" })}
						onOpenMatter={(matterId) => navigateRoute({ tab: "chats", matterId })}
						onStartMatterWithPrompt={(prompt) => {
							startNewMatter();
							setComposerText(prompt);
							requestAnimationFrame(() => composerRef.current?.focus());
						}}
					/>
				</ViewFade>
			)}

			{activeTab === "admin" && isSuperAdmin && (
				<ViewFade>
					<AdminView
						{...adminProps}
						currentUserId={accountUser?.id ?? null}
						onNotice={setNoticeBanner}
						onError={setErrorBanner}
					/>
				</ViewFade>
			)}

			{activeTab === "account" && (
				<ViewFade>
					<AccountView
						accountUser={accountUser}
						currentUser={currentUser}
						authKind={bootstrap?.authKind ?? authKind}
						requireAuth={serverRequireAuth}
						organizations={bootstrap?.organizations ?? []}
						workspaces={bootstrap?.workspaces ?? []}
						onSwitchOrLogout={handleSidebarSwitchOrLogout}
						onNotice={setNoticeBanner}
						onError={setErrorBanner}
					/>
				</ViewFade>
			)}
		</ErrorBoundary>
	);
}

/** Confirmation dialog for archiving or restoring a matter from the sidebar or chat header. */
export function AppArchiveConfirmModal({ onConfirm }: { onConfirm: () => void }) {
	const pendingArchiveConfirm = useWorkbenchStore((s) => s.pendingArchiveConfirm);
	const archivingMatter = useWorkbenchStore((s) => s.archivingMatter);
	const closeArchiveConfirm = useWorkbenchStore((s) => s.closeArchiveConfirm);
	const onClose = () => {
		if (!archivingMatter) closeArchiveConfirm();
	};

	return (
		<ModalDialog
			open={Boolean(pendingArchiveConfirm)}
			title={pendingArchiveConfirm?.archived ? "确认归档事项" : "确认恢复事项"}
			subtitle={
				pendingArchiveConfirm?.archived
					? "归档不会删除历史对话或空间文档，仅将事项置为只读状态。"
					: "恢复后该事项将回到左侧最近事项列表，并可继续对话。"
			}
			size="sm"
			closeDisabled={archivingMatter}
			onClose={onClose}
			footer={
				<>
					<Button variant="secondary" size="sm" disabled={archivingMatter} onClick={onClose}>
						取消
					</Button>
					<Button variant="primary" size="sm" disabled={archivingMatter} onClick={onConfirm}>
						{archivingMatter ? "处理中…" : pendingArchiveConfirm?.archived ? "确认归档" : "确认恢复"}
					</Button>
				</>
			}
		>
			{pendingArchiveConfirm && (
				<p className="m-0 text-xs text-ink-muted leading-relaxed">
					{pendingArchiveConfirm.archived
						? `确定要归档「${pendingArchiveConfirm.title}」吗？归档后将不能继续发送消息，可随时恢复。`
						: `确定要恢复「${pendingArchiveConfirm.title}」为活跃事项吗？`}
				</p>
			)}
		</ModalDialog>
	);
}
