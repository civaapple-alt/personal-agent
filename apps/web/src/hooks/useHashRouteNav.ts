import { type MutableRefObject, useCallback, useEffect, useRef } from "react";
import { formatHashRoute, type HashRoute, type NavTab, parseHashRoute, type SettingsSection } from "../hashRouter.ts";
import { transitionView } from "../viewTransitions.ts";

interface UseHashRouteNavParams {
	initialRoute: HashRoute;
	explicitNewMatterRef: MutableRefObject<boolean>;
	setActiveTab: React.Dispatch<React.SetStateAction<NavTab>>;
	setSpaceRoute: React.Dispatch<React.SetStateAction<{ pageId?: string }>>;
	setSelectedMatterId: React.Dispatch<React.SetStateAction<string | null>>;
	setSelectedMemberId: React.Dispatch<React.SetStateAction<string>>;
	setSettingsSection: React.Dispatch<React.SetStateAction<SettingsSection>>;
}

/** Synchronizes browser hash URLs with active tab, matter selection, and deliverable selection. */
export function useHashRouteNav({
	initialRoute,
	explicitNewMatterRef,
	setActiveTab,
	setSpaceRoute,
	setSelectedMatterId,
	setSelectedMemberId,
	setSettingsSection,
}: UseHashRouteNavParams) {
	const lastTab = useRef(initialRoute.tab);
	const applyRoute = useCallback(
		(next: HashRoute) => {
			const tabChanged = lastTab.current !== next.tab;
			lastTab.current = next.tab;
			explicitNewMatterRef.current = Boolean(next.isNewMatter);
			const update = () => {
				setActiveTab(next.tab);
				if (next.tab === "deliverables") {
					setSpaceRoute({ pageId: next.spacePageId });
				} else if (next.tab === "chats") {
					if (next.isNewMatter) {
						setSelectedMatterId(null);
					} else if (next.matterId !== undefined) {
						setSelectedMemberId("auto");
						setSelectedMatterId(next.matterId || null);
					}
				} else if (next.tab === "settings") {
					setSettingsSection(next.settingsSection ?? "all");
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
		[explicitNewMatterRef, setActiveTab, setSpaceRoute, setSelectedMatterId, setSelectedMemberId, setSettingsSection],
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
