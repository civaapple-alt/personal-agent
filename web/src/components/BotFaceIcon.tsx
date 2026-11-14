interface BotFaceIconProps {
	bg: string;
	tilt?: string;
	size?: "sm" | "md" | "lg";
}

export function BotFaceIcon({ bg, tilt, size = "md" }: BotFaceIconProps) {
	const sizeClass = size === "sm" ? "bot-avatar-sm" : size === "lg" ? "bot-avatar-lg" : "bot-avatar-md";
	return (
		<span
			className={`bot-avatar ${sizeClass}`}
			style={{ background: bg, transform: tilt ? `rotate(${tilt})` : undefined }}
		>
			<svg viewBox="0 0 24 24" className="bot-eyes" aria-hidden="true">
				<rect x="7.5" y="7.5" width="3" height="9" rx="1.5" fill="currentColor" />
				<rect x="13.5" y="7.5" width="3" height="9" rx="1.5" fill="currentColor" />
			</svg>
		</span>
	);
}
