import type { DeliverableSeries } from "../../utils/deliverableSeries.ts";
import { parseDeliverableSummary } from "../../utils/deliverableSummary.ts";
import { DELIVERABLE_TYPE_LABELS, formatClockTime } from "../../utils/formatters.ts";

export function MatterDeliverablesPanel({
	series,
	memberName,
	onOpenDeliverable,
}: {
	series: DeliverableSeries[];
	memberName: (id: string) => string;
	onOpenDeliverable: (id: string) => void;
}) {
	if (series.length === 0) return <p className="muted-hint">本事项暂无成果。</p>;

	return (
		<ul className="matter-deliverables-list" aria-label="本事项成果">
			{series.map(({ key, latest, versions }) => {
				const summary = parseDeliverableSummary(latest.summary).lead;
				return (
					<li key={key} className="matter-deliverable">
						<div className="matter-deliverable-head">
							<div className="matter-deliverable-copy">
								<strong>{latest.title}</strong>
								<span className="matter-deliverable-meta">
									{DELIVERABLE_TYPE_LABELS[latest.type]} · V{latest.version} · {memberName(latest.memberId)} ·{" "}
									{formatClockTime(latest.createdAt)}
								</span>
							</div>
							<button
								type="button"
								className="btn-pill-outline btn-xs"
								aria-label={`查看 ${latest.title} V${latest.version}`}
								onClick={() => onOpenDeliverable(latest.id)}
							>
								查看详情
							</button>
						</div>
						{summary && <p className="matter-deliverable-summary">{summary}</p>}
						{versions.length > 1 && (
							<details className="matter-deliverable-history">
								<summary>历史版本（{versions.length - 1}）</summary>
								<ul>
									{versions
										.slice(0, -1)
										.reverse()
										.map((version) => (
											<li key={version.id}>
												<button
													type="button"
													className="btn-inline"
													aria-label={`查看 ${version.title} V${version.version}`}
													onClick={() => onOpenDeliverable(version.id)}
												>
													V{version.version}
												</button>
												<span>
													{memberName(version.memberId)} · {formatClockTime(version.createdAt)}
												</span>
											</li>
										))}
								</ul>
							</details>
						)}
					</li>
				);
			})}
		</ul>
	);
}
