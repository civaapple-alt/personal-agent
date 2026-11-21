import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
import { builtinExtensionPaths, resolveBuiltinExtensionPath } from "../pa-extensions/builtin-paths.ts";
import { findInstalledPstack, preparePstackRuntime } from "../pa-extensions/pstack-methods/package.ts";
import { PSTACK_TOOL_NAME } from "../pa-extensions/pstack-methods/runtime.ts";
import { TEAM_EXTENSION_TOOLS } from "../pa-extensions/team-extension/runtime.ts";
import { findInstalledPiWebAccess } from "../pa-extensions/web-access/package.ts";
import { hasWebAccessGrant, isWebAccessRole, PI_WEB_SEARCH_TOOLS } from "../pa-extensions/web-access/runtime.ts";
import type { RoleTemplate } from "../roles/types.ts";
import { listPiPackages } from "../rpc/pi-packages.ts";
import type { TeamMember } from "../storage/types.ts";
import { resolveTurnTimeoutMs } from "./types.ts";

const execFileAsync = promisify(execFile);

export interface OrchestratorRuntimeConfig {
	defaultCwd: string;
	sessionDir: string | null;
	noSession: boolean;
	extensions: string[];
	pstackDir: string | null;
	webAccessRoleGrants?: Record<string, string>;
	templates: RoleTemplate[];
}

export interface ServerRuntimeConfig {
	host?: string;
	port?: number;
	dbPath?: string;
	builtinRolesDir?: string;
	rolesDir?: string;
	uploadsDir?: string;
	innerMatterDir?: string;
	webDistDir?: string;
	requireAuth?: boolean;
	inheritLocalPiResources?: boolean;
}

export interface PiCliProbeResult {
	available: boolean;
	executable: string;
	version: string | null;
	error: string | null;
}

export type RuntimeExtensionSourceKind =
	| "builtin"
	| "builtin_conditional"
	| "pi_builtin"
	| "operator_env"
	| "pi_package";
export type RuntimeExtensionStatus = "active" | "conditional" | "inactive" | "error";
export type RuntimeExtensionFileStatus = "present" | "missing" | "builtin" | "unknown";

export interface RuntimeExtensionItem {
	id: string;
	name: string;
	sourceKind: RuntimeExtensionSourceKind;
	status: RuntimeExtensionStatus;
	entryPath: string | null;
	fileStatus: RuntimeExtensionFileStatus;
	scopeSummary: string;
	description: string;
	registeredTools: string[];
	hooks: string[];
	declaredByRoles: string[];
	mcpServers: string[];
	error?: string | null;
}

export interface RuntimeIsolationMode {
	id: "worker" | "decision" | "architect" | "distill";
	label: string;
	usage: string;
	sessionStrategy: string;
	extensionsPolicy: string;
	toolsPolicy: string;
}

export interface RuntimeConfigItem {
	key: string;
	label: string;
	value: string;
	defaultValue?: string;
	overridden?: boolean;
}

export interface RuntimeConfigSection {
	id: "env" | "paths" | "rpc" | "orchestrator";
	title: string;
	items: RuntimeConfigItem[];
}

export interface RuntimeBaseInfo {
	name: string;
	executable: string;
	transport: string;
	available: boolean;
	version: string | null;
	probeError: string | null;
	nodeVersion: string;
	platform: string;
	pathsRedacted: boolean;
	sessionMode: "persisted" | "no_session";
	sessionDir: string | null;
	defaultCwd: string | null;
	pstack: {
		configured: boolean;
		available: boolean;
		root: string | null;
		installedRoot: string | null;
		version: string | null;
		modeSha256: string | null;
		skillCount: number;
		error: string | null;
		source?: "env" | "settings" | "none";
	};
	webAccess: {
		installedVersion: string | null;
		roles: Array<{ id: string; name: string; enabled: boolean }>;
	};
	isolationModes: RuntimeIsolationMode[];
	envFlags: {
		turnTimeoutMs: number;
		promptTimeoutMs: number;
		idleTimeoutMs: number;
		customExtensionsEnvConfigured: boolean;
		pstackDirEnvConfigured: boolean;
	};
}

export interface RuntimeOverviewPayload {
	base: RuntimeBaseInfo;
	extensions: RuntimeExtensionItem[];
	configSections: RuntimeConfigSection[];
	summary: {
		activeCount: number;
		conditionalCount: number;
		operatorCount: number;
		inactiveCount: number;
		errorCount: number;
	};
	checkedAt: string;
}

function parseNonNegativeTimeoutMs(raw: string | undefined, fallback: number): number {
	if (raw === undefined || raw.trim() === "") return fallback;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function formatMs(ms: number, zeroText: string): string {
	if (ms === 0) return zeroText;
	if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000} 分钟 (${ms} ms)`;
	if (ms >= 1000 && ms % 1000 === 0) return `${ms / 1000} 秒 (${ms} ms)`;
	return `${ms} ms`;
}

function formatDisplayPath(raw: string | null | undefined, isOwner: boolean, fallbackLabel: string): string {
	if (!raw) return fallbackLabel;
	if (raw === ":memory:") return ":memory:";
	return isOwner ? raw : basename(raw) || fallbackLabel;
}

async function checkFileOrDir(targetPath: string): Promise<"present" | "missing"> {
	try {
		const info = await stat(targetPath);
		return info.isFile() || info.isDirectory() ? "present" : "missing";
	} catch {
		return "missing";
	}
}

/** Probe local Pi CLI availability and version without starting an interactive session or calling any model. */
export async function probePiCli(executable = "pi"): Promise<PiCliProbeResult> {
	const tryProbe = async (bin: string) =>
		execFileAsync(bin, ["--version"], {
			timeout: 2500,
			windowsHide: true,
			encoding: "utf8",
		});

	try {
		let stdout = "";
		let resolvedBin = executable;
		try {
			const res = await tryProbe(executable);
			stdout = res.stdout;
		} catch (firstErr: unknown) {
			const code =
				firstErr && typeof firstErr === "object" && "code" in firstErr
					? String((firstErr as { code?: unknown }).code)
					: "";
			if (process.platform === "win32" && executable === "pi" && code === "ENOENT") {
				resolvedBin = "pi.cmd";
				const res = await tryProbe(resolvedBin);
				stdout = res.stdout;
			} else {
				throw firstErr;
			}
		}
		const versionLine =
			stdout
				.split(/\r?\n/)
				.map((line) => line.trim())
				.find(Boolean)
				?.slice(0, 120) ?? "";
		if (!versionLine) {
			return {
				available: false,
				executable: resolvedBin,
				version: null,
				error: "Pi CLI 未返回版本号输出",
			};
		}
		return {
			available: true,
			executable: resolvedBin,
			version: versionLine,
			error: null,
		};
	} catch (error: unknown) {
		const code =
			error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
		const message = error instanceof Error ? error.message : String(error);
		return {
			available: false,
			executable,
			version: null,
			error: code === "ENOENT" ? `未在 PATH 中找到 ${executable} 命令` : message,
		};
	}
}

const ISOLATION_MODES: RuntimeIsolationMode[] = [
	{
		id: "worker",
		label: "常规岗位执行",
		usage: "主责 / 内部委托 / 旁听",
		sessionStrategy: "v2 作用域 --session",
		extensionsPolicy: "显式挂载下方 Extensions",
		toolsPolicy: "按角色与模式收窄",
	},
	{
		id: "decision",
		label: "类型化决策",
		usage: "立项阵型 / 角色草案 (model)",
		sessionStrategy: "--no-session",
		extensionsPolicy: "--no-extensions --no-mcp",
		toolsPolicy: '"" 或只读 read',
	},
	{
		id: "architect",
		label: "角色架构师",
		usage: "建队规划 / 团队体检",
		sessionStrategy: "--no-session（应用层持久化）",
		extensionsPolicy: "--no-extensions（仅 role-design）",
		toolsPolicy: '""（零业务工具）',
	},
	{
		id: "distill",
		label: "AI 经验复盘",
		usage: "只读提炼候选经验",
		sessionStrategy: "--no-session",
		extensionsPolicy: "--no-extensions --no-mcp",
		toolsPolicy: '""（仅宿主证据）',
	},
];

/** Assemble read-only overview of the Pi agent runtime base, loaded extensions, and configuration sections. */
export async function buildRuntimeOverview(options: {
	config: OrchestratorRuntimeConfig;
	serverConfig?: ServerRuntimeConfig;
	activeMembers: TeamMember[];
	isOwner: boolean;
	probePiCli?: () => Promise<PiCliProbeResult>;
	listPiPackages?: typeof listPiPackages;
}): Promise<RuntimeOverviewPayload> {
	const { config, serverConfig, activeMembers, isOwner } = options;
	const probePromise = (options.probePiCli ?? (() => probePiCli()))();
	const teamExtPath = resolveBuiltinExtensionPath("team-extension");
	const pstackExtPath = resolveBuiltinExtensionPath("pstack-extension");

	const [piProbe, teamFileStatus, pstackExtFileStatus] = await Promise.all([
		probePromise,
		checkFileOrDir(teamExtPath),
		checkFileOrDir(pstackExtPath),
	]);

	const pstackEnvSet = Boolean(process.env.PA_PSTACK_DIR?.trim());
	let pstackInfo: RuntimeBaseInfo["pstack"] = {
		configured: Boolean(config.pstackDir),
		available: false,
		root: null,
		installedRoot: null,
		version: null,
		modeSha256: null,
		skillCount: 0,
		error: null,
		source: pstackEnvSet ? "env" : config.pstackDir ? "settings" : "none",
	};

	if (config.pstackDir) {
		try {
			const runtime = await preparePstackRuntime(config.pstackDir);
			pstackInfo = {
				...pstackInfo,
				configured: true,
				available: true,
				root: isOwner ? runtime.root : basename(runtime.root) || "pstack",
				version: runtime.version,
				modeSha256: runtime.modeSha256,
				skillCount: runtime.skills.length,
				error: null,
			};
		} catch (error: unknown) {
			pstackInfo = {
				...pstackInfo,
				configured: true,
				available: false,
				root: isOwner ? config.pstackDir : basename(config.pstackDir) || "pstack",
				version: null,
				modeSha256: null,
				skillCount: 0,
				error: isOwner
					? error instanceof Error
						? error.message
						: String(error)
					: "无法读取已配置的 pstack 方法包",
			};
		}
	}
	let packageListing: Promise<string> | undefined;
	const readPackages = (executable: string) => {
		packageListing ??= (options.listPiPackages ?? listPiPackages)(executable);
		return packageListing;
	};
	const [pstackInstalledRoot, webAccessPackage] = await Promise.all([
		isOwner && !pstackEnvSet && !pstackInfo.available && piProbe.available
			? findInstalledPstack(piProbe.executable, readPackages)
			: null,
		isOwner && piProbe.available ? findInstalledPiWebAccess(piProbe.executable, readPackages) : null,
	]);
	pstackInfo.installedRoot = pstackInstalledRoot;

	const templateById = new Map(config.templates.map((tpl) => [tpl.id, tpl]));
	const webAccessRoles = activeMembers
		.filter((member) => isWebAccessRole(member, templateById.get(member.templateId)))
		.map((member) => ({
			id: member.id,
			name: member.displayName,
			enabled: hasWebAccessGrant(member, config.webAccessRoleGrants),
		}));
	const webAccessEnabledRoles = webAccessRoles.filter((role) => role.enabled);
	const webAccessExtensionItem: RuntimeExtensionItem = {
		id: "pi-web-access",
		name: "pi-web-access",
		sourceKind: "pi_package",
		status: webAccessEnabledRoles.length === 0 ? "inactive" : isOwner && !webAccessPackage ? "error" : "conditional",
		entryPath: webAccessPackage?.entry ?? null,
		fileStatus: webAccessPackage ? "present" : "unknown",
		scopeSummary: "仅授权岗位的讨论、主责和内部委托",
		description: "搜索公开网页并读取已保存的搜索结果。",
		registeredTools: [...PI_WEB_SEARCH_TOOLS],
		hooks: ["session_start 工具握手"],
		declaredByRoles: webAccessEnabledRoles.map((role) => role.name),
		mcpServers: [],
		error: isOwner && webAccessEnabledRoles.length > 0 && !webAccessPackage ? "已授权岗位，但 Pi 安装不可用" : null,
	};
	const mcpServersSet = new Set<string>();
	const mcpDeclaringRoles: string[] = [];
	for (const member of activeMembers) {
		const tpl = templateById.get(member.templateId);
		const deps = tpl?.mcpDependencies ?? [];
		if (deps.length > 0) {
			mcpDeclaringRoles.push(member.displayName);
			for (const dep of deps) mcpServersSet.add(dep);
		}
	}
	const mcpServers = [...mcpServersSet].sort();

	const teamExtensionItem: RuntimeExtensionItem = {
		id: "builtin-team-extension",
		name: "team-extension",
		sourceKind: "builtin",
		status: teamFileStatus === "present" ? "active" : "error",
		entryPath: isOwner ? teamExtPath : builtinExtensionPaths["team-extension"],
		fileStatus: teamFileStatus,
		scopeSummary: "常规岗位必装；按主责/内部/旁听收窄工具",
		description: "经 loopback bridge 回调编排核，提供委托、成果发布与经验提案。",
		registeredTools: [...TEAM_EXTENSION_TOOLS],
		hooks: ["session_start", "before_agent_start", "extension_ui"],
		declaredByRoles: [],
		mcpServers: [],
		error: teamFileStatus === "missing" ? "未找到扩展入口文件" : null,
	};

	const pstackStatus: RuntimeExtensionStatus = !config.pstackDir
		? "inactive"
		: pstackExtFileStatus === "present" && pstackInfo.available
			? "active"
			: "error";
	const pstackError = !config.pstackDir
		? null
		: pstackExtFileStatus === "missing"
			? "未找到扩展入口文件"
			: pstackInfo.error;

	const pstackExtensionItem: RuntimeExtensionItem = {
		id: "builtin-pstack-extension",
		name: "pstack-methods",
		sourceKind: "builtin_conditional",
		status: pstackStatus,
		entryPath: isOwner ? pstackExtPath : builtinExtensionPaths["pstack-extension"],
		fileStatus: pstackExtFileStatus,
		scopeSummary: "配置已有 pstack 方法包后随常规岗位挂载",
		description: "只读加载外部 pstack 的 mode、playbook 与原则原文。",
		registeredTools: [PSTACK_TOOL_NAME],
		hooks: ["poteto-mode --skill"],
		declaredByRoles: [],
		mcpServers: [],
		error: pstackError,
	};

	const mcpExtensionItem: RuntimeExtensionItem = {
		id: "pi-builtin-mcp",
		name: "builtin:mcp",
		sourceKind: "pi_builtin",
		status: mcpServers.length > 0 ? "conditional" : "inactive",
		entryPath: "builtin:mcp",
		fileStatus: "builtin",
		scopeSummary: mcpServers.length > 0 ? "仅声明了 mcpDependencies 的角色启用" : "无角色声明，保持 --no-mcp",
		description: "接入角色声明的 Pi MCP 服务工具前缀。",
		registeredTools: mcpServers.map((server) => `mcp__${server}__*`),
		hooks: ["session_start 工具握手"],
		declaredByRoles: mcpDeclaringRoles,
		mcpServers,
		error: null,
	};

	const operatorExtensionItems: RuntimeExtensionItem[] = await Promise.all(
		config.extensions.map(async (rawEntry, index) => {
			const trimmed = rawEntry.trim();
			const isBuiltinSpec = trimmed.startsWith("builtin:");
			if (isBuiltinSpec) {
				return {
					id: `operator-ext-${index + 1}`,
					name: trimmed,
					sourceKind: "operator_env",
					status: "active",
					entryPath: trimmed,
					fileStatus: "builtin",
					scopeSummary: "随常规岗位 --extension 传入",
					description: "PA_PI_EXTENSIONS 指定的 Pi 内置扩展。",
					registeredTools: [],
					hooks: [],
					declaredByRoles: [],
					mcpServers: [],
					error: null,
				};
			}
			const resolved = resolve(config.defaultCwd, trimmed);
			const fileStatus = await checkFileOrDir(resolved);
			return {
				id: `operator-ext-${index + 1}`,
				name: basename(resolved) || trimmed,
				sourceKind: "operator_env",
				status: fileStatus === "present" ? "active" : "error",
				entryPath: isOwner ? resolved : basename(resolved) || trimmed,
				fileStatus,
				scopeSummary: "随常规岗位 --extension 传入",
				description: "PA_PI_EXTENSIONS 批准加载的外部扩展。",
				registeredTools: [],
				hooks: [],
				declaredByRoles: [],
				mcpServers: [],
				error: fileStatus === "missing" ? "路径不存在或不可访问" : null,
			};
		}),
	);

	const extensions: RuntimeExtensionItem[] = [
		teamExtensionItem,
		pstackExtensionItem,
		mcpExtensionItem,
		webAccessExtensionItem,
		...operatorExtensionItems,
	];

	const summary = {
		activeCount: extensions.filter((item) => item.status === "active").length,
		conditionalCount: extensions.filter((item) => item.status === "conditional").length,
		operatorCount: operatorExtensionItems.length,
		inactiveCount: extensions.filter((item) => item.status === "inactive").length,
		errorCount: extensions.filter((item) => item.status === "error").length,
	};

	const turnTimeoutMs = resolveTurnTimeoutMs();
	const promptTimeoutMs = parseNonNegativeTimeoutMs(process.env.PA_PROMPT_TIMEOUT_MS, 0);
	const idleTimeoutMs = parseNonNegativeTimeoutMs(process.env.PA_IDLE_TIMEOUT_MS, 900_000);
	const effectiveHost = serverConfig?.host ?? (process.env.PA_HOST?.trim() || "127.0.0.1");
	const envPort = process.env.PORT ? Number(process.env.PORT) : undefined;
	const effectivePort = serverConfig?.port ?? (envPort !== undefined && Number.isFinite(envPort) ? envPort : 4310);
	const rawDbPath = serverConfig?.dbPath ?? process.env.PA_DB_PATH?.trim() ?? null;
	const dbDisplay = rawDbPath
		? formatDisplayPath(rawDbPath, isOwner, ".data/personal-agent.db")
		: isOwner
			? resolve(config.defaultCwd, ".data/personal-agent.db")
			: "personal-agent.db";

	const configSections: RuntimeConfigSection[] = [
		{
			id: "env",
			title: "环境变量与服务",
			items: [
				{
					key: "PORT",
					label: "监听端口",
					value: String(effectivePort),
					defaultValue: "4310",
					overridden: effectivePort !== 4310,
				},
				{
					key: "PA_HOST",
					label: "绑定地址",
					value: effectiveHost,
					defaultValue: "127.0.0.1",
					overridden: effectiveHost !== "127.0.0.1",
				},
				{
					key: "PA_DB_PATH",
					label: "SQLite 路径",
					value: dbDisplay,
					defaultValue: ".data/personal-agent.db",
					overridden: Boolean(process.env.PA_DB_PATH?.trim() || rawDbPath === ":memory:"),
				},
				{
					key: "PA_PI_EXTENSIONS",
					label: "外部扩展",
					value: config.extensions.length > 0 ? `已配置 ${config.extensions.length} 项` : "未设置",
					defaultValue: "空",
					overridden: config.extensions.length > 0,
				},
				{
					key: "PA_LOCAL_PI_RESOURCES",
					label: "本机 Pi 资源发现",
					value: serverConfig?.inheritLocalPiResources ? "本机所有者的业务执行启用" : "仅显式装配",
					defaultValue: "个人版回环监听时启用",
					overridden: process.env.PA_LOCAL_PI_RESOURCES?.trim() === "0",
				},
				{
					key: "PA_PSTACK_DIR",
					label: "pstack 方法包",
					value: !config.pstackDir
						? "未设置"
						: pstackInfo.available
							? isOwner && pstackInfo.root
								? `${pstackInfo.root} · v${pstackInfo.version} (${pstackInfo.skillCount} 项)`
								: `v${pstackInfo.version} (${pstackInfo.skillCount} 项)`
							: "配置异常",
					defaultValue: "不启用",
					overridden: Boolean(config.pstackDir),
				},
				{
					key: "PA_TURN_TIMEOUT_MS",
					label: "整轮总上限",
					value: formatMs(turnTimeoutMs, "0（不限总时长）"),
					defaultValue: "0",
					overridden: turnTimeoutMs !== 0,
				},
				{
					key: "PA_PROMPT_TIMEOUT_MS",
					label: "单次 Prompt 上限",
					value: formatMs(promptTimeoutMs, "0（不限）"),
					defaultValue: "0",
					overridden: promptTimeoutMs !== 0,
				},
				{
					key: "PA_IDLE_TIMEOUT_MS",
					label: "空闲看门狗",
					value: formatMs(idleTimeoutMs, "0（已关闭）"),
					defaultValue: "900000 ms",
					overridden: idleTimeoutMs !== 900_000,
				},
			],
		},
		{
			id: "paths",
			title: "目录与存储位置",
			items: [
				{
					key: "roles/",
					label: "内置角色模板",
					value: formatDisplayPath(
						serverConfig?.builtinRolesDir ?? resolve(config.defaultCwd, "roles"),
						isOwner,
						"roles",
					),
				},
				{
					key: ".data/roles/",
					label: "自建角色目录",
					value: formatDisplayPath(serverConfig?.rolesDir, isOwner, "未配置（仅内存或临时目录）"),
				},
				{
					key: ".data/pi-sessions",
					label: "Pi 会话目录",
					value: config.noSession
						? "已禁用（noSession）"
						: formatDisplayPath(config.sessionDir, isOwner, "未指定"),
				},
				{
					key: ".data/uploads",
					label: "图片上传目录",
					value: formatDisplayPath(serverConfig?.uploadsDir, isOwner, "内存缓存"),
				},
				{
					key: ".data/inner-matter",
					label: "内置演示目录",
					value: formatDisplayPath(serverConfig?.innerMatterDir, isOwner, "未启用（:memory: 或未配置）"),
				},
				{
					key: "web/dist/",
					label: "前端静态资源",
					value: formatDisplayPath(serverConfig?.webDistDir, isOwner, "未提供"),
				},
			],
		},
		{
			id: "rpc",
			title: "Pi RPC 与桥接参数",
			items: [
				{ key: "executable", label: "CLI 命令", value: piProbe.executable },
				{ key: "commandTimeoutMs", label: "单条 RPC 超时", value: "30 秒 (30000 ms)" },
				{ key: "shutdownGraceMs", label: "退出宽限", value: "2 秒 (2000 ms)" },
				{ key: "toolReadyWait", label: "工具清单 / 握手", value: "10 秒 / 30 秒" },
				{ key: "bridgeTimeout", label: "桥接传输超时", value: "0（禁用 300s 限制）" },
				{ key: "bridgePayloadLimit", label: "单次载荷上限", value: "256 KiB（task ≤ 16000）" },
				{ key: "abortWaitMs", label: "停止响应上限", value: "1 秒 (1000 ms)" },
			],
		},
		{
			id: "orchestrator",
			title: "编排、旁听与工作台边界",
			items: [
				{ key: "delegationLimit", label: "内部委托上限", value: "深度 ≤ 3 · 单轮 ≤ 8 次" },
				{ key: "handoffWindow", label: "切换增量背景", value: "≤ 12 条 / 20000 字符" },
				{ key: "observerDigest", label: "旁听与背景摘录", value: "当前 2000/6000 · 摘录 ≤ 16 条 (6000 字符)" },
				{ key: "distillPass", label: "AI 经验复盘", value: "noSession · 无工具 · 超时 2 分钟" },
				{ key: "sseHeartbeat", label: "SSE 保活心跳", value: "15 秒 (15000 ms)" },
				{ key: "previewManager", label: "本地预览管理", value: "启动 5s · 日志 200 行 · 停止 1.5s" },
				{
					key: "authMode",
					label: "访问模式",
					value: serverConfig?.requireAuth ? "强制口令认证" : "本机回环默认所有者 / 局域网邀请口令",
				},
			],
		},
	];

	return {
		base: {
			name: "Pi CLI",
			executable: piProbe.executable,
			transport: "pi --mode rpc (JSONL)",
			available: piProbe.available,
			version: piProbe.version,
			probeError: piProbe.error,
			nodeVersion: process.version,
			platform: `${process.platform}/${process.arch}`,
			pathsRedacted: !isOwner,
			sessionMode: config.noSession ? "no_session" : "persisted",
			sessionDir: config.sessionDir
				? isOwner
					? config.sessionDir
					: basename(config.sessionDir) || "pi-sessions"
				: null,
			defaultCwd: isOwner ? config.defaultCwd : basename(config.defaultCwd) || ".",
			pstack: pstackInfo,
			webAccess: { installedVersion: webAccessPackage?.version ?? null, roles: webAccessRoles },
			isolationModes: ISOLATION_MODES.map((mode) =>
				mode.id === "worker" && serverConfig?.inheritLocalPiResources
					? {
							...mode,
							sessionStrategy: "v2 作用域，继承本机配置的执行使用独立会话",
							extensionsPolicy: "本机业务执行沿用 Pi 已启用的 Skills 与扩展，其他流程显式装配",
						}
					: mode,
			),
			envFlags: {
				turnTimeoutMs,
				promptTimeoutMs,
				idleTimeoutMs,
				customExtensionsEnvConfigured: Boolean(process.env.PA_PI_EXTENSIONS?.trim()),
				pstackDirEnvConfigured: Boolean(process.env.PA_PSTACK_DIR?.trim()),
			},
		},
		extensions,
		configSections,
		summary,
		checkedAt: new Date().toISOString(),
	};
}
