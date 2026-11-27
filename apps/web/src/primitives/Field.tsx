import type { ComponentProps, ReactNode } from "react";
import { cn } from "../utils/cn.ts";

export interface FieldGroupProps {
	label?: ReactNode;
	htmlFor?: string;
	hint?: ReactNode;
	error?: ReactNode;
	className?: string;
	children: ReactNode;
}

/** Form field wrapper providing label, hint, and error message layout. */
export function FieldGroup({ label, htmlFor, hint, error, className, children }: FieldGroupProps) {
	return (
		<div className={cn("flex flex-col gap-1.5 min-w-0", className)}>
			{label && (
				<label htmlFor={htmlFor} className="text-xs font-medium text-ink-secondary">
					{label}
				</label>
			)}
			{children}
			{error ? (
				<p className="m-0 text-xs text-danger-text">{error}</p>
			) : (
				hint && <p className="m-0 text-xs text-ink-muted leading-normal">{hint}</p>
			)}
		</div>
	);
}

const CONTROL_BASE =
	"w-full min-w-0 border border-line bg-stage text-ink rounded-sm transition-colors placeholder:text-ink-muted focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent focus-visible:border-accent disabled:opacity-50 disabled:cursor-not-allowed";

export interface InputProps extends Omit<ComponentProps<"input">, "size"> {
	size?: "sm" | "md";
	mono?: boolean;
}

/** Single-line text input with compact Geist/Linear border and optional monospace font. */
export function Input({ size = "md", mono = false, className, ...props }: InputProps) {
	return (
		<input
			className={cn(
				CONTROL_BASE,
				size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-sm",
				mono && "font-mono text-xs",
				className,
			)}
			{...props}
		/>
	);
}

export interface SelectProps extends Omit<ComponentProps<"select">, "size"> {
	size?: "sm" | "md";
}

/** Native select dropdown aligned with Input control sizing. */
export function Select({ size = "md", className, children, ...props }: SelectProps) {
	return (
		<select
			className={cn(CONTROL_BASE, size === "sm" ? "h-7 px-2 text-xs" : "h-8 px-2.5 text-sm", className)}
			{...props}
		>
			{children}
		</select>
	);
}

export interface TextareaProps extends ComponentProps<"textarea"> {
	mono?: boolean;
}

/** Multi-line textarea control with crisp hairline border and optional monospace typography. */
export function Textarea({ mono = false, className, ...props }: TextareaProps) {
	return (
		<textarea
			className={cn(
				CONTROL_BASE,
				"px-3 py-2 text-sm leading-relaxed resize-y",
				mono && "font-mono text-xs",
				className,
			)}
			{...props}
		/>
	);
}
