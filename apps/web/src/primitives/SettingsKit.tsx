import type { ReactNode } from "react";
import { cn } from "../utils/cn.ts";
import { Card } from "./Card.tsx";

export interface SettingsCardProps {
	title?: ReactNode;
	description?: ReactNode;
	actions?: ReactNode;
	className?: string;
	children: ReactNode;
}

/** Shared card container for Settings, Account, Admin, and Organization management panels. */
export function SettingsCard({ title, description, actions, className, children }: SettingsCardProps) {
	return (
		<Card className={cn("shadow-sm", className)}>
			{(title || description || actions) && (
				<header className="flex items-start justify-between gap-3 flex-wrap mb-3">
					<div className="min-w-0 flex-1">
						{title && <h3 className="m-0 text-md font-semibold text-ink leading-snug">{title}</h3>}
						{description && <p className="mt-1 mb-0 text-xs text-ink-muted leading-normal">{description}</p>}
					</div>
					{actions && <div className="flex items-center gap-2 flex-wrap shrink-0">{actions}</div>}
				</header>
			)}
			{children}
		</Card>
	);
}

export interface SettingsDisclosureProps {
	summary: ReactNode;
	defaultOpen?: boolean;
	className?: string;
	children: ReactNode;
}

/** Collapsible disclosure block using native `<details>`/`<summary>` with hairline styling. */
export function SettingsDisclosure({ summary, defaultOpen, className, children }: SettingsDisclosureProps) {
	return (
		<details className={cn("border-t border-line pt-2 text-xs text-ink-secondary", className)} open={defaultOpen}>
			<summary className="cursor-pointer font-semibold text-ink-secondary hover:text-ink select-none">
				{summary}
			</summary>
			<div className="pt-2">{children}</div>
		</details>
	);
}
