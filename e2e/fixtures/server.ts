import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelSelection } from "@pa/contracts/model-selection";
import { loadRoleTemplatesFromDir, openPersonalAgentDatabase, PersonalAgentStore } from "@pa/server";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_E2E_SANDBOX_PASSWORD = "SandboxPassword123!";

export interface SandboxSeedAccount {
	email: string;
	role?: string;
	platformRole?: string;
	note?: string;
}

export interface IsolatedPaServerOptions {
	authMode?: "personal" | "team-sandbox";
	seedBoard?: boolean;
	/** Inherit host `~/.pi` login credentials & omit `PI_OFFLINE=1` for opt-in `@live` tests. */
	livePi?: boolean;
	/** Preserve server DB, spaces, sessions, and server.log inside this `.data-e2e/runs/...` directory. */
	persistentRunDir?: string;
	/** Optional initial default model selection saved into platform settings before server start. */
	defaultModelSelection?: ModelSelection;
	/** Optional workspace registered in default org before server start. */
	registerWorkspace?: {
		name: string;
		repoPath: string;
		defaultBranch?: string;
	};
}

export interface IsolatedPaServer {
	baseUrl: string;
	port: number;
	tempDir: string;
	persistent: boolean;
	dbPath: string;
	seededBoardMatterId: string | null;
	registeredWorkspaceId: string | null;
	sandboxPassword: string;
	sandboxAccounts: SandboxSeedAccount[];
	stop: () => Promise<void>;
}

async function allocateFreePort(): Promise<number> {
	return new Promise((resolvePort, rejectPort) => {
		const srv = createServer();
		srv.unref();
		srv.once("error", rejectPort);
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			if (!addr || typeof addr === "string") {
				srv.close(() => rejectPort(new Error("Failed to allocate ephemeral TCP port")));
				return;
			}
			const port = addr.port;
			srv.close((closeErr) => {
				if (closeErr) rejectPort(closeErr);
				else resolvePort(port);
			});
		});
	});
}

async function prepareDatabasePreBoot(options: {
	dbPath: string;
	spacesDir: string;
	workspacesRoot: string;
	seedBoard?: boolean;
	defaultModelSelection?: ModelSelection;
	registerWorkspace?: { name: string; repoPath: string; defaultBranch?: string };
}): Promise<{ seededBoardMatterId: string | null; registeredWorkspaceId: string | null }> {
	const db = openPersonalAgentDatabase(options.dbPath);
	try {
		const store = new PersonalAgentStore(db, { spacesDir: options.spacesDir });
		const templates = await loadRoleTemplatesFromDir(resolve(ROOT_DIR, "roles"));
		for (const tpl of templates) {
			store.upsertMember({
				id: tpl.id,
				templateId: tpl.id,
				displayName: tpl.name,
				roleTitle: tpl.title,
				isPrimaryContact: tpl.isPrimaryContact,
				keywords: tpl.keywords,
			});
		}

		const resolvedOrgId = store.ensureDefaultOrganization().id;

		if (options.defaultModelSelection) {
			store.updatePlatformSettings({ defaultModelSelection: options.defaultModelSelection }, options.workspacesRoot);
		}

		let registeredWorkspaceId: string | null = null;
		if (options.registerWorkspace) {
			const ws = store.upsertWorkspace({
				orgId: resolvedOrgId,
				name: options.registerWorkspace.name,
				repoPath: options.registerWorkspace.repoPath,
				defaultBranch: options.registerWorkspace.defaultBranch ?? "main",
			});
			registeredWorkspaceId = ws.id;
		}

		let seededBoardMatterId: string | null = null;
		if (options.seedBoard) {
			const matter = store.createMatter({
				title: "E2E 0.9.0 团队公告板验证事项",
				leadMemberId: "product-manager",
				collaborationMode: "board",
				coordinatorMemberId: "product-manager",
				orgId: resolvedOrgId,
				visibility: "org",
			});
			seededBoardMatterId = matter.id;

			store.upsertBoardMember({
				matterId: matter.id,
				agentId: "product-manager",
				sourceMemberId: "product-manager",
				displayName: "Product Manager",
				boardRole: "coordinator",
				status: "waiting",
				ownedScope: ["docs/plan.md"],
				lastReadPostNo: 4,
				metrics: { lastAction: "编排 Round 2 并监督验收进度" },
			});
			store.upsertBoardMember({
				matterId: matter.id,
				agentId: "builder-ui",
				sourceMemberId: "engineering-manager",
				displayName: "Frontend Builder",
				boardRole: "builder",
				status: "waiting",
				ownedScope: ["apps/web/"],
				lastReadPostNo: 4,
				metrics: { linesAdded: 128, linesDeleted: 16, lastAction: "已提交 Round 2 前端修复" },
			});
			store.upsertBoardMember({
				matterId: matter.id,
				agentId: "verifier-qa",
				sourceMemberId: "qa-manager",
				displayName: "QA Verifier",
				boardRole: "verifier",
				status: "working",
				ownedScope: ["test/"],
				lastReadPostNo: 4,
				activePostNo: 4,
				metrics: { testsPassed: 22, testsTotal: 24, lastAction: "正在运行端到端回归测试" },
			});
			store.upsertBoardMember({
				matterId: matter.id,
				agentId: "builder-api",
				sourceMemberId: "engineering-manager",
				displayName: "API Builder",
				boardRole: "builder",
				status: "stopped",
				ownedScope: ["packages/server/"],
				lastReadPostNo: 2,
				metrics: { lastAction: "等待上游接口确认后继续" },
			});
			store.upsertBoardMember({
				matterId: matter.id,
				agentId: "contracts-m1",
				sourceMemberId: "engineering-manager",
				displayName: "Contracts Round-1",
				boardRole: "builder",
				status: "retired",
				ownedScope: ["packages/contracts/"],
				lastReadPostNo: 1,
				metrics: { linesAdded: 64, testsPassed: 8, testsTotal: 8, lastAction: "Round 1 契约完成并已退场" },
			});

			store.createBoardPost({
				matterId: matter.id,
				authorType: "agent",
				authorId: "product-manager",
				kind: "assign",
				mentions: ["contracts-m1", "builder-ui"],
				summary: "Round 1：分派契约收敛与看板 UI 实现任务",
				body: "",
				orgId: resolvedOrgId,
			});
			store.createBoardPost({
				matterId: matter.id,
				authorType: "agent",
				authorId: "contracts-m1",
				kind: "handoff",
				mentions: ["verifier-qa"],
				refPostNos: [1],
				summary: "Round 1 DTO 与迁移完成，请核查兼容性",
				body: "## Round 1 交付细节\n\n- 统一 `BoardPostDto` 与 `BoardMemberDto`\n- 已补充 SQLite `user_version = 900` 迁移检查",
				orgId: resolvedOrgId,
			});
			store.createBoardPost({
				matterId: matter.id,
				authorType: "agent",
				authorId: "verifier-qa",
				kind: "verify_rework",
				mentions: ["builder-ui"],
				refPostNos: [2],
				summary: "打回重修：请补充懒加载正文边界与空态测试",
				body: '### 打回核查清单\n\n1. 正文懒加载失败应显示 `role="alert"`\n2. 空公告板需展示引导文案',
				verification: { verdict: "rework", checks: ["node --test test/board-ui-utils.test.ts"] },
				orgId: resolvedOrgId,
			});
			store.createBoardPost({
				matterId: matter.id,
				authorType: "agent",
				authorId: "builder-ui",
				kind: "handoff",
				mentions: ["verifier-qa"],
				refPostNos: [3],
				summary: "已修复懒加载正文异常提示并提交验收",
				body: "## 修复详情（E2E Lazy Body Marker）\n\n已补全正文字段按需拉取与 Markdown 渲染。",
				artifacts: {
					files: [{ path: "apps/web/src/components/chat/MatterBoardPane.tsx", linesAdded: 42, linesDeleted: 6 }],
					commands: ["npm run check"],
				},
				orgId: resolvedOrgId,
			});
			store.createBoardPost({
				matterId: matter.id,
				authorType: "agent",
				authorId: "verifier-qa",
				kind: "verify_pass",
				mentions: ["product-manager"],
				refPostNos: [4],
				summary: "看板正文懒加载与关系图核验通过",
				body: "",
				verification: { verdict: "pass", checks: ["npm test"] },
				orgId: resolvedOrgId,
			});

			const baseMs = Date.UTC(2026, 10, 27, 9, 0, 0);
			for (let i = 0; i < 55; i += 1) {
				const createdAt = new Date(baseMs + i * 1000).toISOString();
				const isLatestAlert = i === 54;
				store.appendEvent({
					matterId: matter.id,
					runId: "run_e2e_seed",
					agentId: isLatestAlert ? "verifier-qa" : "builder-ui",
					boardPostNo: isLatestAlert ? 4 : 1,
					eventType: isLatestAlert ? "monitor_alert" : i % 2 === 0 ? "tool_start" : "tool_end",
					payload: isLatestAlert
						? { silenceMs: 125_000, reason: "E2E Monitor 巡检停滞提醒" }
						: { toolName: "read", seq: i + 1 },
					createdAt,
				});
			}
		}

		return { seededBoardMatterId, registeredWorkspaceId };
	} finally {
		db.close();
	}
}

async function waitForServerReady(
	baseUrl: string,
	child: ChildProcess,
	logs: string[],
	timeoutMs = 15_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastError = "";
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			throw new Error(`PA E2E server exited prematurely with code ${child.exitCode}.\nLogs:\n${logs.join("")}`);
		}
		try {
			const res = await fetch(`${baseUrl}/api/auth/session`);
			if (res.ok) return;
			lastError = `HTTP ${res.status}`;
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err);
		}
		await new Promise((r) => setTimeout(r, 150));
	}
	throw new Error(`Timed out waiting for PA server at ${baseUrl} (${lastError}).\nLogs:\n${logs.join("")}`);
}

/**
 * Boot an isolated Personal Agent host (never touches `.data/`).
 * Uses disposable `mkdtemp` by default, or preserves state/logs under `persistentRunDir` (`.data-e2e/runs/...`).
 */
export async function startIsolatedPaServer(options: IsolatedPaServerOptions = {}): Promise<IsolatedPaServer> {
	const authMode = options.authMode ?? "personal";
	const persistent = Boolean(options.persistentRunDir);
	const tempDir = options.persistentRunDir
		? resolve(options.persistentRunDir)
		: await mkdtemp(join(tmpdir(), "pa-e2e-"));
	await mkdir(tempDir, { recursive: true });

	const port = await allocateFreePort();
	const baseUrl = `http://127.0.0.1:${port}`;
	const dbDir = options.persistentRunDir ? join(tempDir, "db") : tempDir;
	const spacesDir = join(tempDir, "spaces");
	const sessionDir = join(tempDir, options.persistentRunDir ? "sessions" : "pi-sessions");
	const defaultWorkspaceDir = join(tempDir, "default-workspace");
	const workspacesRoot = join(tempDir, "team-workspaces");
	const logsDir = join(tempDir, "logs");
	const serverLogPath = options.persistentRunDir ? join(logsDir, "server.log") : null;

	await Promise.all([
		mkdir(dbDir, { recursive: true }),
		mkdir(spacesDir, { recursive: true }),
		mkdir(sessionDir, { recursive: true }),
		mkdir(defaultWorkspaceDir, { recursive: true }),
		mkdir(workspacesRoot, { recursive: true }),
		...(options.persistentRunDir ? [mkdir(logsDir, { recursive: true })] : []),
	]);

	let dbPath = join(dbDir, "personal-agent.db");
	let sandboxWorkspacesRoot = workspacesRoot;
	let sandboxAccounts: SandboxSeedAccount[] = [];
	const sandboxPassword = DEFAULT_E2E_SANDBOX_PASSWORD;

	try {
		if (authMode === "team-sandbox") {
			const rawSummary = execFileSync(
				process.execPath,
				[
					resolve(ROOT_DIR, "scripts/start-team-sandbox.mjs"),
					"--seed-only",
					`--dir=${tempDir}`,
					`--password=${sandboxPassword}`,
				],
				{ cwd: ROOT_DIR, encoding: "utf8" },
			);
			const parsed = JSON.parse(rawSummary) as {
				dbPath: string;
				workspacesRoot: string;
				accounts?: SandboxSeedAccount[];
			};
			dbPath = parsed.dbPath;
			sandboxWorkspacesRoot = parsed.workspacesRoot;
			sandboxAccounts = parsed.accounts ?? [];
		}

		let seededBoardMatterId: string | null = null;
		let registeredWorkspaceId: string | null = null;
		if (options.seedBoard || options.defaultModelSelection || options.registerWorkspace) {
			const prep = await prepareDatabasePreBoot({
				dbPath,
				spacesDir,
				workspacesRoot: sandboxWorkspacesRoot,
				seedBoard: options.seedBoard,
				defaultModelSelection: options.defaultModelSelection,
				registerWorkspace: options.registerWorkspace,
			});
			seededBoardMatterId = prep.seededBoardMatterId;
			registeredWorkspaceId = prep.registeredWorkspaceId;
		}

		const childEnv: NodeJS.ProcessEnv = {
			...process.env,
			PA_HOST: "127.0.0.1",
			PORT: String(port),
			PA_REQUIRE_AUTH: authMode === "team-sandbox" ? "1" : "0",
			PA_DB_PATH: dbPath,
			PA_WORKSPACES_ROOT: sandboxWorkspacesRoot,
			PA_DEFAULT_WORKSPACE_DIR: defaultWorkspaceDir,
			PA_SESSION_DIR: sessionDir,
		};

		if (options.livePi) {
			// Inherit host `~/.pi` login state (kimi-coding, opencode-go, etc.) for explicit `@live` runs.
			childEnv.PA_LOCAL_PI_RESOURCES = "1";
			delete childEnv.PI_OFFLINE;
		} else {
			const piAgentDir = join(tempDir, "pi-agent");
			await mkdir(piAgentDir, { recursive: true });
			childEnv.PA_LOCAL_PI_RESOURCES = "0";
			childEnv.PI_CODING_AGENT_DIR = piAgentDir;
			childEnv.PI_OFFLINE = "1";
		}

		const logs: string[] = [];
		const child = spawn(process.execPath, [resolve(ROOT_DIR, "apps/cli/src/main.ts")], {
			cwd: ROOT_DIR,
			env: childEnv,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const pushLog = (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			logs.push(text);
			if (logs.length > 100) logs.shift();
			if (serverLogPath) {
				appendFileSync(serverLogPath, text, "utf8");
			}
		};
		child.stdout?.on("data", pushLog);
		child.stderr?.on("data", pushLog);

		await waitForServerReady(baseUrl, child, logs);

		let stopped = false;
		const stop = async () => {
			if (stopped) return;
			stopped = true;
			try {
				if (child.exitCode === null) {
					child.kill("SIGTERM");
					await new Promise<void>((resolveStop) => {
						const timer = setTimeout(() => {
							if (child.exitCode === null) child.kill("SIGKILL");
							resolveStop();
						}, 5000);
						child.once("exit", () => {
							clearTimeout(timer);
							resolveStop();
						});
					});
				}
			} finally {
				if (!persistent) {
					await rm(tempDir, { recursive: true, force: true });
				}
			}
		};

		return {
			baseUrl,
			port,
			tempDir,
			persistent,
			dbPath,
			seededBoardMatterId,
			registeredWorkspaceId,
			sandboxPassword,
			sandboxAccounts,
			stop,
		};
	} catch (error) {
		if (!persistent) {
			await rm(tempDir, { recursive: true, force: true });
		}
		throw error;
	}
}
