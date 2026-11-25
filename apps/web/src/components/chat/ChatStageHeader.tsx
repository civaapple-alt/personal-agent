import type { RefObject } from "react";
import type {
	CollaboratorDto,
	MatterDetailPayload,
	MatterProgressDto,
	OrganizationDto,
	TeamMemberDto,
	WorkspaceDto,
} from "../../api.ts";
import { BotFaceIcon } from "../../primitives/BotFaceIcon.tsx";

import type { MatterCollabTab } from "./MatterCollabDrawer.tsx";

interface ChatStageHeaderProps {
	selectedOrganization: OrganizationDto | null;
	selectedWorkspace: WorkspaceDto | null;
	headerTheme: { bg: string; tilt: string };
	contactLabel: string;
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
	collabTab: MatterCollabTab;
	moreMenuOpen: boolean;
	deliverablesCount: number;
	headerHumansBtnRef: RefObject<HTMLButtonElement | null>;
	moreMenuWrapRef: RefObject<HTMLDivElement | null>;
	onToggleRoster: () => void;
	onToggleMoreMenu: () => void;
	onSelectMorePanel: (tab: Exclude<MatterCollabTab, "events">) => void;
}

/** Top header bar of the active chat workspace with context pills, roster trigger, and overflow actions. */
export function ChatStageHeader({
	selectedOrganization,
	selectedWorkspace,
	headerTheme,
	contactLabel,
	matterDetail,
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
	deliverablesCount,
	headerHumansBtnRef,
	moreMenuWrapRef,
	onToggleRoster,
	onToggleMoreMenu,
	onSelectMorePanel,
}: ChatStageHeaderProps) {
	const hasContext = Boolean(matterDetail);

	return (
		<header className={`stage-header${hasContext ? " has-context" : ""}`}>
			<div className="stage-header-left">
				{matterDetail && (
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
				)}
			</div>
			<div className="stage-center-pill">
				<BotFaceIcon
					bg={headerTheme.bg}
					size="sm"
					mood={isTurnRunning && activeMatterProgress ? activeMatterProgress.stage : "idle"}
				/>
				<span className="stage-center-name">{contactLabel}</span>
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
				{matterDetail && (
					<div ref={moreMenuWrapRef} className="header-more-wrap">
						<button
							type="button"
							aria-label="更多功能"
							aria-haspopup="menu"
							aria-expanded={moreMenuOpen}
							className={`btn-pill-outline btn-xs header-more-btn ${moreMenuOpen || collabOpen ? "active" : ""}`}
							title="团队委托与资料空间"
							onClick={onToggleMoreMenu}
						>
							<span aria-hidden="true">···</span>
						</button>
						{moreMenuOpen && (
							<div role="menu" aria-label="更多功能" className="header-more-menu">
								<button
									type="button"
									role="menuitem"
									className={`header-more-item ${collabOpen && (collabTab === "delegations" || collabTab === "events") ? "active" : ""}`}
									onClick={() => onSelectMorePanel("delegations")}
								>
									<span className="header-more-label">团队委托与事件</span>
								</button>
								<button
									type="button"
									role="menuitem"
									className={`header-more-item ${collabOpen && collabTab === "deliverables" ? "active" : ""}`}
									onClick={() => onSelectMorePanel("deliverables")}
								>
									<span className="header-more-label">资料空间</span>
									<span className="header-more-meta">{deliverablesCount}</span>
								</button>
							</div>
						)}
					</div>
				)}
			</div>
		</header>
	);
}
