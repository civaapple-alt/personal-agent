import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { ErrorBoundary } from "./primitives/ErrorBoundary.tsx";

const container = document.getElementById("root");
if (!container) {
	throw new Error("Root container #root not found");
}

createRoot(container).render(
	<StrictMode>
		<ErrorBoundary scope="workbench">
			<App />
		</ErrorBoundary>
	</StrictMode>,
);
