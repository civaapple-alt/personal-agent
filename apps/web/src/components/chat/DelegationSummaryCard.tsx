import { Badge } from "../../primitives/index.ts";
import { cn } from "../../utils/cn.ts";
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
		<div
			className={cn(
				"self-start mt-1 max-w-[min(88%,740px)] border rounded-xl overflow-hidden transition-colors",
				running > 0 ? "border-accent-border bg-surface-accent" : "border-line bg-sidebar",
			)}
		>
			<button
				type="button"
				className="w-full border-0 bg-transparent px-3 py-1.5 flex items-center justify-between gap-3.5 text-xs text-ink-secondary cursor-pointer text-left hover:bg-hover/50 transition-colors"
				data-open-delegations
				onClick={onOpen}
			>
				<span className="inline-flex items-center gap-2 flex-wrap">
					<Badge tone="accent" size="xs" className="bg-stage">
						{history ? "历史委托" : "本轮委托"}
					</Badge>
					<span>{summary}</span>
				</span>
				<span className="text-accent font-semibold whitespace-nowrap">查看交接</span>
			</button>
		</div>
	);
}
