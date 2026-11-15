import type { MatterProgressDto } from "../api.ts";
import { formatClockTime, STAGE_LABELS, STAGE_ORDER } from "../utils.ts";

interface ExploringStatusProps {
	progress: MatterProgressDto;
	elapsedSeconds: number;
	onAbort?: () => void;
}

export function ExploringStatus({ progress, elapsedSeconds, onAbort }: ExploringStatusProps) {
	const activeIndex = STAGE_ORDER.indexOf(progress.stage);
	return (
		<div className="exploring-block">
			<div className="exploring-row">
				<span className="exploring-ring">
					<span className="exploring-dot" />
				</span>
				<span className="exploring-stage">{STAGE_LABELS[progress.stage]}</span>
				<span className="exploring-label">{progress.label}</span>
				<span className="exploring-time">{elapsedSeconds}s</span>
				{onAbort && (
					<button type="button" className="btn-stop-pill" onClick={onAbort}>
						停止
					</button>
				)}
			</div>
			<div className="exploring-bar">
				{STAGE_ORDER.map((stage, idx) => (
					<span
						key={stage}
						className={`exploring-seg ${idx < activeIndex ? "done" : idx === activeIndex ? "active" : ""}`}
					/>
				))}
			</div>
			{progress.activeDelegations && progress.activeDelegations.length > 0 && (
				<div className="exploring-delegations">
					<span className="exploring-delegations-prefix">团队协同</span>
					{progress.activeDelegations.map((entry) => (
						<span key={`${entry.memberId}-${entry.stageLabel}`} className="exploring-delegation-chip">
							<strong>{entry.memberName}</strong>
							<span>{entry.stageLabel}</span>
						</span>
					))}
				</div>
			)}
			{progress.recentLogs && progress.recentLogs.length > 0 && (
				<div className="exploring-feed">
					{progress.recentLogs.slice(-5).map((entry, idx) => (
						<div key={`${entry.at}-${entry.memberName}-${idx}`} className="exploring-feed-item">
							<span className="exploring-feed-time">{formatClockTime(entry.at)}</span>
							<strong>{entry.memberName}</strong>
							<span className="exploring-feed-text">{entry.summary}</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
