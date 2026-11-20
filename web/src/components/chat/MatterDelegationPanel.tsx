import { useEffect, useState } from "react";
import type { MatterMessageDto, MatterProgressDto } from "../../api/matters.ts";
import { MarkdownView } from "../../MarkdownView.tsx";
import { formatClockTime, stripMarkdownFormatting } from "../../utils/formatters.ts";
import {
	type DelegationPost,
	delegationTaskText,
	liveDelegationEdges,
	type MatterDelegations,
} from "../../utils/matterDelegations.ts";
import { DELEGATION_STATUS, DelegationGraph } from "./DelegationGraph.tsx";

export type DelegationScope = "latest" | "history" | `turn:${string}`;
export type DelegationView = "board" | "graph";

const roundTime = new Intl.DateTimeFormat("zh-CN", {
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
});

function formatRoundTime(iso: string) {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? iso : roundTime.format(date);
}

function describeTurn(message: MatterMessageDto) {
	const preview = stripMarkdownFormatting(message.content).replace(/\s+/g, " ").trim();
	const label = preview.length > 52 ? `${preview.slice(0, 52)}…` : preview;
	return label || "附件消息";
}

function BoardPost({
	post,
	memberName,
	parentNumber,
	onOpenAssignment,
}: {
	post: DelegationPost;
	memberName: (id: string) => string;
	parentNumber?: number;
	onOpenAssignment: (id: string) => void;
}) {
	const [expanded, setExpanded] = useState(false);
	const { assignment, kind, message } = post;
	const isAssignment = kind === "assignment";
	const sender = memberName(assignment.fromMemberId);
	const recipient = assignment.targetLabel || (assignment.toMemberId ? memberName(assignment.toMemberId) : "");
	const content = isAssignment ? delegationTaskText(message.content) : message.content;
	const summary = content.replace(/\s+/g, " ").trim();
	const preview = summary.length > 150 ? `${summary.slice(0, 150)}…` : summary;
	const parentId = assignment.parentRequestMessageId;
	const title = isAssignment
		? `派发 #${assignment.number}`
		: kind === "failure"
			? `未完成 #${assignment.number}`
			: `回报 #${assignment.number}`;

	return (
		<li className="delegation-board-post">
			<div className="delegation-post-meta">
				<span className="delegation-post-number">{title}</span>
				<strong>
					{isAssignment || !recipient ? sender : recipient}
					{recipient && <> → {isAssignment ? recipient : sender}</>}
				</strong>
				{isAssignment && (
					<span className={`delegation-status-tag ${assignment.status}`}>
						{DELEGATION_STATUS[assignment.status]}
					</span>
				)}
				<time dateTime={message.createdAt}>{formatClockTime(message.createdAt)}</time>
			</div>
			{isAssignment && parentNumber !== undefined && parentId && (
				<button
					type="button"
					className="btn-inline btn-xs delegation-post-reference"
					onClick={() => onOpenAssignment(parentId)}
				>
					转派自 #{parentNumber}
				</button>
			)}
			{!isAssignment && (
				<button
					type="button"
					className="btn-inline btn-xs delegation-post-reference"
					onClick={() => onOpenAssignment(assignment.id)}
				>
					查看原委托 #{assignment.number}
				</button>
			)}
			<details
				className="delegation-post-content"
				id={isAssignment ? `delegation-request-${assignment.id}` : undefined}
				onToggle={(event) => setExpanded(event.currentTarget.open)}
			>
				<summary>{preview}</summary>
				{expanded && <MarkdownView content={content} />}
			</details>
		</li>
	);
}

export function MatterDelegationPanel({
	delegations,
	messages,
	progress,
	scope,
	view,
	memberName,
	onSelectScope,
	onSelectView,
	onLocateTurn,
}: {
	delegations: MatterDelegations;
	messages: MatterMessageDto[];
	progress: MatterProgressDto | null;
	scope: DelegationScope;
	view: DelegationView;
	memberName: (id: string) => string;
	onSelectScope: (next: DelegationScope) => void;
	onSelectView: (next: DelegationView) => void;
	onLocateTurn: (turnId: string) => void;
}) {
	const [openRequest, setOpenRequest] = useState<{ id: string } | null>(null);
	const turns = messages.filter((message) => message.senderType === "user");
	const activeId = progress?.sourceUserMessageId;
	const latest = activeId ?? turns.findLast((turn) => delegations.byTurn.has(turn.id))?.id;
	const selectedId = scope === "latest" ? latest : scope === "history" ? undefined : scope.slice(5);
	const selectedTurn = turns.find((turn) => turn.id === selectedId);
	const isLive = Boolean(activeId && selectedId === activeId);
	const board = selectedId ? delegations.byTurn.get(selectedId) : delegations.history;
	const assignmentNumbers = new Map(board?.assignments.map((item) => [item.id, item.number]));
	const liveEdges = isLive
		? liveDelegationEdges(progress?.activeDelegations ?? []).filter((edge) => !edge.observer)
		: [];
	const liveById = new Map(liveEdges.map((edge) => [edge.id, edge]));
	const edges = (board?.assignments ?? [])
		.filter((item) => item.toMemberId || item.targetLabel)
		.map((item) => ({
			id: item.id,
			number: item.number,
			parentId: item.parentRequestMessageId,
			from: memberName(item.fromMemberId),
			to: item.targetLabel || memberName(item.toMemberId),
			status: item.status,
			stageLabel: liveById.get(item.id)?.stageLabel,
		}));
	const extraEdges = liveEdges.filter((edge) => !assignmentNumbers.has(edge.id));
	const requestIsVisible = openRequest !== null && assignmentNumbers.has(openRequest.id);

	useEffect(() => {
		if (view !== "board" || !requestIsVisible || !openRequest) return;
		const details = document.getElementById(`delegation-request-${openRequest.id}`);
		if (!(details instanceof HTMLDetailsElement)) return;
		details.open = true;
		details.querySelector("summary")?.focus({ preventScroll: true });
		details.scrollIntoView({ block: "nearest" });
		setOpenRequest(null);
	}, [view, openRequest, requestIsVisible]);

	const openAssignment = (id: string) => {
		onSelectView("board");
		setOpenRequest({ id });
	};

	return (
		<section className="delegation-panel" aria-label="按轮次查看团队委托">
			<div className="delegation-round">
				<label>
					<span>对话轮次</span>
					<select
						className="input-field"
						value={scope}
						onChange={(event) => {
							const value = event.target.value;
							if (value === "latest" || value === "history") onSelectScope(value);
							else if (value.startsWith("turn:")) onSelectScope(`turn:${value.slice(5)}`);
						}}
					>
						<option value="latest">跟随当前或最近委托</option>
						{turns
							.filter(
								(turn) => delegations.byTurn.has(turn.id) || turn.id === activeId || turn.id === selectedId,
							)
							.toReversed()
							.map((turn) => (
								<option key={turn.id} value={`turn:${turn.id}`}>
									{formatRoundTime(turn.createdAt)} · {describeTurn(turn)}
								</option>
							))}
						{delegations.history.assignments.length > 0 && <option value="history">历史记录 · 轮次未确认</option>}
					</select>
				</label>
				{selectedTurn && (
					<button type="button" className="btn-inline btn-xs" onClick={() => onLocateTurn(selectedTurn.id)}>
						定位消息
					</button>
				)}
			</div>
			{selectedTurn && (
				<div className="delegation-round-context">
					<strong title={selectedTurn.content}>{describeTurn(selectedTurn)}</strong>
					<time dateTime={selectedTurn.createdAt}>{formatRoundTime(selectedTurn.createdAt)}</time>
					{isLive && <span className="delegation-status-tag running">本轮运行中</span>}
				</div>
			)}
			<fieldset className="delegation-view" aria-label="委托视图">
				<button
					type="button"
					className={`choice-chip ${view === "board" ? "active" : ""}`}
					aria-pressed={view === "board"}
					onClick={() => onSelectView("board")}
				>
					交接公告板
				</button>
				<button
					type="button"
					className={`choice-chip ${view === "graph" ? "active" : ""}`}
					aria-pressed={view === "graph"}
					onClick={() => onSelectView("graph")}
				>
					委托关系图
				</button>
			</fieldset>
			{view === "graph" ? (
				edges.length + extraEdges.length > 0 ? (
					<DelegationGraph edges={[...edges, ...extraEdges]} onOpenAssignment={openAssignment} />
				) : (
					<p className="muted-hint">这一轮暂无委托关系。</p>
				)
			) : board?.posts.length ? (
				<ol className="delegation-board-list">
					{board.posts.map((post) => (
						<BoardPost
							key={post.message.id}
							post={post}
							memberName={memberName}
							parentNumber={
								post.assignment.parentRequestMessageId
									? assignmentNumbers.get(post.assignment.parentRequestMessageId)
									: undefined
							}
							onOpenAssignment={openAssignment}
						/>
					))}
				</ol>
			) : (
				<p className="muted-hint">{isLive ? "本轮尚未发出委托。" : "暂无委托交接记录。"}</p>
			)}
		</section>
	);
}
