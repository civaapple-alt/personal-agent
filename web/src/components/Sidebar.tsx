import { useState } from "react";
import type { BootstrapPayload, CollaboratorDto, MatterDto, MatterProgressDto } from "../api.ts";
import { isArchitectMember } from "../architectApi.ts";
import type { HashRoute, NavTab } from "../hashRouter.ts";
import { getBotTheme, inferDelegationMood, type RoleMood, STATUS_LABELS, stripMarkdownFormatting } from "../utils.ts";
import { BotFaceIcon } from "./BotFaceIcon.tsx";

interface SidebarProps {
	activeTab: NavTab;
	bootstrap: BootstrapPayload | null;
	currentUser?: CollaboratorDto | null;
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
	onSwitchOrLogout?: () => void;
}

export function Sidebar({
	activeTab,
	bootstrap,
	currentUser,
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
	onSwitchOrLogout,
}: SidebarProps) {
	const [searchOpen, setSearchOpen] = useState(false);

	return (
		<aside className={`bot-sidebar ${mobileOpen ? "mobile-open" : ""}`}>
			<div className="sidebar-top">
				<button
					type="button"
					className="brand-btn"
					onClick={() => onNavigate({ tab: "chats", matterId: selectedMatterId ?? undefined })}
				>
					<span className="brand-mark">PA</span>
					<span>Personal Agent</span>
				</button>
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
						placeholder="搜索事项或交付标题..."
						value={searchQuery}
						onChange={(e) => onSearchQueryChange(e.target.value)}
					/>
				</div>
			)}

			<div className="roster-strip">
				{bootstrap?.members.map((member, idx) => {
					const theme = getBotTheme(idx);
					const isSelected = activeTab === "chats" && !selectedMatterId && selectedMemberId === member.id;
					let workingMood: RoleMood = "idle";
					for (const [mId, prog] of Object.entries(progressByMatter)) {
						const delegated = prog.activeDelegations?.find((entry) => entry.memberId === member.id);
						if (delegated) {
							workingMood = inferDelegationMood(delegated.stageLabel);
							break;
						}
						const matter = bootstrap.matters.find((m) => m.id === mId);
						if (matter?.leadMemberId === member.id) {
							workingMood = prog.stage;
							break;
						}
					}
					const isWorking = workingMood !== "idle";
					const isArchitect = isArchitectMember(member);
					return (
						<button
							key={member.id}
							type="button"
							className={`roster-tile ${isSelected ? "active" : ""}${isArchitect ? " is-architect" : ""}`}
							onClick={() => onToggleMember(member.id)}
							title={
								isArchitect
									? `${member.displayName} · 建队规划与协作体检（点击发起角色架构对话）`
									: `${member.displayName} · ${member.roleTitle}（点击指定该角色发起新事项）`
							}
						>
							<span className="roster-avatar-wrap">
								<BotFaceIcon bg={theme.bg} tilt={theme.tilt} size="md" mood={workingMood} />
								{isWorking && <span className="roster-working-dot" />}
							</span>
							<span className="roster-name">{member.displayName}</span>
							{isArchitect && <span className="roster-meta-tag">建队·体检</span>}
						</button>
					);
				})}
			</div>

			<div className="matter-scroll">
				<div className="sidebar-section-label">
					<span>最近事项</span>
					<span>{filteredMatters.length}</span>
				</div>
				{filteredMatters.length === 0 ? (
					<div className="sidebar-empty">暂无事项，可在右侧直接布置任务</div>
				) : (
					filteredMatters.map((matter) => {
						const prog = progressByMatter[matter.id];
						const leadIdx = bootstrap?.members.findIndex((m) => m.id === matter.leadMemberId) ?? 0;
						const theme = getBotTheme(leadIdx >= 0 ? leadIdx : 0);
						const isActive = activeTab === "chats" && selectedMatterId === matter.id;
						const previewLine = stripMarkdownFormatting(
							prog
								? prog.label
								: matter.status === "waiting_user"
									? "等待你的确认"
									: matter.summary || STATUS_LABELS[matter.status] || matter.status,
						);

						return (
							<button
								key={matter.id}
								type="button"
								className={`matter-item ${isActive ? "active" : ""}`}
								onClick={() => onNavigate({ tab: "chats", matterId: matter.id })}
							>
								<span className="matter-dot" style={{ background: theme.bg }}>
									{prog && <span className="matter-dot-pulse" style={{ borderColor: theme.bg }} />}
								</span>
								<span className="matter-copy">
									<span className="matter-title">{matter.title}</span>
									<span className="matter-preview">{previewLine}</span>
								</span>
							</button>
						);
					})
				)}
			</div>

			<div className="sidebar-footer">
				<button
					type="button"
					className={`footer-nav-btn ${activeTab === "deliverables" ? "active" : ""}`}
					onClick={() => onNavigate({ tab: "deliverables", deliverableId: selectedDeliverableId ?? undefined })}
				>
					<span>交付成果库</span>
					<span className="pill">{bootstrap?.deliverables.length ?? 0}</span>
				</button>
				<button
					type="button"
					className={`footer-nav-btn ${activeTab === "team" ? "active" : ""}`}
					onClick={() => onNavigate({ tab: "team" })}
				>
					<span>我的团队 · {bootstrap?.members.length ?? 0} 位</span>
					<span className="pill">能力包</span>
				</button>
				<button
					type="button"
					className={`footer-nav-btn ${activeTab === "materials" ? "active" : ""}`}
					onClick={() => onNavigate({ tab: "materials" })}
				>
					<span>项目仓库与资料</span>
					<span className="pill">{bootstrap?.workspaces.length ?? 0}</span>
				</button>
				<div className="sidebar-status-row">
					<span className="muted-tiny">
						{currentUser
							? `${currentUser.name} · ${currentUser.permissionRole === "owner" ? "所有者" : "协同"}`
							: "Pi RPC · kimi-for-coding"}
					</span>
					<div className="sidebar-status-actions">
						{currentUser?.permissionRole === "collaborator" && onSwitchOrLogout && (
							<button type="button" className="btn-inline btn-xs" onClick={onSwitchOrLogout}>
								{window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost"
									? "恢复所有者"
									: "退出"}
							</button>
						)}
						<span className={`pill ${sseConnected ? "live" : ""}`}>{sseConnected ? "实时" : "重连"}</span>
					</div>
				</div>
			</div>
		</aside>
	);
}
