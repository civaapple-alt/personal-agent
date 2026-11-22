import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { BootstrapPayload, CollaboratorDto, MatterDto, MatterProgressDto } from "../api.ts";
import { filterBusinessMembers, isArchitectMember, ROLE_ARCHITECT_MEMBER_ID } from "../architectApi.ts";
import type { HashRoute, NavTab } from "../hashRouter.ts";
import { getBotTheme, inferDelegationMood, type RoleMood, stripMarkdownFormatting } from "../utils.ts";
import { BotFaceIcon } from "./BotFaceIcon.tsx";

type MatterViewMode = "time" | "grouped";

const SIDEBAR_VIEW_STORAGE_KEY = "pa_sidebar_matter_view";

function readInitialViewMode(): MatterViewMode {
	try {
		return window.localStorage.getItem(SIDEBAR_VIEW_STORAGE_KEY) === "grouped" ? "grouped" : "time";
	} catch {
		return "time";
	}
}

interface SidebarProps {
	activeTab: NavTab;
	bootstrap: BootstrapPayload | null;
	currentUser?: CollaboratorDto | null;
	authKind?: "session" | "legacy_token" | "loopback" | null;
	requireAuth?: boolean | null;
	isSuperAdmin?: boolean;
	orgEffectiveMemberIds?: string[] | null;
	runtimeBadge?: string | null;
	filteredMatters: MatterDto[];
	selectedMatterId: string | null;
	selectedMemberId: string;
	selectedDeliverableId: string | null;
	progressByMatter: Record<string, MatterProgressDto>;
	sseConnected: boolean;
	searchQuery: string;
	mobileOpen?: boolean;
	onCloseMobile?: () => void;
	onSearchQueryChange: (q: string) => void;
	onNavigate: (route: HashRoute) => void;
	onToggleMember: (memberId: string) => void;
	onNewMatter: () => void;
	onToggleArchiveMatter?: (matterId: string, archived: boolean) => Promise<void> | void;
	onSwitchOrLogout?: () => void;
}

/** Memoized so streamed text deltas and run timers in the workbench do not re-render the navigation tree. */
export const Sidebar = memo(function Sidebar({
	activeTab,
	bootstrap,
	currentUser,
	authKind = null,
	requireAuth = null,
	isSuperAdmin = false,
	orgEffectiveMemberIds = null,
	runtimeBadge,
	filteredMatters,
	selectedMatterId,
	selectedMemberId,
	selectedDeliverableId,
	progressByMatter,
	sseConnected,
	searchQuery,
	mobileOpen = false,
	onCloseMobile,
	onSearchQueryChange,
	onNavigate,
	onToggleMember,
	onNewMatter,
	onToggleArchiveMatter,
	onSwitchOrLogout,
}: SidebarProps) {
	const [searchOpen, setSearchOpen] = useState(false);
	const [viewMode, setViewMode] = useState<MatterViewMode>(readInitialViewMode);
	const [showArchived, setShowArchived] = useState(false);
	const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
	const [busyArchiveId, setBusyArchiveId] = useState<string | null>(null);
	const [footerMenuOpen, setFooterMenuOpen] = useState(false);
	const [rosterExpanded, setRosterExpanded] = useState(false);
	const footerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!footerMenuOpen) return;
		const onPointerDown = (event: MouseEvent) => {
			if (footerRef.current && !footerRef.current.contains(event.target as Node)) {
				setFooterMenuOpen(false);
			}
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setFooterMenuOpen(false);
		};
		document.addEventListener("mousedown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("mousedown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [footerMenuOpen]);

	const workspaces = bootstrap?.workspaces;
	const organizations = bootstrap?.organizations;
	const workspaceById = useMemo(
		() => new Map(workspaces?.map((workspace) => [workspace.id, workspace])),
		[workspaces],
	);
	const organizationById = useMemo(() => new Map(organizations?.map((org) => [org.id, org.name])), [organizations]);

	const activeMatters = useMemo(
		() => filteredMatters.filter((matter) => matter.status !== "archived"),
		[filteredMatters],
	);
	const archivedMatters = useMemo(
		() => filteredMatters.filter((matter) => matter.status === "archived"),
		[filteredMatters],
	);
	const visibleMatters = showArchived ? archivedMatters : activeMatters;

	const groupedMatters = useMemo(() => {
		const groups = new Map<
			string,
			{
				key: string;
				orgLabel: string;
				workspaceLabel: string;
				items: MatterDto[];
			}
		>();
		for (const matter of visibleMatters) {
			const workspace = matter.workspaceId ? workspaceById.get(matter.workspaceId) : undefined;
			const orgId = matter.orgId === undefined ? workspace?.orgId : matter.orgId;
			const orgLabel = orgId ? (organizationById.get(orgId) ?? "不可见") : "独立";
			const workspaceLabel = matter.workspaceId ? (workspace?.name ?? "不可见") : "未绑定仓库";
			const key = `${orgId ?? "__none__"}::${matter.workspaceId ?? "__none__"}`;
			const existing = groups.get(key);
			if (existing) {
				existing.items.push(matter);
			} else {
				groups.set(key, { key, orgLabel, workspaceLabel, items: [matter] });
			}
		}
		return [...groups.values()];
	}, [visibleMatters, workspaceById, organizationById]);

	const setAndPersistViewMode = (next: MatterViewMode) => {
		setViewMode(next);
		try {
			window.localStorage.setItem(SIDEBAR_VIEW_STORAGE_KEY, next);
		} catch {
			// Ignore storage errors in restricted contexts.
		}
	};

	const allMembers = bootstrap?.members ?? [];
	const allBusinessMembers = filterBusinessMembers(allMembers);
	const businessMembers =
		orgEffectiveMemberIds && orgEffectiveMemberIds.length > 0
			? allBusinessMembers.filter((m) => orgEffectiveMemberIds.includes(m.id) || m.roleScope === "personal")
			: allBusinessMembers;
	const architectMember = allMembers.find((m) => isArchitectMember(m)) ?? null;
	const getWorkingMood = (memberId: string): RoleMood => {
		for (const [mId, prog] of Object.entries(progressByMatter)) {
			const delegated = prog.activeDelegations?.find((entry) => entry.memberId === memberId);
			if (delegated) return inferDelegationMood(delegated.stageLabel);
			const matter = bootstrap?.matters.find((m) => m.id === mId);
			if (matter?.leadMemberId === memberId) return prog.stage;
		}
		return "idle";
	};
	const architectIdx = architectMember ? allMembers.findIndex((m) => m.id === architectMember.id) : -1;
	const architectTheme = getBotTheme(architectIdx >= 0 ? architectIdx : 0);
	const architectMood = architectMember ? getWorkingMood(architectMember.id) : "idle";
	const architectSelected =
		Boolean(architectMember) &&
		activeTab === "chats" &&
		!selectedMatterId &&
		selectedMemberId === architectMember?.id;

	const runningCount = Object.keys(progressByMatter).length;
	const userLabel =
		authKind === "session" && bootstrap?.accountUser
			? `${bootstrap.accountUser.displayName} · ${bootstrap.accountUser.platformRole === "super_admin" ? "超管" : "成员"}`
			: authKind === "legacy_token" && currentUser
				? `${currentUser.name} · 协同访客`
				: currentUser
					? `${currentUser.name} · 本机所有者`
					: "Pi RPC";
	const accountActionLabel =
		authKind === "loopback"
			? "切换账号"
			: authKind === "legacy_token"
				? window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost"
					? "恢复所有者"
					: "退出"
				: "退出登录";
	const hasSecondaryTabActive = activeTab !== "chats";

	const handleArchiveClick = async (matter: MatterDto) => {
		if (!onToggleArchiveMatter || busyArchiveId) return;
		setBusyArchiveId(matter.id);
		try {
			await onToggleArchiveMatter(matter.id, matter.status !== "archived");
		} finally {
			setBusyArchiveId(null);
		}
	};

	const renderMatterRow = (matter: MatterDto) => {
		const prog = progressByMatter[matter.id];
		const workspace = matter.workspaceId ? workspaceById.get(matter.workspaceId) : undefined;
		const orgId = matter.orgId === undefined ? workspace?.orgId : matter.orgId;
		const orgLabel = orgId ? (organizationById.get(orgId) ?? "不可见") : "独立";
		const workspaceLabel = matter.workspaceId ? (workspace?.name ?? "不可见") : "未绑定";
		const leadIdx = bootstrap?.members.findIndex((m) => m.id === matter.leadMemberId) ?? 0;
		const theme = getBotTheme(leadIdx >= 0 ? leadIdx : 0);
		const isActive = activeTab === "chats" && selectedMatterId === matter.id;
		const isArchived = matter.status === "archived";
		const isWaitingUser = !prog && matter.status === "waiting_user";
		const statusLabel = prog
			? stripMarkdownFormatting(prog.label) || "运行中"
			: isWaitingUser
				? "等待你的确认"
				: matter.status === "delivered"
					? "已交付"
					: matter.status === "archived"
						? "已归档"
						: null;
		const tooltip = statusLabel
			? `${matter.title}\n组织：${orgLabel} · 仓库：${workspaceLabel}\n状态：${statusLabel}`
			: `${matter.title}\n组织：${orgLabel} · 仓库：${workspaceLabel}`;

		return (
			<div key={matter.id} className={`matter-row ${isActive ? "active" : ""} ${isArchived ? "is-archived" : ""}`}>
				<button
					type="button"
					className="matter-item"
					title={tooltip}
					onClick={() => onNavigate({ tab: "chats", matterId: matter.id })}
				>
					<span
						className={`matter-dot${prog ? " is-running" : isWaitingUser ? " is-waiting" : ""}`}
						style={{ background: theme.bg }}
					>
						{prog && <span className="matter-dot-pulse" style={{ borderColor: theme.bg }} />}
					</span>
					<span className="matter-title">{matter.title}</span>
					{prog ? (
						<span className="matter-state-tag is-running">运行中</span>
					) : isWaitingUser ? (
						<span className="matter-state-tag is-waiting">待确认</span>
					) : null}
				</button>
				{onToggleArchiveMatter && (
					<button
						type="button"
						className="matter-archive-btn"
						disabled={busyArchiveId === matter.id || (!isArchived && Boolean(prog))}
						aria-label={isArchived ? `取消归档：${matter.title}` : `归档事项：${matter.title}`}
						title={
							!isArchived && prog ? "运行中的事项请先停止再归档" : isArchived ? "恢复至最近事项" : "归档事项"
						}
						onClick={() => void handleArchiveClick(matter)}
					>
						{isArchived ? (
							<svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
								<path
									d="M3.5 6.5L6.5 3.5L9.5 6.5M6.5 4V10.5C6.5 11.6 7.4 12.5 8.5 12.5H12.5"
									stroke="currentColor"
									strokeWidth="1.5"
									strokeLinecap="round"
									strokeLinejoin="round"
								/>
							</svg>
						) : (
							<svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
								<rect
									x="2.25"
									y="2.75"
									width="11.5"
									height="2.75"
									rx="0.9"
									stroke="currentColor"
									strokeWidth="1.35"
								/>
								<path
									d="M3.25 5.5V12C3.25 12.7 3.8 13.25 4.5 13.25H11.5C12.2 13.25 12.75 12.7 12.75 12V5.5"
									stroke="currentColor"
									strokeWidth="1.35"
								/>
								<path d="M6.25 8.5H9.75" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
							</svg>
						)}
					</button>
				)}
			</div>
		);
	};

	const navigateFromMenu = (route: HashRoute) => {
		setFooterMenuOpen(false);
		onNavigate(route);
	};

	return (
		<aside className={`bot-sidebar ${mobileOpen ? "mobile-open" : ""}`}>
			<div className="sidebar-top">
				<div className="sidebar-brand">
					<button
						type="button"
						className="brand-btn"
						onClick={() => onNavigate({ tab: "chats", matterId: selectedMatterId ?? undefined })}
					>
						<span className="brand-mark">PA</span>
						<span className="brand-name">Personal Agent</span>
					</button>
					{typeof requireAuth === "boolean" && (
						<span
							className={`edition-badge ${requireAuth ? "team" : "personal"}`}
							title={requireAuth ? "团队多成员版（PA_REQUIRE_AUTH=1）" : "个人本机版（未开启 PA_REQUIRE_AUTH）"}
						>
							{requireAuth ? "团队版" : "个人版"}
						</span>
					)}
				</div>
				<div className="sidebar-tools">
					<button
						type="button"
						className={`icon-btn ${searchOpen ? "active" : ""}`}
						aria-label="搜索事项与交付"
						onClick={() => {
							const next = !searchOpen;
							setSearchOpen(next);
							if (!next) onSearchQueryChange("");
						}}
					>
						<svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true">
							<circle cx="9" cy="9" r="5.5" stroke="currentColor" strokeWidth="1.7" />
							<path d="M13.5 13.5L17 17" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
						</svg>
					</button>
					<button type="button" className="icon-btn" aria-label="新建事项" onClick={onNewMatter}>
						<svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true">
							<path d="M10 4.5v11M4.5 10h11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
						</svg>
					</button>
					{onCloseMobile && (
						<button
							type="button"
							className="icon-btn mobile-close-btn"
							aria-label="收起侧栏"
							onClick={onCloseMobile}
						>
							<svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true">
								<path d="M5.5 5.5l9 9m0-9l-9 9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
							</svg>
						</button>
					)}
				</div>
			</div>

			{searchOpen && (
				<div className="sidebar-search">
					<input
						className="input-field"
						placeholder="搜索事项或交付标题…"
						value={searchQuery}
						onChange={(e) => onSearchQueryChange(e.target.value)}
					/>
				</div>
			)}

			{(() => {
				const maxCollapsed = 8;
				const hasOverflow = businessMembers.length > maxCollapsed;
				const displayedMembers =
					hasOverflow && !rosterExpanded ? businessMembers.slice(0, maxCollapsed - 1) : businessMembers;
				const hiddenCount = businessMembers.length - displayedMembers.length;
				return (
					<div className={`roster-strip${rosterExpanded ? " is-expanded" : ""}`}>
						{displayedMembers.map((member) => {
							const idx = allMembers.findIndex((m) => m.id === member.id);
							const theme = getBotTheme(idx >= 0 ? idx : 0);
							const isSelected = activeTab === "chats" && !selectedMatterId && selectedMemberId === member.id;
							const workingMood = getWorkingMood(member.id);
							const isWorking = workingMood !== "idle";
							return (
								<button
									key={member.id}
									type="button"
									className={`roster-tile ${isSelected ? "active" : ""}`}
									onClick={() => onToggleMember(member.id)}
									title={`${member.displayName} · ${member.roleTitle}（点击指定该角色发起新事项）`}
								>
									<span className="roster-avatar-wrap">
										<BotFaceIcon bg={theme.bg} tilt={theme.tilt} size="md" mood={workingMood} />
										{isWorking && <span className="roster-working-dot" />}
									</span>
									<span className="roster-name">{member.displayName}</span>
								</button>
							);
						})}
						{hasOverflow && (
							<button
								type="button"
								className="roster-tile roster-more-tile"
								aria-expanded={rosterExpanded}
								onClick={() => setRosterExpanded((open) => !open)}
								title={rosterExpanded ? "收起角色列表" : `展开全部 ${businessMembers.length} 个角色`}
							>
								<span className="roster-more-circle">{rosterExpanded ? "收起" : `+${hiddenCount}`}</span>
								<span className="roster-name">{rosterExpanded ? "收起列表" : "更多角色"}</span>
							</button>
						)}
					</div>
				);
			})()}

			{architectMember && (
				<div className="architect-sidebar-wrap">
					<button
						type="button"
						className={`architect-sidebar-entry ${architectSelected ? "active" : ""}`}
						onClick={() => onToggleMember(ROLE_ARCHITECT_MEMBER_ID)}
						title="角色架构师 · 规划 1~N 个新角色或做团队协作体检（进入独立对话）"
					>
						<span className="roster-avatar-wrap">
							<BotFaceIcon bg={architectTheme.bg} tilt={architectTheme.tilt} size="xs" mood={architectMood} />
							{architectMood !== "idle" && <span className="roster-working-dot" />}
						</span>
						<span className="architect-sidebar-copy">
							<strong>{architectMember.displayName}</strong>
							<small>按流程定制角色与边界</small>
						</span>
						<span className="architect-sidebar-arrow" aria-hidden="true">
							{architectSelected ? "已选" : "→"}
						</span>
					</button>
				</div>
			)}

			<div className="matter-scroll">
				<div className="sidebar-matters-toolbar">
					<div className="sidebar-matter-tabs" role="tablist" aria-label="事项范围">
						<button
							type="button"
							role="tab"
							aria-selected={!showArchived}
							className={`sidebar-mini-tab ${!showArchived ? "active" : ""}`}
							onClick={() => setShowArchived(false)}
						>
							最近 <span className="sidebar-mini-count">{activeMatters.length}</span>
						</button>
						<button
							type="button"
							role="tab"
							aria-selected={showArchived}
							className={`sidebar-mini-tab ${showArchived ? "active" : ""}`}
							onClick={() => setShowArchived(true)}
						>
							归档 <span className="sidebar-mini-count">{archivedMatters.length}</span>
						</button>
					</div>
					<fieldset className="sidebar-view-switch" aria-label="事项排列方式">
						<button
							type="button"
							className={`sidebar-view-btn ${viewMode === "time" ? "active" : ""}`}
							aria-pressed={viewMode === "time"}
							title="按更新时间倒序"
							onClick={() => setAndPersistViewMode("time")}
						>
							时间
						</button>
						<button
							type="button"
							className={`sidebar-view-btn ${viewMode === "grouped" ? "active" : ""}`}
							aria-pressed={viewMode === "grouped"}
							title="按组织和仓库分类"
							onClick={() => setAndPersistViewMode("grouped")}
						>
							分组
						</button>
					</fieldset>
				</div>

				{visibleMatters.length === 0 ? (
					<div className="sidebar-empty">{showArchived ? "暂无已归档事项" : "暂无事项，可在右侧直接布置任务"}</div>
				) : viewMode === "time" ? (
					visibleMatters.map((matter) => renderMatterRow(matter))
				) : (
					groupedMatters.map((group) => {
						const collapsed = Boolean(collapsedGroups[group.key]);
						return (
							<section key={group.key} className="matter-group">
								<button
									type="button"
									className="matter-group-header"
									aria-expanded={!collapsed}
									onClick={() =>
										setCollapsedGroups((prev) => ({
											...prev,
											[group.key]: !prev[group.key],
										}))
									}
								>
									<span className="matter-group-chevron" aria-hidden="true">
										{collapsed ? "▸" : "▾"}
									</span>
									<span className="matter-group-labels" title={`${group.orgLabel} / ${group.workspaceLabel}`}>
										<span className="matter-group-org">{group.orgLabel}</span>
										<span className="matter-group-sep" aria-hidden="true">
											/
										</span>
										<span className="matter-group-repo">{group.workspaceLabel}</span>
									</span>
									<span className="matter-group-count">{group.items.length}</span>
								</button>
								{!collapsed && (
									<div className="matter-group-items">
										{group.items.map((matter) => renderMatterRow(matter))}
									</div>
								)}
							</section>
						);
					})
				)}
			</div>

			<div className="sidebar-footer" ref={footerRef}>
				{footerMenuOpen && (
					<div className="sidebar-footer-popover" role="menu" aria-label="工作台菜单">
						<button
							type="button"
							role="menuitem"
							className={`footer-nav-btn ${activeTab === "deliverables" ? "active" : ""}`}
							onClick={() =>
								navigateFromMenu({ tab: "deliverables", deliverableId: selectedDeliverableId ?? undefined })
							}
						>
							<span>资料空间</span>
							<span className="pill">{bootstrap?.deliverables.length ?? 0}</span>
						</button>
						<button
							type="button"
							role="menuitem"
							className={`footer-nav-btn ${activeTab === "materials" ? "active" : ""}`}
							onClick={() => navigateFromMenu({ tab: "materials" })}
						>
							<span>工作区</span>
							<span className="pill">{bootstrap?.workspaces.length ?? 0}</span>
						</button>
						<button
							type="button"
							role="menuitem"
							className={`footer-nav-btn ${activeTab === "organizations" ? "active" : ""}`}
							onClick={() => navigateFromMenu({ tab: "organizations" })}
						>
							<span>组织</span>
							<span className="pill">{bootstrap?.organizations?.length ?? 0}</span>
						</button>
						<button
							type="button"
							role="menuitem"
							className={`footer-nav-btn ${activeTab === "team" ? "active" : ""}`}
							onClick={() => navigateFromMenu({ tab: "team" })}
						>
							<span>AI 团队</span>
							<span className="pill">{businessMembers.length}</span>
						</button>
						<button
							type="button"
							role="menuitem"
							className={`footer-nav-btn ${activeTab === "settings" ? "active" : ""}`}
							onClick={() => navigateFromMenu({ tab: "settings" })}
						>
							<span>设置</span>
							<span className="pill">{runtimeBadge ?? "Pi RPC"}</span>
						</button>
						{isSuperAdmin && (
							<button
								type="button"
								role="menuitem"
								className={`footer-nav-btn ${activeTab === "admin" ? "active" : ""}`}
								onClick={() => navigateFromMenu({ tab: "admin" })}
							>
								<span>超管控制台</span>
								<span className="pill">Admin</span>
							</button>
						)}
						{onSwitchOrLogout && (
							<>
								<div className="sidebar-footer-divider" />
								<button
									type="button"
									role="menuitem"
									className="footer-nav-btn footer-nav-account"
									onClick={() => {
										setFooterMenuOpen(false);
										onSwitchOrLogout();
									}}
								>
									<span>{accountActionLabel}</span>
								</button>
							</>
						)}
					</div>
				)}
				<div className="sidebar-footer-bar">
					<span className="sidebar-footer-user" title={userLabel}>
						{userLabel}
					</span>
					<span
						className={`pill ${sseConnected ? "live" : ""}`}
						title={
							!sseConnected
								? "实时连接断开，正在重连"
								: runningCount > 0
									? `实时已连接 · 当前 ${runningCount} 个事项运行中`
									: "实时已连接"
						}
					>
						{!sseConnected ? "重连" : runningCount > 0 ? `运行 ${runningCount}` : "实时"}
					</span>
					<button
						type="button"
						className={`sidebar-settings-trigger ${footerMenuOpen || hasSecondaryTabActive ? "active" : ""}`}
						aria-haspopup="menu"
						aria-expanded={footerMenuOpen}
						aria-label="展开工作台与设置菜单"
						onClick={() => setFooterMenuOpen((open) => !open)}
					>
						<svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
							<circle cx="8" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.4" />
							<path
								d="M8 1.9V3.3M8 12.7V14.1M1.9 8H3.3M12.7 8H14.1M3.7 3.7L4.7 4.7M11.3 11.3L12.3 12.3M12.3 3.7L11.3 4.7M4.7 11.3L3.7 12.3"
								stroke="currentColor"
								strokeWidth="1.35"
								strokeLinecap="round"
							/>
						</svg>
						<span>设置</span>
					</button>
				</div>
			</div>
		</aside>
	);
});
