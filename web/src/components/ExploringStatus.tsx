import type {
	ActiveDelegationDto,
	MatterProgressDto,
	ProgressActivityDto,
	ProgressSnapshotDto,
	TeamMemberDto,
} from "../api.ts";
import {
	formatClockTime,
	formatElapsedDuration,
	getBotTheme,
	getMemberThemeById,
	inferDelegationMood,
	SHORT_STAGE_LABELS,
	STAGE_LABELS,
	STAGE_ORDER,
} from "../utils.ts";
import { BotFaceIcon } from "./BotFaceIcon.tsx";

interface ProgressDetailsProps {
	stage: MatterProgressDto["stage"];
	activeDelegations?: ActiveDelegationDto[];
	recentLogs?: ProgressActivityDto[];
	members?: TeamMemberDto[];
	delegationHeading?: string;
	stoppedMode?: boolean;
}

function ProgressDetails({
	stage,
	activeDelegations,
	recentLogs,
	members,
	delegationHeading = "正在协同的团队岗位",
	stoppedMode = false,
}: ProgressDetailsProps) {
	const activeIndex = STAGE_ORDER.indexOf(stage);
	return (
		<>
			<div className="exploring-stepper">
				{STAGE_ORDER.map((stepStage, idx) => {
					const stateClass =
						idx < activeIndex ? "done" : idx === activeIndex ? (stoppedMode ? "stopped" : "active") : "";
					return (
						<div key={stepStage} className={`exploring-step ${stateClass}`}>
							<span className="exploring-seg" />
							<span className="exploring-step-name">{SHORT_STAGE_LABELS[stepStage]}</span>
						</div>
					);
				})}
			</div>

			{activeDelegations && activeDelegations.length > 0 && (
				<div className="exploring-delegations">
					<div className="exploring-section-head">{delegationHeading}</div>
					<div className="exploring-desk-grid">
						{activeDelegations.map((entry) => {
							const colleagueTheme = getMemberThemeById(members, entry.memberId);
							const colleagueMood = stoppedMode ? "idle" : inferDelegationMood(entry.stageLabel);
							return (
								<div key={entry.memberId} className="exploring-desk-card">
									<BotFaceIcon
										bg={colleagueTheme.bg}
										tilt={colleagueTheme.tilt}
										size="sm"
										mood={colleagueMood}
									/>
									<div className="exploring-desk-meta">
										<div className="exploring-desk-name">{entry.memberName}</div>
										<div className="exploring-desk-action">{entry.stageLabel}</div>
									</div>
								</div>
							);
						})}
					</div>
				</div>
			)}

			{recentLogs && recentLogs.length > 0 && (
				<div className="exploring-feed">
					{recentLogs.slice(-6).map((entry, idx) => {
						const logMember = members?.find((m) => m.displayName === entry.memberName);
						const logColor = logMember ? getMemberThemeById(members, logMember.id).bg : getBotTheme(idx).bg;
						return (
							<div key={`${entry.at}-${entry.memberName}-${idx}`} className="exploring-feed-item">
								<span className="exploring-feed-dot" style={{ background: logColor }} />
								<span className="exploring-feed-time">{formatClockTime(entry.at)}</span>
								<strong>{entry.memberName}</strong>
								<span className="exploring-feed-text">{entry.summary}</span>
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
	elapsedSeconds: number;
	members?: TeamMemberDto[];
	leadMemberId?: string | null;
	leadDisplayName?: string;
	onAbort?: () => void;
}

export function ExploringStatus({
	progress,
	elapsedSeconds,
	members,
	leadMemberId,
	leadDisplayName,
	onAbort,
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
						<span className="exploring-time">{formatElapsedDuration(elapsedSeconds)}</span>
						{onAbort && (
							<button type="button" className="btn-stop-pill" onClick={onAbort}>
								停止
							</button>
						)}
					</div>
					<div className="exploring-label">{progress.label}</div>
				</div>
			</div>

			<ProgressDetails
				stage={progress.stage}
				activeDelegations={progress.activeDelegations}
				recentLogs={progress.recentLogs}
				members={members}
			/>
		</div>
	);
}

interface ProgressSnapshotCardProps {
	snapshot: ProgressSnapshotDto;
	expanded: boolean;
	members?: TeamMemberDto[];
	fallbackLeadName?: string;
	onToggle: () => void;
}

export function ProgressSnapshotCard({
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
	const outcomeTitle = snapshot.outcome === "aborted" ? "中止前进度" : "异常前进度";
	return (
		<div className={`progress-snapshot-card is-${snapshot.outcome}`}>
			<button type="button" className="progress-snapshot-toggle" onClick={onToggle}>
				<span className="progress-snapshot-summary">
					<span className={`progress-snapshot-badge is-${snapshot.outcome}`}>{outcomeTitle}</span>
					{leadName && <strong>{leadName}</strong>}
					<span className={`exploring-stage stage-${snapshot.stage}`}>{STAGE_LABELS[snapshot.stage]}</span>
					<span className="progress-snapshot-duration">
						已运行 {formatElapsedDuration(snapshot.elapsedSeconds)}
					</span>
				</span>
				<span className="progress-snapshot-toggle-text">{expanded ? "收起进度" : "查看进度"}</span>
			</button>
			{expanded && (
				<div className="progress-snapshot-body">
					<div className="exploring-label">
						{snapshot.label}
						{snapshot.capturedAt ? ` · 停于 ${formatClockTime(snapshot.capturedAt)}` : ""}
					</div>
					<ProgressDetails
						stage={snapshot.stage}
						activeDelegations={snapshot.activeDelegations}
						recentLogs={snapshot.recentLogs}
						members={members}
						delegationHeading={snapshot.outcome === "aborted" ? "中止时仍在协同的岗位" : "异常时仍在协同的岗位"}
						stoppedMode
					/>
				</div>
			)}
		</div>
	);
}
