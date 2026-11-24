import { useCallback, useRef, useState } from "react";
import {
	type AdminOverviewPayload,
	abortAdminMatter,
	fetchAdminOverview,
	updateAdminSettings,
	updateAdminUser,
} from "../api/admin.ts";
import { fetchRuntimeOverview, type RuntimeOverviewDto } from "../api/runtime.ts";

/** Owns runtime and admin panel data, including lazy loading and session resets. */
export function useWorkbenchPanels(refreshBootstrap: () => Promise<void>) {
	const [runtimeOverview, setRuntimeOverview] = useState<RuntimeOverviewDto | null>(null);
	const [runtimeLoading, setRuntimeLoading] = useState(false);
	const [runtimeError, setRuntimeError] = useState<string | null>(null);
	const [adminOverview, setAdminOverview] = useState<AdminOverviewPayload | null>(null);
	const [adminLoading, setAdminLoading] = useState(false);
	const [adminError, setAdminError] = useState<string | null>(null);
	const runtimeAutoFetchedRef = useRef(false);
	const adminAutoFetchedRef = useRef(false);

	const refreshRuntimeOverview = useCallback(async () => {
		setRuntimeLoading(true);
		setRuntimeError(null);
		try {
			const data = await fetchRuntimeOverview();
			setRuntimeOverview(data);
		} catch (err: unknown) {
			setRuntimeError(err instanceof Error ? err.message : String(err));
		} finally {
			setRuntimeLoading(false);
		}
	}, []);

	const refreshAdminOverview = useCallback(async () => {
		setAdminLoading(true);
		setAdminError(null);
		try {
			const data = await fetchAdminOverview();
			setAdminOverview(data);
		} catch (err: unknown) {
			setAdminError(err instanceof Error ? err.message : String(err));
		} finally {
			setAdminLoading(false);
		}
	}, []);

	const clearAdminOverview = useCallback(() => {
		setAdminOverview(null);
		adminAutoFetchedRef.current = false;
	}, []);

	const clearPanels = useCallback(() => {
		runtimeAutoFetchedRef.current = false;
		clearAdminOverview();
		setRuntimeOverview(null);
		setRuntimeError(null);
		setAdminError(null);
	}, [clearAdminOverview]);

	const openRuntimePanel = useCallback(() => {
		if (runtimeAutoFetchedRef.current) return;
		runtimeAutoFetchedRef.current = true;
		void refreshRuntimeOverview();
	}, [refreshRuntimeOverview]);
	const openAdminPanel = useCallback(() => {
		if (adminAutoFetchedRef.current) return;
		adminAutoFetchedRef.current = true;
		void refreshAdminOverview();
	}, [refreshAdminOverview]);

	return {
		runtimeOverview,
		clearAdminOverview,
		clearPanels,
		openRuntimePanel,
		openAdminPanel,
		settingsProps: {
			overview: runtimeOverview,
			loading: runtimeLoading,
			error: runtimeError,
			onRefresh: refreshRuntimeOverview,
			onOverviewChange: setRuntimeOverview,
		},
		adminProps: {
			overview: adminOverview,
			loading: adminLoading,
			error: adminError,
			onRefresh: refreshAdminOverview,
			onSaveSettings: async (input: Parameters<typeof updateAdminSettings>[0]) => {
				await updateAdminSettings(input);
				await refreshAdminOverview();
				await refreshBootstrap();
			},
			onUpdateUser: async (userId: string, input: Parameters<typeof updateAdminUser>[1]) => {
				await updateAdminUser(userId, input);
				await refreshAdminOverview();
			},
			onAbortMatter: async (matterId: string) => {
				await abortAdminMatter(matterId);
				await refreshAdminOverview();
				await refreshBootstrap();
			},
		},
	};
}
