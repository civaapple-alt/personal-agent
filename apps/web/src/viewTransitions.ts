import { addTransitionType, startTransition } from "react";

export type ViewChange = "page" | "deliverable" | "panel";

export function transitionView(type: ViewChange, update: () => void): void {
	if (
		typeof document.startViewTransition !== "function" ||
		window.matchMedia("(prefers-reduced-motion: reduce)").matches
	) {
		update();
		return;
	}
	startTransition(() => {
		addTransitionType(type);
		update();
	});
}
