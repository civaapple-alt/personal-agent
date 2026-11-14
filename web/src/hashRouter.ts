export type NavTab = "deliverables" | "chats" | "team" | "materials";

export interface HashRoute {
	tab: NavTab;
	deliverableId?: string;
	matterId?: string;
	isNewMatter?: boolean;
}

export function parseHashRoute(rawHash: string): HashRoute {
	const cleaned = rawHash.replace(/^#\/?/, "").trim();
	if (!cleaned) {
		return { tab: "deliverables" };
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
	return { tab: "deliverables" };
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
	return "#/materials";
}
