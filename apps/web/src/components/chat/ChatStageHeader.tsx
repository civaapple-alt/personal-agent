import type { RefObject } from "react";
import type {
	CollaboratorDto,
	MatterDetailPayload,
	MatterProgressDto,
	OrganizationDto,
	TeamMemberDto,
	WorkspaceDto,
} from "../../api.ts";
import { Badge, BotFaceIcon, Button } from "../../primitives/index.ts";
import { cn } from "../../utils/cn.ts";

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
		<header className="@container min-h-12 px-3.5 md:px-5 py-1.5 border-b border-line bg-stage flex flex-wrap @[640px]:flex-nowrap items-center justify-between gap-x-2.5 gap-y-1 min-w-0 shrink-0">
			<div
				className={cn(
					"flex items-center gap-1.5 min-w-0 overflow-hidden flex-wrap @[640px]:flex-nowrap",
					hasContext ? "flex-1 @[640px]:flex-initial" : "flex-1",
				)}
			>
				{matterDetail && (
					<>
						{selectedOrganization && (
							<Badge
								tone="accent"
								size="sm"
								className="max-w-full md:max-w-[210px] truncate"
								title={
									selectedOrganization.description ||
									`所属组织：${selectedOrganization.name}（同组织共享组织记忆与默认 Git 域名）`
								}
							>
								组织：{selectedOrganization.name}
							</Badge>
						)}
						{selectedWorkspace ? (
							<Badge
								tone="neutral"
								size="sm"
								className="max-w-full md:max-w-[210px] truncate"
								title={
									selectedWorkspace.repoGitUser
										? `Git Committer（真实用户保留）：${selectedWorkspace.repoGitUser.name} <${selectedWorkspace.repoGitUser.email}>`
										: selectedWorkspace.repoPath
								}
							>
								仓库：{selectedWorkspace.name}
							</Badge>
						) : (
							<Badge tone="neutral" size="sm" className="max-w-full md:max-w-[210px] truncate">
								{selectedOrganization ? "未绑定仓库" : "通用工作区"}
							</Badge>
						)}
					</>
				)}
			</div>
			<div
				className={cn(
					"hidden @[580px]:inline-flex items-center gap-2 py-1 pr-3 pl-1.5 rounded-pill bg-subtle border border-line text-sm flex-initial min-w-0 overflow-hidden",
					hasContext ? "min-w-[80px] max-w-[38%]" : "max-w-[44%]",
				)}
			>
				<BotFaceIcon
					bg={headerTheme.bg}
					size="sm"
					mood={isTurnRunning && activeMatterProgress ? activeMatterProgress.stage : "idle"}
				/>
				<span className="font-semibold text-ink whitespace-nowrap">{contactLabel}</span>
				{matterDetail && <span className="text-ink-secondary truncate">· {matterDetail.matter.title}</span>}
			</div>
			<div
				className={cn(
					"flex items-center justify-end gap-2 min-w-0 ml-auto @[640px]:ml-0",
					hasContext ? "flex-none @[640px]:flex-initial" : "flex-none @[640px]:flex-1",
				)}
			>
				<Button
					ref={headerHumansBtnRef}
					variant="secondary"
					size="xs"
					aria-expanded={rosterOpen}
					className={cn(
						"h-[30px] px-2.5 rounded-pill max-w-[240px] overflow-hidden",
						rosterOpen && "border-accent bg-accent-soft text-accent",
					)}
					title={[
						`人类成员（${allActiveHumans.length || 1}人）：${allActiveHumans.length > 0 ? allActiveHumans.map((h) => `${h.name}·${h.permissionRole === "owner" ? "所有者" : h.roleTitle}`).join("、") : "当前用户"}`,
						`协作 AI（${inGroupAiMembers.length}/${totalAiMembersCount}）：${leadAi ? `负责人 ${leadAi.displayName}` : ""}${nonLeadGroupAiMembers.length > 0 ? `、${nonLeadGroupAiMembers.map((m) => m.displayName).join("、")}` : ""}`,
						`AI 旁听：${observersEnabled ? `已开启（${observerAis.length} 位）` : "未开启"}`,
					]
						.filter(Boolean)
						.join("\n")}
					onClick={onToggleRoster}
				>
					<span className="inline-flex items-center shrink-0" aria-hidden="true">
						{allActiveHumans.slice(0, 3).map((person) => (
							<span
								key={person.id}
								className={cn(
									"size-[18px] rounded-full inline-flex items-center justify-center text-[10px] font-bold border-[1.5px] border-stage -ml-1.5 first:ml-0",
									person.permissionRole === "owner" ? "bg-cta text-stage" : "bg-info-bg text-info-text",
								)}
							>
								{person.name.slice(0, 1).toUpperCase()}
							</span>
						))}
					</span>
					<span className="whitespace-nowrap truncate max-w-[112px] sm:max-w-none">
						{allActiveHumans.length > 0
							? `协作成员 · ${allActiveHumans
									.slice(0, 2)
									.map((h) => h.name)
									.join("、")}${allActiveHumans.length > 2 ? ` +${allActiveHumans.length - 2}` : ""}`
							: "协作成员 (1)"}
					</span>
					{observersEnabled && (
						<Badge tone="observer" size="xs">
							{observerAis.length > 0 ? `旁听 ${observerAis.length}` : "旁听开"}
						</Badge>
					)}
				</Button>
				{matterDetail && (
					<div ref={moreMenuWrapRef} className="relative inline-flex items-center">
						<Button
							variant="secondary"
							size="xs"
							aria-label="更多功能"
							aria-haspopup="menu"
							aria-expanded={moreMenuOpen}
							className={cn(
								"min-w-9 h-[30px] px-2.5 rounded-pill font-bold tracking-wider",
								(moreMenuOpen || collabOpen) && "border-accent bg-accent-soft text-accent",
							)}
							title="团队委托与资料空间"
							onClick={onToggleMoreMenu}
						>
							<span aria-hidden="true">···</span>
						</Button>
						{moreMenuOpen && (
							<div
								role="menu"
								aria-label="更多功能"
								className="absolute top-[calc(100%+6px)] right-0 z-40 min-w-[224px] p-1.5 rounded-lg border border-line bg-card shadow-lg flex flex-col gap-0.5"
							>
								<button
									type="button"
									role="menuitem"
									className={cn(
										"w-full border-0 rounded-sm px-2.5 py-2 flex items-center justify-between gap-3 text-sm text-left cursor-pointer transition-colors",
										collabOpen && (collabTab === "delegations" || collabTab === "events")
											? "bg-accent-soft text-accent font-semibold"
											: "bg-transparent text-ink hover:bg-hover",
									)}
									onClick={() => onSelectMorePanel("delegations")}
								>
									<span className="whitespace-nowrap">团队委托与事件</span>
								</button>
								<button
									type="button"
									role="menuitem"
									className={cn(
										"w-full border-0 rounded-sm px-2.5 py-2 flex items-center justify-between gap-3 text-sm text-left cursor-pointer transition-colors",
										collabOpen && collabTab === "deliverables"
											? "bg-accent-soft text-accent font-semibold"
											: "bg-transparent text-ink hover:bg-hover",
									)}
									onClick={() => onSelectMorePanel("deliverables")}
								>
									<span className="whitespace-nowrap">资料空间</span>
									<span className="text-xs text-ink-secondary tabular-nums whitespace-nowrap">
										{deliverablesCount}
									</span>
								</button>
							</div>
						)}
					</div>
				)}
			</div>
		</header>
	);
}
