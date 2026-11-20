import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { TeamOrchestrator } from "../src/orchestrator/team-orchestrator.ts";
import {
	loadRoleTemplatesFromDir,
	parseRoleTemplateMarkdown,
	serializeRoleTemplateMarkdown,
} from "../src/roles/template-loader.ts";
import type { ModelSelection, PiModelCatalog } from "../src/rpc/model-selection.ts";
import type { ThinkingLevel } from "../src/rpc/types.ts";
import { createPersonalAgentServer } from "../src/server/app.ts";
import { DialogBroker } from "../src/server/dialog-broker.ts";
import { PreviewManager } from "../src/server/preview-manager.ts";
import { openPersonalAgentDatabase } from "../src/storage/database.ts";
import { PersonalAgentStore } from "../src/storage/repositories.ts";
import { invokeTool, reportReady } from "./worker-helpers.ts";

const piDefault = { provider: "opencode-go", model: "deepseek-v4.1-flash", thinkingLevel: "high" } as const;
const platformModel = { provider: "test-provider", model: "platform", thinkingLevel: "low" } as const;
const orgModel = { provider: "test-provider", model: "org-lead", thinkingLevel: "high" } as const;
const matterModel = { provider: "test-provider", model: "matter-lead", thinkingLevel: "low" } as const;
const observerModel = { provider: "test-provider", model: "org-qa", thinkingLevel: "high" } as const;
const catalog: PiModelCatalog = {
	defaultModel: piDefault,
	models: [piDefault, platformModel, orgModel, matterModel, observerModel].map(({ provider, model }) => ({
		provider,
		model,
		name: model,
		thinkingLevels: ["low", "high"],
	})),
};

test("shared role definitions accept legacy fields and omit execution settings on export", async () => {
	const raw = await readFile(resolve("roles/engineering-manager.md"), "utf8");
	assert.doesNotMatch(raw, /^(defaultProvider|defaultModel|thinkingLevel):/m);
	const legacy = raw.replace(/^---\n/, "---\ndefaultProvider: old\ndefaultModel: custom\nthinkingLevel: high\n");
	const modern = parseRoleTemplateMarkdown(raw);
	assert.deepEqual(parseRoleTemplateMarkdown(legacy), modern);
	assert.doesNotMatch(serializeRoleTemplateMarkdown(modern), /^(defaultProvider|defaultModel|thinkingLevel):/m);
});

test("Pi defaults, platform, organization and matter model settings resolve in order on the same Pi session", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pa-model-selection-"));
	const db = openPersonalAgentDatabase(join(root, "state.db"));
	const store = new PersonalAgentStore(db);
	const organization = store.ensureDefaultOrganization();
	const templates = await loadRoleTemplatesFromDir(resolve("roles"));
	const executions: Array<{ member: string | undefined; selection: ModelSelection; sessionId: string }> = [];
	const sessions = new Map<string, ModelSelection>();
	const orchestrator = new TeamOrchestrator({
		store,
		templates,
		defaultCwd: root,
		readPiModels: async (selection) => ({
			...catalog,
			defaultModel: selection ? { ...selection, thinkingLevel: "high" } : piDefault,
		}),
		workerFactory(options) {
			const sessionId = options.sessionFile ? basename(options.sessionFile) : randomUUID();
			const sessionFile = options.sessionFile ?? join(root, sessionId);
			let selection = sessions.get(sessionId) ?? piDefault;
			return {
				async start() {
					if (!options.sessionFile)
						await writeFile(
							sessionFile,
							`${JSON.stringify({ type: "session", id: sessionId, cwd: options.cwd })}\n`,
						);
					await reportReady(options);
				},
				async stop() {},
				async getState() {
					return {
						sessionFile,
						sessionId,
						model: { provider: selection.provider, id: selection.model },
						thinkingLevel: selection.thinkingLevel,
					};
				},
				async setModel(provider, model) {
					selection = { provider, model };
					return { provider, id: model };
				},
				async getAvailableThinkingLevels(): Promise<ThinkingLevel[]> {
					return ["low", "high"];
				},
				async setThinkingLevel(thinkingLevel) {
					selection = { ...selection, thinkingLevel };
				},
				onNotice: () => () => {},
				setDialogHandler() {},
				async runPromptAndWait(prompt) {
					executions.push({ member: options.env?.PA_MEMBER_ID, selection, sessionId });
					sessions.set(sessionId, selection);
					if (prompt === "ask-qa")
						await invokeTool(options, "delegate_to_member", { memberId: "qa-manager", task: "review-model" });
					return {
						disposition: "started",
						aborted: false,
						assistantText: "done",
						assistantMessages: [],
						toolExecutions: [],
						notices: [],
						dialogs: [],
						events: [],
					};
				},
			};
		},
	});
	const { server } = createPersonalAgentServer({
		store,
		orchestrator,
		templates,
		dialogBroker: new DialogBroker(),
		previewManager: new PreviewManager(),
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	t.after(async () => {
		await orchestrator.shutdown();
		server.closeAllConnections();
		await new Promise<void>((done) => server.close(() => done()));
		db.close();
		await rm(root, { recursive: true, force: true });
	});
	const request = (path: string, method = "GET", body?: unknown) =>
		fetch(`http://127.0.0.1:${address.port}${path}`, {
			method,
			headers: { "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	const create = {
		orgId: organization.id,
		preferredMemberId: "engineering-manager",
		aiMemberIds: ["engineering-manager", "qa-manager"],
		consultMemberIds: ["qa-manager"],
		prompt: "start",
	};

	const available = (await (await request("/api/models")).json()) as PiModelCatalog & {
		platformDefault: ModelSelection | null;
	};
	assert.deepEqual(available.defaultModel, piDefault);
	assert.equal(available.platformDefault, null);
	const alternateDefault = await (await request("/api/models?provider=test-provider&model=matter-lead")).json();
	assert.deepEqual(alternateDefault, { defaultModel: { ...matterModel, thinkingLevel: "high" } });
	assert.equal(
		(await request("/api/matters", "POST", { ...create, modelSelection: { ...matterModel, thinkingLevel: "max" } }))
			.status,
		400,
	);
	const created = await request("/api/matters", "POST", create);
	assert.equal(created.status, 202);
	const { matter } = (await created.json()) as { matter: { id: string } };
	await waitUntil(() => !orchestrator.isMatterRunning(matter.id));
	assert.deepEqual(executions[0]?.selection, piDefault);

	assert.equal((await request("/api/admin/settings", "PATCH", { defaultModelSelection: platformModel })).status, 200);
	assert.deepEqual(store.getPlatformSettings().defaultModelSelection, platformModel);
	const orgPath = `/api/organizations/${organization.id}/ai-roles`;
	const setOrg = (lead: ModelSelection | null) =>
		request(orgPath, "PUT", {
			roles: [
				{ memberId: "engineering-manager", enabled: true, isPrimaryContact: true, modelSelection: lead },
				{ memberId: "qa-manager", enabled: true, modelSelection: observerModel },
			],
		});
	assert.equal((await setOrg(orgModel)).status, 200);
	const matterPath = `/api/matters/${matter.id}`;
	const setMatterModel = (modelSelection: ModelSelection | null) => request(matterPath, "PATCH", { modelSelection });
	assert.equal((await setMatterModel(matterModel)).status, 200);
	assert.deepEqual(store.getMatter(matter.id)?.modelSelection, matterModel);
	const turn = async (prompt: string) => {
		assert.equal((await request(`${matterPath}/messages`, "POST", { prompt })).status, 202);
		await waitUntil(() => !orchestrator.isMatterRunning(matter.id));
	};
	await turn("ask-qa");
	assert.deepEqual(executions[1]?.selection, matterModel);
	assert.deepEqual(executions[2]?.selection, observerModel);
	assert.equal(executions[2]?.member, "qa-manager");

	assert.equal((await setMatterModel(null)).status, 200);
	await turn("organization");
	assert.deepEqual(executions[3]?.selection, orgModel);
	assert.equal((await setOrg(null)).status, 200);
	await turn("platform");
	assert.deepEqual(executions[4]?.selection, platformModel);
	assert.equal((await request("/api/admin/settings", "PATCH", { defaultModelSelection: null })).status, 200);
	await turn("Pi again");
	assert.deepEqual(executions[5]?.selection, piDefault);
	assert.equal(
		new Set(executions.filter((item) => item.member === "engineering-manager").map(({ sessionId }) => sessionId))
			.size,
		1,
	);

	const explicit = await request("/api/matters", "POST", { ...create, modelSelection: matterModel });
	assert.equal(explicit.status, 202);
	const { matter: second } = (await explicit.json()) as { matter: { id: string; modelSelection: unknown } };
	await waitUntil(() => !orchestrator.isMatterRunning(second.id));
	assert.deepEqual(second.modelSelection, matterModel);
	assert.deepEqual(executions[6]?.selection, matterModel);
});

async function waitUntil(condition: () => boolean) {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail("Matter turn did not settle");
}

test("upgrading a legacy store preserves organization model overrides and leaves old matters inheriting defaults", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pa-model-upgrade-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "old.db");
	const oldDb = openPersonalAgentDatabase(path);
	try {
		const store = new PersonalAgentStore(oldDb);
		store.upsertMember({
			id: "legacy",
			templateId: "legacy",
			displayName: "Legacy Role",
			roleTitle: "Legacy Role",
			isPrimaryContact: true,
			provider: "legacy-provider",
			model: "legacy-model",
			thinkingLevel: "high",
			keywords: [],
		});
		const org = store.ensureDefaultOrganization();
		store.setOrgAiRolesBatch(org.id, [
			{ memberId: "legacy", enabled: true, isPrimaryContact: true, thinkingLevelOverride: "low" },
		]);
		store.createMatter({ id: "old-matter", title: "Old matter", orgId: org.id, leadMemberId: "legacy" });
		oldDb.exec("ALTER TABLE matters DROP COLUMN model_selection_json; PRAGMA user_version = 2");
	} finally {
		oldDb.close();
	}
	const upgraded = openPersonalAgentDatabase(path);
	try {
		const store = new PersonalAgentStore(upgraded);
		const oldMatter = store.getMatter("old-matter");
		assert.equal(oldMatter?.modelSelection, null);
		assert.equal(oldMatter?.leadMemberId, "legacy");
		assert.ok(oldMatter.orgId);
		const [role] = store.listOrgAiRoleConfigs(oldMatter.orgId);
		assert.equal(role?.providerOverride, "legacy-provider");
		assert.equal(role.modelOverride, "legacy-model");
		assert.equal(role.thinkingLevelOverride, "low");
		assert.equal(role.isPrimaryContact, true);
	} finally {
		upgraded.close();
	}
});
