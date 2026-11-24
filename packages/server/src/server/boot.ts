import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { PA_RUNTIME_ASSET_MANIFEST } from "../build-support.ts";
import { closeLogging, createLogger, initLogging } from "../log/index.ts";
import { createSystemOneClassifier } from "../orchestrator/architect/system-one.ts";
import { resolveRepoGitUserIdentity } from "../orchestrator/execution/execution-context.ts";
import { probePiCli } from "../orchestrator/runtime/runtime-info.ts";
import { TeamOrchestrator } from "../orchestrator/team-orchestrator.ts";
import { BUILTIN_ROLE_ARCHITECT_TEMPLATE } from "../roles/role-architect.ts";
import { loadRoleTemplatesWithCustomDir } from "../roles/template-loader.ts";
import { openPersonalAgentDatabase } from "../storage/database.ts";
import { PersonalAgentStore } from "../storage/repositories.ts";
import { createPersonalAgentServer } from "./app.ts";
import { DialogBroker } from "./dialog-broker.ts";
import { PreviewManager } from "./preview-manager.ts";

export interface BootHostOptions {
	rootDir?: string;
	dbPath?: string;
	port?: number;
	host?: string;
	requireAuth?: boolean;
	workspacesRoot?: string;
	sessionDir?: string;
	webDistDir?: string;
	piExtensions?: string[];
	inheritLocalPiResources?: boolean;
	adminEmail?: string;
	adminPassword?: string;
	adminName?: string;
}

export interface BootedHost {
	host: string;
	port: number;
	localUrl: string;
	lanUrls: string[];
	shutdown: () => Promise<void>;
}

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

/** Load only the PA classifier credential. Keep dotenv values out of subprocess environments. */
async function readDecisionKey(rootDir: string): Promise<string | undefined> {
	if (process.env.TYPESAFE_API_KEY !== undefined) return process.env.TYPESAFE_API_KEY.trim() || undefined;
	try {
		return parseEnv(await readFile(resolve(rootDir, ".env"), "utf8")).TYPESAFE_API_KEY?.trim() || undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			console.warn("无法读取 .env 的决策模型配置，将使用 Pi 决策。");
		}
		return undefined;
	}
}

function resolveDefaultWebDistDir(rootDir: string): string {
	const workspaceWebDist = resolve(rootDir, PA_RUNTIME_ASSET_MANIFEST.webDistDir);
	if (existsSync(workspaceWebDist)) return workspaceWebDist;
	const legacyWebDist = resolve(rootDir, PA_RUNTIME_ASSET_MANIFEST.legacyWebDistDir);
	if (existsSync(legacyWebDist)) return legacyWebDist;
	return workspaceWebDist;
}

/**
 * Boot the Personal Agent Engine Host as an embeddable library.
 * Launchers (`apps/cli`, future desktop shells, sandboxes) call `bootHost()` instead of owning engine logic.
 */
export async function bootHost(options: BootHostOptions = {}): Promise<BootedHost> {
	const piProbe = probePiCli();
	const rootDir = options.rootDir ?? process.cwd();
	const dbPath = options.dbPath ?? process.env.PA_DB_PATH ?? resolve(rootDir, ".data/personal-agent.db");
	const port = options.port ?? Number(process.env.PORT ?? 4310);
	const host = options.host ?? (process.env.PA_HOST?.trim() || "127.0.0.1");
	const requireAuth =
		options.requireAuth ??
		(process.env.PA_REQUIRE_AUTH === "1" || process.env.PA_REQUIRE_AUTH?.trim().toLowerCase() === "true");
	const defaultWorkspacesRoot = options.workspacesRoot
		? resolve(options.workspacesRoot)
		: process.env.PA_WORKSPACES_ROOT?.trim()
			? resolve(process.env.PA_WORKSPACES_ROOT.trim())
			: dbPath === ":memory:"
				? resolve(rootDir, ".data/team-workspaces")
				: resolve(dirname(resolve(dbPath)), "team-workspaces");
	const dataDir = dbPath === ":memory:" ? resolve(rootDir, ".data") : dirname(resolve(dbPath));
	const log = createLogger("host.boot");
	if (dbPath !== ":memory:") initLogging({ dataDir });
	log.info("Booting Personal Agent host", { host, port, requireAuth, dbPath });

	const db = openPersonalAgentDatabase(dbPath);
	const store = new PersonalAgentStore(db, {
		spacesDir: dbPath === ":memory:" ? undefined : resolve(dataDir, "spaces"),
	});
	const savedSettings = store.getPlatformSettings(defaultWorkspacesRoot);
	const builtinRolesDir = resolve(rootDir, "roles");
	const temporaryRolesDir = dbPath === ":memory:" ? await mkdtemp(join(tmpdir(), "personal-agent-roles-")) : undefined;
	const temporarySkillsDir =
		dbPath === ":memory:" ? await mkdtemp(join(tmpdir(), "personal-agent-skills-")) : undefined;
	const customRolesDir = temporaryRolesDir ?? resolve(dirname(resolve(dbPath)), "roles");
	const customSkillsDir = temporarySkillsDir ?? resolve(dirname(resolve(dbPath)), "skills");
	const templates = [
		...(await loadRoleTemplatesWithCustomDir(builtinRolesDir, customRolesDir)),
		BUILTIN_ROLE_ARCHITECT_TEMPLATE,
	];
	const dialogBroker = new DialogBroker();
	const previewManager = new PreviewManager();

	const decisionKey = await readDecisionKey(rootDir);
	const orchestrator = new TeamOrchestrator({
		classifier: savedSettings.systemOneEnabled && decisionKey ? createSystemOneClassifier(decisionKey) : undefined,
		store,
		templates,
		defaultCwd: rootDir,
		noSession: false,
		extensions: options.piExtensions ?? process.env.PA_PI_EXTENSIONS?.split(delimiter).filter(Boolean),
		sessionDir: options.sessionDir
			? resolve(options.sessionDir)
			: process.env.PA_SESSION_DIR?.trim()
				? resolve(process.env.PA_SESSION_DIR.trim())
				: resolve(rootDir, ".data/pi-sessions"),
		skillsDir: customSkillsDir,
		onDialog: (ctx) => dialogBroker.requestApproval(ctx),
	});

	const hadOrganizations = store.listOrganizations().length > 0;
	const defaultOrg = store.ensureDefaultOrganization();
	if (!hadOrganizations) {
		store.assignOrphanWorkspacesToDefaultOrganization();
	}
	const ownerName = resolveRepoGitUserIdentity(rootDir)?.name ?? "团队所有者";
	const localAdmin = store.ensureLocalBootstrapAdmin(ownerName);
	const adminEmailEnv = (options.adminEmail ?? process.env.PA_ADMIN_EMAIL)?.trim();
	const adminPasswordEnv = options.adminPassword ?? process.env.PA_ADMIN_PASSWORD ?? "";
	if (adminEmailEnv && adminPasswordEnv.length >= 8 && !store.hasPasswordedAdmin()) {
		store.setupInitialAdmin({
			email: adminEmailEnv,
			password: adminPasswordEnv,
			displayName: (options.adminName ?? process.env.PA_ADMIN_NAME)?.trim() || ownerName,
		});
	}
	if (store.listOrgMembers(defaultOrg.id).length === 0) {
		store.upsertOrgMember({
			orgId: defaultOrg.id,
			userId: localAdmin.id,
			orgRole: "org_owner",
			roleTitle: "超级管理员",
		});
	}

	if (store.listWorkspaces().length === 0) {
		store.upsertWorkspace({
			orgId: defaultOrg.id,
			name: "personal-agent",
			repoPath: rootDir,
			defaultBranch: "main",
			description: "Personal Agent 主工作区（架构文档、编排核与工作台）",
		});
	}

	const pi = await piProbe;
	if (pi.available) console.log(`Pi CLI ${pi.version} (${pi.executable})`);
	else console.warn(`Pi CLI startup check failed: ${pi.error}`);

	const webDistDir = options.webDistDir ? resolve(options.webDistDir) : resolveDefaultWebDistDir(rootDir);
	const { server } = createPersonalAgentServer({
		store,
		orchestrator,
		templates,
		previewManager,
		dialogBroker,
		webDistDir,
		rolesDir: customRolesDir,
		skillsDir: customSkillsDir,
		uploadsDir: resolve(dataDir, "uploads"),
		requireAuth,
		inheritLocalPiResources: options.inheritLocalPiResources ?? process.env.PA_LOCAL_PI_RESOURCES?.trim() !== "0",
		defaultWorkspacesRoot,
		dataDir,
		probePiCli: () => piProbe,
		runtimeMeta: {
			host,
			port,
			dbPath,
			builtinRolesDir,
		},
	});

	await new Promise<void>((resolveListen) => {
		server.listen(port, host, () => resolveListen());
	});

	const localHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
	const localUrl = `http://${localHost}:${port}`;
	const lanUrls =
		host === "0.0.0.0" || host === "::" ? listLanIpv4Addresses().map((ip) => `http://${ip}:${port}`) : [];

	let stopping = false;
	const shutdown = async () => {
		if (stopping) return;
		stopping = true;
		const closed = new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		server.closeAllConnections();
		for (const pending of dialogBroker.listPending()) dialogBroker.cancelForMatter(pending.matterId);
		await orchestrator.shutdown();
		await previewManager.stopAll();
		await closed;
		db.close();
		if (temporaryRolesDir) await rm(temporaryRolesDir, { recursive: true, force: true });
		if (temporarySkillsDir) await rm(temporarySkillsDir, { recursive: true, force: true });
		log.info("Personal Agent host stopped");
		closeLogging();
	};

	return { host, port, localUrl, lanUrls, shutdown };
}
