import { type ReactNode, useEffect } from "react";

interface ModalDialogProps {
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

	const sizeClass = size === "sm" ? "modal-card-sm" : size === "lg" ? "modal-card-lg" : "modal-card-md";

	return (
		<div className="architect-modal-backdrop">
			<button
				type="button"
				className="architect-modal-scrim"
				aria-label="关闭弹窗"
				disabled={closeDisabled}
				onClick={onClose}
			/>
			<div
				className={`architect-modal-card ${sizeClass}`}
				role="dialog"
				aria-modal="true"
				aria-label={ariaLabel ?? title}
			>
				<div className="banner-row">
					<div className="modal-dialog-title-group">
						<h2 className="ui-card-title architect-modal-title">{title}</h2>
						{subtitle && <p className="modal-dialog-subtitle">{subtitle}</p>}
					</div>
					<div className="ui-row-actions">
						{headerExtra}
						<button type="button" className="btn-inline" disabled={closeDisabled} onClick={onClose}>
							关闭
						</button>
					</div>
				</div>

				<div className="modal-dialog-body">{children}</div>

				{footer && <div className="modal-dialog-foot">{footer}</div>}
			</div>
		</div>
	);
}
