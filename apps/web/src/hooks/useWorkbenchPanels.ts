import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type SetStateAction, useCallback, useState } from "react";
import { abortAdminMatter, fetchAdminOverview, updateAdminSettings, updateAdminUser } from "../api/admin.ts";
import { fetchRuntimeOverview, type RuntimeOverviewDto } from "../api/runtime.ts";
import { queryKeys } from "../queries/index.ts";

function toErrorMessage(error: unknown): string | null {
	if (!error) return null;
	return error instanceof Error ? error.message : String(error);
}

/** Owns runtime and admin panel data via TanStack Query, including lazy activation and session resets. */
export function useWorkbenchPanels(refreshBootstrap: () => Promise<void>) {
	const queryClient = useQueryClient();
	const [runtimeEnabled, setRuntimeEnabled] = useState(false);
	const [adminEnabled, setAdminEnabled] = useState(false);

	const runtimeQuery = useQuery({
		queryKey: queryKeys.runtime.overview(),
		queryFn: fetchRuntimeOverview,
		enabled: runtimeEnabled,
	});
	const adminQuery = useQuery({
		queryKey: queryKeys.admin.overview(),
		queryFn: fetchAdminOverview,
		enabled: adminEnabled,
	});

	const refreshRuntimeOverview = useCallback(async () => {
		setRuntimeEnabled(true);
		await queryClient.invalidateQueries({ queryKey: queryKeys.runtime.overview() });
		await runtimeQuery.refetch();
	}, [queryClient, runtimeQuery]);

	const refreshAdminOverview = useCallback(async () => {
		setAdminEnabled(true);
		await queryClient.invalidateQueries({ queryKey: queryKeys.admin.overview() });
		await adminQuery.refetch();
	}, [queryClient, adminQuery]);

	const setRuntimeOverviewCache = useCallback(
		(next: SetStateAction<RuntimeOverviewDto | null>) => {
			queryClient.setQueryData<RuntimeOverviewDto | null>(queryKeys.runtime.overview(), (prev) =>
				typeof next === "function" ? next(prev ?? null) : next,
			);
		},
		[queryClient],
	);

	const clearAdminOverview = useCallback(() => {
		setAdminEnabled(false);
		queryClient.removeQueries({ queryKey: queryKeys.admin.all });
	}, [queryClient]);

	const clearPanels = useCallback(() => {
		setRuntimeEnabled(false);
		setAdminEnabled(false);
		queryClient.clear();
	}, [queryClient]);

	const openRuntimePanel = useCallback(() => {
		setRuntimeEnabled(true);
	}, []);

	const openAdminPanel = useCallback(() => {
		setAdminEnabled(true);
	}, []);

	const runtimeOverview = runtimeEnabled ? (runtimeQuery.data ?? null) : null;
	const adminOverview = adminEnabled ? (adminQuery.data ?? null) : null;

	return {
		runtimeOverview,
		clearAdminOverview,
		clearPanels,
		openRuntimePanel,
		openAdminPanel,
		settingsProps: {
			overview: runtimeOverview,
			loading: runtimeQuery.isFetching,
			error: toErrorMessage(runtimeQuery.error),
			onRefresh: refreshRuntimeOverview,
			onOverviewChange: setRuntimeOverviewCache,
		},
		adminProps: {
			overview: adminOverview,
			loading: adminQuery.isFetching,
			error: toErrorMessage(adminQuery.error),
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
