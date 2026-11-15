import { useState } from "react";
import { MarkdownView } from "../../MarkdownView.tsx";
import { type DelegationSummaryItem, formatClockTime } from "../../utils.ts";

/** Renders a single internal colleague delegation record with collapsible long Markdown bodies. */
export function DelegationItemCard({
	item,
	keyPrefix,
	showTime,
	memberName,
}: {
	item: DelegationSummaryItem;
	keyPrefix: string;
	showTime: boolean;
	memberName: (id: string) => string;
}) {
	const [expanded, setExpanded] = useState(false);
	const targetLabel = item.targetLabel || (item.toMemberId ? memberName(item.toMemberId) : "团队成员");
	const totalLen = item.question.length + (item.answer?.length ?? 0);
	const isLong = totalLen > 220 || item.question.split("\n").length > 4;
	const compactPreview = !expanded && isLong;

	return (
		<div key={`${keyPrefix}:${item.id}`} className="delegation-detail-item">
			<div className="delegation-detail-head">
				<span>
					{memberName(item.fromMemberId)} → <strong>{targetLabel}</strong>
					{showTime ? ` · ${formatClockTime(item.createdAt)}` : ""}
				</span>
				<span className={`delegation-status-tag ${item.status}`}>
					{item.status === "running" ? "协同中" : item.status === "completed" ? "已完成" : "未完成"}
				</span>
			</div>
			<div className={`delegation-md-body ${compactPreview ? "is-collapsed" : ""}`}>
				<MarkdownView content={item.question} />
			</div>
			{item.answer && (
				<div className={`delegation-detail-answer delegation-md-body ${compactPreview ? "is-collapsed" : ""}`}>
					<MarkdownView content={item.answer} />
				</div>
			)}
			{isLong && (
				<div className="delegation-collapse-row">
					<button type="button" className="btn-inline btn-xs" onClick={() => setExpanded((v) => !v)}>
						{expanded ? "收起内容" : "展开完整内容 →"}
					</button>
				</div>
			)}
		</div>
	);
}

/** Renders an inline expandable summary pill for delegations tied to a turn. */
export function DelegationSummaryCard({
	anchorKey,
	items,
	memberName,
}: {
	anchorKey: string;
	items: DelegationSummaryItem[];
	memberName: (id: string) => string;
}) {
	const [expanded, setExpanded] = useState(false);
	if (items.length === 0) return null;

	const targets = [
		...new Set(items.map((item) => item.targetLabel || (item.toMemberId ? memberName(item.toMemberId) : "团队成员"))),
	];
	const runningCount = items.filter((item) => item.status === "running").length;
	const failedCount = items.filter((item) => item.status === "failed").length;
	const statusSummary =
		runningCount > 0
			? `${runningCount} 项协同中`
			: failedCount === items.length
				? `${items.length} 项未完成`
				: failedCount > 0
					? `${items.length - failedCount} 项完成 · ${failedCount} 项未完成`
					: `${items.length} 项已完成`;

	return (
		<div className={`delegation-inline-card ${runningCount > 0 ? "is-running" : ""}`}>
			<button type="button" className="delegation-inline-toggle" onClick={() => setExpanded((v) => !v)}>
				<span className="delegation-pill-info">
					<span className="delegation-pill-badge">团队委托</span>
					<span>
						已委托 <strong>{targets.join("、")}</strong> · {statusSummary}
					</span>
				</span>
				<span className="delegation-toggle-text">{expanded ? "收起详情" : "查看详情"}</span>
			</button>
			{expanded && (
				<div className="delegation-detail-list">
					{items.map((item) => (
						<DelegationItemCard
							key={item.id}
							item={item}
							keyPrefix={`inline-${anchorKey}`}
							showTime={false}
							memberName={memberName}
						/>
					))}
				</div>
			)}
		</div>
	);
}
