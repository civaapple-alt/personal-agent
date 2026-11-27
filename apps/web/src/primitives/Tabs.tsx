import { type KeyboardEvent, type ReactNode, useRef } from "react";
import { cn } from "../utils/cn.ts";

export interface TabItem {
	id: string;
	label: ReactNode;
	count?: number;
	disabled?: boolean;
}

export interface TabsProps {
	items: ReadonlyArray<TabItem>;
	value: string;
	onChange: (id: string) => void;
	variant?: "underline" | "pill";
	size?: "sm" | "md";
	ariaLabel?: string;
	className?: string;
}

/** Accessible tablist supporting underline and pill styles with ArrowLeft/ArrowRight navigation. */
export function Tabs({
	items,
	value,
	onChange,
	variant = "underline",
	size = "md",
	ariaLabel,
	className,
}: TabsProps) {
	const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);

	const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
		const len = items.length;
		if (len === 0) return;

		let step = 0;
		if (event.key === "ArrowRight") step = 1;
		else if (event.key === "ArrowLeft") step = -1;
		else if (event.key === "Home") {
			event.preventDefault();
			const firstIdx = items.findIndex((item) => !item.disabled);
			if (firstIdx >= 0) {
				const target = items[firstIdx];
				if (target) {
					onChange(target.id);
					buttonRefs.current[firstIdx]?.focus();
				}
			}
			return;
		} else if (event.key === "End") {
			event.preventDefault();
			for (let i = len - 1; i >= 0; i -= 1) {
				const target = items[i];
				if (target && !target.disabled) {
					onChange(target.id);
					buttonRefs.current[i]?.focus();
					return;
				}
			}
			return;
		} else {
			return;
		}

		event.preventDefault();
		for (let offset = 1; offset <= len; offset += 1) {
			const nextIndex = (currentIndex + step * offset + len) % len;
			const nextItem = items[nextIndex];
			if (nextItem && !nextItem.disabled) {
				onChange(nextItem.id);
				buttonRefs.current[nextIndex]?.focus();
				return;
			}
		}
	};

	const listClass =
		variant === "pill"
			? "inline-flex items-center gap-1 p-0.5 bg-subtle border border-line rounded-md max-w-full overflow-x-auto"
			: "flex items-center gap-1 border-b border-line overflow-x-auto";

	const sizeClass =
		variant === "pill"
			? size === "sm"
				? "h-6 px-2 text-xs"
				: "h-7 px-2.5 text-xs"
			: size === "sm"
				? "h-8 px-2.5 text-xs"
				: "h-9 px-3 text-sm";

	return (
		<div role="tablist" aria-label={ariaLabel} className={cn(listClass, className)}>
			{items.map((item, index) => {
				const active = item.id === value;
				const itemClass =
					variant === "pill"
						? active
							? "bg-stage text-ink font-medium shadow-sm rounded-sm"
							: "text-ink-secondary hover:text-ink rounded-sm"
						: active
							? "-mb-px border-b-2 border-accent text-ink font-medium"
							: "-mb-px border-b-2 border-transparent text-ink-secondary hover:text-ink";

				return (
					<button
						key={item.id}
						ref={(node) => {
							buttonRefs.current[index] = node;
						}}
						type="button"
						role="tab"
						aria-selected={active}
						aria-disabled={item.disabled || undefined}
						disabled={item.disabled}
						tabIndex={active ? 0 : -1}
						onClick={() => {
							if (!item.disabled) onChange(item.id);
						}}
						onKeyDown={(event) => handleKeyDown(event, index)}
						className={cn(
							"inline-flex items-center gap-1.5 whitespace-nowrap transition-colors cursor-pointer select-none focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40 disabled:cursor-not-allowed shrink-0",
							sizeClass,
							itemClass,
						)}
					>
						<span>{item.label}</span>
						{item.count !== undefined && (
							<span
								className={cn(
									"px-1.5 py-0.5 text-micro rounded-pill leading-none tabular-nums",
									active ? "bg-accent-soft text-accent" : "bg-subtle text-ink-muted",
								)}
							>
								{item.count}
							</span>
						)}
					</button>
				);
			})}
		</div>
	);
}
