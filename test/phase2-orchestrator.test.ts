import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
	defaultMemberGitName,
	loadRoleTemplatesFromDir,
	openPersonalAgentDatabase,
	PersonalAgentStore,
	type PiRpcWorkerOptions,
	type PromptRunResult,
	parseRoleTemplateMarkdown,
	type RpcExtensionUIDialogRequest,
	type RpcExtensionUIResponsePayload,
	type RpcWorkerLike,
	serializeRoleTemplateMarkdown,
	TeamOrchestrator,
} from "../src/index.ts";
import { reportReady } from "./worker-helpers.ts";

class FakeRpcWorker implements RpcWorkerLike {
	readonly options: PiRpcWorkerOptions;
	readonly receivedPrompts: string[] = [];
	readonly receivedTimeouts: Array<number | undefined> = [];
	private noticeListeners: Array<(notice: { method: string; [key: string]: unknown }) => void> = [];
	private dialogHandler:
		| ((req: RpcExtensionUIDialogRequest) => Promise<RpcExtensionUIResponsePayload> | RpcExtensionUIResponsePayload)
		| undefined;
	private readonly responder: (
		prompt: string,
		helpers: {
			emitNotice: (notice: { method: string; [key: string]: unknown }) => void;
			askDialog: (req: RpcExtensionUIDialogRequest) => Promise<RpcExtensionUIResponsePayload>;
		},
	) => Promise<string>;

	constructor(
		options: PiRpcWorkerOptions,
		responder: (
			prompt: string,
			helpers: {
				emitNotice: (notice: { method: string; [key: string]: unknown }) => void;
				askDialog: (req: RpcExtensionUIDialogRequest) => Promise<RpcExtensionUIResponsePayload>;
			},
		) => Promise<string>,
	) {
		this.options = options;
		this.responder = responder;
	}

	async start(): Promise<void> {
		await reportReady(this.options);
	}
	async stop(): Promise<void> {}
	async getState(): Promise<{ sessionId: string; sessionFile?: string }> {
		return { sessionId: `fake-session-${this.options.model ?? "default"}` };
	}

	onNotice(listener: (notice: { method: string; [key: string]: unknown }) => void): () => void {
		this.noticeListeners.push(listener);
		return () => {
			this.noticeListeners = this.noticeListeners.filter((l) => l !== listener);
		};
	}

	setDialogHandler(
		handler:
			| ((
					req: RpcExtensionUIDialogRequest,
			  ) => Promise<RpcExtensionUIResponsePayload> | RpcExtensionUIResponsePayload)
			| undefined,
	): void {
		this.dialogHandler = handler;
	}

	async runPromptAndWait(
		message: string,
		runOptions?: { timeoutMs?: number; signal?: AbortSignal },
	): Promise<PromptRunResult> {
		this.receivedPrompts.push(message);
		this.receivedTimeouts.push(runOptions?.timeoutMs);
		const text = await this.responder(message, {
			emitNotice: (notice) => {
				for (const listener of this.noticeListeners) {
					listener(notice);
				}
			},
			askDialog: async (req) => {
				if (!this.dialogHandler) {
					return { cancelled: true };
				}
				return await this.dialogHandler(req);
			},
		});

		return {
			disposition: "started",
			aborted: false,
			assistantText: text,
			assistantMessages: [],
			toolExecutions: [{ toolCallId: "t-1", toolName: "read", args: {}, isError: false }],
			notices: [],
			dialogs: [],
			events: [],
		};
	}
}

test("loads 4 shareable role templates alongside README and serializes without private state", async () => {
	const rolesDir = resolve(process.cwd(), "roles");
	const templates = await loadRoleTemplatesFromDir(rolesDir);
	const ids = templates.map((t) => t.id).sort();

	assert.deepEqual(ids, ["engineering-manager", "marketing-lead", "product-manager", "qa-manager"]);
	const pm = templates.find((t) => t.id === "product-manager")!;
	assert.equal(pm.isPrimaryContact, true);
	assert.equal(pm.shareable, true);
	assert.ok(pm.sections.responsibilitiesAndBoundaries.length > 0);
	assert.ok(pm.sections.deliveryAndVerification.length > 0);

	const roundTripped = serializeRoleTemplateMarkdown(pm);
	assert.match(roundTripped, /id: product-manager/);
	assert.match(roundTripped, /## Responsibilities and Boundaries/);
	assert.equal(pm.name, "Product Manager");
	const legacy = roundTripped
		.replace("## Responsibilities and Boundaries", "## 职责与边界")
		.replace("## Skills and Methods", "## 技能与工作方法")
		.replace("## Tools and Environment", "## 工具与环境依赖")
		.replace("## Collaboration and Communication", "## 协作和沟通约定")
		.replace("## Delivery and Verification", "## 交付与验证方式");
	const parsedLegacy = parseRoleTemplateMarkdown(legacy);
	assert.deepEqual(parsedLegacy.sections, pm.sections);
	assert.equal(serializeRoleTemplateMarkdown(parsedLegacy), legacy);
});

test("isolates project-private memories across workspaces while preserving shared role/company memories", async () => {
	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db);
	const templates = await loadRoleTemplatesFromDir(resolve(process.cwd(), "roles"));
	new TeamOrchestrator({ store, templates });

	const wsA = store.upsertWorkspace({ name: "订单系统", repoPath: "/tmp/repo-orders" });
	const wsB = store.upsertWorkspace({ name: "客户管理", repoPath: "/tmp/repo-crm" });

	store.addMemory({
		memberId: "engineering-manager",
		scope: "role_general",
		content: "改动前先跑 typecheck",
		verified: true,
	});
	store.addMemory({
		memberId: "engineering-manager",
		scope: "company_private",
		workspaceId: wsA.id,
		content: "公司默认采用 Node 22+",
		verified: true,
	});
	store.addMemory({
		memberId: "engineering-manager",
		scope: "project_private",
		workspaceId: wsA.id,
		content: "订单表金额字段为分",
	});
	store.addMemory({
		memberId: "engineering-manager",
		scope: "project_private",
		workspaceId: wsB.id,
		content: "CRM 导出有字段脱敏",
	});

	const forA = store.listRelevantMemories("engineering-manager", wsA.id).map((m) => m.content);
	assert.deepEqual(forA, ["改动前先跑 typecheck", "公司默认采用 Node 22+", "订单表金额字段为分"]);

	const forB = store.listRelevantMemories("engineering-manager", wsB.id).map((m) => m.content);
	assert.deepEqual(forB, ["改动前先跑 typecheck", "CRM 导出有字段脱敏"]);
	db.close();
});

test("routes tasks by role, keeps internal_collab & notices separate, handles waiting_user, and versions deliverables", async () => {
	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db);
	const templates = await loadRoleTemplatesFromDir(resolve(process.cwd(), "roles"));
	const ws = store.upsertWorkspace({ name: "personal-agent", repoPath: "/tmp/personal-agent" });

	const spawnedWorkers: FakeRpcWorker[] = [];
	const seenStatusesDuringDialog: string[] = [];

	const orchestrator = new TeamOrchestrator({
		store,
		templates,
		onDialog: async (ctx) => {
			const during = store.getMatter(ctx.matterId);
			if (during) {
				seenStatusesDuringDialog.push(during.status);
			}
			return { confirmed: true };
		},
		workerFactory: (opts) => {
			const worker = new FakeRpcWorker(opts, async (prompt, helpers) => {
				helpers.emitNotice({ method: "setStatus", statusKey: "phase", statusText: "running" });
				if (prompt.includes("评估") && prompt.includes("架构")) {
					const reply = await helpers.askDialog({
						type: "extension_ui_request",
						id: "dlg-arch",
						method: "confirm",
						title: "确认执行",
						message: "允许读取仓库依赖？",
					});
					return `研发评估完成（confirmed=${"confirmed" in reply ? reply.confirmed : false}）`;
				}
				return "已按内部协作结论整理出 PRD 交付稿";
			});
			spawnedWorkers.push(worker);
			return worker;
		},
	});

	// 1. Route an engineering architecture task to engineering-manager with workspace cwd
	assert.equal(orchestrator.routeMemberForRequest("请研发经理看看").id, "engineering-manager");
	assert.equal(orchestrator.routeMemberForRequest("Ask Engineering Manager to take a look").id, "engineering-manager");
	const engResult = await orchestrator.dispatchMatter({
		title: "评估架构依赖",
		prompt: "帮我评估一下仓库的架构和 SQLite 接口依赖",
		workspaceId: ws.id,
		deliverableTitle: "架构评估报告",
	});

	assert.equal(engResult.assignedMember.id, "engineering-manager");
	assert.equal(spawnedWorkers[0]?.options.cwd, "/tmp/personal-agent");
	assert.match(spawnedWorkers[0]?.options.env?.PA_MEMBER_CONTEXT ?? "", /Use the language of the user's request/);
	assert.match(spawnedWorkers[0]?.options.env?.PA_MEMBER_CONTEXT ?? "", /Turn confirmed goals into working/);
	assert.deepEqual(seenStatusesDuringDialog, ["waiting_user"]);
	assert.equal(engResult.matter.status, "open");
	assert.ok(engResult.deliverable);
	assert.equal(engResult.deliverable.version, 1);
	const exportedPage = store.spacePages.list(engResult.matter.id).find((page) => page.title === "架构评估报告");
	assert.ok(exportedPage);
	assert.equal(store.spacePages.listRevisions(exportedPage.id)[0]?.resultId, engResult.deliverable.id);

	// 2. Internal delegation from PM to QA stays in internal_collab channel, not user channel
	const collab = await orchestrator.delegateToMember({
		matterId: engResult.matter.id,
		fromMemberId: "product-manager",
		toMemberId: "qa-manager",
		question: "请补充该改动对应的验收风险",
	});
	assert.equal(collab.toMember.id, "qa-manager");

	const userMsgs = store.listMessages(engResult.matter.id, "user");
	const collabMsgs = store.listMessages(engResult.matter.id, "internal_collab");
	const noticeMsgs = store.listMessages(engResult.matter.id, "notice");
	assert.equal(userMsgs.length, 2);
	assert.equal(collabMsgs.length, 2);
	assert.equal(noticeMsgs.length, 4);

	// 3. Dispatching a follow-up deliverable with the same title increments version to 2
	const v2Result = await orchestrator.dispatchMatter({
		matterId: engResult.matter.id,
		prompt: "请基于最新需求补充功能范围和验收条件",
		deliverableTitle: "架构评估报告",
	});
	assert.equal(v2Result.assignedMember.id, "engineering-manager");
	assert.ok(v2Result.deliverable);
	assert.equal(v2Result.deliverable.version, 2);

	db.close();
});

test("dispatchMatter defaults to 0ms unlimited Goal-mode turn timeout and honors PA_TURN_TIMEOUT_MS override", async () => {
	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db);
	const templates = await loadRoleTemplatesFromDir(resolve(process.cwd(), "roles"));
	const workers: FakeRpcWorker[] = [];
	const orchestrator = new TeamOrchestrator({
		store,
		templates,
		noSession: true,
		workerFactory: (opts) => {
			const w = new FakeRpcWorker(opts, async () => "ok");
			workers.push(w);
			return w;
		},
	});

	const prevTurnEnv = process.env.PA_TURN_TIMEOUT_MS;
	const prevPromptEnv = process.env.PA_PROMPT_TIMEOUT_MS;
	delete process.env.PA_TURN_TIMEOUT_MS;
	delete process.env.PA_PROMPT_TIMEOUT_MS;
	try {
		await orchestrator.dispatchMatter({ prompt: "默认不设墙钟硬上限验证" });
		assert.equal(workers[0]?.receivedTimeouts[0], 0);

		process.env.PA_TURN_TIMEOUT_MS = "7200000";
		await orchestrator.dispatchMatter({ prompt: "环境变量超时覆盖验证" });
		const envSeen = workers[1]?.receivedTimeouts[0] ?? 0;
		assert.ok(envSeen > 7_190_000 && envSeen <= 7_200_000, `Expected ~7200000ms, got ${envSeen}`);

		process.env.PA_TURN_TIMEOUT_MS = "0";
		await orchestrator.dispatchMatter({ prompt: "显式设为 0 关闭墙钟上限" });
		assert.equal(workers[2]?.receivedTimeouts[0], 0);
	} finally {
		if (prevTurnEnv === undefined) delete process.env.PA_TURN_TIMEOUT_MS;
		else process.env.PA_TURN_TIMEOUT_MS = prevTurnEnv;
		if (prevPromptEnv === undefined) delete process.env.PA_PROMPT_TIMEOUT_MS;
		else process.env.PA_PROMPT_TIMEOUT_MS = prevPromptEnv;
		db.close();
	}
});

test("organization identity, 3-tier memory scope sharing/isolation, and real Git commit attribution per member", async () => {
	const tempRoot = mkdtempSync(join(tmpdir(), "pa-org-git-identity-"));
	const repoA = join(tempRoot, "repo-a");
	const repoB = join(tempRoot, "repo-b");
	const repoC = join(tempRoot, "repo-c");
	for (const repo of [repoA, repoB, repoC]) {
		mkdirSync(repo, { recursive: true });
		execFileSync("git", ["init"], { cwd: repo });
		execFileSync("git", ["config", "user.name", "Real Repo Owner"], { cwd: repo });
		execFileSync("git", ["config", "user.email", "owner@company.com"], { cwd: repo });
	}

	const db = openPersonalAgentDatabase(":memory:");
	try {
		const store = new PersonalAgentStore(db);
		const templates = await loadRoleTemplatesFromDir(resolve(process.cwd(), "roles"));
		const workers: FakeRpcWorker[] = [];
		const orchestrator = new TeamOrchestrator({
			store,
			templates,
			noSession: true,
			workerFactory: (opts) => {
				const w = new FakeRpcWorker(opts, async () => {
					if (opts.env?.PA_MEMBER_ID === "engineering-manager") {
						execFileSync("git", ["commit", "--allow-empty", "-m", "feat: attributed commit"], {
							cwd: opts.cwd,
							env: { ...process.env, ...opts.env },
						});
					}
					return "done";
				});
				workers.push(w);
				return w;
			},
		});

		const orgAcme = store.upsertOrganization({
			id: "org-acme",
			name: "Acme Engineering",
			gitEmailDomain: "acme.dev",
			description: "Core engineering org",
		});
		assert.equal(orgAcme.useRoleGitIdentity, false);
		const orgBeta = store.upsertOrganization({
			id: "org-beta",
			name: "Beta Labs",
			gitEmailDomain: "beta.io",
		});

		const wsA = store.upsertWorkspace({ id: "ws-a", orgId: orgAcme.id, name: "service-a", repoPath: repoA });
		const wsB = store.upsertWorkspace({ id: "ws-b", orgId: orgAcme.id, name: "service-b", repoPath: repoB });
		const wsC = store.upsertWorkspace({ id: "ws-c", name: "standalone-c", repoPath: repoC });

		// Customize member identities:
		// 1) product-manager overrides gitName & identitySummary, keeps default email so org domain (@acme.dev) applies when enabled
		store.updateMemberIdentity("product-manager", {
			gitName: "PM Alice",
			identitySummary: "Owns checkout product metrics across Acme",
		});
		// 2) engineering-manager overrides explicit gitName + custom email (must NOT be overwritten by org domain)
		store.updateMemberIdentity("engineering-manager", {
			gitName: "Eng Bob",
			gitEmail: "bob@custom.org",
			identitySummary: "Leads backend storage",
		});

		// Re-syncing public templates must preserve private customized member identities
		orchestrator.syncRoleTemplates(templates);
		const syncedPm = store.getMember("product-manager")!;
		assert.equal(syncedPm.gitName, "PM Alice");
		assert.equal(syncedPm.gitEmail, "product-manager@team.local");
		assert.equal(syncedPm.identitySummary, "Owns checkout product metrics across Acme");

		// Seed 3-tier memories
		store.addMemory({
			memberId: "product-manager",
			scope: "role_general",
			verified: true,
			content: "GLOBAL_RULE: Always list clear acceptance criteria",
		});
		store.addMemory({
			memberId: "product-manager",
			scope: "company_private",
			orgId: orgAcme.id,
			verified: true,
			content: "ACME_ORG_MEM: All Acme services release on Thursdays",
		});
		store.addMemory({
			memberId: "product-manager",
			scope: "company_private",
			orgId: orgBeta.id,
			verified: true,
			content: "BETA_ORG_MEM: Beta internal rule must never leak to Acme",
		});
		store.addMemory({
			memberId: "product-manager",
			scope: "project_private",
			workspaceId: wsA.id,
			verified: true,
			content: "REPO_A_MEM: repo-a uses Postgres 16",
		});
		store.addMemory({
			memberId: "product-manager",
			scope: "project_private",
			workspaceId: wsB.id,
			verified: true,
			content: "REPO_B_MEM: repo-b uses SQLite",
		});

		// Default behavior (useRoleGitIdentity = false): do NOT inject AI role Git env; commit using repository's own Git user
		await orchestrator.dispatchMatter({
			prompt: "默认仓库身份提交验证",
			preferredMemberId: "engineering-manager",
			workspaceId: wsA.id,
		});
		const defaultWorker = workers[0]!;
		assert.equal(defaultWorker.options.env?.GIT_AUTHOR_NAME, undefined);
		assert.equal(defaultWorker.options.env?.GIT_AUTHOR_EMAIL, undefined);
		assert.equal(defaultWorker.options.env?.GIT_COMMITTER_NAME, undefined);
		assert.equal(defaultWorker.options.env?.GIT_COMMITTER_EMAIL, undefined);
		assert.match(
			defaultWorker.options.env?.PA_TURN_CONTEXT ?? "",
			/Git identity \(repository default\): Real Repo Owner <owner@company\.com>/,
		);
		const defaultGitLog = execFileSync("git", ["log", "-1", "--format=%an|%ae|%cn|%ce"], {
			cwd: repoA,
			encoding: "utf8",
		}).trim();
		assert.equal(defaultGitLog, "Real Repo Owner|owner@company.com|Real Repo Owner|owner@company.com");

		// Enable role Git authorship on orgAcme
		store.updateOrganization(orgAcme.id, { useRoleGitIdentity: true });

		// Dispatch PM in wsA (Acme)
		await orchestrator.dispatchMatter({
			prompt: "分析 service-a 需求",
			preferredMemberId: "product-manager",
			workspaceId: wsA.id,
		});
		const pmWorkerA = workers[1]!;
		assert.equal(pmWorkerA.options.env?.GIT_AUTHOR_NAME, "PM Alice");
		assert.equal(pmWorkerA.options.env?.GIT_AUTHOR_EMAIL, "product-manager@acme.dev");
		assert.equal(pmWorkerA.options.env?.GIT_COMMITTER_NAME, "Real Repo Owner");
		assert.equal(pmWorkerA.options.env?.GIT_COMMITTER_EMAIL, "owner@company.com");
		assert.equal(pmWorkerA.options.env?.PA_ORG_ID, "org-acme");
		assert.equal(pmWorkerA.options.env?.PA_ORG_NAME, "Acme Engineering");

		const ctxA = pmWorkerA.options.env?.PA_TURN_CONTEXT ?? "";
		assert.match(ctxA, /## Role and organization identity/);
		assert.match(ctxA, /Acme Engineering/);
		assert.match(ctxA, /PM Alice <product-manager@acme\.dev>/);
		assert.match(ctxA, /Git committer \(repository user\): Real Repo Owner <owner@company\.com>/);
		assert.match(ctxA, /Owns checkout product metrics across Acme/);
		assert.match(ctxA, /GLOBAL_RULE/);
		assert.match(ctxA, /ACME_ORG_MEM/);
		assert.match(ctxA, /REPO_A_MEM/);
		assert.doesNotMatch(ctxA, /REPO_B_MEM/);
		assert.doesNotMatch(ctxA, /BETA_ORG_MEM/);

		// Dispatch PM in wsB (same Acme org, different repo!)
		await orchestrator.dispatchMatter({
			prompt: "分析 service-b 需求",
			preferredMemberId: "product-manager",
			workspaceId: wsB.id,
		});
		const ctxB = workers[2]?.options.env?.PA_TURN_CONTEXT ?? "";
		assert.match(ctxB, /GLOBAL_RULE/);
		assert.match(ctxB, /ACME_ORG_MEM/);
		assert.match(ctxB, /REPO_B_MEM/);
		assert.doesNotMatch(ctxB, /REPO_A_MEM/);
		assert.doesNotMatch(ctxB, /BETA_ORG_MEM/);

		// Dispatch PM in wsC (standalone workspace without org -> always keeps repo default Git user)
		await orchestrator.dispatchMatter({
			prompt: "分析独立仓库需求",
			preferredMemberId: "product-manager",
			workspaceId: wsC.id,
		});
		const ctxC = workers[3]?.options.env?.PA_TURN_CONTEXT ?? "";
		assert.equal(workers[3]?.options.env?.GIT_AUTHOR_EMAIL, undefined);
		assert.equal(workers[3]?.options.env?.GIT_COMMITTER_EMAIL, undefined);
		assert.match(ctxC, /Git identity \(repository default\): Real Repo Owner <owner@company\.com>/);
		assert.match(ctxC, /GLOBAL_RULE/);
		assert.doesNotMatch(ctxC, /ACME_ORG_MEM/);
		assert.doesNotMatch(ctxC, /BETA_ORG_MEM/);
		assert.doesNotMatch(ctxC, /REPO_A_MEM/);

		// Dispatch engineering-manager in wsA: executes real git commit and proves role Author + real user Committer
		await orchestrator.dispatchMatter({
			prompt: "提交一笔研发变更",
			preferredMemberId: "engineering-manager",
			workspaceId: wsA.id,
		});
		const gitLog = execFileSync("git", ["log", "-1", "--format=%an|%ae|%cn|%ce"], {
			cwd: repoA,
			encoding: "utf8",
		}).trim();
		assert.equal(gitLog, "Eng Bob|bob@custom.org|Real Repo Owner|owner@company.com");

		// Configure per-organization AI role Git override inside orgAcme
		store.setOrgAiRolesBatch(orgAcme.id, [
			{ memberId: "product-manager", enabled: true, isPrimaryContact: true },
			{
				memberId: "engineering-manager",
				enabled: true,
				gitNameOverride: "Acme Eng Bot",
				gitEmailOverride: "eng-bot@acme.dev",
			},
		]);
		await orchestrator.dispatchMatter({
			prompt: "使用组织覆盖的研发 Git 信息提交",
			preferredMemberId: "engineering-manager",
			workspaceId: wsA.id,
		});
		const orgOverrideGitLog = execFileSync("git", ["log", "-1", "--format=%an|%ae|%cn|%ce"], {
			cwd: repoA,
			encoding: "utf8",
		}).trim();
		assert.equal(orgOverrideGitLog, "Acme Eng Bot|eng-bot@acme.dev|Real Repo Owner|owner@company.com");

		// Disabling useRoleGitIdentity reverts commits to the repository directory's own Git user while preserving saved overrides
		store.updateOrganization(orgAcme.id, { useRoleGitIdentity: false });
		await orchestrator.dispatchMatter({
			prompt: "关闭角色 Git 后恢复仓库默认身份提交",
			preferredMemberId: "engineering-manager",
			workspaceId: wsA.id,
		});
		const revertedGitLog = execFileSync("git", ["log", "-1", "--format=%an|%ae|%cn|%ce"], {
			cwd: repoA,
			encoding: "utf8",
		}).trim();
		assert.equal(revertedGitLog, "Real Repo Owner|owner@company.com|Real Repo Owner|owner@company.com");
		assert.equal(
			store.listOrgAiRoleConfigs(orgAcme.id).find((c) => c.memberId === "engineering-manager")?.gitNameOverride,
			"Acme Eng Bot",
		);
	} finally {
		db.close();
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

test("default organization seeding, switching default, and assigning orphan workspaces", () => {
	const db = openPersonalAgentDatabase(":memory:");
	try {
		const store = new PersonalAgentStore(db);
		assert.equal(store.getDefaultOrganization(), null);
		const orphanWs = store.upsertWorkspace({ name: "orphan", repoPath: "/tmp/orphan-ws" });
		assert.equal(orphanWs.orgId, null);

		const defaultOrg = store.ensureDefaultOrganization();
		assert.equal(defaultOrg.isDefault, true);
		assert.equal(store.assignOrphanWorkspacesToDefaultOrganization(), 1);
		assert.equal(store.getWorkspace(orphanWs.id)?.orgId, defaultOrg.id);

		const customOrg = store.upsertOrganization({ name: "civa team", gitEmailDomain: "civa.dev" });
		assert.equal(customOrg.isDefault, false);
		const promoted = store.setDefaultOrganization(customOrg.id);
		assert.equal(promoted.isDefault, true);
		assert.equal(store.getOrganization(defaultOrg.id)?.isDefault, false);
		assert.equal(store.getDefaultOrganization()?.id, customOrg.id);
	} finally {
		db.close();
	}
});

test("openPersonalAgentDatabase upgrades legacy databases without member identity or org columns", () => {
	const tempRoot = mkdtempSync(join(tmpdir(), "pa-legacy-migration-"));
	const dbPath = join(tempRoot, "legacy.sqlite");
	const raw = new DatabaseSync(dbPath);
	raw.exec(`
		CREATE TABLE team_members (
			id TEXT PRIMARY KEY,
			template_id TEXT NOT NULL,
			display_name TEXT NOT NULL,
			role_title TEXT NOT NULL,
			is_primary_contact INTEGER NOT NULL DEFAULT 0,
			provider TEXT NOT NULL,
			model TEXT NOT NULL,
			thinking_level TEXT NOT NULL,
			keywords_json TEXT NOT NULL DEFAULT '[]',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE workspace_links (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			repo_path TEXT NOT NULL UNIQUE,
			org_id TEXT,
			default_branch TEXT NOT NULL DEFAULT 'main',
			description TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL
		);
		CREATE TABLE matters (
			id TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			summary TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'open',
			lead_member_id TEXT,
			workspace_id TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE member_memories (
			id TEXT PRIMARY KEY,
			member_id TEXT NOT NULL,
			scope TEXT NOT NULL,
			workspace_id TEXT,
			content TEXT NOT NULL,
			source_deliverable_id TEXT,
			verified INTEGER NOT NULL DEFAULT 1,
			created_at TEXT NOT NULL
		);
		CREATE TABLE worker_sessions (
			id TEXT PRIMARY KEY,
			member_id TEXT NOT NULL,
			matter_id TEXT,
			workspace_id TEXT,
			pi_session_id TEXT,
			session_file TEXT,
			status TEXT NOT NULL DEFAULT 'active',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE deliverables (
			id TEXT PRIMARY KEY,
			matter_id TEXT NOT NULL,
			member_id TEXT NOT NULL,
			type TEXT NOT NULL,
			title TEXT NOT NULL,
			summary TEXT NOT NULL DEFAULT '',
			content_or_path TEXT NOT NULL,
			service_url TEXT,
			version INTEGER NOT NULL DEFAULT 1,
			feedback TEXT,
			created_at TEXT NOT NULL
		);
		INSERT INTO team_members VALUES (
			'legacy-pm', 'product-manager', 'Legacy PM', 'Product Manager', 1,
			'kimi-coding', 'kimi-for-coding', 'high', '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
		);
		INSERT INTO workspace_links VALUES ('ws-1', 'legacy-repo', '/tmp/legacy-repo', NULL, 'main', '', '2026-01-01T00:00:00Z');
		INSERT INTO member_memories VALUES ('mem-1', 'legacy-pm', 'company_private', 'ws-1', 'Legacy workspace memory', NULL, 1, '2026-01-01T00:00:00Z');
	`);
	raw.close();

	const db = openPersonalAgentDatabase(dbPath);
	try {
		const store = new PersonalAgentStore(db);
		const member = store.getMember("legacy-pm");
		assert.ok(member);
		assert.equal(member.gitName, "Legacy PM");
		assert.equal(member.gitEmail, "legacy-pm@team.local");
		assert.equal(member.identitySummary, "");

		const ws = store.getWorkspace("ws-1");
		assert.ok(ws);
		assert.equal(ws.orgId, null);

		const relevant = store.listRelevantMemories("legacy-pm", "ws-1");
		assert.equal(relevant.length, 1);
		assert.equal(relevant[0]?.orgId, null);
		assert.equal(relevant[0]?.workspaceId, "ws-1");
		assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 9);
		assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
		const fresh = openPersonalAgentDatabase();
		try {
			for (const table of ["workspace_links", "member_memories"]) {
				const keys = (source: DatabaseSync) =>
					source
						.prepare(`PRAGMA foreign_key_list(${table})`)
						.all()
						.map((row) => [row.from, row.table, row.on_delete].join(":"))
						.sort();
				assert.deepEqual(keys(db), keys(fresh));
			}
		} finally {
			fresh.close();
		}
		assert.throws(() => db.prepare("UPDATE workspace_links SET org_id = ?").run("missing-org"), /FOREIGN KEY/);
		assert.throws(
			() => db.prepare("UPDATE member_memories SET source_deliverable_id = ?").run("missing-result"),
			/FOREIGN KEY/,
		);
	} finally {
		db.close();
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

test("default gitName uses English roleTitle/id and preserves explicitly saved Unicode identity", async () => {
	const tempRoot = mkdtempSync(join(tmpdir(), "pa-gitname-en-"));
	const dbPath = join(tempRoot, "team.sqlite");
	const db = openPersonalAgentDatabase(dbPath);
	try {
		const store = new PersonalAgentStore(db);
		const pm = store.upsertMember({
			id: "architect-lead",
			templateId: "architect-lead",
			displayName: "系统架构师",
			roleTitle: "System Architect",
			isPrimaryContact: false,
			provider: "kimi-coding",
			model: "kimi-for-coding",
			thinkingLevel: "high",
			keywords: ["架构"],
		});
		assert.equal(pm.gitName, "System Architect");
		assert.equal(defaultMemberGitName({ id: "sec-ops", displayName: "安全官", roleTitle: "安全负责人" }), "sec-ops");

		store.updateMemberIdentity("architect-lead", { gitName: "系统架构师" });
		// Released databases never recorded a schema version.
		db.exec("PRAGMA user_version = 0");
	} finally {
		db.close();
	}

	const reopened = openPersonalAgentDatabase(dbPath);
	try {
		const store = new PersonalAgentStore(reopened);
		assert.equal(store.getMember("architect-lead")?.gitName, "系统架构师");

		// Workspace-less matter under an explicit org injects org context & company_private memories
		const org = store.upsertOrganization({
			id: "org-test",
			name: "test-org",
			gitEmailDomain: "test-team.local",
		});
		store.addMemory({
			memberId: "architect-lead",
			scope: "company_private",
			orgId: org.id,
			verified: true,
			content: "TEST_ORG_ONLY: Follow test-org RFC format",
		});
		const matter = store.createMatter({
			title: "Org-level design",
			leadMemberId: "architect-lead",
			workspaceId: null,
			orgId: org.id,
		});
		assert.equal(matter.orgId, org.id);

		const templates = await loadRoleTemplatesFromDir(resolve(process.cwd(), "roles"));
		const workers: FakeRpcWorker[] = [];
		const orchestrator = new TeamOrchestrator({
			store,
			templates,
			sessionDir: tempRoot,
			noSession: true,
			defaultCwd: process.cwd(),
			workerFactory: (opts) => {
				const w = new FakeRpcWorker(opts, async () => "done");
				workers.push(w);
				return w;
			},
		});
		await orchestrator.dispatchMatter({
			matterId: matter.id,
			prompt: "Draft architecture plan",
			preferredMemberId: "architect-lead",
		});
		assert.equal(workers[0]?.options.env?.GIT_AUTHOR_NAME, undefined);
		assert.equal(workers[0]?.options.env?.GIT_AUTHOR_EMAIL, undefined);
		assert.equal(workers[0]?.options.env?.PA_ORG_ID, org.id);
		assert.match(workers[0]?.options.env?.PA_TURN_CONTEXT ?? "", /TEST_ORG_ONLY/);

		store.updateOrganization(org.id, { useRoleGitIdentity: true });
		await orchestrator.dispatchMatter({
			matterId: matter.id,
			prompt: "Draft architecture plan with role Git identity",
			preferredMemberId: "architect-lead",
		});
		assert.equal(workers[1]?.options.env?.GIT_AUTHOR_NAME, "系统架构师");
		assert.equal(workers[1]?.options.env?.GIT_AUTHOR_EMAIL, "architect-lead@test-team.local");
	} finally {
		reopened.close();
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

test("TeamOrchestrator preserves multi-human discussion speaker attribution and tracks non-owner collaborators", async () => {
	const tempRoot = mkdtempSync(join(tmpdir(), "pa-collab-orch-"));
	const db = openPersonalAgentDatabase(join(tempRoot, "team.sqlite"));
	try {
		const store = new PersonalAgentStore(db);
		const templates = await loadRoleTemplatesFromDir(resolve(process.cwd(), "roles"));
		const workers: FakeRpcWorker[] = [];
		const orchestrator = new TeamOrchestrator({
			store,
			templates,
			sessionDir: tempRoot,
			noSession: true,
			defaultCwd: tempRoot,
			workerFactory: (opts) => {
				const w = new FakeRpcWorker(opts, async () => "已收到各位成员的讨论，下面是执行方案。");
				workers.push(w);
				return w;
			},
		});

		const lead = store.getMember("product-manager")!;
		const matter = store.createMatter({
			title: "多人协同讨论测试",
			leadMemberId: lead.id,
			workspaceId: null,
		});

		store.appendMessage({
			matterId: matter.id,
			channel: "user",
			senderType: "user",
			senderId: "collab-alice",
			content: "我这边建议先做房间人员展示和聊天隔离，暂不动跨网段鉴权。",
			metadata: {
				mode: "discussion",
				workspaceId: null,
				repoPath: resolve(orchestrator.getDefaultCwd()),
				authorId: "collab-alice",
				authorName: "Alice",
				authorRole: "后端研发",
				permissionRole: "collaborator",
			},
		});

		await orchestrator.dispatchMatter({
			matterId: matter.id,
			prompt: "请基于上面的团队讨论整理拆解方案",
			preferredMemberId: lead.id,
			author: {
				collaboratorId: "collab-bob",
				name: "Bob",
				roleTitle: "产品测试",
				permissionRole: "collaborator",
			},
		});

		assert.equal(workers.length, 1);
		assert.match(
			workers[0]?.receivedPrompts[0] ?? "",
			/\[Team discussion\] Alice \(后端研发\): 我这边建议先做房间人员展示/,
		);
		const updatedMatter = store.getMatter(matter.id);
		assert.ok(updatedMatter?.collaboratorIds.includes("collab-bob"));
	} finally {
		db.close();
		rmSync(tempRoot, { recursive: true, force: true });
	}
});

test("TeamOrchestrator injects target workspace top-level entries, scope rules, and PA_TARGET_WORKSPACE_ROOT isolation", async () => {
	const tempRoot = mkdtempSync(join(tmpdir(), "pa-ws-scope-"));
	const targetRepo = join(tempRoot, ".data", "team-workspaces", "civa-team", "hello-rust");
	mkdirSync(join(targetRepo, ".git"), { recursive: true });
	mkdirSync(join(targetRepo, "src"), { recursive: true });
	writeFileSync(join(targetRepo, "Cargo.toml"), '[package]\nname = "hello-rust"\n', "utf8");
	writeFileSync(join(targetRepo, "README.md"), "# hello-rust\n", "utf8");
	const db = openPersonalAgentDatabase(join(tempRoot, "team.sqlite"));
	try {
		const store = new PersonalAgentStore(db);
		const org = store.upsertOrganization({ name: "civa-team" });
		const ws = store.upsertWorkspace({
			orgId: org.id,
			name: "hello-rust",
			repoPath: targetRepo,
			sourceType: "cloned",
		});
		const templates = await loadRoleTemplatesFromDir(resolve(process.cwd(), "roles"));
		const workers: FakeRpcWorker[] = [];
		const orchestrator = new TeamOrchestrator({
			store,
			templates,
			sessionDir: tempRoot,
			noSession: true,
			defaultCwd: tempRoot,
			workerFactory: (opts) => {
				const w = new FakeRpcWorker(opts, async () => "ok");
				workers.push(w);
				return w;
			},
		});

		await orchestrator.dispatchMatter({
			prompt: "简单介绍当前项目",
			workspaceId: ws.id,
			preferredMemberId: "product-manager",
			observersEnabled: false,
		});
		const wsEnv = workers[0]?.options.env;
		assert.equal(wsEnv?.PA_TARGET_WORKSPACE_ROOT, resolve(targetRepo));
		assert.match(wsEnv?.PA_MEMBER_CONTEXT ?? "", /Treat "hello-rust"/);
		assert.match(wsEnv?.PA_TURN_CONTEXT ?? "", /Top-level entries: Cargo\.toml, README\.md, src\//);
		assert.doesNotMatch(wsEnv?.PA_TURN_CONTEXT ?? "", /\.git/);

		await orchestrator.dispatchMatter({
			prompt: "一般讨论任务",
			orgId: org.id,
			preferredMemberId: "product-manager",
			observersEnabled: false,
		});
		assert.equal(workers[1]?.options.env?.PA_TARGET_WORKSPACE_ROOT, "__none__");
	} finally {
		db.close();
		rmSync(tempRoot, { recursive: true, force: true });
	}
});
