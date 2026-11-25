import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, networkInterfaces, tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { parseEnv } from "node:util";
import { PA_RUNTIME_ASSET_MANIFEST, resolveRepoRoot } from "../build-support.ts";
import { listServerExtensionSummaries } from "../extensions/registry.ts";
import { closeLogging, createLogger, initLogging } from "../log/index.ts";
import { createSystemOneClassifier } from "../orchestrator/architect/system-one.ts";
import { resolveRepoGitUserIdentity } from "../orchestrator/execution/execution-context.ts";
import {
	type LocalPiResourcesPolicy,
	normalizeLocalPiResourcesPolicy,
	type PiCliProbeResult,
	probePiCli,
} from "../orchestrator/runtime/runtime-info.ts";
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
	inheritLocalPiResources?: boolean | LocalPiResourcesPolicy;
	adminEmail?: string;
	adminPassword?: string;
	adminName?: string;
}

export interface BootedHostSummary {
	version: string | null;
	requireAuth: boolean;
	localPiResourcesInherited: boolean;
	pi: PiCliProbeResult;
	nodeVersion: string;
	rootDir: string;
	installRoot: string;
	dbPath: string;
	sessionDir: string;
	workspaceNames: string[];
	businessRoleIds: string[];
	hasArchitectRole: boolean;
	extensionNames: string[];
	extraPiExtensions: string[];
}

export interface BootedHost {
	host: string;
	port: number;
	localUrl: string;
	lanUrls: string[];
	summary: BootedHostSummary;
	shutdown: () => Promise<void>;
}

/** Returns true for IPv4 addresses that are realistically reachable by LAN/mesh teammates (excludes loopback, APIPA, and RFC 2544 fake-IP TUN ranges like 198.18.0.0/15). */
export function isUsableLanIpv4(address: string): boolean {
	const parts = address.split(".").map((segment) => Number(segment));
	if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
	const [a, b] = parts as [number, number, number, number];
	if (a === 0 || a === 127) return false;
	// Link-local APIPA (169.254.0.0/16)
	if (a === 169 && b === 254) return false;
	// RFC 2544 benchmark / Clash & Surge fake-IP TUN (198.18.0.0/15)
	if (a === 198 && (b === 18 || b === 19)) return false;
	return true;
}

function isRfc1918PrivateIpv4(address: string): boolean {
	const [a, b] = address.split(".").map((segment) => Number(segment));
	if (a === 192 && b === 168) return true;
	if (a === 10) return true;
	if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
	return false;
}

function listLanIpv4Addresses(): string[] {
	const seen = new Set<string>();
	const interfaces = networkInterfaces();
	for (const entries of Object.values(interfaces)) {
		if (!entries) continue;
		for (const item of entries) {
			if (item.family === "IPv4" && !item.internal && isUsableLanIpv4(item.address)) {
				seen.add(item.address);
			}
		}
	}
	return [...seen].sort((left, right) => {
		const leftPrivate = isRfc1918PrivateIpv4(left) ? 0 : 1;
		const rightPrivate = isRfc1918PrivateIpv4(right) ? 0 : 1;
		if (leftPrivate !== rightPrivate) return leftPrivate - rightPrivate;
		return left.localeCompare(right);
	});
}

function isLoopbackHost(host: string): boolean {
	const normalized = host.trim().toLowerCase();
	return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function readPackageVersion(installRoot: string, rootDir: string): string | null {
	for (const candidate of [resolve(installRoot, "package.json"), resolve(rootDir, "package.json")]) {
		try {
			const parsed = JSON.parse(readFileSync(candidate, "utf8")) as { version?: unknown };
			if (typeof parsed.version === "string" && parsed.version.trim()) return parsed.version.trim();
		} catch {
			// Ignore missing or unreadable package.json in custom temp working directories.
		}
	}
	return null;
}

function formatDisplayPath(targetPath: string, rootDir: string): string {
	if (targetPath === ":memory:") return ":memory:";
	const resolved = resolve(targetPath);
	const rel = relative(rootDir, resolved);
	if (rel && !rel.startsWith("..") && !rel.startsWith("/")) return rel;
	const home = homedir();
	if (home && (resolved === home || resolved.startsWith(`${home}/`))) {
		return `~${resolved.slice(home.length)}`;
	}
	return resolved;
}

/** Formats a concise Pi-inspired startup banner with runtime, storage, role, and extension context. */
export function formatStartupBanner(booted: Pick<BootedHost, "host" | "localUrl" | "lanUrls" | "summary">): string {
	const { summary } = booted;
	const versionLabel = summary.version ? ` v${summary.version}` : "";
	const modeLabel = summary.requireAuth ? "team mode · auth required" : "personal mode · loopback owner";
	const piLine = summary.pi.available
		? `Pi CLI ${summary.pi.version} (${summary.pi.executable})`
		: `Pi CLI startup check failed: ${summary.pi.error}`;
	const localResourcesLabel = summary.localPiResourcesInherited ? "inherited" : "isolated";
	const lines: string[] = [
		`Personal Agent${versionLabel} (${modeLabel})`,
		`Personal Agent workbench listening on ${booted.localUrl} (bind ${booted.host})`,
	];
	if (booted.lanUrls.length > 0) {
		lines.push(`LAN URLs (auth required): ${booted.lanUrls.join(", ")}`);
	}
	lines.push("AI roles can inspect Pi and PA docs/examples. Ask any role how to use, troubleshoot, or extend PA.");
	lines.push("");
	lines.push("[Runtime]");
	lines.push(`  ${piLine} · Node ${summary.nodeVersion} · Local Pi resources: ${localResourcesLabel}`);
	lines.push(
		`  Docs: ${formatDisplayPath(resolve(summary.installRoot, PA_RUNTIME_ASSET_MANIFEST.docsDir), summary.rootDir)} · Examples: ${formatDisplayPath(resolve(summary.installRoot, PA_RUNTIME_ASSET_MANIFEST.examplesDir), summary.rootDir)}`,
	);
	lines.push("");
	lines.push("[Storage]");
	lines.push(
		`  DB: ${formatDisplayPath(summary.dbPath, summary.rootDir)} · Sessions: ${formatDisplayPath(summary.sessionDir, summary.rootDir)}`,
	);
	if (summary.workspaceNames.length > 0) {
		const shown = summary.workspaceNames.slice(0, 6).join(", ");
		const overflow = summary.workspaceNames.length > 6 ? `, +${summary.workspaceNames.length - 6} more` : "";
		lines.push(`  Workspaces (${summary.workspaceNames.length}): ${shown}${overflow}`);
	} else {
		lines.push("  Workspaces (0): none registered");
	}
	lines.push("");
	lines.push("[Roles]");
	const roleList = summary.businessRoleIds.join(", ") || "none";
	const archSuffix = summary.hasArchitectRole ? " (+ role-architect)" : "";
	lines.push(`  ${summary.businessRoleIds.length} business roles: ${roleList}${archSuffix}`);
	lines.push("");
	lines.push("[Extensions]");
	lines.push(`  ${summary.extensionNames.join(", ")}`);
	if (summary.extraPiExtensions.length > 0) {
		lines.push(`  PA_PI_EXTENSIONS: ${summary.extraPiExtensions.join(", ")}`);
	}
	return lines.join("\n");
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

	const extraPiExtensions =
		options.piExtensions ?? process.env.PA_PI_EXTENSIONS?.split(delimiter).filter(Boolean) ?? [];
	const sessionDir = options.sessionDir
		? resolve(options.sessionDir)
		: process.env.PA_SESSION_DIR?.trim()
			? resolve(process.env.PA_SESSION_DIR.trim())
			: resolve(rootDir, ".data/pi-sessions");
	const decisionKey = await readDecisionKey(rootDir);
	const orchestrator = new TeamOrchestrator({
		classifier: savedSettings.systemOneEnabled && decisionKey ? createSystemOneClassifier(decisionKey) : undefined,
		store,
		templates,
		defaultCwd: rootDir,
		noSession: false,
		extensions: extraPiExtensions.length > 0 ? extraPiExtensions : undefined,
		sessionDir,
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
	const localPiResourcesPolicy = normalizeLocalPiResourcesPolicy(
		options.inheritLocalPiResources ?? process.env.PA_LOCAL_PI_RESOURCES,
	);
	const localPiResourcesInherited =
		localPiResourcesPolicy === "always" ||
		(localPiResourcesPolicy === "auto" && !requireAuth && isLoopbackHost(host));
	const installRoot = resolveRepoRoot(import.meta.url);

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
		inheritLocalPiResources: localPiResourcesPolicy,
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
	const boundAddress = server.address();
	const listeningPort = typeof boundAddress === "object" && boundAddress ? boundAddress.port : port;

	const localHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
	const localUrl = `http://${localHost}:${listeningPort}`;
	const lanUrls =
		host === "0.0.0.0" || host === "::" ? listLanIpv4Addresses().map((ip) => `http://${ip}:${listeningPort}`) : [];
	const businessRoleIds = templates
		.filter((template) => template.id !== BUILTIN_ROLE_ARCHITECT_TEMPLATE.id)
		.map((template) => template.id);
	const summary: BootedHostSummary = {
		version: readPackageVersion(installRoot, rootDir),
		requireAuth,
		localPiResourcesInherited,
		pi,
		nodeVersion: process.version,
		rootDir,
		installRoot,
		dbPath,
		sessionDir,
		workspaceNames: store.listWorkspaces().map((ws) => ws.name),
		businessRoleIds,
		hasArchitectRole: templates.some((template) => template.id === BUILTIN_ROLE_ARCHITECT_TEMPLATE.id),
		extensionNames: listServerExtensionSummaries().map((ext) => ext.name),
		extraPiExtensions,
	};

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

	return { host, port: listeningPort, localUrl, lanUrls, summary, shutdown };
}
