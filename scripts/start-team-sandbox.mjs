// Isolated Team Edition sandbox starter with multi-org RBAC, restricted repos, and versioned Space documents.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TeamOrchestrator } from "../src/orchestrator/team-orchestrator.ts";
import { BUILTIN_ROLE_ARCHITECT_TEMPLATE } from "../src/roles/role-architect.ts";
import { loadRoleTemplatesFromDir } from "../src/roles/template-loader.ts";
import { openPersonalAgentDatabase } from "../src/storage/database.ts";
import { PersonalAgentStore } from "../src/storage/repositories.ts";

const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const DEFAULT_PORT = 4399;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_SANDBOX_SECRET = process.env.PA_SANDBOX_PASSWORD?.trim() || "Sandbox123!";

export function parseSandboxArgs(argv) {
	let help = false;
	let keep = false;
	let seedOnly = false;
	let port = Number(process.env.PORT ?? DEFAULT_PORT);
	let host = process.env.PA_HOST?.trim() || DEFAULT_HOST;
	let dir = null;
	let password = DEFAULT_SANDBOX_SECRET;

	for (const arg of argv) {
		if (arg === "--help" || arg === "-h") {
			help = true;
		} else if (arg === "--keep") {
			keep = true;
		} else if (arg === "--seed-only") {
			seedOnly = true;
		} else if (arg.startsWith("--port=")) {
			port = Number(arg.slice("--port=".length));
		} else if (arg.startsWith("--host=")) {
			host = arg.slice("--host=".length).trim() || DEFAULT_HOST;
		} else if (arg.startsWith("--dir=")) {
			const value = arg.slice("--dir=".length).trim();
			if (value) dir = resolve(value);
		} else if (arg.startsWith("--password=")) {
			password = arg.slice("--password=".length);
		} else {
			throw new Error(`Unknown sandbox argument: ${arg}`);
		}
	}

	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`Invalid port: ${port}`);
	}
	if (password.length < 8) {
		throw new Error("Sandbox password must be at least 8 characters long.");
	}
	return { help, keep, seedOnly, port, host, dir, password };
}

function printUsage() {
	console.log(`Usage: npm run start:team:sandbox -- [options]

Starts an isolated Team Edition workbench (PA_REQUIRE_AUTH=1) in a temporary directory
pre-seeded with organizations, RBAC roles, open/restricted repos, versioned Space documents,
review feedback, candidate/verified memories, and sample chat history (never touches .data/).

Options:
  --port=<port>        HTTP port (default: ${DEFAULT_PORT})
  --host=<host>        Bind host (default: ${DEFAULT_HOST})
  --dir=<path>         Use a persistent sandbox directory (kept after exit, skips re-seeding if initialized)
  --keep               Keep the auto-created temporary directory after exit
  --password=<secret>  Login password shared by all seeded accounts (min 8 chars, env PA_SANDBOX_PASSWORD)
  --seed-only          Seed database and workspace directories cleanly, print summary JSON, and exit
  --help, -h           Show this help message
`);
}

async function ensureRepoStub(dirPath, title, body) {
	await mkdir(dirPath, { recursive: true });
	const readmePath = join(dirPath, "README.md");
	if (!existsSync(readmePath)) {
		await writeFile(readmePath, `# ${title}\n\n${body}\n`, "utf8");
	}
}

function summarizeExistingSandbox(store, sandboxRoot, dbPath, workspacesRoot, password) {
	const orgs = store.listOrganizations();
	const alphaOrg = orgs.find((o) => o.slug === "alpha-studio") ?? orgs[0];
	const betaOrg = orgs.find((o) => o.slug === "beta-labs") ?? null;
	const users = store.listUsers();
	return {
		seeded: false,
		sandboxRoot,
		dbPath,
		workspacesRoot,
		password,
		inviteToken: null,
		organizations: [alphaOrg?.name, betaOrg?.name].filter(Boolean),
		documentCount: store.spaces.listDocuments({}).length,
		accounts: users.map((u) => ({
			email: u.email,
			displayName: u.displayName,
			platformRole: u.platformRole,
			status: u.status,
		})),
	};
}

export async function seedTeamSandbox({ sandboxRoot, password = DEFAULT_SANDBOX_SECRET }) {
	const dbPath = join(sandboxRoot, "pa.db");
	const reposRoot = join(sandboxRoot, "repos");
	const workspacesRoot = join(sandboxRoot, "team-workspaces");
	const alphaOpenRepo = join(reposRoot, "alpha-platform");
	const alphaSecretRepo = join(reposRoot, "alpha-secret");
	const betaOpenRepo = join(reposRoot, "beta-app");

	await Promise.all([
		ensureRepoStub(alphaOpenRepo, "Alpha Platform", "Alpha Studio primary service repository for sandbox testing."),
		ensureRepoStub(alphaSecretRepo, "Alpha Secret", "Restricted repository containing sensitive rotation runbooks."),
		ensureRepoStub(betaOpenRepo, "Beta App", "Beta Labs gateway and developer API specification repository."),
		mkdir(workspacesRoot, { recursive: true }),
	]);

	const db = openPersonalAgentDatabase(dbPath);
	const store = new PersonalAgentStore(db, { spacesDir: join(sandboxRoot, "spaces") });
	const templates = [...(await loadRoleTemplatesFromDir(resolve(ROOT_DIR, "roles"))), BUILTIN_ROLE_ARCHITECT_TEMPLATE];
	new TeamOrchestrator({ store, templates, noSession: true, defaultCwd: ROOT_DIR });

	try {
		if (
			store.hasPasswordedAdmin() &&
			store.listOrganizations().length > 1 &&
			store.spaces.listDocuments({}).length > 0
		) {
			return summarizeExistingSandbox(store, sandboxRoot, dbPath, workspacesRoot, password);
		}

		store.ensureLocalBootstrapAdmin("沙盒超管");
		const admin = store.setupInitialAdmin({
			email: "admin@sandbox.local",
			password,
			displayName: "沙盒超管",
		});
		store.updatePlatformSettings(
			{
				registrationMode: "open_review",
				allowLocalWorkspacePath: true,
				localWorkspaceAllowlist: [reposRoot],
				defaultMaxOrgs: 5,
				defaultMaxActiveDispatches: 3,
				defaultMaxPersonalRoles: 5,
			},
			workspacesRoot,
		);

		const alphaOrg = store.upsertOrganization({
			name: "Alpha Studio",
			slug: "alpha-studio",
			gitEmailDomain: "alpha.local",
			description: "沙盒主团队：包含共享、私密与受限仓库多版本交付成果",
			isDefault: true,
			createdByUserId: admin.id,
		});
		const betaOrg = store.upsertOrganization({
			name: "Beta Labs",
			slug: "beta-labs",
			gitEmailDomain: "beta.local",
			description: "沙盒第二团队：用于跨组织成果筛选与权限隔离验证",
			isDefault: false,
			createdByUserId: admin.id,
		});

		const ownerAlpha = store.createUser({
			email: "owner@alpha.local",
			displayName: "Alpha 所有者",
			password,
			status: "active",
		});
		const adminAlpha = store.createUser({
			email: "admin@alpha.local",
			displayName: "Alpha 管理员",
			password,
			status: "active",
		});
		const memberAlpha = store.createUser({
			email: "member@alpha.local",
			displayName: "Alpha 成员",
			password,
			status: "active",
		});
		const peerAlpha = store.createUser({
			email: "peer@alpha.local",
			displayName: "Alpha 协作同事",
			password,
			status: "active",
		});
		const viewerAlpha = store.createUser({
			email: "viewer@alpha.local",
			displayName: "Alpha 只读访客",
			password,
			status: "active",
		});
		const ownerBeta = store.createUser({
			email: "owner@beta.local",
			displayName: "Beta 所有者",
			password,
			status: "active",
		});
		store.createUser({
			email: "pending@sandbox.local",
			displayName: "待审核申请人",
			password,
			status: "pending_review",
		});

		store.upsertOrgMember({ orgId: alphaOrg.id, userId: ownerAlpha.id, orgRole: "org_owner", roleTitle: "负责人" });
		store.upsertOrgMember({ orgId: alphaOrg.id, userId: adminAlpha.id, orgRole: "org_admin", roleTitle: "管理员" });
		store.upsertOrgMember({ orgId: alphaOrg.id, userId: memberAlpha.id, orgRole: "org_member", roleTitle: "研发" });
		store.upsertOrgMember({ orgId: alphaOrg.id, userId: peerAlpha.id, orgRole: "org_member", roleTitle: "协作研发" });
		store.upsertOrgMember({
			orgId: alphaOrg.id,
			userId: viewerAlpha.id,
			orgRole: "org_viewer",
			roleTitle: "审阅访客",
		});
		store.upsertOrgMember({
			orgId: betaOrg.id,
			userId: ownerBeta.id,
			orgRole: "org_owner",
			roleTitle: "Beta 负责人",
		});
		store.upsertOrgMember({
			orgId: betaOrg.id,
			userId: ownerAlpha.id,
			orgRole: "org_member",
			roleTitle: "跨组织协作",
		});

		store.setOrgAiRolesBatch(alphaOrg.id, [
			{ memberId: "product-manager", enabled: true, isPrimaryContact: true },
			{ memberId: "engineering-manager", enabled: true },
			{ memberId: "qa-manager", enabled: true },
			{ memberId: "marketing-lead", enabled: true },
		]);
		store.setOrgAiRolesBatch(betaOrg.id, [
			{ memberId: "engineering-manager", enabled: true, isPrimaryContact: true },
			{ memberId: "product-manager", enabled: true },
		]);

		const wsAlphaOpen = store.upsertWorkspace({
			name: "Alpha Platform",
			repoPath: alphaOpenRepo,
			orgId: alphaOrg.id,
			visibility: "org",
			description: "Alpha Studio 组织公开业务仓库",
		});
		const wsAlphaSecret = store.upsertWorkspace({
			name: "Alpha Secret",
			repoPath: alphaSecretRepo,
			orgId: alphaOrg.id,
			visibility: "restricted",
			description: "Alpha Studio 受限安全仓库（仅 Alpha 所有者、管理员与 Alpha 成员可见）",
		});
		store.setWorkspaceAccess(wsAlphaSecret.id, "restricted", [ownerAlpha.id, memberAlpha.id]);
		const wsBetaOpen = store.upsertWorkspace({
			name: "Beta App",
			repoPath: betaOpenRepo,
			orgId: betaOrg.id,
			visibility: "org",
			description: "Beta Labs 开放平台网关仓库",
		});

		const mAlphaShared = store.createMatter({
			title: "Q4 发布计划与灰度架构",
			summary: "覆盖 Alpha Platform 多版本发布规范与灰度验证",
			leadMemberId: "product-manager",
			workspaceId: wsAlphaOpen.id,
			orgId: alphaOrg.id,
			createdByUserId: ownerAlpha.id,
			visibility: "org",
		});
		store.appendMessage({
			matterId: mAlphaShared.id,
			channel: "user",
			senderType: "user",
			senderId: ownerAlpha.id,
			senderName: ownerAlpha.displayName,
			content: "请结合 Alpha Platform 当前结构产出 Q4 发布计划与灰度回滚方案。",
		});
		store.spaces.ensureAllDefaultSpaces();
		const alphaDocumentV1 = await store.spaces.createDocument({
			spaceId: `spc_ws_${wsAlphaOpen.id}`,
			matterId: mAlphaShared.id,
			title: "Q4 发布计划与架构方案",
			content: "# Q4 发布计划（V1 初稿）\n\n- 完成多组织隔离。\n- 补充灰度监控指标与回滚手册。",
			actorId: ownerAlpha.id,
			actorName: ownerAlpha.displayName,
		});
		await store.spaces.saveDocumentFeedback({
			documentId: alphaDocumentV1.id,
			commitHash: alphaDocumentV1.headCommit,
			actorId: ownerAlpha.id,
			actorName: ownerAlpha.displayName,
			feedback: "V1 结构完整，请补充具体放量梯度与回滚演练清单。",
			rating: "positive",
		});

		const verifiedOrgMem = store.addMemory({
			memberId: "product-manager",
			scope: "company_private",
			category: "domain_constraint",
			orgId: alphaOrg.id,
			content: "Alpha Studio 所有发布方案必须附带灰度放量比例、监控阈值与一键回滚开关。",
			rationale: "来自历史发布复盘沉淀",
			sourceMatterId: mAlphaShared.id,
			status: "verified",
			verified: true,
		});
		const appIds = store.recordMemoryApplications({
			memoryIds: [verifiedOrgMem.id],
			matterId: mAlphaShared.id,
			memberId: "product-manager",
			note: "修订 V2 发布方案时自动注入组织发布约束",
		});
		const alphaDocumentV2 = await store.spaces.updateDocument(alphaDocumentV1.id, {
			revision: alphaDocumentV1.revision,
			title: "Q4 发布计划与架构方案",
			content: "# Q4 发布计划（V2）\n\n按 5% → 25% → 100% 灰度放量，错误率超阈值时回滚。",
			actorId: ownerAlpha.id,
			actorName: ownerAlpha.displayName,
		});
		store.recordTurnOutcome({
			candidates: [],
			applicationIds: appIds,
			spaceDocuments: [{ id: alphaDocumentV2.id, headCommit: alphaDocumentV2.headCommit }],
		});
		store.appendMessage({
			matterId: mAlphaShared.id,
			channel: "user",
			senderType: "member",
			senderId: "product-manager",
			senderName: "Product Manager",
			content: "已依据 V1 反馈发布《Q4 发布计划与架构方案》V2，补充灰度比例与回滚阈值。",
			metadata: { spaceDocuments: [alphaDocumentV2] },
		});
		store.addMemory({
			memberId: "qa-manager",
			scope: "company_private",
			category: "efficiency",
			orgId: alphaOrg.id,
			content: "发布检查清单应先执行离线启动检查再进入灰度验证。",
			rationale: "来自 Q4 发布方案 V2 复盘候选",
			sourceMatterId: mAlphaShared.id,
			status: "candidate",
			verified: false,
		});

		const mAlphaPrivate = store.createMatter({
			title: "高风险故障应急预案（私密）",
			summary: "仅发起人、受邀成员（Alpha 成员）与组织管理员可见",
			leadMemberId: "engineering-manager",
			workspaceId: wsAlphaOpen.id,
			orgId: alphaOrg.id,
			createdByUserId: ownerAlpha.id,
			visibility: "private",
			collaboratorIds: [memberAlpha.id],
		});
		const alphaPrivateDoc = await store.spaces.createDocument({
			spaceId: `spc_usr_${ownerAlpha.id}`,
			matterId: mAlphaPrivate.id,
			title: "高风险灰度应急预案",
			content: "# 高风险灰度应急预案\n\n一级告警关闭非核心接口，二级告警切换只读模式。",
			actorId: ownerAlpha.id,
			actorName: ownerAlpha.displayName,
		});
		store.appendMessage({
			matterId: mAlphaPrivate.id,
			channel: "user",
			senderType: "member",
			senderId: "engineering-manager",
			senderName: "Engineering Manager",
			content: "已归档私密交付成果《高风险灰度应急预案》。",
			metadata: { spaceDocuments: [alphaPrivateDoc] },
		});

		const mAlphaSecret = store.createMatter({
			title: "核心密钥轮换与审计清单",
			summary: "绑定受限仓库 Alpha Secret，非授权成员与访客不可见",
			leadMemberId: "engineering-manager",
			workspaceId: wsAlphaSecret.id,
			orgId: alphaOrg.id,
			createdByUserId: ownerAlpha.id,
			visibility: "org",
		});
		await store.spaces.createDocument({
			spaceId: `spc_ws_${wsAlphaSecret.id}`,
			matterId: mAlphaSecret.id,
			title: "核心密钥轮换与审计清单",
			content: "# 核心密钥轮换与审计清单\n\n每 90 天双密钥平滑切换，核查仓库访问权限。",
			actorId: ownerAlpha.id,
			actorName: ownerAlpha.displayName,
		});
		store.addMemory({
			memberId: "engineering-manager",
			scope: "project_private",
			category: "domain_constraint",
			workspaceId: wsAlphaSecret.id,
			content: "Alpha Secret 仓库任何配置变更须采用双密钥滚动过渡，禁止原地覆盖。",
			rationale: "受限仓库专属约束",
			sourceMatterId: mAlphaSecret.id,
			status: "verified",
			verified: true,
		});

		const mBetaShared = store.createMatter({
			title: "Beta 开放平台接口规范",
			summary: "Beta Labs 团队交付示例（验证跨组织成果筛选）",
			leadMemberId: "engineering-manager",
			workspaceId: wsBetaOpen.id,
			orgId: betaOrg.id,
			createdByUserId: ownerBeta.id,
			visibility: "org",
		});
		const betaDocumentV1 = await store.spaces.createDocument({
			spaceId: `spc_ws_${wsBetaOpen.id}`,
			matterId: mBetaShared.id,
			title: "Beta 开放平台接口规范",
			content: "# Beta 开放平台接口规范（V1）\n\n定义认证 Header 与统一错误信封。",
			actorId: ownerBeta.id,
			actorName: ownerBeta.displayName,
		});
		const betaDocumentV2 = await store.spaces.updateDocument(betaDocumentV1.id, {
			revision: betaDocumentV1.revision,
			title: betaDocumentV1.title,
			content: "# Beta 开放平台接口规范（V2）\n\n限流返回 HTTP 429 与 Retry-After，Webhook 按指数退避重试。",
			actorId: ownerBeta.id,
			actorName: ownerBeta.displayName,
		});
		store.appendMessage({
			matterId: mBetaShared.id,
			channel: "user",
			senderType: "member",
			senderId: "engineering-manager",
			senderName: "Engineering Manager",
			content: "已发布《Beta 开放平台接口规范》V2。",
			metadata: { spaceDocuments: [betaDocumentV2] },
		});

		const { rawToken: inviteToken } = store.createOrgInvite({
			orgId: alphaOrg.id,
			orgRole: "org_member",
			createdByUserId: ownerAlpha.id,
			maxUses: 50,
		});

		return {
			seeded: true,
			sandboxRoot,
			dbPath,
			workspacesRoot,
			password,
			inviteToken,
			organizations: [alphaOrg.name, betaOrg.name],
			documentCount: store.spaces.listDocuments({}).length,
			accounts: [
				{ email: "admin@sandbox.local", role: "super_admin", note: "平台超级管理员（#/admin 有 1 条待审核用户）" },
				{
					email: "owner@alpha.local",
					role: "org_owner (Alpha) + org_member (Beta)",
					note: "可见全部 4 组跨组织成果并切换范围/复盘",
				},
				{
					email: "admin@alpha.local",
					role: "org_admin (Alpha)",
					note: "可查看并管理 Alpha 组织及私密/受限成果与经验",
				},
				{
					email: "member@alpha.local",
					role: "org_member (Alpha + 受邀私密/受限)",
					note: "可见 Alpha 全部 3 项成果（含受邀私密/受限）",
				},
				{
					email: "peer@alpha.local",
					role: "org_member (Alpha)",
					note: "仅见 Alpha 公开共享成果（屏蔽私密/受限与 Beta）",
				},
				{
					email: "viewer@alpha.local",
					role: "org_viewer (Alpha)",
					note: "只读模式：仅见 Alpha 公开共享成果，无编辑/验收/范围改动按钮",
				},
				{ email: "owner@beta.local", role: "org_owner (Beta)", note: "仅见 Beta Labs 成果" },
			],
		};
	} finally {
		db.close();
	}
}

function printSandboxBanner({ baseUrl, summary, cleanupOnExit }) {
	const lines = [
		"",
		"============================================================",
		"  Personal Agent · 团队版独立验证沙盒已就绪 (不触碰 .data/)",
		"============================================================",
		`  首页地址     : ${baseUrl}/#/deliverables`,
		`  管理后台     : ${baseUrl}/#/admin`,
		summary.inviteToken ? `  组织邀请链接 : ${baseUrl}/?invite=${summary.inviteToken}` : null,
		`  沙盒目录     : ${summary.sandboxRoot} (${cleanupOnExit ? "退出自动清理" : "已保留"})`,
		`  统一登录密码 : ${summary.password}`,
		`  已预置资料数 : ${summary.documentCount} 条（覆盖 Alpha Studio / Beta Labs、Git 版本、共享/私密/受限、评价与候选经验）`,
		"",
		"  可直接登录的预设账号:",
		...summary.accounts.map(
			(acc) =>
				`    - ${acc.email.padEnd(20)} | ${(acc.role ?? acc.platformRole).padEnd(36)} | ${acc.note ?? acc.status}`,
		),
		"",
		"  按 Ctrl+C 停止沙盒服务。",
		"============================================================",
	].filter((line) => line !== null);
	console.log(lines.join("\n"));
}

async function runSandboxCli() {
	const opts = parseSandboxArgs(process.argv.slice(2));
	if (opts.help) {
		printUsage();
		return;
	}

	const createdTempDir = !opts.dir;
	const sandboxRoot = opts.dir ?? (await mkdtemp(join(tmpdir(), "personal-agent-team-sandbox-")));
	await mkdir(sandboxRoot, { recursive: true });
	const cleanupOnExit = createdTempDir && !opts.keep && !opts.seedOnly;

	const summary = await seedTeamSandbox({ sandboxRoot, password: opts.password });
	if (opts.seedOnly) {
		console.log(JSON.stringify(summary, null, 2));
		return;
	}

	const webEntry = resolve(ROOT_DIR, "web/dist/index.html");
	if (!existsSync(webEntry)) {
		console.warn(
			"[team-sandbox] web/dist/index.html not found; run via `npm run start:team:sandbox` or `npm run build:web` to serve web UI.",
		);
	}

	const sessionDir = join(sandboxRoot, "pi-sessions");
	await mkdir(sessionDir, { recursive: true });

	const child = spawn(process.execPath, [resolve(ROOT_DIR, "src/server/main.ts")], {
		cwd: ROOT_DIR,
		env: {
			...process.env,
			PA_REQUIRE_AUTH: "1",
			PA_HOST: opts.host,
			PORT: String(opts.port),
			PA_DB_PATH: summary.dbPath,
			PA_WORKSPACES_ROOT: summary.workspacesRoot,
			PA_SESSION_DIR: sessionDir,
		},
		stdio: ["ignore", "pipe", "pipe", "ipc"],
	});

	let bannerPrinted = false;
	const localHost = opts.host === "0.0.0.0" || opts.host === "::" ? "127.0.0.1" : opts.host;
	const baseUrl = `http://${localHost}:${opts.port}`;

	child.stdout.on("data", (chunk) => {
		const text = chunk.toString("utf8");
		process.stdout.write(text);
		if (!bannerPrinted && text.includes("workbench listening")) {
			bannerPrinted = true;
			printSandboxBanner({ baseUrl, summary, cleanupOnExit });
		}
	});
	child.stderr.on("data", (chunk) => {
		process.stderr.write(chunk);
	});

	let stopping = false;
	const stopChild = () => {
		if (stopping) return;
		stopping = true;
		if (child.exitCode === null) {
			if (process.platform === "win32" && child.connected) {
				child.send("shutdown");
			} else {
				child.kill("SIGTERM");
			}
		}
	};

	const onSigInt = () => stopChild();
	const onSigTerm = () => stopChild();
	const onIpcMessage = (msg) => {
		if (msg === "shutdown") stopChild();
	};
	process.once("SIGINT", onSigInt);
	process.once("SIGTERM", onSigTerm);
	if (typeof process.send === "function") {
		process.on("message", onIpcMessage);
	}

	try {
		const exitCode = await new Promise((resolveExit, rejectExit) => {
			child.once("error", rejectExit);
			child.once("exit", (code) => resolveExit(code ?? 0));
		});
		if (exitCode !== 0 && !stopping) {
			process.exitCode = exitCode;
		}
	} finally {
		process.off("SIGINT", onSigInt);
		process.off("SIGTERM", onSigTerm);
		if (typeof process.send === "function") {
			process.off("message", onIpcMessage);
			if (process.connected) process.disconnect();
		}
		if (cleanupOnExit) {
			await rm(sandboxRoot, { recursive: true, force: true });
		}
	}
}

const isMain = Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	runSandboxCli().catch((err) => {
		console.error("Failed to start Team Edition sandbox:", err);
		process.exitCode = 1;
	});
}
