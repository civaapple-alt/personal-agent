import type { RefObject } from "react";
import type {
	CollaboratorDto,
	MatterDetailPayload,
	MatterProgressDto,
	OrganizationDto,
	TeamMemberDto,
	WorkspaceDto,
} from "../../api.ts";
import { BotFaceIcon } from "../BotFaceIcon.tsx";

interface ChatStageHeaderProps {
	selectedOrganization: OrganizationDto | null;
	selectedWorkspace: WorkspaceDto | null;
	headerTheme: { bg: string; tilt: string };
	headerContact: TeamMemberDto | null;
	matterDetail: MatterDetailPayload | null;
	isArchitectMode?: boolean;
	isTurnRunning: boolean;
	activeMatterProgress: MatterProgressDto | null;
	allActiveHumans: CollaboratorDto[];
	inGroupAiMembers: TeamMemberDto[];
	totalAiMembersCount: number;
	leadAi: TeamMemberDto | null;
	nonLeadGroupAiMembers: TeamMemberDto[];
	observerAis: TeamMemberDto[];
	observersEnabled: boolean;
	rosterOpen: boolean;
	collabOpen: boolean;
	collabTab: "delegations" | "events" | "experiences";
	moreMenuOpen: boolean;
	pendingMatterMemoriesCount: number;
	matterMemoriesCount: number;
	deliverablesCount: number;
	activeChatDeliverableId: string | null;
	selectedDeliverableId: string | null;
	headerHumansBtnRef: RefObject<HTMLButtonElement | null>;
	moreMenuWrapRef: RefObject<HTMLDivElement | null>;
	onToggleRoster: () => void;
	onToggleMoreMenu: () => void;
	onSelectMoreCollab: () => void;
	onSelectMoreExperiences: () => void;
	onOpenDeliverables: (deliverableId?: string) => void;
	onCloseMenus: () => void;
}

/** Top header bar of the active chat workspace with context pills, roster trigger, and overflow actions. */
export function ChatStageHeader({
	selectedOrganization,
	selectedWorkspace,
	headerTheme,
	headerContact,
	matterDetail,
	isArchitectMode = false,
	isTurnRunning,
	activeMatterProgress,
	allActiveHumans,
	inGroupAiMembers,
	totalAiMembersCount,
	leadAi,
	nonLeadGroupAiMembers,
	observerAis,
	observersEnabled,
	rosterOpen,
	collabOpen,
	collabTab,
	moreMenuOpen,
	pendingMatterMemoriesCount,
	matterMemoriesCount,
	deliverablesCount,
	activeChatDeliverableId,
	selectedDeliverableId,
	headerHumansBtnRef,
	moreMenuWrapRef,
	onToggleRoster,
	onToggleMoreMenu,
	onSelectMoreCollab,
	onSelectMoreExperiences,
	onOpenDeliverables,
	onCloseMenus,
}: ChatStageHeaderProps) {
	const hasContext = Boolean(isArchitectMode || matterDetail);

	return (
		<header className={`stage-header${hasContext ? " has-context" : ""}`}>
			<div className="stage-header-left">
				{isArchitectMode ? (
					<span className="pill" title="角色架构师以团队全局成员配置工作，不绑定具体代码仓库">
						团队建队规划 · 全局名录
					</span>
				) : (
					matterDetail && (
						<>
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
						</>
					)
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
						`协作 AI（${inGroupAiMembers.length}/${totalAiMembersCount}）：${leadAi ? `负责人 ${leadAi.displayName}` : ""}${nonLeadGroupAiMembers.length > 0 ? `、${nonLeadGroupAiMembers.map((m) => m.displayName).join("、")}` : ""}`,
						`AI 旁听：${observersEnabled ? `已开启（${observerAis.length} 位）` : "未开启"}`,
					]
						.filter(Boolean)
						.join("\n")}
					onClick={onToggleRoster}
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
						onClick={onToggleMoreMenu}
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
										onClick={onSelectMoreCollab}
									>
										<span className="header-more-label">团队委托与事件</span>
									</button>
									<button
										type="button"
										role="menuitem"
										className={`header-more-item ${collabOpen && collabTab === "experiences" ? "active" : ""}`}
										onClick={onSelectMoreExperiences}
									>
										<span className="header-more-label">经验复盘</span>
										<span className="header-more-meta">
											{matterMemoriesCount}
											{pendingMatterMemoriesCount > 0 && (
												<span className="header-more-pending">· {pendingMatterMemoriesCount} 待核验</span>
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
									onCloseMenus();
									onOpenDeliverables(activeChatDeliverableId ?? selectedDeliverableId ?? undefined);
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
	);
}
