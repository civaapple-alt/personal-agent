import { type MutableRefObject, useCallback, useEffect, useRef } from "react";
import { formatHashRoute, type HashRoute, parseHashRoute } from "../hashRouter.ts";
import { useMatterRuntimeStore, useSessionStore, useWorkbenchStore } from "../stores/index.ts";
import { transitionView } from "../viewTransitions.ts";

interface UseHashRouteNavParams {
	initialRoute: HashRoute;
	explicitNewMatterRef: MutableRefObject<boolean>;
}

/** Synchronizes browser hash URLs with Zustand navigation and active matter/member stores. */
export function useHashRouteNav({ initialRoute, explicitNewMatterRef }: UseHashRouteNavParams) {
	const lastTab = useRef(initialRoute.tab);
	const applyRoute = useCallback(
		(next: HashRoute) => {
			const tabChanged = lastTab.current !== next.tab;
			lastTab.current = next.tab;
			explicitNewMatterRef.current = Boolean(next.isNewMatter);
			const update = () => {
				const workbench = useWorkbenchStore.getState();
				workbench.setActiveTab(next.tab);
				if (next.tab === "deliverables") {
					workbench.setSpaceRoute({ pageId: next.spacePageId });
				} else if (next.tab === "chats") {
					if (next.isNewMatter) {
						useMatterRuntimeStore.getState().setSelectedMatterId(null);
						useSessionStore.getState().setSelectedMemberId(next.newMatterLeadId || "auto");
					} else if (next.matterId !== undefined) {
						useSessionStore.getState().setSelectedMemberId("auto");
						useMatterRuntimeStore.getState().setSelectedMatterId(next.matterId || null);
					}
				} else if (next.tab === "settings") {
					workbench.setSettingsSection(next.settingsSection ?? "all");
				}
			};
			if (tabChanged) {
				transitionView("page", update);
			} else if (next.tab === "deliverables") {
				transitionView("deliverable", update);
			} else {
				update();
			}
		},
		[explicitNewMatterRef],
	);

	const navigateRoute = useCallback(
		(next: HashRoute, options?: { replace?: boolean }) => {
			const targetHash = formatHashRoute(next);
			if (options?.replace) {
				window.history.replaceState(null, "", targetHash);
			} else if (window.location.hash !== targetHash) {
				window.history.pushState(null, "", targetHash);
			}
			applyRoute(next);
		},
		[applyRoute],
	);

	useEffect(() => {
		const normalized = formatHashRoute(initialRoute);
		if (window.location.hash !== normalized) window.history.replaceState(null, "", normalized);
	}, [initialRoute]);

	useEffect(() => {
		const handleHashChange = () => applyRoute(parseHashRoute(window.location.hash));
		window.addEventListener("hashchange", handleHashChange);
		return () => window.removeEventListener("hashchange", handleHashChange);
	}, [applyRoute]);

	return navigateRoute;
}
