import type { DelegationAssignment } from "../../utils/matterDelegations.ts";

/** Opens the handoff board for the round shown immediately above this control. */
export function DelegationSummaryCard({
	items,
	onOpen,
	history = false,
}: {
	items: DelegationAssignment[];
	onOpen: () => void;
	history?: boolean;
}) {
	if (items.length === 0) return null;
	const running = items.filter((item) => item.status === "running").length;
	const failed = items.filter((item) => item.status === "failed").length;
	const done = items.length - running - failed;
	const summary = [
		running ? `${running} 项协同中` : "",
		done ? `${done} 项完成` : "",
		failed ? `${failed} 项未完成` : "",
	]
		.filter(Boolean)
		.join(" · ");
	return (
		<div className={`delegation-inline-card ${running > 0 ? "is-running" : ""}`}>
			<button type="button" className="delegation-inline-toggle" data-open-delegations onClick={onOpen}>
				<span className="delegation-pill-info">
					<span className="delegation-pill-badge">{history ? "历史委托" : "本轮委托"}</span>
					<span>{summary}</span>
				</span>
				<span className="delegation-toggle-text">查看交接</span>
			</button>
		</div>
	);
}
