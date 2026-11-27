import type { ReactNode } from "react";
import { cn } from "../utils/cn.ts";

export interface EmptyStateProps {
	icon?: ReactNode;
	title: ReactNode;
	description?: ReactNode;
	action?: ReactNode;
	compact?: boolean;
	className?: string;
}

/** Centered empty-state placeholder with dashed hairline framing and optional action. */
export function EmptyState({ icon, title, description, action, compact = false, className }: EmptyStateProps) {
	return (
		<div
			className={cn(
				"flex flex-col items-center justify-center text-center border border-dashed border-line rounded-lg bg-surface/60",
				compact ? "px-4 py-6 gap-2" : "px-6 py-10 gap-3",
				className,
			)}
		>
			{icon && <div className="text-ink-muted flex items-center justify-center">{icon}</div>}
			<div className="flex flex-col gap-1 max-w-[420px]">
				<div className={cn("font-semibold text-ink", compact ? "text-sm" : "text-base")}>{title}</div>
				{description && <p className="m-0 text-xs text-ink-secondary leading-relaxed">{description}</p>}
			</div>
			{action && <div className="mt-1 flex items-center justify-center gap-2 flex-wrap">{action}</div>}
		</div>
	);
}
