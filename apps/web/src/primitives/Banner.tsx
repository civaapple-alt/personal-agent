import type { ReactNode } from "react";
import { cn } from "../utils/cn.ts";

export type BannerTone = "neutral" | "info" | "warn" | "danger" | "success";

export interface BannerProps {
	tone?: BannerTone;
	title?: ReactNode;
	actions?: ReactNode;
	onDismiss?: () => void;
	className?: string;
	children?: ReactNode;
}

const BANNER_TONES: Record<BannerTone, string> = {
	neutral: "bg-sidebar border-line text-ink",
	info: "bg-info-bg border-info-border text-info-text",
	warn: "bg-warn-bg border-warn-border text-warn-text",
	danger: "bg-danger-bg border-danger-border text-danger-text",
	success: "bg-success-bg border-success-border text-success-text",
};

/** Compact inline notice/alert strip with semantic tone, optional actions, and dismiss control. */
export function Banner({ tone = "neutral", title, actions, onDismiss, className, children }: BannerProps) {
	const role = tone === "danger" || tone === "warn" ? "alert" : "status";
	return (
		<div
			role={role}
			className={cn(
				"flex items-start justify-between gap-3 border rounded-md px-3 py-2 text-xs leading-normal",
				BANNER_TONES[tone],
				className,
			)}
		>
			<div className="min-w-0 flex-1">
				{title && <div className="font-semibold leading-snug">{title}</div>}
				{children && <div className={cn(Boolean(title) && "mt-0.5")}>{children}</div>}
			</div>
			{(actions || onDismiss) && (
				<div className="flex items-center gap-2 shrink-0">
					{actions}
					{onDismiss && (
						<button
							type="button"
							aria-label="关闭提示"
							onClick={onDismiss}
							className="inline-grid place-items-center size-5 rounded-xs text-current opacity-70 hover:opacity-100 hover:bg-hover/60 cursor-pointer focus-visible:outline-2 focus-visible:outline-accent"
						>
							<svg viewBox="0 0 16 16" className="size-3.5" fill="none" aria-hidden="true">
								<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
							</svg>
						</button>
					)}
				</div>
			)}
		</div>
	);
}
