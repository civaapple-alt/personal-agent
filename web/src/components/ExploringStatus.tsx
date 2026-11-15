import type { MatterProgressDto, TeamMemberDto } from "../api.ts";
import {
	formatClockTime,
	getBotTheme,
	getMemberThemeById,
	inferDelegationMood,
	STAGE_LABELS,
	STAGE_ORDER,
} from "../utils.ts";
import { BotFaceIcon } from "./BotFaceIcon.tsx";

const SHORT_STAGE_LABELS: Record<MatterProgressDto["stage"], string> = {
	starting: "准备",
	thinking: "思考",
	tool: "执行",
	waiting_user: "确认",
	finalizing: "整理",
};

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
	const activeIndex = STAGE_ORDER.indexOf(progress.stage);
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
						<span className="exploring-time">{elapsedSeconds}s</span>
						{onAbort && (
							<button type="button" className="btn-stop-pill" onClick={onAbort}>
								停止
							</button>
						)}
					</div>
					<div className="exploring-label">{progress.label}</div>
				</div>
			</div>

			<div className="exploring-stepper">
				{STAGE_ORDER.map((stage, idx) => {
					const stateClass = idx < activeIndex ? "done" : idx === activeIndex ? "active" : "";
					return (
						<div key={stage} className={`exploring-step ${stateClass}`}>
							<span className="exploring-seg" />
							<span className="exploring-step-name">{SHORT_STAGE_LABELS[stage]}</span>
						</div>
					);
				})}
			</div>

			{progress.activeDelegations && progress.activeDelegations.length > 0 && (
				<div className="exploring-delegations">
					<div className="exploring-section-head">正在协同的团队岗位</div>
					<div className="exploring-desk-grid">
						{progress.activeDelegations.map((entry) => {
							const colleagueTheme = getMemberThemeById(members, entry.memberId);
							const colleagueMood = inferDelegationMood(entry.stageLabel);
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

			{progress.recentLogs && progress.recentLogs.length > 0 && (
				<div className="exploring-feed">
					{progress.recentLogs.slice(-5).map((entry, idx) => {
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
		</div>
	);
}
