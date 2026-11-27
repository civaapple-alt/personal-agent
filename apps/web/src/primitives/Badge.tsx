import type { ComponentProps } from "react";
import { cn } from "../utils/cn.ts";

export type BadgeTone = "neutral" | "accent" | "success" | "warn" | "danger" | "info" | "observer";
export type BadgeSize = "xs" | "sm";

export interface BadgeProps extends ComponentProps<"span"> {
	tone?: BadgeTone;
	dot?: boolean;
	size?: BadgeSize;
}

const BADGE_TONES: Record<BadgeTone, string> = {
	neutral: "bg-subtle border-line text-ink-secondary",
	accent: "bg-accent-soft border-accent-border text-accent",
	success: "bg-success-bg border-success-border text-success-text",
	warn: "bg-warn-bg border-warn-border text-warn-text",
	danger: "bg-danger-bg border-danger-border text-danger-text",
	info: "bg-info-bg border-info-border text-info-text",
	observer: "bg-observer-bg border-observer-border text-observer-text",
};

const DOT_TONES: Record<BadgeTone, string> = {
	neutral: "bg-ink-muted",
	accent: "bg-accent",
	success: "bg-success-text",
	warn: "bg-warn-text",
	danger: "bg-danger-text",
	info: "bg-info-text",
	observer: "bg-observer-text",
};

const BADGE_SIZES: Record<BadgeSize, string> = {
	xs: "px-1.5 py-0.5 text-micro",
	sm: "px-2 py-1 text-xs",
};

/** Clean hairline status pill with optional 6px status indicator dot. */
export function Badge({ tone = "neutral", dot = false, size = "xs", className, children, ...props }: BadgeProps) {
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1.5 border rounded-pill font-medium whitespace-nowrap leading-none",
				BADGE_TONES[tone],
				BADGE_SIZES[size],
				className,
			)}
			{...props}
		>
			{dot && <span className={cn("size-1.5 rounded-full shrink-0", DOT_TONES[tone])} aria-hidden="true" />}
			{children}
		</span>
	);
}
