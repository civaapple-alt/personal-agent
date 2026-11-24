import { useEffect, useRef } from "react";
import type {
	ActiveDelegationDto,
	MatterProgressDto,
	ProgressActivityDto,
	ProgressSnapshotDto,
	TeamMemberDto,
} from "../api.ts";
import { getToolDisplay } from "../extensions/registry.ts";
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
import { BotFaceIcon } from "./BotFaceIcon.tsx";
import { DelegationGraph } from "./chat/DelegationGraph.tsx";
import { ElapsedTimer } from "./ElapsedTimer.tsx";

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
			<div className="exploring-stepper">
				{STAGE_ORDER.map((stepStage, idx) => {
					const stateClass = completedMode
						? "done"
						: idx < activeIndex
							? "done"
							: idx === activeIndex
								? stoppedMode
									? "stopped"
									: "active"
								: "";
					return (
						<div key={stepStage} className={`exploring-step ${stateClass}`}>
							<span className="exploring-seg" />
							<span className="exploring-step-name">{SHORT_STAGE_LABELS[stepStage]}</span>
						</div>
					);
				})}
			</div>

			{toolCalls.length > 0 && (
				<section className="exploring-tool-records" aria-label="工具与 Skill 记录">
					<div className="exploring-section-head">工具与 Skill 记录 · {toolCalls.length}</div>
					<div className="exploring-tool-list">
						{toolCalls.map((call) => {
							const cleanSkillName = call.skillName?.replace(/^\/?skill:/u, "") ?? null;
							const showDetail = Boolean(call.detail) && (!cleanSkillName || call.detail !== call.skillName);
							return (
								<div key={call.id} className="exploring-tool-item">
									<span className="exploring-feed-time">{formatClockTime(call.at)}</span>
									<strong className="exploring-tool-member">
										{members?.find((member) => member.id === call.memberId)?.displayName ?? call.memberId}
									</strong>
									{cleanSkillName && <span className="exploring-skill-badge">Skill · {cleanSkillName}</span>}
									<code
										className="exploring-tool-name"
										title={getToolDisplay(call.toolName)?.label ?? call.toolName}
									>
										{call.toolName}
									</code>
									{showDetail && (
										<span className="exploring-tool-detail" title={call.detail}>
											{call.detail}
										</span>
									)}
									<span className={`exploring-tool-status is-${call.status}`}>
										{toolStatusLabel(call.status, call.toolName)}
									</span>
								</div>
							);
						})}
					</div>
				</section>
			)}

			{activeDelegations && activeDelegations.length > 0 && (
				<div className="exploring-delegations">
					<div className="exploring-section-head delegation-live-heading">
						<span>{delegationHeading}</span>
						{onOpenDelegations && activeDelegations.some((entry) => entry.kind === "delegation") && (
							<button
								type="button"
								className="btn-inline btn-xs"
								data-open-delegations
								onClick={onOpenDelegations}
							>
								查看本轮关系图
							</button>
						)}
					</div>
					<DelegationGraph edges={liveDelegationEdges(activeDelegations, stoppedMode ? "failed" : "running")} />
				</div>
			)}

			{displayLogs && displayLogs.length > 0 && (
				<div ref={feedRef} className="exploring-feed">
					{displayLogs.map((entry, idx) => {
						const logMember = members?.find((m) => m.displayName === entry.memberName);
						const logColor = logMember ? getMemberThemeById(members, logMember.id).bg : getBotTheme(idx).bg;
						return (
							<div key={`${entry.at}-${entry.memberName}-${idx}`} className="exploring-feed-item">
								<span className="exploring-feed-dot" style={{ background: logColor }} />
								<span className="exploring-feed-time">{formatClockTime(entry.at)}</span>
								<strong>{entry.memberName}</strong>
								<span className="exploring-feed-text" title={entry.summary}>
									{entry.summary}
								</span>
								{entry.toolName && <code className="exploring-tool-name">{entry.toolName}</code>}
								{entry.toolStatus && (
									<span className={`exploring-tool-status is-${entry.toolStatus}`}>
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
		<div className="exploring-block">
			<div className="exploring-hero">
				<BotFaceIcon bg={leadTheme.bg} tilt={leadTheme.tilt} size="md" mood={progress.stage} />
				<div className="exploring-main">
					<div className="exploring-row">
						<span className="exploring-actor">{leadName}</span>
						<span className={`exploring-stage stage-${progress.stage}`}>{STAGE_LABELS[progress.stage]}</span>
						<ElapsedTimer className="exploring-time" startedAt={startedAt} />
						{onAbort && (
							<button type="button" className="btn-stop-pill" onClick={onAbort}>
								停止
							</button>
						)}
					</div>
					<div className="exploring-label">{progress.label}</div>
				</div>
			</div>
			{progress.stalledMembers && progress.stalledMembers.length > 0 && (
				<ul className="exploring-stall-notices" aria-live="polite">
					{progress.stalledMembers.map(
						({ memberId, memberName, assignmentNumber, lastActivityAt, lastAction }) => (
							<li key={`${memberId}:${assignmentNumber ?? "turn"}`}>
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
	return (
		<div className={`progress-snapshot-card is-${snapshot.outcome}`}>
			<button type="button" className="progress-snapshot-toggle" onClick={onToggle}>
				<span className="progress-snapshot-summary">
					<span className={`progress-snapshot-badge is-${snapshot.outcome}`}>{outcomeTitle}</span>
					{leadName && <strong>{leadName}</strong>}
					{!isCompleted && (
						<span className={`exploring-stage stage-${snapshot.stage}`}>{STAGE_LABELS[snapshot.stage]}</span>
					)}
					<span className="progress-snapshot-duration">
						{isCompleted ? "耗时 " : "已运行 "}
						{formatElapsedDuration(snapshot.elapsedSeconds)}
						{logCount > 0 ? ` · ${logCount} 条活动` : ""}
					</span>
				</span>
				<span className="progress-snapshot-toggle-text">
					{expanded ? "收起" : isCompleted ? "查看过程" : "查看进度"}
				</span>
			</button>
			{expanded && (
				<div className="progress-snapshot-body">
					{!isCompleted && (
						<div className="exploring-label">
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
