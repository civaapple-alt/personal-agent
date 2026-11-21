import type { DeliverableDto } from "../api/deliverables.ts";

export interface DeliverableSeries {
	key: string;
	latest: DeliverableDto;
	versions: DeliverableDto[];
}

export function groupDeliverableSeries(deliverables: readonly DeliverableDto[]): DeliverableSeries[] {
	const groups = new Map<string, DeliverableDto[]>();
	for (const deliverable of deliverables) {
		const key = `${deliverable.matterId}::${deliverable.title}`;
		const group = groups.get(key);
		if (group) group.push(deliverable);
		else groups.set(key, [deliverable]);
	}

	const series: DeliverableSeries[] = [];
	for (const [key, versions] of groups) {
		versions.sort((a, b) => a.version - b.version);
		series.push({ key, versions, latest: versions[versions.length - 1]! });
	}
	return series.sort((a, b) => b.latest.createdAt.localeCompare(a.latest.createdAt));
}
