import { type ReactNode, useEffect } from "react";
import { cn } from "../utils/cn.ts";
import { Button } from "./Button.tsx";

export interface ModalDialogProps {
	open: boolean;
	title: string;
	subtitle?: string;
	ariaLabel?: string;
	size?: "sm" | "md" | "lg";
	headerExtra?: ReactNode;
	footer?: ReactNode;
	closeDisabled?: boolean;
	onClose: () => void;
	children: ReactNode;
}

const MODAL_SIZES: Record<NonNullable<ModalDialogProps["size"]>, string> = {
	sm: "max-w-[540px]",
	md: "max-w-[680px]",
	lg: "max-w-[780px]",
};

/** Shared accessible centered modal shell with Escape-key dismissal, header chrome, and footer alignment. */
export function ModalDialog({
	open,
	title,
	subtitle,
	ariaLabel,
	size = "md",
	headerExtra,
	footer,
	closeDisabled = false,
	onClose,
	children,
}: ModalDialogProps) {
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

	return (
		<div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-3 sm:p-5">
			<button
				type="button"
				className="absolute inset-0 border-0 p-0 m-0 bg-transparent cursor-pointer"
				aria-label="关闭弹窗"
				disabled={closeDisabled}
				onClick={onClose}
			/>
			<div
				className={cn(
					"relative z-10 w-full max-h-[90vh] overflow-y-auto overscroll-contain bg-card border border-line rounded-lg p-5 shadow-lg flex flex-col gap-3.5",
					MODAL_SIZES[size],
				)}
				role="dialog"
				aria-modal="true"
				aria-label={ariaLabel ?? title}
			>
				<div className="flex items-start justify-between gap-3">
					<div className="flex flex-col gap-1 min-w-0">
						<h2 className="m-0 text-md font-semibold text-ink leading-snug">{title}</h2>
						{subtitle && <p className="m-0 text-xs text-ink-secondary leading-relaxed">{subtitle}</p>}
					</div>
					<div className="flex items-center gap-2 flex-wrap shrink-0">
						{headerExtra}
						<Button variant="inline" size="xs" disabled={closeDisabled} onClick={onClose}>
							关闭
						</Button>
					</div>
				</div>

				<div className="flex flex-col gap-3 text-sm text-ink">{children}</div>

				{footer && (
					<div className="pt-2.5 border-t border-line flex items-center justify-end gap-2 flex-wrap">{footer}</div>
				)}
			</div>
		</div>
	);
}
