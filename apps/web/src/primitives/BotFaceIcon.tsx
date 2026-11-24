import type { RoleMood } from "../utils.ts";

interface BotFaceIconProps {
	bg: string;
	tilt?: string;
	size?: "xs" | "sm" | "md" | "lg";
	mood?: RoleMood;
}

export function BotFaceIcon({ bg, tilt, size = "md", mood = "idle" }: BotFaceIconProps) {
	const sizeClass =
		size === "xs"
			? "bot-avatar-xs"
			: size === "sm"
				? "bot-avatar-sm"
				: size === "lg"
					? "bot-avatar-lg"
					: "bot-avatar-md";
	return (
		<span
			className={`bot-avatar ${sizeClass} mood-${mood}`}
			style={{ background: bg, transform: tilt ? `rotate(${tilt})` : undefined }}
		>
			<span className="bot-avatar-inner">
				<svg viewBox="0 0 24 24" className="bot-eyes" aria-hidden="true">
					{mood === "finalizing" ? (
						<g className="bot-eye-happy">
							<path
								d="M6.4 13.4 Q9 9.2 11.4 13.4"
								stroke="currentColor"
								strokeWidth="2.3"
								strokeLinecap="round"
								fill="none"
							/>
							<path
								d="M12.6 13.4 Q15 9.2 17.6 13.4"
								stroke="currentColor"
								strokeWidth="2.3"
								strokeLinecap="round"
								fill="none"
							/>
						</g>
					) : (
						<g className="bot-eye-pair">
							<rect className="bot-eye" x="7.5" y="7.5" width="3" height="9" rx="1.5" fill="currentColor" />
							<rect className="bot-eye" x="13.5" y="7.5" width="3" height="9" rx="1.5" fill="currentColor" />
						</g>
					)}
				</svg>
			</span>
			{mood === "thinking" && (
				<span className="bot-mood-pip pip-thinking" aria-hidden="true">
					<span />
					<span />
				</span>
			)}
			{mood === "tool" && <span className="bot-mood-pip pip-tool" aria-hidden="true" />}
			{mood === "waiting_user" && (
				<span className="bot-mood-pip pip-waiting" aria-hidden="true">
					?
				</span>
			)}
		</span>
	);
}
