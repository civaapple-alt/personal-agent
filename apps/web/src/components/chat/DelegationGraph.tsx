import type { DelegationEdge } from "../../utils/matterDelegations.ts";

export const DELEGATION_STATUS = {
	running: "协同中",
	completed: "已完成",
	failed: "未完成",
};

export const VERIFICATION_STATUS = {
	passed: "验收通过",
	changes_requested: "需返工",
	inconclusive: "待复验",
};

/** A directed call tree. Each branch represents one call, including repeated calls to the same role. */
export function DelegationGraph({
	edges,
	onOpenAssignment,
}: {
	edges: DelegationEdge[];
	onOpenAssignment?: (id: string) => void;
}) {
	const order = new Map(edges.map((edge, index) => [edge.id, index]));
	const children = new Map<string | undefined, DelegationEdge[]>();
	for (const edge of edges) {
		const parentIndex = edge.parentId ? order.get(edge.parentId) : undefined;
		const parentId = parentIndex !== undefined && parentIndex < (order.get(edge.id) ?? 0) ? edge.parentId : undefined;
		const siblings = children.get(parentId) ?? [];
		siblings.push(edge);
		children.set(parentId, siblings);
	}
	function renderBranches(branches: DelegationEdge[]) {
		return (
			<ul className="delegation-graph-list">
				{branches.map((edge) => {
					const nested = children.get(edge.id);
					const path = (
						<span className="delegation-graph-path">
							{edge.number !== undefined && <span className="delegation-graph-number">#{edge.number}</span>}
							{edge.from && (
								<>
									<span>{edge.from}</span>
									<span className="delegation-graph-arrow">→</span>
								</>
							)}
							<strong>{edge.to}</strong>
						</span>
					);
					return (
						<li key={edge.id} className="delegation-graph-branch">
							<div className={`delegation-graph-edge ${edge.status}`}>
								{onOpenAssignment ? (
									<button
										type="button"
										className="delegation-graph-link"
										onClick={() => onOpenAssignment(edge.id)}
									>
										{path}
									</button>
								) : (
									path
								)}
								<span
									className={`delegation-status-tag ${edge.verdict && edge.verdict !== "passed" ? "failed" : edge.status}`}
								>
									{edge.verdict
										? VERIFICATION_STATUS[edge.verdict]
										: edge.observer
											? "旁听"
											: edge.verification && edge.status === "running"
												? "验收中"
												: DELEGATION_STATUS[edge.status]}
								</span>
								{edge.stageLabel && <span className="delegation-graph-stage">{edge.stageLabel}</span>}
							</div>
							{nested && renderBranches(nested)}
						</li>
					);
				})}
			</ul>
		);
	}
	return <div className="delegation-graph">{renderBranches(children.get(undefined) ?? [])}</div>;
}
