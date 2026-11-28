import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { CollaboratorDto, MatterDto } from "../api.ts";
import { filterBusinessMembers, isArchitectMember, isSoloMember } from "../architectApi.ts";
import type { HashRoute } from "../hashRouter.ts";
import { Badge, BotFaceIcon, IconButton, Input } from "../primitives/index.ts";
import { useMatterRuntimeStore, useSessionStore, useWorkbenchStore } from "../stores/index.ts";
import { cn } from "../utils/cn.ts";
import { getBotTheme, inferDelegationMood, type RoleMood, stripMarkdownFormatting } from "../utils.ts";

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
	currentUser?: CollaboratorDto | null;
	authKind?: "session" | "loopback" | null;
	requireAuth?: boolean | null;
	isSuperAdmin?: boolean;
	orgEffectiveMemberIds?: string[] | null;
	runtimeBadge?: string | null;
	onNavigate: (route: HashRoute) => void;
	onToggleMember: (memberId: string) => void;
	onNewMatter: () => void;
	onToggleArchiveMatter?: (matterId: string, archived: boolean) => Promise<void> | void;
	onSwitchOrLogout?: () => void;
}

/** Memoized so streamed text deltas and run timers in the workbench do not re-render the navigation tree. */
export const Sidebar = memo(function Sidebar({
	currentUser,
	authKind = null,
	requireAuth = null,
	isSuperAdmin = false,
	orgEffectiveMemberIds = null,
	runtimeBadge,
	onNavigate,
	onToggleMember,
	onNewMatter,
	onToggleArchiveMatter,
	onSwitchOrLogout,
}: SidebarProps) {
	const activeTab = useWorkbenchStore((s) => s.activeTab);
	const searchQuery = useWorkbenchStore((s) => s.searchQuery);
	const setSearchQuery = useWorkbenchStore((s) => s.setSearchQuery);
	const mobileOpen = useWorkbenchStore((s) => s.mobileNavOpen);
	const setMobileNavOpen = useWorkbenchStore((s) => s.setMobileNavOpen);

	const bootstrap = useSessionStore((s) => s.bootstrap);
	const selectedMemberId = useSessionStore((s) => s.selectedMemberId);

	const selectedMatterId = useMatterRuntimeStore((s) => s.selectedMatterId);
	const progressByMatter = useMatterRuntimeStore((s) => s.progressByMatter);
	const sseConnected = useMatterRuntimeStore((s) => s.sseConnected);

	const filteredMatters = useMemo(() => {
		const list = bootstrap?.matters ?? [];
		const q = searchQuery.trim().toLowerCase();
		if (!q) return list;
		return list.filter((m) => m.title.toLowerCase().includes(q) || m.summary.toLowerCase().includes(q));
	}, [bootstrap?.matters, searchQuery]);

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
	const soloMembers = allMembers.filter((m) => isSoloMember(m));
	const architectMember = allMembers.find((m) => isArchitectMember(m)) ?? null;
	const businessMembers = [
		...(orgEffectiveMemberIds && orgEffectiveMemberIds.length > 0
			? allBusinessMembers.filter((m) => orgEffectiveMemberIds.includes(m.id) || m.roleScope === "personal")
			: allBusinessMembers),
		...soloMembers,
		...(architectMember ? [architectMember] : []),
	];
	const getWorkingMood = (memberId: string): RoleMood => {
		for (const [mId, prog] of Object.entries(progressByMatter)) {
			const delegated = prog.activeDelegations?.find((entry) => entry.memberId === memberId);
			if (delegated) return inferDelegationMood(delegated.stageLabel);
			const matter = bootstrap?.matters.find((m) => m.id === mId);
			if (matter?.leadMemberId === memberId) return prog.stage;
		}
		return "idle";
	};

	const runningCount = Object.keys(progressByMatter).length;
	const userLabel =
		authKind === "session" && bootstrap?.accountUser
			? `${bootstrap.accountUser.displayName} · ${bootstrap.accountUser.platformRole === "super_admin" ? "超管" : "成员"}`
			: currentUser
				? `${currentUser.name} · 本机所有者`
				: "Pi RPC";
	const accountActionLabel = authKind === "loopback" ? "切换账号" : "退出登录";
	const hasSecondaryTabActive = activeTab !== "chats" && activeTab !== "account";

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
				: matter.status === "archived"
					? "已归档"
					: null;
		const tooltip = statusLabel
			? `${matter.title}\n组织：${orgLabel} · 仓库：${workspaceLabel}\n状态：${statusLabel}`
			: `${matter.title}\n组织：${orgLabel} · 仓库：${workspaceLabel}`;

		return (
			<div
				key={matter.id}
				className={cn(
					"group relative flex items-center border rounded-md transition-colors [content-visibility:auto] [contain-intrinsic-size:auto_34px] focus-visible:[content-visibility:visible] focus-within:[content-visibility:visible]",
					isActive ? "bg-stage border-line shadow-sm" : "border-transparent hover:bg-hover/70",
					isArchived && "opacity-80",
				)}
			>
				<button
					type="button"
					className="flex-1 min-w-0 border-0 bg-transparent rounded-md px-2 py-1.5 flex items-center gap-2 text-left cursor-pointer"
					title={tooltip}
					onClick={() => onNavigate({ tab: "chats", matterId: matter.id })}
				>
					<span
						className={cn("size-2.5 rounded-full shrink-0 relative", isWaitingUser && "ring-2 ring-warn-border")}
						style={{ background: theme.bg }}
					>
						{prog && (
							<span
								className="absolute -inset-[3px] rounded-full border-[1.5px] animate-ping opacity-75 motion-reduce:animate-none"
								style={{ borderColor: theme.bg }}
							/>
						)}
					</span>
					<span
						className={cn("flex-1 min-w-0 text-xs text-ink truncate", isActive ? "font-semibold" : "font-medium")}
					>
						{matter.title}
					</span>
					{prog ? (
						<Badge tone="success" size="xs" className="shrink-0">
							运行中
						</Badge>
					) : isWaitingUser ? (
						<Badge tone="warn" size="xs" className="shrink-0">
							待确认
						</Badge>
					) : null}
				</button>
				{onToggleArchiveMatter && (
					<button
						type="button"
						className={cn(
							"shrink-0 size-6 mr-1 border-0 rounded-sm bg-transparent text-ink-muted inline-flex items-center justify-center cursor-pointer transition-opacity hover:enabled:bg-subtle hover:enabled:text-ink disabled:opacity-35 disabled:cursor-not-allowed",
							isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
						)}
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

	const footerMenuItemClass = (active: boolean) =>
		cn(
			"border-0 rounded-md px-2.5 py-1.5 flex items-center justify-between text-sm font-medium cursor-pointer text-left transition-colors",
			active
				? "bg-accent-soft text-accent font-semibold"
				: "bg-transparent text-ink-secondary hover:bg-subtle hover:text-ink",
		);

	return (
		<aside
			className={cn(
				"bg-sidebar border-r border-line flex flex-col min-w-0 min-h-0 overflow-hidden",
				"max-[960px]:fixed max-[960px]:inset-y-0 max-[960px]:left-0 max-[960px]:z-[60] max-[960px]:w-[min(338px,90vw)] max-[960px]:shadow-lg max-[960px]:transition-transform max-[960px]:duration-200 max-[960px]:ease-out",
				mobileOpen ? "max-[960px]:translate-x-0" : "max-[960px]:-translate-x-[105%]",
				"min-[961px]:w-[292px] min-[961px]:shrink-0",
			)}
		>
			<div className="h-[52px] px-3 flex items-center justify-between gap-1.5 shrink-0">
				<div className="flex items-center gap-1.5 min-w-0 flex-1">
					<button
						type="button"
						className="border-0 bg-transparent inline-flex items-center gap-1.5 min-w-0 text-sm font-semibold text-ink cursor-pointer px-0.5 py-1 rounded-sm hover:opacity-85"
						onClick={() => onNavigate({ tab: "chats", matterId: selectedMatterId ?? undefined })}
					>
						<span className="size-6 rounded-sm bg-cta text-stage grid place-items-center shrink-0 text-micro font-bold">
							PA
						</span>
						<span className="truncate">Personal Agent</span>
					</button>
					{typeof requireAuth === "boolean" && (
						<Badge
							tone={requireAuth ? "accent" : "neutral"}
							size="xs"
							title={requireAuth ? "团队多成员版（PA_REQUIRE_AUTH=1）" : "个人本机版（未开启 PA_REQUIRE_AUTH）"}
						>
							{requireAuth ? "团队版" : "个人版"}
						</Badge>
					)}
				</div>
				<div className="flex items-center gap-1 shrink-0">
					<IconButton
						size="sm"
						variant="secondary"
						active={searchOpen}
						className="rounded-full"
						aria-label="搜索事项与交付"
						onClick={() => {
							const next = !searchOpen;
							setSearchOpen(next);
							if (!next) setSearchQuery("");
						}}
					>
						<svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true">
							<circle cx="9" cy="9" r="5.5" stroke="currentColor" strokeWidth="1.7" />
							<path d="M13.5 13.5L17 17" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
						</svg>
					</IconButton>
					<IconButton
						size="sm"
						variant="secondary"
						className="rounded-full"
						aria-label="新建事项"
						onClick={onNewMatter}
					>
						<svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true">
							<path d="M10 4.5v11M4.5 10h11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
						</svg>
					</IconButton>
					<IconButton
						size="sm"
						variant="secondary"
						className="min-[961px]:hidden rounded-full"
						aria-label="收起侧栏"
						onClick={() => setMobileNavOpen(false)}
					>
						<svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true">
							<path d="M5.5 5.5l9 9m0-9l-9 9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
						</svg>
					</IconButton>
				</div>
			</div>

			{searchOpen && (
				<div className="px-3 pb-2.5">
					<Input
						size="sm"
						placeholder="搜索事项或交付标题…"
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
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
					<div
						className={cn(
							"px-2 pt-1 pb-2.5 grid grid-cols-4 gap-0.5 border-b border-line shrink-0",
							rosterExpanded && "max-h-[260px] overflow-y-auto overscroll-contain",
						)}
					>
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
									className={cn(
										"border rounded-xl px-1 py-1.5 min-w-0 flex flex-col items-center gap-1 cursor-pointer transition-colors",
										isSelected
											? "bg-stage border-line shadow-sm"
											: "border-transparent bg-transparent hover:bg-hover/70",
									)}
									onClick={() => onToggleMember(member.id)}
									title={`${member.displayName} · ${member.roleTitle}（点击指定该角色发起新事项）`}
								>
									<span className="relative inline-flex">
										<BotFaceIcon bg={theme.bg} tilt={theme.tilt} size="md" mood={workingMood} />
										{isWorking && (
											<span className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full bg-success-text border-2 border-sidebar" />
										)}
									</span>
									<span
										className={cn(
											"text-[10px] leading-tight max-w-full text-center line-clamp-2 break-normal",
											isSelected ? "text-ink font-semibold" : "text-ink-secondary font-medium",
										)}
									>
										{member.displayName}
									</span>
								</button>
							);
						})}
						{hasOverflow && (
							<button
								type="button"
								className="group border border-transparent bg-transparent rounded-xl px-1 py-1.5 min-w-0 flex flex-col items-center gap-1 cursor-pointer hover:bg-hover/70"
								aria-expanded={rosterExpanded}
								onClick={() => setRosterExpanded((open) => !open)}
								title={rosterExpanded ? "收起角色列表" : `展开全部 ${businessMembers.length} 个角色`}
							>
								<span className="size-[42px] rounded-xl border border-dashed border-line bg-subtle text-ink-secondary text-xs font-semibold inline-flex items-center justify-center group-hover:border-accent-border group-hover:text-ink transition-colors">
									{rosterExpanded ? "收起" : `+${hiddenCount}`}
								</span>
								<span className="text-micro leading-tight font-medium text-ink-secondary max-w-full text-center line-clamp-2 break-normal">
									{rosterExpanded ? "收起列表" : "更多角色"}
								</span>
							</button>
						)}
					</div>
				);
			})()}

			<div className="flex-1 overflow-y-auto px-2.5 py-2.5 flex flex-col gap-1 min-h-0">
				<div className="px-1 pb-1.5 flex items-center justify-between gap-1.5 shrink-0">
					<div
						className="inline-flex items-center gap-0.5 p-0.5 rounded-md bg-subtle"
						role="tablist"
						aria-label="事项范围"
					>
						<button
							type="button"
							role="tab"
							aria-selected={!showArchived}
							className={cn(
								"border-0 rounded-xs px-1.5 py-0.5 text-micro cursor-pointer inline-flex items-center gap-1 transition-colors",
								!showArchived
									? "bg-stage text-ink font-semibold shadow-sm"
									: "bg-transparent text-ink-secondary font-medium hover:text-ink",
							)}
							onClick={() => setShowArchived(false)}
						>
							最近 <span className="text-ink-muted font-medium">{activeMatters.length}</span>
						</button>
						<button
							type="button"
							role="tab"
							aria-selected={showArchived}
							className={cn(
								"border-0 rounded-xs px-1.5 py-0.5 text-micro cursor-pointer inline-flex items-center gap-1 transition-colors",
								showArchived
									? "bg-stage text-ink font-semibold shadow-sm"
									: "bg-transparent text-ink-secondary font-medium hover:text-ink",
							)}
							onClick={() => setShowArchived(true)}
						>
							归档 <span className="text-ink-muted font-medium">{archivedMatters.length}</span>
						</button>
					</div>
					<fieldset
						className="inline-flex items-center gap-0.5 p-0.5 m-0 border-0 rounded-md bg-subtle"
						aria-label="事项排列方式"
					>
						<button
							type="button"
							className={cn(
								"border-0 rounded-xs px-1.5 py-0.5 text-micro cursor-pointer inline-flex items-center gap-1 transition-colors",
								viewMode === "time"
									? "bg-stage text-ink font-semibold shadow-sm"
									: "bg-transparent text-ink-secondary font-medium hover:text-ink",
							)}
							aria-pressed={viewMode === "time"}
							title="按更新时间倒序"
							onClick={() => setAndPersistViewMode("time")}
						>
							时间
						</button>
						<button
							type="button"
							className={cn(
								"border-0 rounded-xs px-1.5 py-0.5 text-micro cursor-pointer inline-flex items-center gap-1 transition-colors",
								viewMode === "grouped"
									? "bg-stage text-ink font-semibold shadow-sm"
									: "bg-transparent text-ink-secondary font-medium hover:text-ink",
							)}
							aria-pressed={viewMode === "grouped"}
							title="按组织和仓库分类"
							onClick={() => setAndPersistViewMode("grouped")}
						>
							分组
						</button>
					</fieldset>
				</div>

				{visibleMatters.length === 0 ? (
					<div className="px-2.5 py-4 text-xs text-ink-muted text-center">
						{showArchived ? "暂无已归档事项" : "暂无事项，可在右侧直接布置任务"}
					</div>
				) : viewMode === "time" ? (
					visibleMatters.map((matter) => renderMatterRow(matter))
				) : (
					groupedMatters.map((group) => {
						const collapsed = Boolean(collapsedGroups[group.key]);
						return (
							<section key={group.key} className="flex flex-col gap-0.5 mb-1">
								<button
									type="button"
									className="w-full border-0 bg-transparent rounded-md px-1.5 py-1 flex items-center gap-1 text-micro text-ink-secondary cursor-pointer text-left hover:bg-hover/70 hover:text-ink"
									aria-expanded={!collapsed}
									onClick={() =>
										setCollapsedGroups((prev) => ({
											...prev,
											[group.key]: !prev[group.key],
										}))
									}
								>
									<span className="w-2.5 shrink-0 text-ink-muted" aria-hidden="true">
										{collapsed ? "▸" : "▾"}
									</span>
									<span
										className="flex-1 min-w-0 inline-flex items-center gap-1 overflow-hidden"
										title={`${group.orgLabel} / ${group.workspaceLabel}`}
									>
										<span className="text-accent font-semibold truncate">{group.orgLabel}</span>
										<span className="text-ink-muted shrink-0" aria-hidden="true">
											/
										</span>
										<span className="text-ink font-semibold truncate">{group.workspaceLabel}</span>
									</span>
									<span className="shrink-0 text-micro text-ink-muted">{group.items.length}</span>
								</button>
								{!collapsed && (
									<div className="flex flex-col gap-0.5 pl-1.5">
										{group.items.map((matter) => renderMatterRow(matter))}
									</div>
								)}
							</section>
						);
					})
				)}
			</div>

			<div className="relative border-t border-line px-2.5 py-2 shrink-0" ref={footerRef}>
				{footerMenuOpen && (
					<div
						className="absolute left-2.5 right-2.5 bottom-[calc(100%+6px)] z-40 p-1.5 border border-line rounded-lg bg-stage shadow-lg flex flex-col gap-0.5"
						role="menu"
						aria-label="工作台菜单"
					>
						<button
							type="button"
							role="menuitem"
							className={footerMenuItemClass(activeTab === "deliverables")}
							onClick={() => navigateFromMenu({ tab: "deliverables" })}
						>
							<span>资料空间</span>
						</button>
						<button
							type="button"
							role="menuitem"
							className={footerMenuItemClass(activeTab === "materials")}
							onClick={() => navigateFromMenu({ tab: "materials" })}
						>
							<span>工作区</span>
							<Badge tone={activeTab === "materials" ? "accent" : "neutral"} size="xs">
								{bootstrap?.workspaces.length ?? 0}
							</Badge>
						</button>
						<button
							type="button"
							role="menuitem"
							className={footerMenuItemClass(activeTab === "organizations")}
							onClick={() => navigateFromMenu({ tab: "organizations" })}
						>
							<span>组织</span>
							<Badge tone={activeTab === "organizations" ? "accent" : "neutral"} size="xs">
								{bootstrap?.organizations?.length ?? 0}
							</Badge>
						</button>
						<button
							type="button"
							role="menuitem"
							className={footerMenuItemClass(activeTab === "team")}
							onClick={() => navigateFromMenu({ tab: "team" })}
						>
							<span>AI 团队</span>
							<Badge tone={activeTab === "team" ? "accent" : "neutral"} size="xs">
								{businessMembers.length}
							</Badge>
						</button>
						<button
							type="button"
							role="menuitem"
							className={footerMenuItemClass(activeTab === "settings")}
							onClick={() => navigateFromMenu({ tab: "settings" })}
						>
							<span>设置</span>
							<Badge tone={activeTab === "settings" ? "accent" : "neutral"} size="xs">
								{runtimeBadge ?? "Pi RPC"}
							</Badge>
						</button>
						<button
							type="button"
							role="menuitem"
							className={footerMenuItemClass(false)}
							onClick={() => navigateFromMenu({ tab: "settings", settingsSection: "skills" })}
						>
							<span>技能与信任</span>
							<Badge tone="neutral" size="xs">
								四步
							</Badge>
						</button>
						<button
							type="button"
							role="menuitem"
							className={footerMenuItemClass(false)}
							onClick={() => navigateFromMenu({ tab: "settings", settingsSection: "insights" })}
						>
							<span>运行洞察</span>
							<Badge tone="neutral" size="xs">
								本地
							</Badge>
						</button>
						{isSuperAdmin && (
							<button
								type="button"
								role="menuitem"
								className={footerMenuItemClass(activeTab === "admin")}
								onClick={() => navigateFromMenu({ tab: "admin" })}
							>
								<span>超管控制台</span>
								<Badge tone={activeTab === "admin" ? "accent" : "neutral"} size="xs">
									Admin
								</Badge>
							</button>
						)}
						{onSwitchOrLogout && (
							<>
								<div className="h-px my-1 mx-1.5 bg-line" />
								<button
									type="button"
									role="menuitem"
									className="border-0 bg-transparent rounded-md px-2.5 py-1.5 flex items-center justify-between text-xs font-medium text-ink-muted cursor-pointer text-left hover:bg-subtle hover:text-ink"
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
				<div className="sidebar-footer-bar flex items-center gap-1.5 min-w-0">
					<button
						type="button"
						className={cn(
							"flex-1 min-w-0 border-0 px-1.5 py-1 -my-1 -ml-1.5 rounded-sm text-left cursor-pointer text-micro truncate transition-colors",
							activeTab === "account"
								? "bg-hover text-ink font-semibold"
								: "bg-transparent text-ink-secondary font-medium hover:bg-hover hover:text-ink",
						)}
						title={`${userLabel} · 点击进入个人账号`}
						aria-current={activeTab === "account" ? "page" : undefined}
						onClick={() => {
							setFooterMenuOpen(false);
							onNavigate({ tab: "account" });
						}}
					>
						{userLabel}
					</button>
					<span
						className={cn(
							"pill inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-pill bg-subtle text-xs text-ink-secondary shrink-0 whitespace-nowrap",
							sseConnected && "live",
						)}
						title={
							!sseConnected
								? "实时连接断开，正在重连"
								: runningCount > 0
									? `实时已连接 · 当前 ${runningCount} 个事项运行中`
									: "实时已连接"
						}
					>
						<span
							className={cn("size-1.5 rounded-full shrink-0", sseConnected ? "bg-success-text" : "bg-warn-text")}
							aria-hidden="true"
						/>
						{!sseConnected ? "重连" : runningCount > 0 ? `运行 ${runningCount}` : "实时"}
					</span>
					<button
						type="button"
						className={cn(
							"shrink-0 inline-flex items-center gap-1 px-2 py-1 border rounded-md text-micro font-medium cursor-pointer transition-colors",
							footerMenuOpen || hasSecondaryTabActive
								? "text-accent border-accent-border bg-accent-soft"
								: "border-line bg-stage text-ink-secondary hover:text-ink hover:border-accent-border",
						)}
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
