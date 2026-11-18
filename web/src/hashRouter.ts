export type NavTab = "deliverables" | "chats" | "team" | "materials" | "settings" | "admin";
export type SettingsSection = "all" | "base" | "extensions" | "config";

export interface HashRoute {
	tab: NavTab;
	deliverableId?: string;
	matterId?: string;
	isNewMatter?: boolean;
	settingsSection?: SettingsSection;
}

const VALID_SETTINGS_SECTIONS = new Set<SettingsSection>(["base", "extensions", "config"]);

export function parseHashRoute(rawHash: string): HashRoute {
	const cleaned = rawHash.replace(/^#\/?/, "").trim();
	if (!cleaned) {
		return { tab: "chats" };
	}
	const parts = cleaned.split("/");
	const segment0 = parts[0] ? decodeURIComponent(parts[0]) : "";
	const segment1 = parts[1] ? decodeURIComponent(parts[1]) : undefined;

	if (segment0 === "deliverables") {
		return segment1 ? { tab: "deliverables", deliverableId: segment1 } : { tab: "deliverables" };
	}
	if (segment0 === "chats") {
		if (segment1 === "new") {
			return { tab: "chats", isNewMatter: true };
		}
		return segment1 ? { tab: "chats", matterId: segment1 } : { tab: "chats" };
	}
	if (segment0 === "team") {
		return { tab: "team" };
	}
	if (segment0 === "materials") {
		return { tab: "materials" };
	}
	if (segment0 === "settings") {
		if (segment1 && VALID_SETTINGS_SECTIONS.has(segment1 as SettingsSection)) {
			return { tab: "settings", settingsSection: segment1 as SettingsSection };
		}
		return { tab: "settings" };
	}
	if (segment0 === "admin") {
		return { tab: "admin" };
	}
	return { tab: "chats" };
}

export function formatHashRoute(route: HashRoute): string {
	if (route.tab === "deliverables") {
		return route.deliverableId ? `#/deliverables/${encodeURIComponent(route.deliverableId)}` : "#/deliverables";
	}
	if (route.tab === "chats") {
		if (route.isNewMatter) {
			return "#/chats/new";
		}
		return route.matterId ? `#/chats/${encodeURIComponent(route.matterId)}` : "#/chats";
	}
	if (route.tab === "team") {
		return "#/team";
	}
	if (route.tab === "settings") {
		return route.settingsSection && route.settingsSection !== "all"
			? `#/settings/${encodeURIComponent(route.settingsSection)}`
			: "#/settings";
	}
	if (route.tab === "admin") {
		return "#/admin";
	}
	return "#/materials";
}
