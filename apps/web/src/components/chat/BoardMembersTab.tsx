import type { ModelSelection } from "../../api/models.ts";
import type { BoardMemberDto, BoardMemberStatus, BoardPostSummaryDto, BoardRole } from "../../api.ts";
import type { BoardMemberGroup } from "../../hooks/useMatterBoard.ts";
import { canSwapBoardMemberModel } from "../../hooks/useMatterBoard.ts";
import { BotFaceIcon } from "../../primitives/BotFaceIcon.tsx";
import { getBotTheme, type RoleMood } from "../../utils.ts";

function boardRoleLabel(role: BoardRole): string {
	if (role === "coordinator") return "Coordinator";
	if (role === "verifier") return "Verifier";
	return "Builder";
}

function boardStatusLabel(status: BoardMemberStatus): string {
	switch (status) {
		case "working":
			return "执行中";
		case "waiting":
			return "待命";
		case "blocked_human":
			return "待人工确认";
		case "stopped":
			return "已暂停";
		case "retired":
			return "已退场";
	}
}

function boardStatusMood(status: BoardMemberStatus): RoleMood {
	if (status === "working") return "tool";
	if (status === "blocked_human") return "waiting_user";
	return "idle";
}

function formatModelBadge(model: ModelSelection | null): string | null {
	if (!model) return null;
	return `${model.provider}/${model.model}${model.thinkingLevel ? ` (${model.thinkingLevel})` : ""}`;
}

export interface BoardMembersTabProps {
	coordinator: BoardMemberDto | null;
	groups: BoardMemberGroup[];
	posts: BoardPostSummaryDto[];
	activeMemberCount: number;
	retiredCount: number;
	hideInactive: boolean;
	showRetiredGroup: boolean;
	canControlMembers: boolean;
	busyAgentId: string | null;
	memberActionError: string | null;
	onClearMemberActionError: () => void;
	onToggleHideInactive: () => void;
	onToggleRetiredGroup: () => void;
	onTogglePause: (member: BoardMemberDto) => void;
	onOpenSwapModal: (member: BoardMemberDto) => void;
	onRetireMember: (member: BoardMemberDto) => void;
	onOpenBoardTab: () => void;
}

export function BoardMembersTab({
	coordinator,
	groups,
	posts,
	activeMemberCount,
	retiredCount,
	hideInactive,
	showRetiredGroup,
	canControlMembers,
	busyAgentId,
	memberActionError,
	onClearMemberActionError,
	onToggleHideInactive,
	onToggleRetiredGroup,
	onTogglePause,
	onOpenSwapModal,
	onRetireMember,
	onOpenBoardTab,
}: BoardMembersTabProps) {
	const renderMemberCard = (member: BoardMemberDto, index: number) => {
		const theme = getBotTheme(index);
		const isWaiting = canSwapBoardMemberModel(member);
		const isBusy = busyAgentId === member.agentId;
		const modelLabel = formatModelBadge(member.modelOverride);
		const metrics = member.metrics;
		return (
			<article
				key={member.agentId}
				className={`board-member-card is-${member.status}${member.boardRole === "coordinator" ? " is-coordinator" : ""}`}
			>
				<div className="board-member-head">
					<div className="board-member-identity">
						<BotFaceIcon bg={theme.bg} size="sm" mood={boardStatusMood(member.status)} />
						<div className="board-member-titles">
							<div className="board-member-name-row">
								<strong className="board-member-name">{member.displayName}</strong>
								<span className={`board-role-badge is-${member.boardRole}`}>
									{boardRoleLabel(member.boardRole)}
								</span>
							</div>
							<span className="board-member-id">@{member.agentId}</span>
						</div>
					</div>
					<span className={`board-status-badge is-${member.status}`}>
						<span className={`board-status-dot is-${member.status}`} aria-hidden="true" />
						{boardStatusLabel(member.status)}
					</span>
				</div>

				{member.ownedScope.length > 0 && (
					<div className="board-scope-chips">
						{member.ownedScope.map((scope) => (
							<span key={scope} className="board-scope-chip" title={scope}>
								{scope}
							</span>
						))}
					</div>
				)}

				<div className="board-member-metrics">
					<span className="board-metric-chip">已读 #{member.lastReadPostNo}</span>
					{member.activePostNo !== null && (
						<span className="board-metric-chip is-active">处理中 #{member.activePostNo}</span>
					)}
					{metrics?.linesAdded !== undefined && (
						<span className="board-metric-chip is-positive">+{metrics.linesAdded} 行</span>
					)}
					{metrics?.linesDeleted !== undefined && metrics.linesDeleted > 0 && (
						<span className="board-metric-chip">-{metrics.linesDeleted} 行</span>
					)}
					{metrics?.testsPassed !== undefined && (
						<span className="board-metric-chip is-positive">
							测试 {metrics.testsPassed}
							{metrics.testsTotal !== undefined ? `/${metrics.testsTotal}` : ""} 通过
						</span>
					)}
					{modelLabel && (
						<span className="board-metric-chip is-model" title={`模型覆盖：${modelLabel}`}>
							{modelLabel}
						</span>
					)}
				</div>

				{metrics?.lastAction && <p className="board-member-last-action">{metrics.lastAction}</p>}

				{canControlMembers && member.status !== "retired" && (
					<div className="board-member-actions">
						<button
							type="button"
							className="btn-pill-outline btn-xs"
							disabled={isBusy}
							onClick={() => onTogglePause(member)}
						>
							{isBusy ? "处理中…" : member.status === "stopped" ? "恢复" : "暂停"}
						</button>
						<button
							type="button"
							className="btn-pill-outline btn-xs"
							disabled={!isWaiting || isBusy}
							title={
								isWaiting
									? "在待命状态下原地热切换模型（保留 Pi 会话历史）"
									: `仅在待命（waiting）状态可热切换模型，当前为「${boardStatusLabel(member.status)}」`
							}
							onClick={() => onOpenSwapModal(member)}
						>
							切换模型
						</button>
						{member.boardRole !== "coordinator" && member.status !== "working" && (
							<button
								type="button"
								className="btn-pill-outline btn-xs"
								disabled={isBusy}
								title="将该成员标记为退场，保留历史记录并默认折叠"
								onClick={() => onRetireMember(member)}
							>
								退场
							</button>
						)}
						{member.status === "working" && <span className="board-swap-hint">执行中不可换模型</span>}
					</div>
				)}
			</article>
		);
	};

	return (
		<div className="board-members-tab">
			{memberActionError && (
				<div className="board-inline-error" role="alert">
					<span>{memberActionError}</span>
					<button type="button" className="btn-inline" onClick={onClearMemberActionError}>
						关闭
					</button>
				</div>
			)}

			{!coordinator && groups.length === 0 ? (
				<div className="board-empty-state">
					<p>当前尚未组建公告板成员。</p>
					<p className="board-empty-hint">
						在 Board 模式下发送目标后，Coordinator 会自动按任务切片组建 Builder 与 Verifier。
					</p>
				</div>
			) : (
				<>
					<div className="board-members-toolbar">
						<span className="board-pane-subtitle">
							活跃 {activeMemberCount} 人{retiredCount > 0 ? ` · 已退场 ${retiredCount} 人` : ""}
						</span>
						<button
							type="button"
							className={`board-filter-pill${hideInactive ? " active" : ""}`}
							aria-pressed={hideInactive}
							onClick={onToggleHideInactive}
						>
							{hideInactive ? "已隐藏非活跃成员" : "隐藏非活跃"}
						</button>
					</div>
					{coordinator && (
						<section className="board-member-group" aria-label="交付总控">
							<header className="board-group-header">
								<span>交付总控 · Coordinator（常驻）</span>
							</header>
							<div className="board-member-grid">{renderMemberCard(coordinator, 0)}</div>
						</section>
					)}
					{groups.map((group) => {
						const isRetiredGroup = group.status === "retired";
						const collapsed = isRetiredGroup && !showRetiredGroup && activeMemberCount > 1;
						return (
							<section key={group.status} className="board-member-group" aria-label={group.label}>
								<header className="board-group-header">
									<span>{group.label}</span>
									<div className="board-group-header-right">
										<span className="board-group-count">{group.members.length}</span>
										{isRetiredGroup && activeMemberCount > 1 && (
											<button type="button" className="btn-inline" onClick={onToggleRetiredGroup}>
												{collapsed ? "展开" : "收起"}
											</button>
										)}
									</div>
								</header>
								{!collapsed && (
									<div className="board-member-grid">
										{group.members.map((member, idx) => renderMemberCard(member, idx + 1))}
									</div>
								)}
							</section>
						);
					})}
				</>
			)}

			{posts.length > 0 && (
				<section className="board-shared-strip" aria-label="最新公告板交接">
					<div className="board-shared-strip-head">
						<span className="board-shared-strip-label">SHARED BOARD · 最新动态</span>
						<button type="button" className="btn-inline" onClick={onOpenBoardTab}>
							查看全部 ({posts.length})
						</button>
					</div>
					<div className="board-shared-strip-list">
						{posts
							.slice(-3)
							.reverse()
							.map((post) => (
								<button
									key={post.postNo}
									type="button"
									className="board-shared-strip-item"
									onClick={onOpenBoardTab}
								>
									<span className="board-post-no">#{post.postNo}</span>
									<span className="board-strip-author">@{post.authorId}</span>
									<span className="board-strip-summary">{post.summary}</span>
								</button>
							))}
					</div>
				</section>
			)}
		</div>
	);
}
