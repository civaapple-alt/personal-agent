import { useEffect, useState } from "react";
import { Banner, Button } from "../primitives/index.ts";
import { useWorkbenchStore } from "../stores/index.ts";

/** Floating workbench alert and auto-dismissing status notice stack. */
export function WorkbenchBanners() {
	const errorBanner = useWorkbenchStore((s) => s.errorBanner);
	const noticeBanner = useWorkbenchStore((s) => s.noticeBanner);
	const dismissError = useWorkbenchStore((s) => s.dismissError);
	const dismissNotice = useWorkbenchStore((s) => s.dismissNotice);
	const [noticePaused, setNoticePaused] = useState(false);

	useEffect(() => {
		if (!noticeBanner || noticePaused) return;
		const timer = window.setTimeout(() => {
			dismissNotice();
			setNoticePaused(false);
		}, 4500);
		return () => window.clearTimeout(timer);
	}, [noticeBanner, noticePaused, dismissNotice]);

	useEffect(() => {
		if (!noticeBanner) {
			setNoticePaused(false);
		}
	}, [noticeBanner]);

	if (!errorBanner && !noticeBanner) return null;
	return (
		<div className="pointer-events-none absolute top-[calc(50px+max(12px,env(safe-area-inset-top)))] min-[961px]:top-[max(12px,env(safe-area-inset-top))] right-3.5 sm:right-6 z-[90] w-[min(460px,calc(100%-28px))] sm:w-[min(460px,calc(100%-48px))] max-h-[calc(100%-74px)] min-[961px]:max-h-[calc(100%-24px)] flex flex-col gap-2 overflow-y-auto">
			{errorBanner && (
				<Banner
					tone="warn"
					className="pointer-events-auto shadow-md"
					actions={
						<Button variant="inline" size="xs" onClick={dismissError} aria-label="关闭操作提示">
							关闭
						</Button>
					}
				>
					<span className="min-w-0 break-words">
						<strong className="font-semibold">操作提示：</strong> {errorBanner}
					</span>
				</Banner>
			)}
			{noticeBanner && (
				<output
					aria-live="polite"
					className="pointer-events-auto block"
					onMouseEnter={() => setNoticePaused(true)}
					onMouseLeave={() => setNoticePaused(false)}
					onFocus={() => setNoticePaused(true)}
					onBlur={() => setNoticePaused(false)}
				>
					<Banner
						tone="success"
						className="shadow-md"
						actions={
							<Button
								variant="inline"
								size="xs"
								onClick={() => {
									setNoticePaused(false);
									dismissNotice();
								}}
							>
								知道了
							</Button>
						}
					>
						<span className="min-w-0 break-words">{noticeBanner}</span>
					</Banner>
				</output>
			)}
		</div>
	);
}
