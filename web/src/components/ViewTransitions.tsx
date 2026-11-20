import { type ReactNode, ViewTransition } from "react";
import type { ViewChange } from "../viewTransitions.ts";

const fadeClasses = {
	page: { enter: "vt-fade-in", exit: "vt-fade-out" },
	deliverable: { enter: "vt-pop-in", exit: "vt-pop-out" },
	panel: { enter: "vt-pop-in", exit: "vt-pop-out" },
} satisfies Record<ViewChange, { enter: string; exit: string }>;

export function ViewFade({ children, type = "page" }: { children: ReactNode; type?: ViewChange }) {
	const { enter, exit } = fadeClasses[type];
	return (
		<ViewTransition
			enter={{ [type]: enter, default: "none" }}
			exit={{ [type]: exit, default: "none" }}
			default="none"
		>
			{children}
		</ViewTransition>
	);
}
