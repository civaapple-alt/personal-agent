export type NavTab =
	| "deliverables"
	| "chats"
	| "team"
	| "organizations"
	| "materials"
	| "settings"
	| "admin"
	| "account";
export type SettingsSection = "all" | "base" | "extensions" | "config" | "skills" | "insights";

export interface HashRoute {
	tab: NavTab;
	spacePageId?: string;
	matterId?: string;
	isNewMatter?: boolean;
	newMatterLeadId?: string;
	settingsSection?: SettingsSection;
}

const VALID_SETTINGS_SECTIONS = new Set<SettingsSection>(["base", "extensions", "config", "skills", "insights"]);

export function parseHashRoute(rawHash: string): HashRoute {
	const cleaned = rawHash.replace(/^#\/?/, "").trim();
	if (!cleaned) {
		return { tab: "chats" };
	}
	const parts = cleaned.split("/");
	const segment0 = parts[0] ? decodeURIComponent(parts[0]) : "";
	const segment1 = parts[1] ? decodeURIComponent(parts[1]) : undefined;
	const segment2 = parts[2] ? decodeURIComponent(parts[2]) : undefined;

	if (segment0 === "deliverables") {
		return { tab: "deliverables" };
	}
	if (segment0 === "space" || segment0 === "spaces") {
		return segment1 ? { tab: "deliverables", spacePageId: segment1 } : { tab: "deliverables" };
	}
	if (segment0 === "chats") {
		if (segment1 === "new") {
			return segment2 && segment2 !== "auto"
				? { tab: "chats", isNewMatter: true, newMatterLeadId: segment2 }
				: { tab: "chats", isNewMatter: true };
		}
		return segment1 ? { tab: "chats", matterId: segment1 } : { tab: "chats" };
	}
	if (segment0 === "team") {
		return { tab: "team" };
	}
	if (segment0 === "organizations") {
		return { tab: "organizations" };
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
	if (segment0 === "account") {
		return { tab: "account" };
	}
	return { tab: "chats" };
}

export function formatHashRoute(route: HashRoute): string {
	if (route.tab === "deliverables") {
		if (route.spacePageId) return `#/space/${encodeURIComponent(route.spacePageId)}`;
		return "#/deliverables";
	}
	if (route.tab === "chats") {
		if (route.isNewMatter) {
			return route.newMatterLeadId && route.newMatterLeadId !== "auto"
				? `#/chats/new/${encodeURIComponent(route.newMatterLeadId)}`
				: "#/chats/new";
		}
		return route.matterId ? `#/chats/${encodeURIComponent(route.matterId)}` : "#/chats";
	}
	if (route.tab === "team") {
		return "#/team";
	}
	if (route.tab === "organizations") {
		return "#/organizations";
	}
	if (route.tab === "settings") {
		return route.settingsSection && route.settingsSection !== "all"
			? `#/settings/${encodeURIComponent(route.settingsSection)}`
			: "#/settings";
	}
	if (route.tab === "admin") {
		return "#/admin";
	}
	if (route.tab === "account") {
		return "#/account";
	}
	return "#/materials";
}
