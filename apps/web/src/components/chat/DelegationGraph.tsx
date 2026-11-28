import { Badge, type BadgeTone } from "../../primitives/index.ts";
import { cn } from "../../utils/cn.ts";
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

function resolveStatusTone(edge: DelegationEdge): BadgeTone {
	if (edge.verdict) return edge.verdict === "passed" ? "info" : "warn";
	if (edge.status === "running") return "accent";
	if (edge.status === "completed") return "info";
	return "warn";
}

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
	function renderBranches(branches: DelegationEdge[], depth = 0) {
		return (
			<ul
				className={cn("list-none m-0 p-0 grid gap-1.5", depth > 0 && "mt-1.5 ml-2.5 pl-2.5 border-l-2 border-line")}
			>
				{branches.map((edge) => {
					const nested = children.get(edge.id);
					const path = (
						<span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 break-words">
							{edge.number !== undefined && (
								<span className="text-accent text-micro tabular-nums font-bold">#{edge.number}</span>
							)}
							{edge.from && (
								<>
									<span>{edge.from}</span>
									<span className="text-accent font-bold">→</span>
								</>
							)}
							<strong>{edge.to}</strong>
						</span>
					);
					return (
						<li key={edge.id} className="min-w-0">
							<div
								className={cn(
									"flex items-center flex-wrap gap-x-2 gap-y-1 min-w-0 bg-stage border rounded-md px-2.5 py-1.5 text-ink text-xs",
									edge.status === "running" ? "border-accent-border" : "border-line",
								)}
							>
								{onOpenAssignment ? (
									<button
										type="button"
										className="min-w-0 border-0 p-0.5 bg-transparent text-xs text-inherit text-start cursor-pointer hover:text-accent transition-colors"
										onClick={() => onOpenAssignment(edge.id)}
									>
										{path}
									</button>
								) : (
									path
								)}
								<Badge tone={resolveStatusTone(edge)} size="xs" className="whitespace-nowrap">
									{edge.verdict
										? VERIFICATION_STATUS[edge.verdict]
										: edge.observer
											? "旁听"
											: edge.verification && edge.status === "running"
												? "验收中"
												: DELEGATION_STATUS[edge.status]}
								</Badge>
								{edge.stageLabel && <span className="text-ink-secondary break-words">{edge.stageLabel}</span>}
							</div>
							{nested && renderBranches(nested, depth + 1)}
						</li>
					);
				})}
			</ul>
		);
	}
	return <div className="min-w-0">{renderBranches(children.get(undefined) ?? [])}</div>;
}
