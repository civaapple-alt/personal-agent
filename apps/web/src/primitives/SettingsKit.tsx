import type { ReactNode } from "react";

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
		<section className={className ? `ui-card ${className}` : "ui-card"}>
			{(title || description || actions) && (
				<header className="settings-card-head">
					<div>
						{title && <h3>{title}</h3>}
						{description && <p className="settings-card-desc">{description}</p>}
					</div>
					{actions && <div className="settings-card-actions">{actions}</div>}
				</header>
			)}
			{children}
		</section>
	);
}

export interface SettingsDisclosureProps {
	summary: ReactNode;
	defaultOpen?: boolean;
	className?: string;
	children: ReactNode;
}

/** Collapsible disclosure block using PA's native `.settings-details` styling. */
export function SettingsDisclosure({ summary, defaultOpen, className, children }: SettingsDisclosureProps) {
	return (
		<details className={className ? `settings-details ${className}` : "settings-details"} open={defaultOpen}>
			<summary>{summary}</summary>
			{children}
		</details>
	);
}
