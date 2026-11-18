import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
	createPersonalAgentServer,
	DialogBroker,
	loadRoleTemplatesFromDir,
	openPersonalAgentDatabase,
	PersonalAgentStore,
	PreviewManager,
	type RpcWorkerLike,
	TeamOrchestrator,
} from "../src/index.ts";
import {
	countMemberMemoriesByScope,
	formatMemberGitIdentity,
	MEMORY_SCOPE_LABELS,
	MEMORY_SCOPE_SHORT_LABELS,
} from "../web/src/utils.ts";
import { reportReady } from "./worker-helpers.ts";

test("organization CRUD, workspace binding, member identity updates & sanitized export, and frontend identity helpers", async () => {
	assert.equal(MEMORY_SCOPE_SHORT_LABELS.role_general, "岗位通用");
	assert.equal(MEMORY_SCOPE_SHORT_LABELS.company_private, "组织记忆");
	assert.equal(MEMORY_SCOPE_SHORT_LABELS.project_private, "仓库记忆");
	assert.match(MEMORY_SCOPE_LABELS.company_private ?? "", /组织/);

	const gitDefault = formatMemberGitIdentity(
		{ id: "pm", displayName: "产品经理", roleTitle: "Product Manager", gitName: "", gitEmail: "pm@team.local" },
		{ gitEmailDomain: "@acme.dev" },
	);
	assert.equal(gitDefault.formatted, "Product Manager <pm@acme.dev>");

	const gitCustom = formatMemberGitIdentity(
		{ id: "pm", displayName: "PM", gitName: "Alice", gitEmail: "alice@custom.io" },
		{ gitEmailDomain: "acme.dev" },
	);
	assert.equal(gitCustom.formatted, "Alice <alice@custom.io>");

	const scopeCounts = countMemberMemoriesByScope([
		{
			id: "m1",
			memberId: "pm",
			scope: "role_general",
			category: "general",
			orgId: null,
			workspaceId: null,
			content: "a",
			status: "verified",
			verified: true,
			appliedCount: 0,
			positiveCount: 0,
			negativeCount: 0,
			createdAt: "2026-11-15T00:00:00Z",
		},
		{
			id: "m2",
			memberId: "pm",
			scope: "company_private",
			category: "collaboration",
			orgId: "org1",
			workspaceId: null,
			content: "b",
			status: "candidate",
			verified: false,
			appliedCount: 0,
			positiveCount: 0,
			negativeCount: 0,
			createdAt: "2026-11-15T00:00:00Z",
		},
		{
			id: "m3",
			memberId: "pm",
			scope: "project_private",
			category: "domain_constraint",
			orgId: null,
			workspaceId: "ws1",
			content: "c",
			status: "verified",
			verified: true,
			appliedCount: 0,
			positiveCount: 0,
			negativeCount: 0,
			createdAt: "2026-11-15T00:00:00Z",
		},
		{
			id: "m4",
			memberId: "pm",
			scope: "project_private",
			category: "general",
			orgId: null,
			workspaceId: "ws1",
			content: "ignored",
			status: "rejected",
			verified: false,
			appliedCount: 0,
			positiveCount: 0,
			negativeCount: 0,
			createdAt: "2026-11-15T00:00:00Z",
		},
	]);
	assert.deepEqual(scopeCounts, {
		totalActive: 3,
		roleGeneral: 1,
		companyPrivate: 1,
		projectPrivate: 1,
		pendingReview: 1,
	});

	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db);
	const templates = await loadRoleTemplatesFromDir(resolve(process.cwd(), "roles"));
	const tempDir = mkdtempSync(join(tmpdir(), "pa-server-org-"));
	const dialogBroker = new DialogBroker();
	const previewManager = new PreviewManager();
	const orchestrator = new TeamOrchestrator({
		store,
		templates,
		noSession: true,
		workerFactory: (opts) =>
			({
				options: opts,
				onSessionEvent: () => () => {},
				onNotice: () => () => {},
				setDialogHandler: () => {},
				start: async () => {},
				stop: async () => {},
				getState: async () => ({ sessionId: "s", isStreaming: false }),
				runPromptAndWait: async () => ({
					disposition: "started",
					aborted: false,
					assistantText: "ok",
					assistantMessages: [],
					toolExecutions: [],
					notices: [],
					dialogs: [],
					events: [],
				}),
			}) as unknown as RpcWorkerLike,
	});

	const { server } = createPersonalAgentServer({
		store,
		orchestrator,
		templates,
		dialogBroker,
		previewManager,
		uploadsDir: join(tempDir, "uploads"),
	});
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const baseUrl = `http://127.0.0.1:${address.port}`;

	try {
		const orgCreate = await fetch(`${baseUrl}/api/organizations`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				name: "Acme Corp",
				gitEmailDomain: "@acme.dev",
				description: "Engineering org",
			}),
		});
		assert.equal(orgCreate.status, 201);
		const { organization } = (await orgCreate.json()) as {
			organization: { id: string; name: string; gitEmailDomain: string; useRoleGitIdentity?: boolean };
		};
		assert.equal(organization.gitEmailDomain, "acme.dev");
		assert.equal(organization.useRoleGitIdentity, false);

		const orgPatch = await fetch(`${baseUrl}/api/organizations/${organization.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ description: "Updated org description", useRoleGitIdentity: true }),
		});
		assert.equal(orgPatch.status, 200);
		const patchedOrgPayload = (await orgPatch.json()) as { organization: { useRoleGitIdentity?: boolean } };
		assert.equal(patchedOrgPayload.organization.useRoleGitIdentity, true);

		const aiRolesPut = await fetch(`${baseUrl}/api/organizations/${organization.id}/ai-roles`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				useRoleGitIdentity: false,
				roles: [
					{
						memberId: "product-manager",
						enabled: true,
						isPrimaryContact: true,
						gitNameOverride: "Acme PM Lead",
						gitEmailOverride: "pm-lead@acme.dev",
					},
				],
			}),
		});
		assert.equal(aiRolesPut.status, 200);
		const aiRolesPayload = (await aiRolesPut.json()) as {
			organization?: { useRoleGitIdentity?: boolean };
			configs: Array<{ memberId: string; gitNameOverride?: string | null; gitEmailOverride?: string | null }>;
			effectiveMembers: Array<{ id: string; gitName: string; gitEmail: string }>;
		};
		assert.equal(aiRolesPayload.organization?.useRoleGitIdentity, false);
		assert.equal(aiRolesPayload.configs[0]?.gitNameOverride, "Acme PM Lead");
		assert.equal(aiRolesPayload.configs[0]?.gitEmailOverride, "pm-lead@acme.dev");
		assert.equal(aiRolesPayload.effectiveMembers[0]?.gitName, "Acme PM Lead");
		assert.equal(aiRolesPayload.effectiveMembers[0]?.gitEmail, "pm-lead@acme.dev");

		const wsCreate = await fetch(`${baseUrl}/api/workspaces`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				orgId: organization.id,
				name: "app-one",
				repoPath: join(tempDir, "app-one"),
			}),
		});
		assert.equal(wsCreate.status, 201);
		const { workspace } = (await wsCreate.json()) as { workspace: { id: string; orgId: string | null } };
		assert.equal(workspace.orgId, organization.id);

		const badWsPatch = await fetch(`${baseUrl}/api/workspaces/${workspace.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ orgId: "non-existent-org" }),
		});
		assert.equal(badWsPatch.status, 404);

		const memberPatch = await fetch(`${baseUrl}/api/members/product-manager`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				gitName: "PM Secret Name",
				gitEmail: "secret-pm@acme.dev",
				identitySummary: "Private internal company background",
			}),
		});
		assert.equal(memberPatch.status, 200);
		const patchedMember = (await memberPatch.json()) as {
			member: { gitName: string; gitEmail: string; identitySummary: string };
		};
		assert.equal(patchedMember.member.gitName, "PM Secret Name");
		assert.equal(patchedMember.member.gitEmail, "secret-pm@acme.dev");
		assert.equal(patchedMember.member.identitySummary, "Private internal company background");

		// Public role export MUST NOT leak private gitEmail, identitySummary, or org name
		const exportRes = await fetch(`${baseUrl}/api/members/product-manager/export`);
		assert.equal(exportRes.status, 200);
		const exported = (await exportRes.json()) as { markdown: string };
		assert.doesNotMatch(exported.markdown, /secret-pm@acme\.dev/);
		assert.doesNotMatch(exported.markdown, /Private internal company background/);
		assert.doesNotMatch(exported.markdown, /Acme Corp/);

		// Memory CRUD with orgId
		const memRes = await fetch(`${baseUrl}/api/memories`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				memberId: "product-manager",
				scope: "company_private",
				orgId: organization.id,
				content: "All Acme PRs require tests",
			}),
		});
		assert.equal(memRes.status, 201);
		const { memory } = (await memRes.json()) as {
			memory: { id: string; orgId: string | null; workspaceId: string | null };
		};
		assert.equal(memory.orgId, organization.id);
		assert.equal(memory.workspaceId, null);

		const memSwitchRes = await fetch(`${baseUrl}/api/memories/${memory.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				scope: "project_private",
				workspaceId: workspace.id,
			}),
		});
		assert.equal(memSwitchRes.status, 200);
		const switched = (await memSwitchRes.json()) as {
			memory: { scope: string; orgId: string | null; workspaceId: string | null };
		};
		assert.equal(switched.memory.scope, "project_private");
		assert.equal(switched.memory.orgId, null);
		assert.equal(switched.memory.workspaceId, workspace.id);

		const bootstrapRes = await fetch(`${baseUrl}/api/bootstrap`);
		const bootstrapBody = (await bootstrapRes.json()) as {
			organizations: Array<{ id: string; isDefault?: boolean }>;
		};
		assert.equal(bootstrapBody.organizations.length, 1);
		assert.equal(bootstrapBody.organizations[0]?.id, organization.id);
		assert.equal(bootstrapBody.organizations[0]?.isDefault, true);

		// Creating another org & promoting it as default, then auto-assigning a new workspace with omitted orgId
		const secondOrgRes = await fetch(`${baseUrl}/api/organizations`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "Default Org Two" }),
		});
		assert.equal(secondOrgRes.status, 201);
		const { organization: secondOrg } = (await secondOrgRes.json()) as {
			organization: { id: string; isDefault: boolean };
		};
		assert.equal(secondOrg.isDefault, false);

		const setDefaultRes = await fetch(`${baseUrl}/api/organizations/${secondOrg.id}/default`, { method: "POST" });
		assert.equal(setDefaultRes.status, 200);

		const autoWsRes = await fetch(`${baseUrl}/api/workspaces`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "auto-org-ws", repoPath: join(tempDir, "auto-org-ws") }),
		});
		assert.equal(autoWsRes.status, 201);
		const { workspace: autoWs } = (await autoWsRes.json()) as { workspace: { orgId: string | null } };
		assert.equal(autoWs.orgId, secondOrg.id);

		// Explicit orgId: null still creates a standalone workspace
		const standaloneWsRes = await fetch(`${baseUrl}/api/workspaces`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "standalone-ws", repoPath: join(tempDir, "standalone-ws"), orgId: null }),
		});
		assert.equal(standaloneWsRes.status, 201);
		const { workspace: standaloneWs } = (await standaloneWsRes.json()) as { workspace: { orgId: string | null } };
		assert.equal(standaloneWs.orgId, null);

		// Creating & switching organization on a workspace-less matter (e.g., new org with no registered repos yet)
		const createMatterRes = await fetch(`${baseUrl}/api/matters`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: "Plan test-org roadmap", orgId: secondOrg.id }),
		});
		assert.equal(createMatterRes.status, 202);
		const { matter: orgMatter } = (await createMatterRes.json()) as {
			matter: { id: string; orgId: string | null; workspaceId: string | null };
		};
		assert.equal(orgMatter.orgId, secondOrg.id);
		assert.equal(orgMatter.workspaceId, null);

		await orchestrator.abortMatter(orgMatter.id);

		const patchMatterOrgRes = await fetch(`${baseUrl}/api/matters/${orgMatter.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ orgId: organization.id }),
		});
		assert.equal(patchMatterOrgRes.status, 200);
		const patchedOrgMatter = (await patchMatterOrgRes.json()) as {
			matter: { orgId: string | null; workspaceId: string | null };
		};
		assert.equal(patchedOrgMatter.matter.orgId, organization.id);
	} finally {
		await orchestrator.shutdown();
		server.closeAllConnections();
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		db.close();
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("Multi-human restricted collaboration: auth gate, discussion vs ai_request vs dispatch, owner approval, and token redaction", async () => {
	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db);
	const owner = store.ensureOwnerCollaborator("团队所有者");
	const templates = await loadRoleTemplatesFromDir(resolve(process.cwd(), "roles"));
	const tempDir = mkdtempSync(join(tmpdir(), "pa-server-collab-"));
	const dialogBroker = new DialogBroker();
	const previewManager = new PreviewManager();
	const capturedPrompts: string[] = [];

	const orchestrator = new TeamOrchestrator({
		store,
		templates,
		noSession: true,
		defaultCwd: tempDir,
		workerFactory: (opts) =>
			({
				options: opts,
				onSessionEvent: () => () => {},
				onNotice: () => () => {},
				setDialogHandler: () => {},
				start: async () => {
					await reportReady(opts);
				},
				stop: async () => {},
				getState: async () => ({ sessionId: "s", isStreaming: false }),
				runPromptAndWait: async (prompt: string) => {
					capturedPrompts.push(prompt);
					return {
						disposition: "started",
						aborted: false,
						assistantText: "已按所有者确认的提请完成分析。",
						assistantMessages: [],
						toolExecutions: [],
						notices: [],
						dialogs: [],
						events: [],
					};
				},
			}) as unknown as RpcWorkerLike,
	});

	const { server } = createPersonalAgentServer({
		store,
		orchestrator,
		templates,
		dialogBroker,
		previewManager,
		uploadsDir: join(tempDir, "uploads"),
		requireAuth: true,
	});
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const baseUrl = `http://127.0.0.1:${address.port}`;

	try {
		// Unauthenticated LAN session check & API rejection
		const unauthSession = await fetch(`${baseUrl}/api/auth/session`);
		assert.equal(unauthSession.status, 200);
		const unauthSessionJson = (await unauthSession.json()) as { authenticated: boolean; currentUser: unknown };
		assert.equal(unauthSessionJson.authenticated, false);
		assert.equal(unauthSessionJson.currentUser, null);

		const unauthBoot = await fetch(`${baseUrl}/api/bootstrap`);
		assert.equal(unauthBoot.status, 401);

		// Owner login sets cookie & adds collaborator
		const ownerLogin = await fetch(`${baseUrl}/api/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token: owner.token }),
		});
		assert.equal(ownerLogin.status, 200);
		const ownerCookie = ownerLogin.headers.get("set-cookie")?.split(";")[0] ?? "";
		assert.match(ownerCookie, /^pa_session=/);

		const addCollabRes = await fetch(`${baseUrl}/api/collaborators`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: ownerCookie },
			body: JSON.stringify({ name: "李四", roleTitle: "后端研发" }),
		});
		assert.equal(addCollabRes.status, 201);
		const { collaborator: colleague } = (await addCollabRes.json()) as {
			collaborator: { id: string; name: string; roleTitle: string; token: string; permissionRole: string };
		};
		assert.equal(colleague.permissionRole, "collaborator");
		assert.ok(colleague.token.startsWith("inv_"));

		// Collaborator login & token redaction
		const collabLogin = await fetch(`${baseUrl}/api/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token: colleague.token }),
		});
		assert.equal(collabLogin.status, 200);
		const collabCookie = collabLogin.headers.get("set-cookie")?.split(";")[0] ?? "";

		const collabBootRes = await fetch(`${baseUrl}/api/bootstrap`, { headers: { Cookie: collabCookie } });
		assert.equal(collabBootRes.status, 200);
		const collabBoot = (await collabBootRes.json()) as {
			currentUser: { id: string; permissionRole: string; token?: string };
			collaborators: Array<{ id: string; token?: string }>;
		};
		assert.equal(collabBoot.currentUser.id, colleague.id);
		assert.equal(collabBoot.currentUser.permissionRole, "collaborator");
		for (const item of collabBoot.collaborators) {
			assert.equal(item.token, undefined);
		}

		// Collaborator is blocked from admin & direct AI dispatch
		for (const [urlPath, payload] of [
			["/api/matters", { prompt: "直接触发 AI" }],
			["/api/organizations", { name: "Unauthorized Org" }],
			["/api/workspaces", { name: "bad-ws", repoPath: tempDir }],
			["/api/members", { name: "hack", title: "Hack" }],
			["/api/previews", { url: "http://127.0.0.1:9999" }],
		] as const) {
			const res = await fetch(`${baseUrl}${urlPath}`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Cookie: collabCookie },
				body: JSON.stringify(payload),
			});
			assert.equal(res.status, 403, `Expected 403 for collaborator on ${urlPath}`);
		}

		// Collaborator starts a matter in discussion mode & submits follow-up discussion + ai_request
		const startDiscussionRes = await fetch(`${baseUrl}/api/matters`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: collabCookie },
			body: JSON.stringify({ mode: "discussion", prompt: "大家先讨论一下接口协议字段名" }),
		});
		assert.equal(startDiscussionRes.status, 201);
		const { matter } = (await startDiscussionRes.json()) as {
			matter: { id: string; collaboratorIds: string[] };
		};
		assert.ok(matter.collaboratorIds.includes(colleague.id));

		const enableDiscussion = await fetch(`${baseUrl}/api/matters/${matter.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Cookie: ownerCookie },
			body: JSON.stringify({ discussionAiEnabled: true }),
		});
		assert.equal(enableDiscussion.status, 200);
		const guestDiscussion = await fetch(`${baseUrl}/api/matters/${matter.id}/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: collabCookie },
			body: JSON.stringify({ mode: "discussion", prompt: "@product-manager 评论接口命名" }),
		});
		assert.equal(guestDiscussion.status, 201);
		assert.equal(
			((await guestDiscussion.json()) as { aiDiscussionSkippedReason: string }).aiDiscussionSkippedReason,
			"unauthorized",
		);
		assert.equal(capturedPrompts.length, 0);

		const postAiRequestRes = await fetch(`${baseUrl}/api/matters/${matter.id}/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: collabCookie },
			body: JSON.stringify({ mode: "ai_request", prompt: "请 AI 根据刚才讨论整理 API 文档" }),
		});
		assert.equal(postAiRequestRes.status, 201);
		const { message: requestMsg } = (await postAiRequestRes.json()) as {
			message: { id: string; metadata: Record<string, unknown> };
		};
		assert.equal(requestMsg.metadata.mode, "ai_request");
		assert.equal(requestMsg.metadata.aiRequestStatus, "pending");

		// Collaborator cannot directly dispatch on existing matter
		const forbiddenDispatch = await fetch(`${baseUrl}/api/matters/${matter.id}/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: collabCookie },
			body: JSON.stringify({ prompt: "绕过审核直接派发" }),
		});
		assert.equal(forbiddenDispatch.status, 403);

		// Collaborator cannot approve own ai_request
		const forbiddenApprove = await fetch(`${baseUrl}/api/matters/${matter.id}/messages/${requestMsg.id}/approve-ai`, {
			method: "POST",
			headers: { Cookie: collabCookie },
		});
		assert.equal(forbiddenApprove.status, 403);

		// Owner approves ai_request -> AI worker executes with discussion + request context
		const ownerApprove = await fetch(`${baseUrl}/api/matters/${matter.id}/messages/${requestMsg.id}/approve-ai`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: ownerCookie },
			body: "{}",
		});
		assert.equal(ownerApprove.status, 202);

		await new Promise<void>((resolveWait, rejectWait) => {
			const deadline = Date.now() + 2000;
			const poll = () => {
				if (capturedPrompts.length > 0 && !orchestrator.isMatterRunning(matter.id)) {
					resolveWait();
					return;
				}
				if (Date.now() > deadline) {
					rejectWait(new Error("Timed out waiting for approved AI request dispatch"));
					return;
				}
				setTimeout(poll, 25);
			};
			poll();
		});
		assert.match(capturedPrompts[0] ?? "", /\[Team discussion\] 李四 \(后端研发\): 大家先讨论一下接口协议字段名/);
		assert.match(capturedPrompts[0] ?? "", /Owner 已确认同事 李四 的 AI 提请并安排执行/);

		// Collaborator can rate deliverable without autoDistill, but autoDistill: true returns 403
		const deliv = store.recordDeliverable({
			matterId: matter.id,
			memberId: "product-manager",
			type: "document",
			title: "接口设计方案",
			summary: "Draft",
			contentOrPath: "# API",
		});
		const forbiddenDistill = await fetch(`${baseUrl}/api/deliverables/${deliv.id}/feedback`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: collabCookie },
			body: JSON.stringify({ feedback: "需要补充错误码", rating: "neutral", autoDistill: true }),
		});
		assert.equal(forbiddenDistill.status, 403);

		const allowedFeedback = await fetch(`${baseUrl}/api/deliverables/${deliv.id}/feedback`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: collabCookie },
			body: JSON.stringify({ feedback: "字段定义清晰", rating: "positive" }),
		});
		assert.equal(allowedFeedback.status, 200);
		const fbJson = (await allowedFeedback.json()) as { feedback: string; rating: string };
		assert.equal(fbJson.rating, "positive");
		assert.equal(fbJson.feedback, "[李四 (后端研发)]: 字段定义清晰");

		// Dismiss flow + token regeneration
		const secondReqRes = await fetch(`${baseUrl}/api/matters/${matter.id}/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: collabCookie },
			body: JSON.stringify({ mode: "ai_request", prompt: "顺便重构一下数据库层" }),
		});
		assert.equal(secondReqRes.status, 201);
		const { message: secondReq } = (await secondReqRes.json()) as { message: { id: string } };
		const dismissRes = await fetch(`${baseUrl}/api/matters/${matter.id}/messages/${secondReq.id}/dismiss-ai`, {
			method: "POST",
			headers: { Cookie: ownerCookie },
		});
		assert.equal(dismissRes.status, 200);
		assert.equal(store.getMessage(secondReq.id)?.metadata?.aiRequestStatus, "dismissed");

		const regenRes = await fetch(`${baseUrl}/api/collaborators/${colleague.id}/regenerate-token`, {
			method: "POST",
			headers: { Cookie: ownerCookie },
		});
		assert.equal(regenRes.status, 200);
		const oldLogin = await fetch(`${baseUrl}/api/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token: colleague.token }),
		});
		assert.equal(oldLogin.status, 401);
	} finally {
		await orchestrator.shutdown();
		server.closeAllConnections();
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		db.close();
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("Matter AI roster, lead switching, Matter-wide observer toggle, and delegation scope enforcement", async () => {
	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db);
	const templates = await loadRoleTemplatesFromDir(resolve(process.cwd(), "roles"));
	const tempDir = mkdtempSync(join(tmpdir(), "pa-server-roster-"));
	const dialogBroker = new DialogBroker();
	const previewManager = new PreviewManager();

	const orchestrator = new TeamOrchestrator({
		store,
		templates,
		noSession: true,
		defaultCwd: tempDir,
		workerFactory: (opts) =>
			({
				options: opts,
				onSessionEvent: () => () => {},
				onNotice: () => () => {},
				setDialogHandler: () => {},
				start: async () => {
					await reportReady(opts);
				},
				stop: async () => {},
				getState: async () => ({ sessionId: "s", isStreaming: false }),
				runPromptAndWait: async () => ({
					disposition: "started",
					aborted: false,
					assistantText: "已完成测试处理。",
					assistantMessages: [],
					toolExecutions: [],
					notices: [],
					dialogs: [],
					events: [],
				}),
			}) as unknown as RpcWorkerLike,
	});

	const { server } = createPersonalAgentServer({
		store,
		orchestrator,
		templates,
		dialogBroker,
		previewManager,
		uploadsDir: join(tempDir, "uploads"),
	});
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const baseUrl = `http://127.0.0.1:${address.port}`;

	try {
		const createRes = await fetch(`${baseUrl}/api/matters`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				prompt: "验证默认全员 AI 参与与统一旁听开关",
				preferredMemberId: "product-manager",
			}),
		});
		assert.equal(createRes.status, 202);
		const created = (await createRes.json()) as {
			matter: {
				id: string;
				leadMemberId: string | null;
				aiMemberIds: string[] | null;
				observersEnabled: boolean;
				observerMemberIds: string[];
			};
		};
		const matterId = created.matter.id;
		assert.equal(created.matter.leadMemberId, "product-manager");
		assert.equal(created.matter.aiMemberIds, null);
		assert.equal(created.matter.observersEnabled, false);
		assert.deepEqual(created.matter.observerMemberIds, []);

		// Wait for initial background dispatch turn to settle before patching lead/roster.
		for (let i = 0; i < 40; i++) {
			const detailRes = await fetch(`${baseUrl}/api/matters/${matterId}`);
			assert.equal(detailRes.status, 200);
			const detail = (await detailRes.json()) as {
				activeRun?: unknown;
				running?: boolean;
				matter: { status: string };
			};
			if (!detail.activeRun && !detail.running && detail.matter.status !== "running") break;
			await new Promise((r) => setTimeout(r, 25));
		}

		// Enable Matter-wide observer toggle -> auto-populates all non-lead AI roles.
		const enableObsRes = await fetch(`${baseUrl}/api/matters/${matterId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ observersEnabled: true }),
		});
		assert.equal(enableObsRes.status, 200);
		const enabledObs = (await enableObsRes.json()) as {
			matter: { observersEnabled: boolean; observerMemberIds: string[] };
		};
		assert.equal(enabledObs.matter.observersEnabled, true);
		assert.deepEqual([...enabledObs.matter.observerMemberIds].sort(), [
			"engineering-manager",
			"marketing-lead",
			"qa-manager",
		]);

		// Switch Matter lead -> previous lead joins observers and new lead leaves observers.
		const switchLeadRes = await fetch(`${baseUrl}/api/matters/${matterId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ leadMemberId: "engineering-manager" }),
		});
		assert.equal(switchLeadRes.status, 200);
		const switchedLead = (await switchLeadRes.json()) as {
			matter: { leadMemberId: string | null; observerMemberIds: string[] };
		};
		assert.equal(switchedLead.matter.leadMemberId, "engineering-manager");
		assert.deepEqual([...switchedLead.matter.observerMemberIds].sort(), [
			"marketing-lead",
			"product-manager",
			"qa-manager",
		]);

		// Reject empty AI member roster with 400.
		const emptyRosterRes = await fetch(`${baseUrl}/api/matters/${matterId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ aiMemberIds: [] }),
		});
		assert.equal(emptyRosterRes.status, 400);

		// Narrow AI roster -> removed AI roles are dropped from both aiMemberIds and observerMemberIds.
		const narrowRes = await fetch(`${baseUrl}/api/matters/${matterId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ aiMemberIds: ["engineering-manager", "product-manager"] }),
		});
		assert.equal(narrowRes.status, 200);
		const narrowed = (await narrowRes.json()) as {
			matter: { aiMemberIds: string[] | null; observerMemberIds: string[] };
		};
		assert.deepEqual(narrowed.matter.aiMemberIds, ["engineering-manager", "product-manager"]);
		assert.deepEqual(narrowed.matter.observerMemberIds, ["product-manager"]);

		// Turn off Matter-wide observer toggle -> clears observerMemberIds.
		const disableObsRes = await fetch(`${baseUrl}/api/matters/${matterId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ observersEnabled: false }),
		});
		assert.equal(disableObsRes.status, 200);
		const disabledObs = (await disableObsRes.json()) as {
			matter: { observersEnabled: boolean; observerMemberIds: string[] };
		};
		assert.equal(disabledObs.matter.observersEnabled, false);
		assert.deepEqual(disabledObs.matter.observerMemberIds, []);

		// Delegating to an AI removed from the Matter is rejected.
		await assert.rejects(
			() =>
				orchestrator.delegateToMember({
					matterId,
					fromMemberId: "engineering-manager",
					toMemberId: "qa-manager",
					question: "请补充测试方案",
				}),
			/removed from this matter/,
		);
	} finally {
		await orchestrator.shutdown();
		server.closeAllConnections();
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		db.close();
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("Revoked or deleted collaborator session stays blocked on refresh, loopback, and live SSE", async () => {
	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db);
	store.ensureOwnerCollaborator("团队所有者");
	const templates = await loadRoleTemplatesFromDir(resolve(process.cwd(), "roles"));
	const tempDir = mkdtempSync(join(tmpdir(), "pa-server-revoke-"));
	const dialogBroker = new DialogBroker();
	const previewManager = new PreviewManager();

	const orchestrator = new TeamOrchestrator({
		store,
		templates,
		noSession: true,
		defaultCwd: tempDir,
		workerFactory: (opts) =>
			({
				options: opts,
				onSessionEvent: () => () => {},
				onNotice: () => () => {},
				setDialogHandler: () => {},
				start: async () => {
					await reportReady(opts);
				},
				stop: async () => {},
				getState: async () => ({ sessionId: "s", isStreaming: false }),
				runPromptAndWait: async () => ({
					disposition: "started",
					aborted: false,
					assistantText: "ok",
					assistantMessages: [],
					toolExecutions: [],
					notices: [],
					dialogs: [],
					events: [],
				}),
			}) as unknown as RpcWorkerLike,
	});

	// Intentionally omit requireAuth (defaults to false, same as local start:web) to verify loopback does NOT fallback.
	const { server } = createPersonalAgentServer({
		store,
		orchestrator,
		templates,
		dialogBroker,
		previewManager,
		uploadsDir: join(tempDir, "uploads"),
	});
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const baseUrl = `http://127.0.0.1:${address.port}`;

	try {
		const addRes = await fetch(`${baseUrl}/api/collaborators`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "potato", roleTitle: "协同同事" }),
		});
		assert.equal(addRes.status, 201);
		const { collaborator } = (await addRes.json()) as { collaborator: { id: string; token: string } };

		const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token: collaborator.token }),
		});
		assert.equal(loginRes.status, 200);
		const staleCookie = loginRes.headers.get("set-cookie")?.split(";")[0] ?? "";
		assert.match(staleCookie, /^pa_session=/);

		// Open live SSE stream as the collaborator.
		const sseRes = await fetch(`${baseUrl}/api/events`, {
			headers: { Cookie: staleCookie },
		});
		assert.equal(sseRes.status, 200);
		assert.ok(sseRes.body);
		const reader = sseRes.body.getReader();
		const decoder = new TextDecoder();
		const firstChunk = await reader.read();
		assert.match(decoder.decode(firstChunk.value), /event: connected/);

		// Owner regenerates collaborator token -> live SSE must receive auth_revoked and close.
		const regenRes = await fetch(`${baseUrl}/api/collaborators/${collaborator.id}/regenerate-token`, {
			method: "POST",
		});
		assert.equal(regenRes.status, 200);

		let sseText = "";
		for (let i = 0; i < 5; i++) {
			const chunk = await reader.read();
			if (chunk.value) sseText += decoder.decode(chunk.value);
			if (chunk.done) break;
		}
		assert.match(sseText, /event: auth_revoked/);

		// Stale cookie on loopback MUST NOT silently fall back to local Owner.
		const sessionAfter = await fetch(`${baseUrl}/api/auth/session`, {
			headers: { Cookie: staleCookie },
		});
		assert.equal(sessionAfter.status, 200);
		const sessionJson = (await sessionAfter.json()) as {
			authenticated: boolean;
			revokedSession?: boolean;
			currentUser: unknown;
		};
		assert.equal(sessionJson.authenticated, false);
		assert.equal(sessionJson.revokedSession, true);
		assert.equal(sessionJson.currentUser, null);

		const bootAfter = await fetch(`${baseUrl}/api/bootstrap`, {
			headers: { Cookie: staleCookie },
		});
		assert.equal(bootAfter.status, 401);

		const sseReconnect = await fetch(`${baseUrl}/api/events`, {
			headers: { Cookie: staleCookie },
		});
		assert.equal(sseReconnect.status, 401);

		const matterPostAfter = await fetch(`${baseUrl}/api/matters`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: staleCookie },
			body: JSON.stringify({ prompt: "试图用已重置的旧会话发起事项" }),
		});
		assert.equal(matterPostAfter.status, 401);

		// New token works; deleting collaborator also invalidates its active cookie session.
		const { collaborator: refreshed } = (await regenRes.json()) as { collaborator: { token: string } };
		const reloginRes = await fetch(`${baseUrl}/api/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token: refreshed.token }),
		});
		assert.equal(reloginRes.status, 200);
		const newCookie = reloginRes.headers.get("set-cookie")?.split(";")[0] ?? "";

		const delRes = await fetch(`${baseUrl}/api/collaborators/${collaborator.id}`, {
			method: "DELETE",
		});
		assert.equal(delRes.status, 200);

		const bootAfterDelete = await fetch(`${baseUrl}/api/bootstrap`, {
			headers: { Cookie: newCookie },
		});
		assert.equal(bootAfterDelete.status, 401);
	} finally {
		await orchestrator.shutdown();
		server.closeAllConnections();
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		db.close();
		rmSync(tempDir, { recursive: true, force: true });
	}
});
