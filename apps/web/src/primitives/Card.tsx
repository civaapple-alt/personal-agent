import type { ComponentProps, ReactNode } from "react";
import { cn } from "../utils/cn.ts";

export type CardPadding = "none" | "sm" | "md";

export interface CardProps extends ComponentProps<"div"> {
	interactive?: boolean;
	padding?: CardPadding;
}

const CARD_PADDING: Record<CardPadding, string> = {
	none: "",
	sm: "p-3",
	md: "p-4",
};

/** Neutral surface container with crisp 1px hairline border. */
export function Card({ interactive = false, padding = "md", className, children, ...props }: CardProps) {
	return (
		<div
			className={cn(
				"bg-card border border-line rounded-lg min-w-0",
				CARD_PADDING[padding],
				interactive && "transition-colors hover:border-line-strong hover:bg-hover/40 cursor-pointer",
				className,
			)}
			{...props}
		>
			{children}
		</div>
	);
}

export interface CardHeaderProps {
	title: ReactNode;
	description?: ReactNode;
	actions?: ReactNode;
	className?: string;
}

/** Header slot for Card with title, optional description, and right-aligned actions. */
export function CardHeader({ title, description, actions, className }: CardHeaderProps) {
	return (
		<div className={cn("flex items-start justify-between gap-3 flex-wrap mb-3", className)}>
			<div className="min-w-0 flex-1">
				<div className="text-md font-semibold text-ink leading-snug">{title}</div>
				{description && <div className="mt-0.5 text-xs text-ink-muted leading-normal">{description}</div>}
			</div>
			{actions && <div className="flex items-center gap-2 flex-wrap shrink-0">{actions}</div>}
		</div>
	);
}

/** Content slot for Card. */
export function CardBody({ className, children, ...props }: ComponentProps<"div">) {
	return (
		<div className={cn("text-sm text-ink min-w-0", className)} {...props}>
			{children}
		</div>
	);
}

/** Footer slot for Card with hairline divider and right-aligned action flow. */
export function CardFooter({ className, children, ...props }: ComponentProps<"div">) {
	return (
		<div
			className={cn(
				"mt-3 pt-3 border-t border-line-subtle flex items-center justify-end gap-2 flex-wrap",
				className,
			)}
			{...props}
		>
			{children}
		</div>
	);
}
