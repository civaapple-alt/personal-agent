import { useEffect, useRef } from "react";
import type {
	ActiveDelegationDto,
	MatterProgressDto,
	ProgressActivityDto,
	ProgressSnapshotDto,
	TeamMemberDto,
} from "../api.ts";
import { getToolDisplay, getToolRenderer } from "../extensions/registry.ts";
import { Badge, type BadgeTone, BotFaceIcon, Button, ElapsedTimer } from "../primitives/index.ts";
import { cn } from "../utils/cn.ts";
import { liveDelegationEdges } from "../utils/matterDelegations.ts";
import type { TurnToolCall } from "../utils/matterStream.ts";
import {
	formatClockTime,
	formatElapsedDuration,
	getBotTheme,
	getMemberThemeById,
	SHORT_STAGE_LABELS,
	STAGE_LABELS,
	STAGE_ORDER,
} from "../utils.ts";
import { DelegationGraph } from "./chat/DelegationGraph.tsx";

function stageBadgeTone(stage: MatterProgressDto["stage"]): BadgeTone {
	if (stage === "waiting_user") return "warn";
	if (stage === "finalizing") return "success";
	return "accent";
}

function toolStatusClass(status: TurnToolCall["status"]): string {
	if (status === "error") return "text-danger-text";
	if (status === "success") return "text-accent";
	return "text-ink-muted";
}

function toolStatusLabel(status: TurnToolCall["status"], toolName?: string): string {
	if (status === "success" && toolName) {
		const custom = getToolDisplay(toolName)?.successLabel;
		if (custom) return custom;
	}
	switch (status) {
		case "running":
			return "进行中";
		case "success":
			return "完成";
		case "error":
			return "失败";
		case "unknown":
			return "结果未知";
	}
}

interface ProgressDetailsProps {
	toolCalls?: TurnToolCall[];
	stage: MatterProgressDto["stage"];
	activeDelegations?: ActiveDelegationDto[];
	recentLogs?: ProgressActivityDto[];
	members?: TeamMemberDto[];
	delegationHeading?: string;
	stoppedMode?: boolean;
	completedMode?: boolean;
	onOpenDelegations?: () => void;
}

function ProgressDetails({
	toolCalls = [],
	stage,
	activeDelegations,
	recentLogs,
	members,
	delegationHeading = "本轮协作路径",
	stoppedMode = false,
	completedMode = false,
	onOpenDelegations,
}: ProgressDetailsProps) {
	const activeIndex = STAGE_ORDER.indexOf(stage);
	const feedRef = useRef<HTMLDivElement | null>(null);
	const displayLogs = recentLogs?.filter(
		(entry) =>
			!entry.toolCallId ||
			!entry.memberId ||
			!toolCalls.some((call) => call.id === `${entry.memberId}:${entry.toolCallId}`),
	);
	const logCount = displayLogs?.length ?? 0;

	useEffect(() => {
		const el = feedRef.current;
		if (!el || logCount === 0) return;
		el.scrollTop = el.scrollHeight;
	}, [logCount]);

	return (
		<>
			<div className="mt-2.5 grid grid-cols-5 gap-1.5">
				{STAGE_ORDER.map((stepStage, idx) => {
					const stepState = completedMode
						? "done"
						: idx < activeIndex
							? "done"
							: idx === activeIndex
								? stoppedMode
									? "stopped"
									: "active"
								: "pending";
					return (
						<div key={stepStage} className="flex flex-col gap-1">
							<span
								className={cn(
									"h-1 rounded-pill transition-colors",
									stepState === "done" && "bg-accent/60",
									stepState === "active" && "bg-accent animate-pulse motion-reduce:animate-none",
									stepState === "stopped" && "bg-warn-text",
									stepState === "pending" && "bg-line",
								)}
							/>
							<span
								className={cn(
									"text-micro text-center",
									stepState === "done" && "text-ink-secondary",
									stepState === "active" && "text-accent font-semibold",
									stepState === "stopped" && "text-warn-text font-semibold",
									stepState === "pending" && "text-ink-muted",
								)}
							>
								{SHORT_STAGE_LABELS[stepStage]}
							</span>
						</div>
					);
				})}
			</div>

			{toolCalls.length > 0 && (
				<section className="mt-2.5 pt-2 border-t border-dashed border-line" aria-label="工具与 Skill 记录">
					<div className="text-micro font-semibold text-ink-muted">工具与 Skill 记录 · {toolCalls.length}</div>
					<div className="flex flex-col gap-1.5 max-h-[240px] overflow-y-auto mt-1.5">
						{toolCalls.map((call) => {
							const cleanSkillName = call.skillName?.replace(/^\/?skill:/u, "") ?? null;
							const toolDisplay = getToolDisplay(call.toolName);
							const formattedDetail =
								toolDisplay?.formatSummary?.({
									toolName: call.toolName,
									summary: call.detail,
									args: call.args,
								}) ?? call.detail;
							const showDetail =
								Boolean(formattedDetail) && (!cleanSkillName || formattedDetail !== call.skillName);
							const rendererReg = call.args ? getToolRenderer(call.toolName) : undefined;
							const renderedCard = rendererReg
								? rendererReg.renderer({
										toolCallId: call.id,
										toolName: call.toolName,
										args: call.args ?? {},
										status: call.status,
										detail: formattedDetail,
									})
								: null;
							return (
								<div key={call.id} className="flex flex-col gap-1.5">
									<div className="flex items-baseline flex-nowrap gap-1.5 min-w-0 text-micro leading-snug group">
										<span className="text-ink-muted tabular-nums shrink-0">{formatClockTime(call.at)}</span>
										<strong className="shrink-0 whitespace-nowrap text-ink">
											{members?.find((member) => member.id === call.memberId)?.displayName ?? call.memberId}
										</strong>
										{cleanSkillName && (
											<Badge tone="accent" size="xs" className="shrink-0">
												Skill · {cleanSkillName}
											</Badge>
										)}
										<code
											className="shrink-0 whitespace-nowrap rounded-xs px-1.5 py-0.5 bg-stage border border-line-subtle text-ink-secondary font-mono text-micro"
											title={toolDisplay?.label ?? call.toolName}
										>
											{call.toolName}
										</code>
										{showDetail && (
											<span
												className="flex-1 min-w-0 break-words text-ink-secondary line-clamp-1 group-hover:line-clamp-4"
												title={formattedDetail}
											>
												{formattedDetail}
											</span>
										)}
										<span
											className={cn(
												"shrink-0 whitespace-nowrap text-micro font-medium",
												toolStatusClass(call.status),
											)}
										>
											{toolStatusLabel(call.status, call.toolName)}
										</span>
									</div>
									{renderedCard && (
										<div className="ml-3 p-2.5 border border-line rounded-md bg-subtle/60">
											{renderedCard}
										</div>
									)}
								</div>
							);
						})}
					</div>
				</section>
			)}

			{activeDelegations && activeDelegations.length > 0 && (
				<div className="mt-2.5 pt-2 border-t border-dashed border-line flex flex-col gap-1.5">
					<div className="flex items-center justify-between gap-2 text-micro font-semibold text-ink-muted">
						<span>{delegationHeading}</span>
						{onOpenDelegations && activeDelegations.some((entry) => entry.kind === "delegation") && (
							<Button variant="inline" size="xs" data-open-delegations onClick={onOpenDelegations}>
								查看本轮关系图
							</Button>
						)}
					</div>
					<DelegationGraph edges={liveDelegationEdges(activeDelegations, stoppedMode ? "failed" : "running")} />
				</div>
			)}

			{displayLogs && displayLogs.length > 0 && (
				<div
					ref={feedRef}
					className="mt-2 pt-2 pr-1 border-t border-dashed border-line flex flex-col gap-1.5 text-micro text-ink-secondary max-h-[220px] overflow-y-auto overscroll-contain"
				>
					{displayLogs.map((entry, idx) => {
						const logMember = members?.find((m) => m.displayName === entry.memberName);
						const logColor = logMember ? getMemberThemeById(members, logMember.id).bg : getBotTheme(idx).bg;
						return (
							<div
								key={`${entry.at}-${entry.memberName}-${idx}`}
								className="flex items-start gap-1.5 min-w-0 leading-snug group"
							>
								<span className="size-1.5 mt-1.5 rounded-full shrink-0" style={{ background: logColor }} />
								<span className="text-ink-muted tabular-nums shrink-0">{formatClockTime(entry.at)}</span>
								<strong className="text-ink shrink-0">{entry.memberName}</strong>
								<span
									className="flex-1 min-w-0 break-words line-clamp-1 group-hover:line-clamp-4"
									title={entry.summary}
								>
									{entry.summary}
								</span>
								{entry.toolName && (
									<code className="shrink-0 whitespace-nowrap rounded-xs px-1.5 py-0.5 bg-stage border border-line-subtle text-ink-secondary font-mono text-micro">
										{entry.toolName}
									</code>
								)}
								{entry.toolStatus && (
									<span
										className={cn(
											"shrink-0 whitespace-nowrap text-micro font-medium",
											toolStatusClass(entry.toolStatus),
										)}
									>
										{toolStatusLabel(entry.toolStatus, entry.toolName)}
									</span>
								)}
							</div>
						);
					})}
				</div>
			)}
		</>
	);
}

interface ExploringStatusProps {
	progress: MatterProgressDto;
	startedAt: number | null;
	members?: TeamMemberDto[];
	leadMemberId?: string | null;
	leadDisplayName?: string;
	onAbort?: () => void;
	onOpenDelegations?: () => void;
}

export function ExploringStatus({
	progress,
	startedAt,
	members,
	leadMemberId,
	leadDisplayName,
	onAbort,
	onOpenDelegations,
}: ExploringStatusProps) {
	const leadTheme = getMemberThemeById(members, leadMemberId);
	const leadName =
		leadDisplayName ?? members?.find((member) => member.id === leadMemberId)?.displayName ?? "主负责同事";

	return (
		<div className="self-start p-3.5 rounded-lg bg-sidebar border border-line w-[min(100%,660px)] min-w-0 shadow-sm">
			<div className="flex items-center gap-3">
				<BotFaceIcon bg={leadTheme.bg} tilt={leadTheme.tilt} size="md" mood={progress.stage} />
				<div className="flex-1 min-w-0 flex flex-col gap-0.5">
					<div className="flex items-center gap-2 text-sm flex-wrap">
						<span className="font-semibold text-ink">{leadName}</span>
						<Badge tone={stageBadgeTone(progress.stage)} size="xs">
							{STAGE_LABELS[progress.stage]}
						</Badge>
						<ElapsedTimer className="ml-auto text-xs tabular-nums text-ink-muted" startedAt={startedAt} />
						{onAbort && (
							<Button variant="danger" size="xs" className="rounded-pill" onClick={onAbort}>
								停止
							</Button>
						)}
					</div>
					<div className="text-ink-secondary text-xs leading-snug break-words line-clamp-1 hover:line-clamp-4">
						{progress.label}
					</div>
				</div>
			</div>
			{progress.stalledMembers && progress.stalledMembers.length > 0 && (
				<ul
					className="list-none mt-2.5 mb-0 px-2.5 py-2 rounded-md bg-warn-bg border border-warn-border text-warn-text text-xs flex flex-col gap-1"
					aria-live="polite"
				>
					{progress.stalledMembers.map(
						({ memberId, memberName, assignmentNumber, lastActivityAt, lastAction }) => (
							<li key={`${memberId}:${assignmentNumber ?? "turn"}`} className="flex flex-wrap gap-x-2.5 gap-y-1">
								<strong>
									{assignmentNumber ? `#${assignmentNumber} · ` : ""}
									{memberName}长时间无进展
								</strong>
								<span>
									最后活动 {formatClockTime(lastActivityAt)} · {lastAction}
								</span>
							</li>
						),
					)}
				</ul>
			)}

			<ProgressDetails
				stage={progress.stage}
				activeDelegations={progress.activeDelegations}
				recentLogs={progress.recentLogs}
				members={members}
				onOpenDelegations={onOpenDelegations}
			/>
		</div>
	);
}

interface ProgressSnapshotCardProps {
	toolCalls?: TurnToolCall[];
	snapshot: ProgressSnapshotDto;
	expanded: boolean;
	members?: TeamMemberDto[];
	fallbackLeadName?: string;
	onToggle: () => void;
}

export function ProgressSnapshotCard({
	toolCalls = [],
	snapshot,
	expanded,
	members,
	fallbackLeadName,
	onToggle,
}: ProgressSnapshotCardProps) {
	const leadName =
		snapshot.leadMemberName ??
		(snapshot.leadMemberId
			? members?.find((member) => member.id === snapshot.leadMemberId)?.displayName
			: undefined) ??
		fallbackLeadName;
	const isCompleted = snapshot.outcome === "completed";
	const outcomeTitle = isCompleted ? "执行过程" : snapshot.outcome === "aborted" ? "中止前进度" : "异常前进度";
	const logCount = snapshot.recentLogs?.length ?? 0;
	const badgeTone: BadgeTone = isCompleted ? "accent" : snapshot.outcome === "aborted" ? "neutral" : "warn";
	const warnStyle = !isCompleted && snapshot.outcome !== "aborted";
	return (
		<div
			className={cn(
				"self-start mt-1 w-[min(100%,660px)] max-w-[min(88%,740px)] max-md:max-w-full border rounded-lg overflow-hidden",
				warnStyle ? "border-warn-border bg-warn-bg/40" : "border-line bg-sidebar",
			)}
		>
			<button
				type="button"
				className="w-full border-0 bg-transparent px-3 py-2 flex items-center justify-between gap-3 text-xs text-ink-secondary cursor-pointer text-left hover:bg-hover/60 transition-colors"
				onClick={onToggle}
			>
				<span className="inline-flex items-center gap-2 flex-wrap min-w-0">
					<Badge tone={badgeTone} size="xs">
						{outcomeTitle}
					</Badge>
					{leadName && <strong className="text-ink">{leadName}</strong>}
					{!isCompleted && (
						<Badge tone={stageBadgeTone(snapshot.stage)} size="xs">
							{STAGE_LABELS[snapshot.stage]}
						</Badge>
					)}
					<span className="text-ink-muted tabular-nums">
						{isCompleted ? "耗时 " : "已运行 "}
						{formatElapsedDuration(snapshot.elapsedSeconds)}
						{logCount > 0 ? ` · ${logCount} 条活动` : ""}
					</span>
				</span>
				<span className="text-accent font-semibold whitespace-nowrap">
					{expanded ? "收起" : isCompleted ? "查看过程" : "查看进度"}
				</span>
			</button>
			{expanded && (
				<div
					className={cn(
						"border-t border-dashed px-3 py-2.5 flex flex-col gap-1 bg-stage",
						warnStyle ? "border-warn-border" : "border-line",
					)}
				>
					{!isCompleted && (
						<div className="text-ink-secondary text-xs leading-snug break-words">
							{snapshot.label}
							{snapshot.capturedAt ? ` · 停于 ${formatClockTime(snapshot.capturedAt)}` : ""}
						</div>
					)}
					<ProgressDetails
						stage={snapshot.stage}
						toolCalls={toolCalls}
						activeDelegations={snapshot.activeDelegations}
						recentLogs={snapshot.recentLogs}
						members={members}
						delegationHeading={
							isCompleted
								? "本轮协作岗位"
								: snapshot.outcome === "aborted"
									? "中止时仍在协同的岗位"
									: "异常时仍在协同的岗位"
						}
						stoppedMode={!isCompleted}
						completedMode={isCompleted}
					/>
				</div>
			)}
		</div>
	);
}
