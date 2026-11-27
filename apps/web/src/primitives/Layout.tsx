import type { CSSProperties, ReactNode } from "react";
import { cn } from "../utils/cn.ts";

export interface PageShellProps {
	maxWidth?: "md" | "wide" | "full";
	className?: string;
	innerClassName?: string;
	children: ReactNode;
}

const MAX_WIDTH_CLASS: Record<NonNullable<PageShellProps["maxWidth"]>, string> = {
	md: "max-w-[var(--content-max-w)]",
	wide: "max-w-[var(--content-wide-w)]",
	full: "max-w-none",
};

/** Scrollable workbench main region aligned to PA's content width tokens. */
export function PageShell({ maxWidth = "md", className, innerClassName, children }: PageShellProps) {
	return (
		<div
			className={cn(
				"flex-1 min-h-0 overflow-y-auto px-[var(--page-pad-x)] py-[var(--page-pad-y)] pb-9",
				className,
			)}
		>
			<div className={cn("mx-auto w-full min-w-0", MAX_WIDTH_CLASS[maxWidth], innerClassName)}>{children}</div>
		</div>
	);
}

export interface PaneHeaderProps {
	title: ReactNode;
	subtitle?: ReactNode;
	meta?: ReactNode;
	actions?: ReactNode;
	sticky?: boolean;
	className?: string;
}

/** Compact Linear-style pane header with optional metadata badge, subtitle, and right-aligned actions. */
export function PaneHeader({ title, subtitle, meta, actions, sticky = false, className }: PaneHeaderProps) {
	return (
		<header
			className={cn(
				"min-h-11 py-2.5 flex items-start justify-between gap-3 flex-wrap border-b border-line",
				sticky && "sticky top-0 z-10 bg-stage/95",
				className,
			)}
		>
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2 flex-wrap">
					<h1 className="m-0 text-xl font-semibold tracking-tight text-ink leading-tight">{title}</h1>
					{meta}
				</div>
				{subtitle && <p className="mt-1 mb-0 text-xs text-ink-secondary leading-normal">{subtitle}</p>}
			</div>
			{actions && <div className="flex items-center gap-2 flex-wrap shrink-0">{actions}</div>}
		</header>
	);
}

export interface SplitPaneProps {
	sidebar: ReactNode;
	children: ReactNode;
	sidebarWidth?: string;
	className?: string;
}

/** Responsive two-column split layout that stacks below lg and keeps sidebar width configurable. */
export function SplitPane({ sidebar, children, sidebarWidth, className }: SplitPaneProps) {
	const style = sidebarWidth ? ({ "--split-sidebar-w": sidebarWidth } as CSSProperties) : undefined;
	return (
		<div
			style={style}
			className={cn(
				"grid grid-cols-1 lg:grid-cols-[var(--split-sidebar-w,280px)_minmax(0,1fr)] gap-4 items-start min-w-0",
				className,
			)}
		>
			<aside className="min-w-0 w-full">{sidebar}</aside>
			<div className="min-w-0 w-full">{children}</div>
		</div>
	);
}
