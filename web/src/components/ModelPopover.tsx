import { type CSSProperties, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface ModelPopoverProps {
	label: string;
	panelLabel: string;
	accessibleLabel?: string;
	buttonClassName: string;
	align?: "start" | "end";
	disabled?: boolean;
	closeDisabled?: boolean;
	onOpen?: () => void;
	children: (close: () => void) => ReactNode;
}

/** Keep the model panel out of both card layout and scrolling containers. */
export function ModelPopover({
	label,
	panelLabel,
	accessibleLabel,
	buttonClassName,
	align = "start",
	disabled,
	closeDisabled,
	onOpen,
	children,
}: ModelPopoverProps) {
	const id = useId();
	const [open, setOpen] = useState(false);
	const [position, setPosition] = useState<CSSProperties>();
	const trigger = useRef<HTMLButtonElement>(null);
	const popup = useRef<HTMLDivElement>(null);

	useLayoutEffect(() => {
		if (!open || !trigger.current) return;
		const anchor = trigger.current;
		const viewport = window.visualViewport;
		const place = () => {
			const rect = anchor.getBoundingClientRect();
			const x = viewport?.offsetLeft ?? 0;
			const y = viewport?.offsetTop ?? 0;
			const width = viewport?.width ?? window.innerWidth;
			const height = viewport?.height ?? window.innerHeight;
			const margin = 8;
			const gap = 6;
			const panelWidth = Math.min(420, width - margin * 2);
			const viewportTop = y + margin;
			const viewportBottom = y + height - margin;
			const upperEdge = Math.min(rect.top - gap, viewportBottom);
			const lowerEdge = Math.max(rect.bottom + gap, viewportTop);
			const above = upperEdge - viewportTop;
			const below = viewportBottom - lowerEdge;
			const upward = below < 360 && above > below;
			const alignedLeft = align === "end" ? rect.right - panelWidth : rect.left;
			setPosition({
				width: panelWidth,
				left: Math.min(Math.max(alignedLeft, x + margin), x + width - panelWidth - margin),
				maxHeight: Math.max(0, upward ? above : below),
				...(upward ? { bottom: window.innerHeight - upperEdge } : { top: lowerEdge }),
			});
		};
		const onScroll = (event: Event) => {
			if (event.target instanceof Node && popup.current?.contains(event.target)) return;
			place();
		};
		place();
		window.addEventListener("scroll", onScroll, true);
		window.addEventListener("resize", place);
		viewport?.addEventListener("resize", place);
		viewport?.addEventListener("scroll", place);
		return () => {
			window.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("resize", place);
			viewport?.removeEventListener("resize", place);
			viewport?.removeEventListener("scroll", place);
		};
	}, [open, align]);

	useEffect(() => {
		if (!open || closeDisabled) return;
		const dismissOutside = (event: Event) => {
			const target = event.target;
			if (target instanceof Node && !trigger.current?.contains(target) && !popup.current?.contains(target)) {
				setOpen(false);
			}
		};
		const dismissWithEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
			event.preventDefault();
			event.stopPropagation();
			setOpen(false);
			trigger.current?.focus({ preventScroll: true });
		};
		document.addEventListener("pointerdown", dismissOutside, true);
		document.addEventListener("focusin", dismissOutside);
		document.addEventListener("keydown", dismissWithEscape, true);
		return () => {
			document.removeEventListener("pointerdown", dismissOutside, true);
			document.removeEventListener("focusin", dismissOutside);
			document.removeEventListener("keydown", dismissWithEscape, true);
		};
	}, [open, closeDisabled]);

	const close = () => {
		setOpen(false);
		trigger.current?.focus({ preventScroll: true });
	};

	return (
		<>
			<button
				ref={trigger}
				type="button"
				className={buttonClassName}
				title={label}
				aria-label={accessibleLabel ?? label}
				aria-expanded={open}
				aria-haspopup="dialog"
				aria-controls={open ? id : undefined}
				disabled={disabled}
				onClick={() => {
					if (open) {
						if (!closeDisabled) close();
					} else {
						onOpen?.();
						setOpen(true);
					}
				}}
			>
				<span>{label}</span>
				<span className="model-choices-chevron" aria-hidden="true" />
			</button>
			{open &&
				createPortal(
					<div
						id={id}
						ref={popup}
						className="model-popover"
						role="dialog"
						aria-label={panelLabel}
						style={position}
					>
						{children(close)}
					</div>,
					trigger.current?.closest('[aria-modal="true"]') ?? document.body,
				)}
		</>
	);
}
