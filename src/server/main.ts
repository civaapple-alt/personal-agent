import { delimiter, resolve } from "node:path";
import { TeamOrchestrator } from "../orchestrator/team-orchestrator.ts";
import { loadRoleTemplatesFromDir } from "../roles/template-loader.ts";
import { openPersonalAgentDatabase } from "../storage/database.ts";
import { PersonalAgentStore } from "../storage/repositories.ts";
import { createPersonalAgentServer } from "./app.ts";
import { DialogBroker } from "./dialog-broker.ts";
import { PreviewManager } from "./preview-manager.ts";

async function main(): Promise<void> {
	const rootDir = process.cwd();
	const dbPath = process.env.PA_DB_PATH ?? resolve(rootDir, ".data/personal-agent.db");
	const port = Number(process.env.PORT ?? 4310);

	const db = openPersonalAgentDatabase(dbPath);
	const store = new PersonalAgentStore(db);
	const templates = await loadRoleTemplatesFromDir(resolve(rootDir, "roles"));
	const dialogBroker = new DialogBroker();
	const previewManager = new PreviewManager();

	const orchestrator = new TeamOrchestrator({
		store,
		templates,
		defaultCwd: rootDir,
		noSession: false,
		extensions: process.env.PA_PI_EXTENSIONS?.split(delimiter).filter(Boolean),
		sessionDir: resolve(rootDir, ".data/pi-sessions"),
		onDialog: (ctx) => dialogBroker.requestApproval(ctx),
	});

	if (store.listWorkspaces().length === 0) {
		store.upsertWorkspace({
			name: "personal-agent",
			repoPath: rootDir,
			defaultBranch: "main",
			description: "Personal Agent 主工作区（架构文档、编排核与 V4 工作台）",
		});
	}

	const { server } = createPersonalAgentServer({
		store,
		orchestrator,
		templates,
		previewManager,
		dialogBroker,
		webDistDir: resolve(rootDir, "web/dist"),
		rolesDir: resolve(rootDir, "roles"),
		uploadsDir: resolve(rootDir, ".data/uploads"),
	});

	await new Promise<void>((resolveListen) => {
		server.listen(port, "127.0.0.1", () => resolveListen());
	});

	console.log(`Personal Agent V4 workbench listening on http://127.0.0.1:${port}`);

	let stopping = false;
	const shutdown = async () => {
		if (stopping) return;
		stopping = true;
		console.log("\nShutting down Personal Agent server...");
		const closed = new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		server.closeAllConnections();
		for (const pending of dialogBroker.listPending()) dialogBroker.cancelForMatter(pending.matterId);
		await orchestrator.shutdown();
		await previewManager.stopAll();
		await closed;
		db.close();
		process.exit(0);
	};

	process.once("SIGINT", () => void shutdown());
	process.once("SIGTERM", () => void shutdown());
}

main().catch((error) => {
	console.error("Failed to start Personal Agent server:", error);
	process.exitCode = 1;
});
