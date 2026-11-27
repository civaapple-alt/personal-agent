import { type ReactNode, useEffect } from "react";
import { cn } from "../utils/cn.ts";
import { Button } from "./Button.tsx";

export interface DrawerProps {
	open: boolean;
	onClose: () => void;
	title: ReactNode;
	subtitle?: ReactNode;
	headerExtra?: ReactNode;
	footer?: ReactNode;
	size?: "sm" | "md" | "lg";
	closeDisabled?: boolean;
	ariaLabel?: string;
	children: ReactNode;
}

const DRAWER_SIZES: Record<NonNullable<DrawerProps["size"]>, string> = {
	sm: "max-w-[360px]",
	md: "max-w-[480px]",
	lg: "max-w-[640px]",
};

/** Pure-React slide-over side drawer with Escape dismissal and scrim backdrop. */
export function Drawer({
	open,
	onClose,
	title,
	subtitle,
	headerExtra,
	footer,
	size = "md",
	closeDisabled = false,
	ariaLabel,
	children,
}: DrawerProps) {
	useEffect(() => {
		if (!open || closeDisabled) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				onClose();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [open, closeDisabled, onClose]);

	if (!open) return null;

	const resolvedLabel = ariaLabel ?? (typeof title === "string" ? title : "侧边抽屉");

	return (
		<div className="fixed inset-0 z-50 flex justify-end bg-black/40">
			<button
				type="button"
				className="absolute inset-0 border-0 p-0 m-0 bg-transparent cursor-pointer"
				aria-label="关闭抽屉"
				disabled={closeDisabled}
				onClick={onClose}
			/>
			<div
				className={cn(
					"relative z-10 w-full h-full bg-card border-l border-line shadow-lg flex flex-col",
					DRAWER_SIZES[size],
				)}
				role="dialog"
				aria-modal="true"
				aria-label={resolvedLabel}
			>
				<header className="min-h-11 px-5 py-3 border-b border-line flex items-start justify-between gap-3 shrink-0">
					<div className="min-w-0 flex-1">
						<h2 className="m-0 text-md font-semibold text-ink leading-snug">{title}</h2>
						{subtitle && <p className="mt-0.5 mb-0 text-xs text-ink-secondary leading-normal">{subtitle}</p>}
					</div>
					<div className="flex items-center gap-2 shrink-0">
						{headerExtra}
						<Button variant="inline" size="xs" disabled={closeDisabled} onClick={onClose}>
							关闭
						</Button>
					</div>
				</header>

				<div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-5 py-4 text-sm text-ink">
					{children}
				</div>

				{footer && (
					<footer className="px-5 py-3 border-t border-line flex items-center justify-end gap-2 flex-wrap shrink-0">
						{footer}
					</footer>
				)}
			</div>
		</div>
	);
}
