import { useEffect, useId, useState } from "react";
import type { MatterMessageDto, MatterProgressDto } from "../../api/matters.ts";
import { MarkdownView } from "../../MarkdownView.tsx";
import { Badge, type BadgeTone, Button, Select, Tabs } from "../../primitives/index.ts";
import { formatClockTime, stripMarkdownFormatting } from "../../utils/formatters.ts";
import {
	type BoardFilter,
	type DelegationPost,
	delegationTaskText,
	filterDelegationBoard,
	liveDelegationEdges,
	type MatterDelegations,
} from "../../utils/matterDelegations.ts";
import { DELEGATION_STATUS, DelegationGraph, VERIFICATION_STATUS } from "./DelegationGraph.tsx";

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

function resolvePostStatusTone(status: "running" | "completed" | "failed", verdict?: string): BadgeTone {
	if (verdict) return verdict === "passed" ? "info" : "warn";
	if (status === "running") return "accent";
	if (status === "completed") return "info";
	return "warn";
}

function BoardPost({
	post,
	memberName,
	parentNumber,
	reviewedNumber,
	onOpenAssignment,
}: {
	post: DelegationPost;
	memberName: (id: string) => string;
	parentNumber?: number;
	reviewedNumber?: number;
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
	const verification = assignment.verification;
	const title = isAssignment
		? `${verification ? "安排验收" : "派发"} #${assignment.number}`
		: kind === "failure"
			? `未完成 #${assignment.number}`
			: `${verification ? "验收回报" : "回报"} #${assignment.number}`;

	return (
		<li className="border border-line rounded-md px-3 py-2.5 min-w-0 bg-stage">
			<div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-ink break-words">
				<span className="text-accent text-micro tabular-nums font-bold">{title}</span>
				<strong>
					{isAssignment || !recipient ? sender : recipient}
					{recipient && <> → {isAssignment ? recipient : sender}</>}
				</strong>
				{(isAssignment || (kind === "reply" && verification?.verdict)) && (
					<Badge tone={resolvePostStatusTone(assignment.status, verification?.verdict)} size="xs">
						{verification?.verdict
							? VERIFICATION_STATUS[verification.verdict]
							: DELEGATION_STATUS[assignment.status]}
					</Badge>
				)}
				<time className="ml-auto text-ink-muted whitespace-nowrap" dateTime={message.createdAt}>
					{formatClockTime(message.createdAt)}
				</time>
			</div>
			{verification && isAssignment && (
				<div className="flex gap-x-2.5 gap-y-1 flex-wrap mt-1 text-ink-secondary break-words">
					<span>
						{verification.kind === "commit" ? "提交" : verification.kind === "file" ? "文件" : "文档草稿"}{" "}
						<code className="font-mono">{verification.reference}</code>
					</span>
					{verification.kind !== "commit" && (
						<code className="font-mono" title={verification.digest}>
							SHA-256 {verification.digest.slice(0, 12)}
						</code>
					)}
				</div>
			)}
			{isAssignment && verification?.assignmentId && reviewedNumber !== undefined && (
				<Button
					variant="inline"
					size="xs"
					className="mt-1 px-0"
					onClick={() => {
						if (verification.assignmentId) onOpenAssignment(verification.assignmentId);
					}}
				>
					验收任务 #{reviewedNumber}
				</Button>
			)}
			{isAssignment && parentNumber !== undefined && parentId && (
				<Button variant="inline" size="xs" className="mt-1 px-0" onClick={() => onOpenAssignment(parentId)}>
					转派自 #{parentNumber}
				</Button>
			)}
			{!isAssignment && (
				<Button variant="inline" size="xs" className="mt-1 px-0" onClick={() => onOpenAssignment(assignment.id)}>
					查看原委托 #{assignment.number}
				</Button>
			)}
			<details
				className="mt-1 break-words [&[open]>.md-body]:mt-2 [&[open]>.md-body]:pt-2 [&[open]>.md-body]:border-t [&[open]>.md-body]:border-line"
				id={isAssignment ? `delegation-request-${assignment.id}` : undefined}
				onToggle={(event) => setExpanded(event.currentTarget.open)}
			>
				<summary className="py-0.5 cursor-pointer leading-relaxed text-ink-secondary hover:text-ink">
					{preview}
				</summary>
				{expanded && (
					<MarkdownView
						content={
							isAssignment && verification?.criteria
								? `${content}\n\n**验收条件**\n\n${verification.criteria}`
								: content
						}
					/>
				)}
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
	const scopeSelectId = useId();
	const filterSelectId = useId();
	const [openRequest, setOpenRequest] = useState<{ id: string } | null>(null);
	const [selection, setSelection] = useState<{ scopeId: string | undefined; filter: BoardFilter }>();
	const turns = messages.filter((message) => message.senderType === "user");
	const activeId = progress?.sourceUserMessageId;
	const latest = activeId ?? turns.findLast((turn) => delegations.byTurn.has(turn.id))?.id;
	const selectedId = scope === "latest" ? latest : scope === "history" ? undefined : scope.slice(5);
	const selectedTurn = turns.find((turn) => turn.id === selectedId);
	const isLive = Boolean(activeId && selectedId === activeId);
	const board = selectedId ? delegations.byTurn.get(selectedId) : delegations.history;
	const assignments = board?.assignments ?? [];
	const filter = selection && selection.scopeId === selectedId ? selection.filter : "all";
	const shown = filterDelegationBoard(assignments, filter);
	const shownIds = new Set(shown.map((item) => item.id));
	const assignmentNumbers = new Map(assignments.map((item) => [item.id, item.number]));
	const branches = assignments.filter(
		(item) => !item.parentRequestMessageId && !item.verification?.assignmentId && item.toMemberId,
	);
	const memberIds = [...new Set(assignments.flatMap((item) => [item.fromMemberId, item.toMemberId]).filter(Boolean))];
	const liveEdges = isLive
		? liveDelegationEdges(progress?.activeDelegations ?? []).filter((edge) => !edge.observer)
		: [];
	const liveById = new Map(liveEdges.map((edge) => [edge.id, edge]));
	const edges = shown
		.filter((item) => item.toMemberId || item.targetLabel)
		.map((item) => ({
			id: item.id,
			number: item.number,
			parentId: item.parentRequestMessageId ?? item.verification?.assignmentId,
			from: memberName(item.fromMemberId),
			to: item.targetLabel || memberName(item.toMemberId),
			status: item.status,
			verification: Boolean(item.verification),
			verdict: item.verification?.verdict,
			stageLabel: liveById.get(item.id)?.stageLabel,
		}));
	const extraEdges = liveEdges.filter(
		(edge) =>
			!assignmentNumbers.has(edge.id) && (filter === "all" || (filter === "verification" && edge.verification)),
	);
	const requestIsVisible = openRequest !== null && shownIds.has(openRequest.id);

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
		if (!shownIds.has(id)) setSelection({ scopeId: selectedId, filter: "all" });
		onSelectView("board");
		setOpenRequest({ id });
	};

	return (
		<section className="grid gap-2.5 min-w-0" aria-label="按轮次查看团队委托">
			<div className="flex items-end gap-3">
				<label htmlFor={scopeSelectId} className="grid flex-1 min-w-0 gap-1 font-semibold text-ink">
					<span>对话轮次</span>
					<Select
						id={scopeSelectId}
						size="sm"
						className="text-ellipsis"
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
					</Select>
				</label>
				{selectedTurn && (
					<Button variant="inline" size="xs" onClick={() => onLocateTurn(selectedTurn.id)}>
						定位消息
					</Button>
				)}
			</div>
			{selectedTurn && (
				<div className="flex items-center flex-wrap gap-x-2.5 gap-y-1.5 bg-sidebar border border-line rounded-md px-2.5 py-2">
					<strong className="break-words text-ink" title={selectedTurn.content}>
						{describeTurn(selectedTurn)}
					</strong>
					<time className="text-ink-muted" dateTime={selectedTurn.createdAt}>
						{formatRoundTime(selectedTurn.createdAt)}
					</time>
					{isLive && (
						<Badge tone="accent" size="xs">
							本轮运行中
						</Badge>
					)}
				</div>
			)}
			<div className="flex items-center flex-wrap gap-2">
				<Tabs
					variant="pill"
					size="sm"
					ariaLabel="委托视图"
					value={view}
					onChange={(id) => {
						if (id === "board" || id === "graph") onSelectView(id);
					}}
					items={[
						{ id: "board", label: "交接公告板" },
						{ id: "graph", label: "委托关系图" },
					]}
				/>
			</div>
			{assignments.length > 0 && (
				<label htmlFor={filterSelectId} className="flex items-center gap-2 flex-wrap font-semibold text-ink">
					<span>筛选交接记录</span>
					<Select
						id={filterSelectId}
						size="sm"
						className="w-auto min-w-0 max-w-full"
						value={filter}
						onChange={(event) => {
							const value = event.target.value;
							if (value === "all" || value === "verification")
								setSelection({ scopeId: selectedId, filter: value });
							else if (value.startsWith("member:"))
								setSelection({ scopeId: selectedId, filter: `member:${value.slice("member:".length)}` });
							else if (value.startsWith("branch:"))
								setSelection({ scopeId: selectedId, filter: `branch:${value.slice("branch:".length)}` });
						}}
					>
						<option value="all">全部</option>
						<option value="verification">独立验收</option>
						{branches.length > 0 && (
							<optgroup label="委托分支">
								{branches.map((item) => (
									<option key={item.id} value={`branch:${item.id}`}>
										#{item.number} · {item.targetLabel || memberName(item.toMemberId)}
									</option>
								))}
							</optgroup>
						)}
						{memberIds.length > 0 && (
							<optgroup label="参与成员">
								{memberIds.map((id) => (
									<option key={id} value={`member:${id}`}>
										{memberName(id)}
									</option>
								))}
							</optgroup>
						)}
					</Select>
				</label>
			)}
			{view === "graph" ? (
				edges.length + extraEdges.length > 0 ? (
					<DelegationGraph edges={[...edges, ...extraEdges]} onOpenAssignment={openAssignment} />
				) : (
					<p className="m-0 text-xs text-ink-muted">
						{filter === "all" ? "这一轮暂无委托关系。" : "当前筛选没有匹配的委托关系。"}
					</p>
				)
			) : board?.posts.length && shown.length > 0 ? (
				<ol className="list-none m-0 p-0 grid gap-2.5 min-w-0">
					{board.posts
						.filter((post) => shownIds.has(post.assignment.id))
						.map((post) => (
							<BoardPost
								key={post.message.id}
								post={post}
								memberName={memberName}
								reviewedNumber={
									post.assignment.verification?.assignmentId
										? assignmentNumbers.get(post.assignment.verification.assignmentId)
										: undefined
								}
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
				<p className="m-0 text-xs text-ink-muted">
					{filter !== "all"
						? "当前筛选没有匹配的交接记录。"
						: isLive
							? "本轮尚未发出委托。"
							: "暂无委托交接记录。"}
				</p>
			)}
		</section>
	);
}
