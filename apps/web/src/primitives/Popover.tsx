import {
	cloneElement,
	type HTMLAttributes,
	isValidElement,
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { cn } from "../utils/cn.ts";

export interface PopoverProps {
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	trigger: ReactNode;
	align?: "start" | "end";
	side?: "bottom" | "top";
	className?: string;
	children: ReactNode;
}

/** Pure-React floating popover supporting controlled/uncontrolled state, click-outside, and Escape dismissal. */
export function Popover({
	open: controlledOpen,
	onOpenChange,
	trigger,
	align = "start",
	side = "bottom",
	className,
	children,
}: PopoverProps) {
	const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement | null>(null);

	const isControlled = controlledOpen !== undefined;
	const isOpen = isControlled ? controlledOpen : uncontrolledOpen;

	const setOpen = useCallback(
		(next: boolean) => {
			if (!isControlled) setUncontrolledOpen(next);
			onOpenChange?.(next);
		},
		[isControlled, onOpenChange],
	);

	const toggle = useCallback(() => {
		setOpen(!isOpen);
	}, [isOpen, setOpen]);

	useEffect(() => {
		if (!isOpen) return;
		const onPointerDown = (event: MouseEvent) => {
			const target = event.target;
			if (target instanceof Node && !rootRef.current?.contains(target)) {
				setOpen(false);
			}
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				setOpen(false);
			}
		};
		document.addEventListener("mousedown", onPointerDown);
		window.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("mousedown", onPointerDown);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [isOpen, setOpen]);

	const triggerNode = isValidElement<HTMLAttributes<HTMLElement>>(trigger) ? (
		cloneElement(trigger, {
			onClick: (event) => {
				trigger.props.onClick?.(event);
				if (!event.defaultPrevented) toggle();
			},
			"aria-expanded": isOpen,
			"aria-haspopup": "dialog",
		})
	) : (
		<button
			type="button"
			onClick={toggle}
			aria-expanded={isOpen}
			aria-haspopup="dialog"
			className="inline-flex items-center cursor-pointer focus-visible:outline-2 focus-visible:outline-accent"
		>
			{trigger}
		</button>
	);

	return (
		<div ref={rootRef} className="relative inline-flex">
			{triggerNode}
			{isOpen && (
				<div
					role="dialog"
					className={cn(
						"absolute z-40 min-w-[200px] bg-card border border-line rounded-md shadow-md p-2 text-sm text-ink",
						side === "bottom" ? "top-full mt-1.5" : "bottom-full mb-1.5",
						align === "end" ? "right-0" : "left-0",
						className,
					)}
				>
					{children}
				</div>
			)}
		</div>
	);
}
