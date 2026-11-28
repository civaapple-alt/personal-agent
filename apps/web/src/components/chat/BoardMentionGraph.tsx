import { useMemo } from "react";
import type { BoardMemberDto, BoardPostSummaryDto } from "../../api.ts";
import { buildBoardMentionGraph } from "../../hooks/useMatterBoard.ts";
import { EmptyState } from "../../primitives/index.ts";
import { cn } from "../../utils/cn.ts";

interface BoardMentionGraphProps {
	members: readonly BoardMemberDto[];
	posts: readonly BoardPostSummaryDto[];
	hideInactive: boolean;
	onToggleHideInactive: () => void;
	onSelectAgent?: (agentId: string) => void;
}

const EDGE_COLOR_VAR: Record<"normal" | "rework" | "pass" | "escalate", string> = {
	normal: "var(--border-strong)",
	rework: "var(--warn-border)",
	pass: "var(--accent)",
	escalate: "var(--danger-text)",
};

/** Renders a lightweight interactive SVG `@mention` interaction graph for the active matter board. */
export function BoardMentionGraph({
	members,
	posts,
	hideInactive,
	onToggleHideInactive,
	onSelectAgent,
}: BoardMentionGraphProps) {
	const graph = useMemo(
		() => buildBoardMentionGraph(members, posts, { hideInactive }),
		[members, posts, hideInactive],
	);

	const nodeMap = useMemo(() => new Map(graph.nodes.map((node) => [node.agentId, node])), [graph.nodes]);

	return (
		<div className="flex flex-col gap-2.5">
			<div className="flex items-center justify-between gap-2 flex-wrap">
				<span className="text-micro text-ink-muted">
					点击节点可筛选该成员板帖；默认过滤静默的后台巡检与历史退场节点。
				</span>
				<button
					type="button"
					className={cn(
						"border rounded-pill px-2.5 py-0.5 text-micro cursor-pointer transition-colors",
						hideInactive
							? "border-accent bg-accent-soft text-accent font-semibold"
							: "border-line bg-stage text-ink-secondary font-medium hover:border-line-strong hover:text-ink",
					)}
					aria-pressed={hideInactive}
					onClick={onToggleHideInactive}
				>
					{hideInactive ? "仅看活跃成员" : "显示全部历史"}
				</button>
			</div>

			{graph.nodes.length === 0 ? (
				<EmptyState compact title="暂无看板关系数据。" />
			) : (
				<div className="border border-line rounded-md bg-subtle p-2 overflow-x-auto">
					<svg
						className="w-full h-auto block"
						viewBox={`0 0 ${graph.width} ${graph.height}`}
						role="img"
						aria-label="团队 @mention 协作关系图"
					>
						<defs>
							<marker
								id="board-arrow-normal"
								viewBox="0 0 10 10"
								refX="8"
								refY="5"
								markerWidth="6"
								markerHeight="6"
								orient="auto-start-reverse"
							>
								<path d="M 0 1 L 10 5 L 0 9 z" fill="var(--border-strong)" />
							</marker>
							<marker
								id="board-arrow-rework"
								viewBox="0 0 10 10"
								refX="8"
								refY="5"
								markerWidth="6"
								markerHeight="6"
								orient="auto-start-reverse"
							>
								<path d="M 0 1 L 10 5 L 0 9 z" fill="var(--warn-border)" />
							</marker>
							<marker
								id="board-arrow-pass"
								viewBox="0 0 10 10"
								refX="8"
								refY="5"
								markerWidth="6"
								markerHeight="6"
								orient="auto-start-reverse"
							>
								<path d="M 0 1 L 10 5 L 0 9 z" fill="var(--accent)" />
							</marker>
							<marker
								id="board-arrow-escalate"
								viewBox="0 0 10 10"
								refX="8"
								refY="5"
								markerWidth="6"
								markerHeight="6"
								orient="auto-start-reverse"
							>
								<path d="M 0 1 L 10 5 L 0 9 z" fill="var(--danger-text)" />
							</marker>
						</defs>

						{graph.edges.map((edge) => {
							const src = nodeMap.get(edge.from);
							const dst = nodeMap.get(edge.to);
							if (!src || !dst) return null;
							const dx = dst.x - src.x;
							const dy = dst.y - src.y;
							const dist = Math.hypot(dx, dy) || 1;
							const ux = dx / dist;
							const uy = dy / dist;
							const reverseExists = graph.edges.some(
								(other) => other.from === edge.to && other.to === edge.from,
							);
							const offset = reverseExists ? 12 : 0;
							const nx = -uy * offset;
							const ny = ux * offset;
							const x1 = src.x + ux * 26 + nx;
							const y1 = src.y + uy * 22 + ny;
							const x2 = dst.x - ux * 28 + nx;
							const y2 = dst.y - uy * 24 + ny;
							const cx = (x1 + x2) / 2 + nx * 1.4;
							const cy = (y1 + y2) / 2 + ny * 1.4;
							const strokeWidth = Math.min(4, 1.4 + edge.count * 0.5);
							return (
								<g key={`${edge.from}->${edge.to}`}>
									<path
										d={`M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`}
										stroke={EDGE_COLOR_VAR[edge.tone]}
										strokeWidth={strokeWidth}
										fill="none"
										markerEnd={`url(#board-arrow-${edge.tone})`}
									/>
									<text
										x={cx}
										y={cy - 4}
										textAnchor="middle"
										fontSize={10}
										fontWeight={600}
										fill="var(--text-secondary)"
									>
										{edge.count}
									</text>
								</g>
							);
						})}

						{graph.nodes.map((node) => {
							const isRetired = node.status === "retired" || node.status === "stopped";
							const label =
								node.displayName.length > 14 ? `${node.displayName.slice(0, 13)}…` : node.displayName;
							const boxStroke =
								node.status === "working"
									? "var(--accent)"
									: node.status === "blocked_human"
										? "var(--warn-border)"
										: "var(--border-strong)";
							const boxStrokeWidth = node.status === "working" || node.status === "blocked_human" ? 2 : 1.5;
							return (
								<g
									key={node.agentId}
									transform={`translate(${node.x}, ${node.y})`}
									className={cn("board-graph-node cursor-pointer", isRetired && "opacity-50")}
								>
									<rect
										x={-56}
										y={-20}
										width={112}
										height={40}
										rx={12}
										fill="var(--bg-card)"
										stroke={boxStroke}
										strokeWidth={boxStrokeWidth}
										strokeDasharray={isRetired ? "4 3" : undefined}
									/>
									<text
										x={0}
										y={-2}
										textAnchor="middle"
										fontSize={11}
										fontWeight={600}
										fill="var(--text-primary)"
									>
										{label}
									</text>
									<text
										x={0}
										y={12}
										textAnchor="middle"
										fontSize={9.5}
										className="font-mono"
										fill="var(--text-muted)"
									>
										@{node.agentId} · {node.postCount}帖
									</text>
								</g>
							);
						})}
					</svg>
				</div>
			)}

			{graph.nodes.length > 0 && onSelectAgent && (
				<div className="board-graph-node-filters flex items-center flex-wrap gap-1.5">
					<span className="text-micro text-ink-muted">直达板帖：</span>
					{graph.nodes.map((node) => (
						<button
							key={node.agentId}
							type="button"
							className="border border-line bg-stage text-ink-secondary rounded-pill px-2.5 py-0.5 text-micro font-medium cursor-pointer transition-colors hover:border-line-strong hover:text-ink"
							onClick={() => onSelectAgent(node.agentId)}
						>
							@{node.agentId}
						</button>
					))}
				</div>
			)}

			<div className="flex flex-wrap gap-2.5 text-micro text-ink-secondary">
				<span className="inline-flex items-center gap-1.5">
					<span className="inline-block w-3 h-0.5 bg-line-strong" aria-hidden="true" />
					普通 @mention
				</span>
				<span className="inline-flex items-center gap-1.5">
					<span className="inline-block w-3 h-0.5 bg-warn-border" aria-hidden="true" />
					验收打回
				</span>
				<span className="inline-flex items-center gap-1.5">
					<span className="inline-block w-3 h-0.5 bg-accent" aria-hidden="true" />
					验收通过
				</span>
				<span className="inline-flex items-center gap-1.5">
					<span className="inline-block w-3 h-0.5 bg-danger-text" aria-hidden="true" />
					升级 / @monitor
				</span>
			</div>
		</div>
	);
}
