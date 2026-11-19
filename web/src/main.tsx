import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles/tokens.css";
import "./styles/primitives.css";
import "./styles/shell.css";
import "./styles/chat-stream.css";
import "./styles/chat-cards.css";
import "./styles/chat-composer.css";
import "./styles/chat-roster.css";
import "./styles/deliverables.css";
import "./styles/team.css";
import "./styles/role-architect.css";
import "./styles/settings.css";
import "./styles/account-admin.css";
import "./styles/responsive.css";

const container = document.getElementById("root");
if (!container) {
	throw new Error("Root container #root not found");
}

createRoot(container).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
