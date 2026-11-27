import { useMemo } from "react";
import type { BoardMemberDto, BoardPostSummaryDto } from "../../api.ts";
import { buildBoardMentionGraph } from "../../hooks/useMatterBoard.ts";

interface BoardMentionGraphProps {
	members: readonly BoardMemberDto[];
	posts: readonly BoardPostSummaryDto[];
	hideInactive: boolean;
	onToggleHideInactive: () => void;
	onSelectAgent?: (agentId: string) => void;
}

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
		<div className="board-graph-tab">
			<div className="board-graph-toolbar">
				<span className="board-graph-caption">
					点击节点可筛选该成员板帖；默认过滤静默的后台巡检与历史退场节点。
				</span>
				<button
					type="button"
					className={`board-filter-pill${hideInactive ? " active" : ""}`}
					aria-pressed={hideInactive}
					onClick={onToggleHideInactive}
				>
					{hideInactive ? "仅看活跃成员" : "显示全部历史"}
				</button>
			</div>

			{graph.nodes.length === 0 ? (
				<div className="board-empty-state">
					<p>暂无看板关系数据。</p>
				</div>
			) : (
				<div className="board-graph-canvas-wrap">
					<svg
						className="board-graph-svg"
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
								<path d="M 0 1 L 10 5 L 0 9 z" className="board-graph-marker-normal" />
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
								<path d="M 0 1 L 10 5 L 0 9 z" className="board-graph-marker-rework" />
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
								<path d="M 0 1 L 10 5 L 0 9 z" className="board-graph-marker-pass" />
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
								<path d="M 0 1 L 10 5 L 0 9 z" className="board-graph-marker-escalate" />
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
								<g key={`${edge.from}->${edge.to}`} className={`board-graph-edge is-${edge.tone}`}>
									<path
										d={`M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`}
										strokeWidth={strokeWidth}
										fill="none"
										markerEnd={`url(#board-arrow-${edge.tone})`}
									/>
									<text x={cx} y={cy - 4} textAnchor="middle" className="board-graph-edge-label">
										{edge.count}
									</text>
								</g>
							);
						})}

						{graph.nodes.map((node) => {
							const isRetired = node.status === "retired" || node.status === "stopped";
							const label =
								node.displayName.length > 14 ? `${node.displayName.slice(0, 13)}…` : node.displayName;
							return (
								<g
									key={node.agentId}
									transform={`translate(${node.x}, ${node.y})`}
									className={`board-graph-node is-${node.status}${isRetired ? " is-dimmed" : ""}`}
								>
									<rect x={-56} y={-20} width={112} height={40} rx={12} className="board-graph-node-box" />
									<text x={0} y={-2} textAnchor="middle" className="board-graph-node-title">
										{label}
									</text>
									<text x={0} y={12} textAnchor="middle" className="board-graph-node-sub">
										@{node.agentId} · {node.postCount}帖
									</text>
								</g>
							);
						})}
					</svg>
				</div>
			)}

			{graph.nodes.length > 0 && onSelectAgent && (
				<div className="board-graph-node-filters">
					<span className="board-graph-caption">直达板帖：</span>
					{graph.nodes.map((node) => (
						<button
							key={node.agentId}
							type="button"
							className="board-filter-pill"
							onClick={() => onSelectAgent(node.agentId)}
						>
							@{node.agentId}
						</button>
					))}
				</div>
			)}

			<div className="board-graph-legend">
				<span className="board-graph-legend-item is-normal">普通 @mention</span>
				<span className="board-graph-legend-item is-rework">验收打回</span>
				<span className="board-graph-legend-item is-pass">验收通过</span>
				<span className="board-graph-legend-item is-escalate">升级 / @monitor</span>
			</div>
		</div>
	);
}
