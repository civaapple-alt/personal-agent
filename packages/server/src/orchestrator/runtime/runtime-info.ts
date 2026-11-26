import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
import { builtinExtensionPaths, resolveBuiltinExtensionPath } from "../../extensions/builtin-paths.ts";
import {
	listManagedEnvStatus,
	type ManagedEnvStatus,
	readWebAccessEnvFromDotEnv,
	resolveEnvFilePath,
} from "../../extensions/env-credentials.ts";
import { HUMAN_QUESTION_TOOL } from "../../extensions/human-question/runtime.ts";
import { findInstalledPiWebAccess } from "../../extensions/web-access/package.ts";
import {
	PI_WEB_SEARCH_TOOLS,
	type ResolvedWebSearchProvider,
	resolveEffectiveWebSearchProvider,
	type WebSearchProviderPreference,
} from "../../extensions/web-access/runtime.ts";
import type { RoleTemplate } from "../../roles/types.ts";
import { listPiPackages } from "../../rpc/pi-packages.ts";
import type { TeamMember } from "../../storage/types.ts";
import { resolveTurnTimeoutMs } from "../types.ts";

const execFileAsync = promisify(execFile);

export interface OrchestratorRuntimeConfig {
	defaultCwd: string;
	sessionDir: string | null;
	noSession: boolean;
	extensions: string[];
	webSearchProvider?: WebSearchProviderPreference;
	systemOneEnabled?: boolean;
	templates: RoleTemplate[];
}

export type LocalPiResourcesPolicy = "auto" | "always" | "off";

/** Parse `PA_LOCAL_PI_RESOURCES` or programmatic option into tri-state policy (`auto` | `always` | `off`). */
export function normalizeLocalPiResourcesPolicy(
	raw: boolean | LocalPiResourcesPolicy | string | undefined,
): LocalPiResourcesPolicy {
	if (raw === false) return "off";
	if (raw === true || raw === undefined) return "auto";
	const normalized = raw.trim().toLowerCase();
	if (normalized === "1" || normalized === "true" || normalized === "always" || normalized === "on") {
		return "always";
	}
	if (normalized === "0" || normalized === "false" || normalized === "off" || normalized === "never") {
		return "off";
	}
	return "auto";
}

export interface ServerRuntimeConfig {
	host?: string;
	port?: number;
	dbPath?: string;
	builtinRolesDir?: string;
	rolesDir?: string;
	uploadsDir?: string;
	webDistDir?: string;
	requireAuth?: boolean;
	inheritLocalPiResources?: boolean;
	localPiResourcesPolicy?: LocalPiResourcesPolicy;
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
	id: "worker" | "decision" | "architect-aux";
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
	webAccess: {
		installedVersion: string | null;
		roles: Array<{ id: string; name: string; enabled: boolean }>;
		provider: WebSearchProviderPreference;
		effectiveProvider: ResolvedWebSearchProvider | null;
	};
	systemOne?: {
		enabled: boolean;
	};
	isolationModes: RuntimeIsolationMode[];
	envFlags: {
		turnTimeoutMs: number;
		promptTimeoutMs: number;
		idleTimeoutMs: number;
		customExtensionsEnvConfigured: boolean;
	};
}

export interface RuntimeOverviewPayload {
	base: RuntimeBaseInfo;
	extensions: RuntimeExtensionItem[];
	configSections: RuntimeConfigSection[];
	envCredentials?: ManagedEnvStatus[];
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
		label: "业务岗位执行",
		usage: "主责 / 内部委托 / 旁听 / 独立验收 / 事项内角色架构师",
		sessionStrategy: "按事项、成员与作用域持久化 Pi 会话（支持 session_compact 续接）",
		extensionsPolicy: "--no-extensions 显式装配 PA 扩展；按租户作用域挂载 --skill",
		toolsPolicy: "Pi 原生工具 + 扩展门禁（内部成员禁发布；受管 Skill 脚本按信任四步确认）",
	},
	{
		id: "decision",
		label: "无状态结构化决策",
		usage: "立项阵型评估 / 快速角色草案 / 意图路由",
		sessionStrategy: "无持久 Pi 会话（--no-session）",
		extensionsPolicy: "--no-extensions --no-skills --no-mcp --no-context-files",
		toolsPolicy: '默认无工具（--tools ""）；查仓时仅开放 read',
	},
	{
		id: "architect-aux",
		label: "独立角色架构师弹窗",
		usage: "团队协作体检 / 角色规划对话",
		sessionStrategy: "无持久 Pi 会话（--no-session）；传入对话上下文",
		extensionsPolicy: "--no-extensions --no-context-files；显式加载角色 Skill 与 MCP",
		toolsPolicy: "仅只读工具（read, grep, find, ls）；提案须经人类确认",
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
	const workerRuntimePath = resolveBuiltinExtensionPath("worker-runtime");
	const spacePath = resolveBuiltinExtensionPath("space");
	const delegationPath = resolveBuiltinExtensionPath("delegation");
	const skillCapturePath = resolveBuiltinExtensionPath("skill-capture");
	const humanQuestionPath = resolveBuiltinExtensionPath("human-question");
	const skillCatalogPath = resolveBuiltinExtensionPath("skill-catalog");
	const roleSkillsPath = resolveBuiltinExtensionPath("role-skills");

	const [
		piProbe,
		workerRuntimeFileStatus,
		spaceFileStatus,
		delegationFileStatus,
		skillCaptureFileStatus,
		humanQuestionFileStatus,
		skillCatalogFileStatus,
		roleSkillsFileStatus,
	] = await Promise.all([
		probePromise,
		checkFileOrDir(workerRuntimePath),
		checkFileOrDir(spacePath),
		checkFileOrDir(delegationPath),
		checkFileOrDir(skillCapturePath),
		checkFileOrDir(humanQuestionPath),
		checkFileOrDir(skillCatalogPath),
		checkFileOrDir(roleSkillsPath),
	]);

	let packageListing: Promise<string> | undefined;
	const readPackages = (executable: string) => {
		packageListing ??= (options.listPiPackages ?? listPiPackages)(executable);
		return packageListing;
	};
	const webAccessPackage =
		isOwner && piProbe.available ? await findInstalledPiWebAccess(piProbe.executable, readPackages) : null;

	const templateById = new Map(config.templates.map((tpl) => [tpl.id, tpl]));
	const webAccessRoles = activeMembers.map((member) => ({
		id: member.id,
		name: member.displayName,
		enabled: Boolean(webAccessPackage),
	}));
	const webAccessEnabledRoles = webAccessRoles.filter((role) => role.enabled);
	const webAccessExtensionItem: RuntimeExtensionItem = {
		id: "pi-web-access",
		name: "pi-web-access",
		sourceKind: "pi_package",
		status: webAccessEnabledRoles.length === 0 ? "inactive" : isOwner && !webAccessPackage ? "error" : "conditional",
		entryPath: webAccessPackage?.entry ?? null,
		fileStatus: webAccessPackage ? "present" : "unknown",
		scopeSummary: "所有岗位执行，包括旁听与独立验收",
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

	const workerRuntimeItem: RuntimeExtensionItem = {
		id: "builtin-worker-runtime",
		name: "worker-runtime",
		sourceKind: "builtin",
		status: workerRuntimeFileStatus === "present" ? "active" : "error",
		entryPath: isOwner ? workerRuntimePath : builtinExtensionPaths["worker-runtime"],
		fileStatus: workerRuntimeFileStatus,
		scopeSummary: "所有 PA 宿主岗位启动时加载",
		description:
			"隔离目标工作区 AGENTS.md、注入成员与轮次上下文、核查工具握手、标注外部检索证据，并为非讨论主责提供团队角色读取与提案工具。",
		registeredTools: ["read_team_roles", "propose_role"],
		hooks: ["session_start", "before_agent_start", "tool_call", "tool_result"],
		declaredByRoles: [],
		mcpServers: [],
		error: workerRuntimeFileStatus === "missing" ? "未找到扩展入口文件" : null,
	};

	const spaceExtensionItem: RuntimeExtensionItem = {
		id: "builtin-space",
		name: "space",
		sourceKind: "builtin",
		status: spaceFileStatus === "present" ? "conditional" : "error",
		entryPath: isOwner ? spacePath : builtinExtensionPaths.space,
		fileStatus: spaceFileStatus,
		scopeSummary: "非架构师主责与受托岗位（仅主责非讨论模式可写）",
		description: "通过本机桥接读写 Git 资料空间与版本化成果。",
		registeredTools: ["read_space", "save_space_page"],
		hooks: [],
		declaredByRoles: [],
		mcpServers: [],
		error: spaceFileStatus === "missing" ? "未找到扩展入口文件" : null,
	};

	const delegationExtensionItem: RuntimeExtensionItem = {
		id: "builtin-delegation",
		name: "delegation",
		sourceKind: "builtin",
		status: delegationFileStatus === "present" ? "conditional" : "error",
		entryPath: isOwner ? delegationPath : builtinExtensionPaths.delegation,
		fileStatus: delegationFileStatus,
		scopeSummary: "具备可委托同事的主责或内部协作者",
		description: "通过本机桥接委托团队成员执行专业任务或独立验收。",
		registeredTools: ["delegate_to_member"],
		hooks: [],
		declaredByRoles: [],
		mcpServers: [],
		error: delegationFileStatus === "missing" ? "未找到扩展入口文件" : null,
	};

	const skillCaptureItem: RuntimeExtensionItem = {
		id: "builtin-skill-capture",
		name: "skill-capture",
		sourceKind: "builtin",
		status: skillCaptureFileStatus === "present" ? "conditional" : "error",
		entryPath: isOwner ? skillCapturePath : builtinExtensionPaths["skill-capture"],
		fileStatus: skillCaptureFileStatus,
		scopeSummary: "正式执行的主责或内部协作者（经人工确认后写入磁盘）",
		description: "对应信任四步第二步：提议将可复用方法与脚本存为标准 Pi Skill（SKILL.md + scripts/*）。",
		registeredTools: ["propose_skill"],
		hooks: ["extension_ui"],
		declaredByRoles: [],
		mcpServers: [],
		error: skillCaptureFileStatus === "missing" ? "未找到扩展入口文件" : null,
	};

	const skillCatalogItem: RuntimeExtensionItem = {
		id: "builtin-skill-catalog",
		name: "skill-catalog",
		sourceKind: "builtin",
		status: skillCatalogFileStatus === "present" ? "active" : "error",
		entryPath: isOwner ? skillCatalogPath : builtinExtensionPaths["skill-catalog"],
		fileStatus: skillCatalogFileStatus,
		scopeSummary: "事项岗位与独立角色架构师",
		description: "发现 Pi 当前可用的 Skills 和插件命令，按需读取方法或提交命令。",
		registeredTools: ["list_available_skills", "load_available_skill"],
		hooks: [],
		declaredByRoles: [],
		mcpServers: [],
		error: skillCatalogFileStatus === "missing" ? "未找到扩展入口文件" : null,
	};

	const roleSkillsItem: RuntimeExtensionItem = {
		id: "builtin-role-skills",
		name: "role-skills",
		sourceKind: "builtin",
		status: roleSkillsFileStatus === "present" ? "active" : "error",
		entryPath: isOwner ? roleSkillsPath : builtinExtensionPaths["role-skills"],
		fileStatus: roleSkillsFileStatus,
		scopeSummary: "内置岗位方法 Skill 包（支持终端 pi install）",
		description: "提供产品、研发、测试与增长岗位的内置方法论 Skills，作为标准 Pi Package 加载。",
		registeredTools: [],
		hooks: [],
		declaredByRoles: [],
		mcpServers: [],
		error: roleSkillsFileStatus === "missing" ? "未找到内置角色 Skill 包目录" : null,
	};

	const humanQuestionItem: RuntimeExtensionItem = {
		id: "builtin-human-question",
		name: "human-question",
		sourceKind: "builtin_conditional",
		status: humanQuestionFileStatus === "present" ? "conditional" : "error",
		entryPath: isOwner ? humanQuestionPath : builtinExtensionPaths["human-question"],
		fileStatus: humanQuestionFileStatus,
		scopeSummary: "正式执行的主责与内部委托",
		description: "主责提请人工决定，协作者将澄清问题交回直接委托者。",
		registeredTools: [HUMAN_QUESTION_TOOL],
		hooks: [],
		declaredByRoles: [],
		mcpServers: [],
		error: humanQuestionFileStatus === "missing" ? "未找到扩展入口文件" : null,
	};

	const mcpExtensionItem: RuntimeExtensionItem = {
		id: "pi-builtin-mcp",
		name: "builtin:mcp",
		sourceKind: "pi_builtin",
		status: "conditional",
		entryPath: "builtin:mcp",
		fileStatus: "builtin",
		scopeSummary: "所有岗位可使用已配置的 Pi MCP 服务",
		description: "接入 Pi 已配置的 MCP 服务；角色声明仅供参考。",
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
		workerRuntimeItem,
		spaceExtensionItem,
		delegationExtensionItem,
		skillCaptureItem,
		skillCatalogItem,
		roleSkillsItem,
		humanQuestionItem,
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
					label: "宿主机 Pi 资源继承",
					value:
						serverConfig?.localPiResourcesPolicy === "always"
							? "已强制启用（always · 含团队/登录模式）"
							: serverConfig?.localPiResourcesPolicy === "off"
								? "已禁用（off · 仅显式装配）"
								: serverConfig?.inheritLocalPiResources
									? "自动（auto · 本机个人版已继承）"
									: "自动（auto · 团队/非回环模式仅显式装配）",
					defaultValue: "auto（支持 1/always 或 0/off）",
					overridden:
						serverConfig?.localPiResourcesPolicy !== undefined
							? serverConfig.localPiResourcesPolicy !== "auto"
							: normalizeLocalPiResourcesPolicy(process.env.PA_LOCAL_PI_RESOURCES) !== "auto",
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
					key: "apps/web/dist/",
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
					value: serverConfig?.requireAuth ? "强制账号认证" : "本机回环默认所有者 / 非回环账号认证",
				},
			],
		},
	];

	const envFilePath = resolveEnvFilePath(config.defaultCwd);
	const envCredentials = isOwner ? await listManagedEnvStatus(envFilePath) : undefined;
	const dotEnvWebAccess = await readWebAccessEnvFromDotEnv(envFilePath);
	const webSearchProvider: WebSearchProviderPreference = config.webSearchProvider ?? "auto";
	const effectiveWebSearchProvider = resolveEffectiveWebSearchProvider(webSearchProvider, dotEnvWebAccess) ?? null;

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
			webAccess: {
				installedVersion: webAccessPackage?.version ?? null,
				roles: webAccessRoles,
				provider: webSearchProvider,
				effectiveProvider: effectiveWebSearchProvider,
			},
			systemOne: {
				enabled: Boolean(config.systemOneEnabled),
			},
			isolationModes: ISOLATION_MODES.map((mode) =>
				mode.id === "worker"
					? {
							...mode,
							...(config.noSession ? { sessionStrategy: "无持久 Pi 会话" } : {}),
							extensionsPolicy: serverConfig?.inheritLocalPiResources
								? serverConfig.localPiResourcesPolicy === "always"
									? "宿主机 Pi 资源已继承（PA_LOCAL_PI_RESOURCES=1 · --offline；本地工作区按 trust.json 传 --approve，托管克隆仓保持 --no-extensions --no-approve）；Skill 由 Pi 发现及按需读取"
									: "本机个人模式可继承 Pi 资源（--offline；本地工作区按 trust.json 传 --approve，无工作区落盘至 ~/.pa/workspaces/default）；Skill 由 Pi 发现及按需读取"
								: "--no-extensions 显式装配 PA 扩展；按租户作用域挂载 --skill（Skill 由 Pi 发现及按需读取；设 PA_LOCAL_PI_RESOURCES=1 可继承宿主机 Pi 扩展）",
						}
					: mode,
			),
			envFlags: {
				turnTimeoutMs,
				promptTimeoutMs,
				idleTimeoutMs,
				customExtensionsEnvConfigured: Boolean(process.env.PA_PI_EXTENSIONS?.trim()),
			},
		},
		extensions,
		configSections,
		...(envCredentials ? { envCredentials } : {}),
		summary,
		checkedAt: new Date().toISOString(),
	};
}
