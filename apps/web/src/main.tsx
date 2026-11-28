import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { ErrorBoundary } from "./primitives/ErrorBoundary.tsx";
import { workbenchQueryClient } from "./queries/index.ts";

const container = document.getElementById("root");
if (!container) {
	throw new Error("Root container #root not found");
}

createRoot(container).render(
	<StrictMode>
		<ErrorBoundary scope="workbench">
			<QueryClientProvider client={workbenchQueryClient}>
				<App />
			</QueryClientProvider>
		</ErrorBoundary>
	</StrictMode>,
);
