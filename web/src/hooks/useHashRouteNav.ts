import { type MutableRefObject, useCallback, useEffect } from "react";
import { formatHashRoute, type HashRoute, type NavTab, parseHashRoute, type SettingsSection } from "../hashRouter.ts";

interface UseHashRouteNavParams {
	initialRoute: HashRoute;
	explicitNewMatterRef: MutableRefObject<boolean>;
	setActiveTab: React.Dispatch<React.SetStateAction<NavTab>>;
	setSelectedDeliverableId: React.Dispatch<React.SetStateAction<string | null>>;
	setSelectedMatterId: React.Dispatch<React.SetStateAction<string | null>>;
	setSelectedMemberId: React.Dispatch<React.SetStateAction<string>>;
	setSettingsSection: React.Dispatch<React.SetStateAction<SettingsSection>>;
}

/** Synchronizes browser hash URLs with active tab, matter selection, and deliverable selection. */
export function useHashRouteNav({
	initialRoute,
	explicitNewMatterRef,
	setActiveTab,
	setSelectedDeliverableId,
	setSelectedMatterId,
	setSelectedMemberId,
	setSettingsSection,
}: UseHashRouteNavParams) {
	const navigateRoute = useCallback(
		(next: HashRoute, options?: { replace?: boolean }) => {
			setActiveTab(next.tab);
			explicitNewMatterRef.current = Boolean(next.isNewMatter);
			if (next.tab === "deliverables" && next.deliverableId !== undefined) {
				setSelectedDeliverableId(next.deliverableId || null);
			}
			if (next.tab === "chats") {
				if (next.isNewMatter) {
					setSelectedMatterId(null);
				} else if (next.matterId !== undefined) {
					setSelectedMemberId("auto");
					setSelectedMatterId(next.matterId || null);
				}
			}
			if (next.tab === "settings") {
				setSettingsSection(next.settingsSection ?? "all");
			}
			const targetHash = formatHashRoute(next);
			if (options?.replace) {
				window.history.replaceState(null, "", targetHash);
			} else if (window.location.hash !== targetHash) {
				window.location.hash = targetHash;
			}
		},
		[
			explicitNewMatterRef,
			setActiveTab,
			setSelectedDeliverableId,
			setSelectedMatterId,
			setSelectedMemberId,
			setSettingsSection,
		],
	);

	useEffect(() => {
		const normalized = formatHashRoute(initialRoute);
		if (!window.location.hash || window.location.hash !== normalized) {
			window.history.replaceState(null, "", normalized);
		}
	}, [initialRoute]);

	useEffect(() => {
		const handleHashChange = () => {
			const route = parseHashRoute(window.location.hash);
			setActiveTab(route.tab);
			explicitNewMatterRef.current = Boolean(route.isNewMatter);
			if (route.tab === "deliverables" && route.deliverableId) {
				setSelectedDeliverableId(route.deliverableId);
			} else if (route.tab === "chats") {
				if (route.isNewMatter) {
					setSelectedMatterId(null);
				} else if (route.matterId) {
					setSelectedMemberId("auto");
					setSelectedMatterId(route.matterId);
				}
			} else if (route.tab === "settings") {
				setSettingsSection(route.settingsSection ?? "all");
			}
		};
		window.addEventListener("hashchange", handleHashChange);
		return () => window.removeEventListener("hashchange", handleHashChange);
	}, [
		explicitNewMatterRef,
		setActiveTab,
		setSelectedDeliverableId,
		setSelectedMatterId,
		setSelectedMemberId,
		setSettingsSection,
	]);

	return navigateRoute;
}
