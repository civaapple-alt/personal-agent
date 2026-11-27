import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { ErrorBoundary } from "./primitives/ErrorBoundary.tsx";
import "./styles/tokens.css";
import "./styles/primitives.css";
import "./styles/shell.css";
import "./styles/chat-stream.css";
import "./styles/matter-delegation.css";
import "./styles/chat-cards.css";
import "./styles/chat-composer.css";
import "./styles/model-picker.css";
import "./styles/chat-roster.css";
import "./styles/deliverables.css";
import "./styles/spaces.css";
import "./styles/workspaces.css";
import "./styles/team.css";
import "./styles/role-architect.css";
import "./styles/settings.css";
import "./styles/account-admin.css";
import "./styles/board.css";
import "./styles/view-transitions.css";
import "./styles/responsive.css";

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
