import { useEffect, useState } from "react";
import { formatElapsedDuration } from "../utils/formatters.ts";

interface ElapsedTimerProps {
	/** Epoch milliseconds when the run started; falls back to the mount time when unknown. */
	startedAt: number | null;
	className?: string;
}

/**
 * Leaf component that owns the 1s tick so only this text node re-renders while a turn runs,
 * instead of the whole workbench tree.
 */
export function ElapsedTimer({ startedAt, className }: ElapsedTimerProps) {
	const [mountedAt] = useState(() => Date.now());
	const [now, setNow] = useState(mountedAt);

	useEffect(() => {
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);

	const origin = startedAt ?? mountedAt;
	return <span className={className}>{formatElapsedDuration(Math.max(0, Math.floor((now - origin) / 1000)))}</span>;
}
