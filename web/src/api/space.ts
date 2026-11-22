import { requestJson } from "./client.ts";

export interface SpacePage {
	id: string;
	matterId: string;
	title: string;
	content: string;
	revision: number;
	createdBy: string;
	updatedBy: string;
	createdAt: string;
	updatedAt: string;
}

export interface SpacePageRevision {
	pageId: string;
	revision: number;
	title: string;
	content: string;
	updatedBy: string;
	createdAt: string;
	resultId: string | null;
}

export function listSpacePages() {
	return requestJson<{ pages: SpacePage[] }>("/api/space/pages");
}

export function listSpacePageRevisions(id: string) {
	return requestJson<{ revisions: SpacePageRevision[] }>(`/api/space/pages/${encodeURIComponent(id)}/revisions`);
}

export function createSpacePage(input: { matterId: string; title: string; content: string }) {
	return requestJson<{ page: SpacePage }>("/api/space/pages", { method: "POST", body: JSON.stringify(input) });
}

export function updateSpacePage(id: string, input: { revision: number; title: string; content: string }) {
	return requestJson<{ page: SpacePage }>(`/api/space/pages/${encodeURIComponent(id)}`, {
		method: "PATCH",
		body: JSON.stringify(input),
	});
}
