import { networkInterfaces } from "node:os";
import { delimiter, dirname, resolve } from "node:path";
import { resolveRepoGitUserIdentity } from "../orchestrator/execution-context.ts";
import { TeamOrchestrator } from "../orchestrator/team-orchestrator.ts";
import { loadRoleTemplatesFromDir } from "../roles/template-loader.ts";
import { openPersonalAgentDatabase } from "../storage/database.ts";
import { PersonalAgentStore } from "../storage/repositories.ts";
import { createPersonalAgentServer } from "./app.ts";
import { DialogBroker } from "./dialog-broker.ts";
import { PreviewManager } from "./preview-manager.ts";

function listLanIpv4Addresses(): string[] {
	const results: string[] = [];
	const interfaces = networkInterfaces();
	for (const entries of Object.values(interfaces)) {
		if (!entries) continue;
		for (const item of entries) {
			if (item.family === "IPv4" && !item.internal) {
				results.push(item.address);
			}
		}
	}
	return results;
}

async function main(): Promise<void> {
	const rootDir = process.cwd();
	const dbPath = process.env.PA_DB_PATH ?? resolve(rootDir, ".data/personal-agent.db");
	const port = Number(process.env.PORT ?? 4310);
	const host = process.env.PA_HOST?.trim() || "127.0.0.1";

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

	const hadOrganizations = store.listOrganizations().length > 0;
	const defaultOrg = store.ensureDefaultOrganization();
	if (!hadOrganizations) {
		store.assignOrphanWorkspacesToDefaultOrganization();
	}
	store.ensureOwnerCollaborator(resolveRepoGitUserIdentity(rootDir)?.name ?? "团队所有者");

	if (store.listWorkspaces().length === 0) {
		store.upsertWorkspace({
			orgId: defaultOrg.id,
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
		innerMatterDir: dbPath === ":memory:" ? undefined : resolve(dirname(resolve(dbPath)), "inner-matter"),
	});

	await new Promise<void>((resolveListen) => {
		server.listen(port, host, () => resolveListen());
	});

	const localHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
	console.log(`Personal Agent V4 workbench listening on http://${localHost}:${port} (bind ${host})`);
	if (host === "0.0.0.0" || host === "::") {
		const lanIps = listLanIpv4Addresses();
		if (lanIps.length > 0) {
			console.log(
				`LAN collaboration URLs (invite link required): ${lanIps.map((ip) => `http://${ip}:${port}`).join(", ")}`,
			);
		}
	}

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
