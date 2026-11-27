import type { ComponentProps } from "react";
import { cn } from "../utils/cn.ts";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "accent" | "inline";
export type ButtonSize = "xs" | "sm" | "md";

export interface ButtonProps extends ComponentProps<"button"> {
	variant?: ButtonVariant;
	size?: ButtonSize;
}

const BUTTON_BASE =
	"inline-flex items-center justify-center font-medium whitespace-nowrap transition-colors cursor-pointer select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-45 disabled:pointer-events-none shrink-0";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
	primary: "bg-cta text-stage border border-transparent hover:opacity-90",
	secondary: "bg-stage text-ink border border-line hover:bg-hover hover:border-line-strong",
	ghost: "bg-transparent text-ink-secondary border border-transparent hover:bg-hover hover:text-ink",
	danger: "bg-danger-bg text-danger-text border border-danger-border hover:brightness-95",
	accent: "bg-accent text-white border border-transparent hover:bg-accent-hover",
	inline: "bg-transparent text-accent border-0 hover:underline",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
	xs: "h-6 px-2 text-xs gap-1 rounded-xs",
	sm: "h-7 px-2.5 text-xs gap-1.5 rounded-sm",
	md: "h-8 px-3 text-sm gap-1.5 rounded-sm",
};

const INLINE_SIZE_OVERRIDE = "h-auto px-1 py-0.5 text-xs gap-1 rounded-xs";

/** Compact Geist/Linear button primitive with semantic variants and accessible focus styling. */
export function Button({
	variant = "secondary",
	size = "md",
	type = "button",
	className,
	children,
	...props
}: ButtonProps) {
	return (
		<button
			type={type}
			className={cn(
				BUTTON_BASE,
				BUTTON_VARIANTS[variant],
				variant === "inline" ? INLINE_SIZE_OVERRIDE : BUTTON_SIZES[size],
				className,
			)}
			{...props}
		>
			{children}
		</button>
	);
}

export interface IconButtonProps extends Omit<ComponentProps<"button">, "aria-label"> {
	"aria-label": string;
	size?: ButtonSize;
	active?: boolean;
	variant?: "ghost" | "secondary";
}

const ICON_BUTTON_SIZES: Record<ButtonSize, string> = {
	xs: "size-6 rounded-xs text-xs",
	sm: "size-7 rounded-sm text-xs",
	md: "size-8 rounded-sm text-sm",
};

/** Square icon-only button requiring an accessible label. */
export function IconButton({
	size = "md",
	active = false,
	variant = "secondary",
	type = "button",
	className,
	children,
	...props
}: IconButtonProps) {
	const variantClasses =
		variant === "ghost"
			? active
				? "bg-subtle text-ink border border-line"
				: "bg-transparent text-ink-secondary border border-transparent hover:bg-hover hover:text-ink"
			: active
				? "bg-subtle text-ink border border-line-strong"
				: "bg-stage text-ink-secondary border border-line hover:bg-hover hover:text-ink";

	return (
		<button
			type={type}
			aria-pressed={active || undefined}
			className={cn(
				"inline-grid place-items-center transition-colors cursor-pointer select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-45 disabled:pointer-events-none shrink-0",
				variantClasses,
				ICON_BUTTON_SIZES[size],
				className,
			)}
			{...props}
		>
			{children}
		</button>
	);
}
