import { QueryClient } from "@tanstack/react-query";

/** Create a QueryClient configured for Personal Agent workbench server-state queries. */
export function createWorkbenchQueryClient(): QueryClient {
	return new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: 30_000,
				gcTime: 5 * 60_000,
				retry: false,
				refetchOnWindowFocus: false,
			},
		},
	});
}

/** Shared singleton QueryClient used by the web app and SSE cache invalidation hooks. */
export const workbenchQueryClient = createWorkbenchQueryClient();
