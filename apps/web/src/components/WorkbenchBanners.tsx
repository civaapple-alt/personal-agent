import { useEffect, useState } from "react";

type WorkbenchBannersProps = {
	errorBanner: string | null;
	noticeBanner: string | null;
	onDismissError: () => void;
	onDismissNotice: () => void;
};

export function WorkbenchBanners({
	errorBanner,
	noticeBanner,
	onDismissError,
	onDismissNotice,
}: WorkbenchBannersProps) {
	const [noticePaused, setNoticePaused] = useState(false);

	useEffect(() => {
		if (!noticeBanner || noticePaused) return;
		const timer = window.setTimeout(() => {
			onDismissNotice();
			setNoticePaused(false);
		}, 4500);
		return () => window.clearTimeout(timer);
	}, [noticeBanner, noticePaused, onDismissNotice]);

	useEffect(() => {
		if (!noticeBanner) {
			setNoticePaused(false);
		}
	}, [noticeBanner]);

	if (!errorBanner && !noticeBanner) return null;
	return (
		<div className="app-banners">
			{errorBanner && (
				<div className="approval-card banner-gap" role="alert">
					<div className="banner-row">
						<span>
							<strong>操作提示：</strong> {errorBanner}
						</span>
						<button type="button" className="btn-inline" onClick={onDismissError} aria-label="关闭操作提示">
							关闭
						</button>
					</div>
				</div>
			)}
			{noticeBanner && (
				<output
					className="notice-card banner-gap"
					aria-live="polite"
					onMouseEnter={() => setNoticePaused(true)}
					onMouseLeave={() => setNoticePaused(false)}
					onFocus={() => setNoticePaused(true)}
					onBlur={() => setNoticePaused(false)}
				>
					<div className="banner-row">
						<span>{noticeBanner}</span>
						<button
							type="button"
							className="btn-inline"
							onClick={() => {
								setNoticePaused(false);
								onDismissNotice();
							}}
						>
							知道了
						</button>
					</div>
				</output>
			)}
		</div>
	);
}
