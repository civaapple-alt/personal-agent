import type { ModelSelection } from "../../api/models.ts";
import type { BoardMemberDto, BoardMemberStatus, BoardPostSummaryDto, BoardRole } from "../../api.ts";
import type { BoardMemberGroup } from "../../hooks/useMatterBoard.ts";
import { canSwapBoardMemberModel } from "../../hooks/useMatterBoard.ts";
import { Badge, type BadgeTone, Banner, BotFaceIcon, Button, Card, EmptyState } from "../../primitives/index.ts";
import { cn } from "../../utils/cn.ts";
import { getBotTheme, type RoleMood } from "../../utils.ts";

function boardRoleLabel(role: BoardRole): string {
	if (role === "coordinator") return "Coordinator";
	if (role === "verifier") return "Verifier";
	return "Builder";
}

function boardRoleTone(role: BoardRole): BadgeTone {
	if (role === "coordinator") return "accent";
	if (role === "verifier") return "observer";
	return "info";
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

function boardStatusTone(status: BoardMemberStatus): BadgeTone {
	switch (status) {
		case "working":
			return "success";
		case "blocked_human":
			return "warn";
		case "stopped":
			return "danger";
		case "waiting":
		case "retired":
			return "neutral";
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
		const cardSurfaceClass =
			member.status === "blocked_human"
				? "border-warn-border bg-warn-bg"
				: member.boardRole === "coordinator"
					? "border-accent-border bg-surface-accent"
					: member.status === "working"
						? "border-accent-border"
						: "border-line";

		return (
			<Card
				key={member.agentId}
				padding="sm"
				className={cn(
					"board-member-card flex flex-col gap-2 transition-colors",
					cardSurfaceClass,
					(member.status === "stopped" || member.status === "retired") && "opacity-75",
				)}
			>
				<div className="flex items-start justify-between gap-2">
					<div className="flex items-center gap-2 min-w-0">
						<BotFaceIcon bg={theme.bg} size="sm" mood={boardStatusMood(member.status)} />
						<div className="flex flex-col gap-0.5 min-w-0">
							<div className="flex items-center gap-1.5 flex-wrap">
								<strong className="text-sm font-semibold text-ink">{member.displayName}</strong>
								<Badge tone={boardRoleTone(member.boardRole)} size="xs">
									{boardRoleLabel(member.boardRole)}
								</Badge>
							</div>
							<span className="font-mono text-micro text-ink-muted">@{member.agentId}</span>
						</div>
					</div>
					<Badge tone={boardStatusTone(member.status)} dot size="xs" className="shrink-0">
						{boardStatusLabel(member.status)}
					</Badge>
				</div>

				{member.ownedScope.length > 0 && (
					<div className="flex flex-wrap gap-1">
						{member.ownedScope.map((scope) => (
							<span
								key={scope}
								title={scope}
								className="inline-flex items-center max-w-full px-1.5 py-0.5 rounded-xs border border-line bg-surface text-ink-secondary font-mono text-micro truncate"
							>
								{scope}
							</span>
						))}
					</div>
				)}

				<div className="flex flex-wrap gap-1">
					<Badge tone="neutral" size="xs">
						已读 #{member.lastReadPostNo}
					</Badge>
					{member.activePostNo !== null && (
						<Badge tone="info" size="xs">
							处理中 #{member.activePostNo}
						</Badge>
					)}
					{metrics?.linesAdded !== undefined && (
						<Badge tone="success" size="xs">
							+{metrics.linesAdded} 行
						</Badge>
					)}
					{metrics?.linesDeleted !== undefined && metrics.linesDeleted > 0 && (
						<Badge tone="neutral" size="xs">
							-{metrics.linesDeleted} 行
						</Badge>
					)}
					{metrics?.testsPassed !== undefined && (
						<Badge tone="success" size="xs">
							测试 {metrics.testsPassed}
							{metrics.testsTotal !== undefined ? `/${metrics.testsTotal}` : ""} 通过
						</Badge>
					)}
					{modelLabel && (
						<Badge tone="observer" size="xs" className="font-mono" title={`模型覆盖：${modelLabel}`}>
							{modelLabel}
						</Badge>
					)}
				</div>

				{metrics?.lastAction && (
					<p className="m-0 text-xs text-ink-secondary leading-normal">{metrics.lastAction}</p>
				)}

				{canControlMembers && member.status !== "retired" && (
					<div className="flex items-center gap-1.5 flex-wrap pt-1.5 border-t border-dashed border-line">
						<Button variant="secondary" size="xs" disabled={isBusy} onClick={() => onTogglePause(member)}>
							{isBusy ? "处理中…" : member.status === "stopped" ? "恢复" : "暂停"}
						</Button>
						<Button
							variant="secondary"
							size="xs"
							disabled={!isWaiting || isBusy}
							title={
								isWaiting
									? "在待命状态下原地热切换模型（保留 Pi 会话历史）"
									: `仅在待命（waiting）状态可热切换模型，当前为「${boardStatusLabel(member.status)}」`
							}
							onClick={() => onOpenSwapModal(member)}
						>
							切换模型
						</Button>
						{member.boardRole !== "coordinator" && member.status !== "working" && (
							<Button
								variant="secondary"
								size="xs"
								disabled={isBusy}
								title="将该成员标记为退场，保留历史记录并默认折叠"
								onClick={() => onRetireMember(member)}
							>
								退场
							</Button>
						)}
						{member.status === "working" && <span className="text-micro text-ink-muted">执行中不可换模型</span>}
					</div>
				)}
			</Card>
		);
	};

	return (
		<div className="flex flex-col gap-3.5">
			{memberActionError && (
				<Banner tone="danger" onDismiss={onClearMemberActionError}>
					{memberActionError}
				</Banner>
			)}

			{!coordinator && groups.length === 0 ? (
				<EmptyState
					compact
					title="当前尚未组建公告板成员。"
					description="在 Board 模式下发送目标后，Coordinator 会自动按任务切片组建 Builder 与 Verifier。"
				/>
			) : (
				<>
					<div className="flex items-center justify-between gap-2">
						<span className="text-xs text-ink-muted truncate">
							活跃 {activeMemberCount} 人{retiredCount > 0 ? ` · 已退场 ${retiredCount} 人` : ""}
						</span>
						<button
							type="button"
							aria-pressed={hideInactive}
							onClick={onToggleHideInactive}
							className={cn(
								"px-2.5 py-0.5 rounded-pill text-micro border transition-colors cursor-pointer shrink-0",
								hideInactive
									? "border-accent bg-accent-soft text-accent font-semibold"
									: "border-line bg-stage text-ink-secondary font-medium hover:border-line-strong hover:text-ink",
							)}
						>
							{hideInactive ? "已隐藏非活跃成员" : "隐藏非活跃"}
						</button>
					</div>
					{coordinator && (
						<section className="flex flex-col gap-2" aria-label="交付总控">
							<header className="flex items-center justify-between text-xs font-semibold text-ink-secondary px-0.5">
								<span>交付总控 · Coordinator（常驻）</span>
							</header>
							<div className="flex flex-col gap-2">{renderMemberCard(coordinator, 0)}</div>
						</section>
					)}
					{groups.map((group) => {
						const isRetiredGroup = group.status === "retired";
						const collapsed = isRetiredGroup && !showRetiredGroup && activeMemberCount > 1;
						return (
							<section key={group.status} className="flex flex-col gap-2" aria-label={group.label}>
								<header className="flex items-center justify-between text-xs font-semibold text-ink-secondary px-0.5">
									<span>{group.label}</span>
									<div className="inline-flex items-center gap-2">
										<span className="text-micro text-ink-muted tabular-nums">{group.members.length}</span>
										{isRetiredGroup && activeMemberCount > 1 && (
											<Button variant="inline" size="xs" onClick={onToggleRetiredGroup}>
												{collapsed ? "展开" : "收起"}
											</Button>
										)}
									</div>
								</header>
								{!collapsed && (
									<div className="flex flex-col gap-2">
										{group.members.map((member, idx) => renderMemberCard(member, idx + 1))}
									</div>
								)}
							</section>
						);
					})}
				</>
			)}

			{posts.length > 0 && (
				<section
					aria-label="最新公告板交接"
					className="flex flex-col gap-1.5 px-3 py-2.5 rounded-md border border-line bg-surface"
				>
					<div className="flex items-center justify-between gap-2">
						<span className="text-micro font-semibold tracking-wider text-ink-muted">
							SHARED BOARD · 最新动态
						</span>
						<Button variant="inline" size="xs" onClick={onOpenBoardTab}>
							查看全部 ({posts.length})
						</Button>
					</div>
					<div className="flex flex-col gap-1">
						{posts
							.slice(-3)
							.reverse()
							.map((post) => (
								<button
									key={post.postNo}
									type="button"
									onClick={onOpenBoardTab}
									className="flex items-baseline gap-1.5 w-full px-1.5 py-1 border-0 rounded-xs bg-transparent text-ink text-xs text-left cursor-pointer hover:bg-hover transition-colors"
								>
									<span className="font-mono text-xs font-semibold text-ink shrink-0">#{post.postNo}</span>
									<span className="font-mono text-micro text-accent shrink-0">@{post.authorId}</span>
									<span className="min-w-0 truncate text-ink-secondary">{post.summary}</span>
								</button>
							))}
					</div>
				</section>
			)}
		</div>
	);
}
