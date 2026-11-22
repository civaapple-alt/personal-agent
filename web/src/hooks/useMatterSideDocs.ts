import { useCallback, useEffect, useMemo, useState } from "react";
import type { MatterDetailPayload } from "../api.ts";

/** Manages the open tabs, active selection, auto-diff state, and title lookup for the right-hand split document pane. */
export function useMatterSideDocs({
	selectedMatterId,
	matterDetail,
	onOpened,
}: {
	selectedMatterId: string | null;
	matterDetail: MatterDetailPayload | null;
	onOpened?: () => void;
}) {
	const [openDocIds, setOpenDocIds] = useState<string[]>([]);
	const [activeDocId, setActiveDocId] = useState<string | null>(null);
	const [autoDiff, setAutoDiff] = useState(false);

	useEffect(() => {
		void selectedMatterId;
		setOpenDocIds([]);
		setActiveDocId(null);
		setAutoDiff(false);
	}, [selectedMatterId]);

	const openDoc = useCallback(
		(docId: string, options?: { showDiff?: boolean }) => {
			setOpenDocIds((prev) => (prev.includes(docId) ? prev : [...prev, docId]));
			setActiveDocId(docId);
			setAutoDiff(Boolean(options?.showDiff));
			onOpened?.();
		},
		[onOpened],
	);

	const selectDoc = useCallback((docId: string) => {
		setActiveDocId(docId);
		setAutoDiff(false);
	}, []);

	const closeDoc = useCallback((docId: string) => {
		setOpenDocIds((prev) => {
			const next = prev.filter((id) => id !== docId);
			setActiveDocId((current) => (current === docId ? (next[next.length - 1] ?? null) : current));
			return next;
		});
	}, []);

	const closePane = useCallback(() => {
		setOpenDocIds([]);
		setActiveDocId(null);
		setAutoDiff(false);
	}, []);

	const docTitlesById = useMemo(() => {
		const map = new Map<string, string>();
		for (const doc of matterDetail?.spaceDocuments ?? []) {
			map.set(doc.id, doc.title);
		}
		for (const msg of matterDetail?.userMessages ?? []) {
			if (Array.isArray(msg.metadata?.spaceDocuments)) {
				for (const item of msg.metadata.spaceDocuments as Array<{ id?: string; title?: string }>) {
					if (item.id && item.title) map.set(item.id, item.title);
				}
			}
		}
		return map;
	}, [matterDetail]);

	return {
		openDocIds,
		activeDocId,
		autoDiff,
		docTitlesById,
		openDoc,
		selectDoc,
		closeDoc,
		closePane,
	};
}
