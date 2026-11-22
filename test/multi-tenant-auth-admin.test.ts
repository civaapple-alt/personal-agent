import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
	createPersonalAgentServer,
	DialogBroker,
	loadRoleTemplatesFromDir,
	openPersonalAgentDatabase,
	PersonalAgentStore,
	type PiRpcWorkerOptions,
	PreviewManager,
	type PromptRunResult,
	type RpcWorkerLike,
	TeamOrchestrator,
} from "../src/index.ts";
import { validateCloneUrl } from "../src/server/git-clone.ts";
import { reportReady } from "./worker-helpers.ts";

class MultiTenantTestWorker implements RpcWorkerLike {
	readonly options: PiRpcWorkerOptions;
	constructor(options: PiRpcWorkerOptions) {
		this.options = options;
	}
	async start(): Promise<void> {
		await reportReady(this.options);
	}
	async stop(): Promise<void> {}
	async getState(): Promise<{ sessionId: string; sessionFile?: string }> {
		return { sessionId: "mt-session" };
	}
	onNotice(): () => void {
		return () => {};
	}
	setDialogHandler(): void {}
	onEvent(): () => void {
		return () => {};
	}
	async runPromptAndWait(_message: string): Promise<PromptRunResult> {
		return {
			disposition: "started",
			aborted: false,
			assistantText: "# 多租户测试响应\n\n- 成员直接触发 AI 成功完成",
			assistantMessages: [],
			toolExecutions: [],
			notices: [],
			dialogs: [],
			events: [],
		};
	}
}

function extractSessionCookie(res: Response): string {
	const raw = res.headers.get("set-cookie") ?? "";
	const match = raw.match(/pa_session=([^;]+)/);
	assert.ok(match?.[1], `Expected pa_session cookie in headers, got: ${raw}`);
	return `pa_session=${match[1]}`;
}

async function startBareGitHttpServer(rootDir: string): Promise<{ cloneUrl: string; close: () => Promise<void> }> {
	const workSrc = join(rootDir, "git-src");
	const bareDir = join(rootDir, "sample.git");
	mkdirSync(workSrc, { recursive: true });
	execFileSync("git", ["init", "-b", "main", workSrc], { stdio: "ignore" });
	execFileSync("git", ["config", "user.name", "Test User"], { cwd: workSrc, stdio: "ignore" });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: workSrc, stdio: "ignore" });
	writeFileSync(join(workSrc, "README.md"), "# Sample Multi-Team Repo\n");
	execFileSync("git", ["add", "README.md"], { cwd: workSrc, stdio: "ignore" });
	execFileSync("git", ["commit", "-m", "init"], { cwd: workSrc, stdio: "ignore" });
	execFileSync("git", ["clone", "--bare", workSrc, bareDir], { stdio: "ignore" });
	execFileSync("git", ["update-server-info"], { cwd: bareDir, stdio: "ignore" });

	const httpServer = http.createServer((req, res) => {
		const urlPath = (req.url ?? "/").split("?")[0] ?? "/";
		const cleanRel = urlPath.replace(/^\/sample\.git\/?/, "");
		const target = resolve(bareDir, cleanRel);
		if (!target.startsWith(bareDir) || !existsSync(target) || statSync(target).isDirectory()) {
			res.writeHead(404);
			res.end("Not found");
			return;
		}
		res.writeHead(200);
		res.end(readFileSync(target));
	});
	await new Promise<void>((resolveListen) => httpServer.listen(0, "127.0.0.1", () => resolveListen()));
	const addr = httpServer.address();
	assert.ok(addr && typeof addr === "object");
	return {
		cloneUrl: `http://127.0.0.1:${addr.port}/sample.git`,
		close: () => new Promise<void>((resolveClose) => httpServer.close(() => resolveClose())),
	};
}

test("Multi-tenant security: admin bootstrap, open registration/review, org isolation, clone root & member AI dispatch", async () => {
	// Unit checks on validateCloneUrl
	assert.throws(() => validateCloneUrl("file:///etc/passwd"), /file:\/\//);
	assert.throws(() => validateCloneUrl("ext::sh%20id"), /file:\/\/|自定义/);
	assert.throws(() => validateCloneUrl("-u/bin/sh"), /格式无效/);
	assert.throws(() => validateCloneUrl("https://evil.com/repo.git --upload-pack=bad"), /空格/);
	assert.equal(validateCloneUrl("https://github.com/acme/repo.git"), "https://github.com/acme/repo.git");
	assert.equal(validateCloneUrl("git@github.com:acme/repo.git"), "git@github.com:acme/repo.git");

	const tempDir = mkdtempSync(join(tmpdir(), "pa-mt-"));
	const dataDir = join(tempDir, "data");
	const workspacesRoot = join(tempDir, "workspaces-root");
	const allowedLocalRoot = join(tempDir, "allowed-repos");
	const forbiddenLocalRoot = join(tempDir, "outside-repos");
	mkdirSync(dataDir, { recursive: true });
	mkdirSync(workspacesRoot, { recursive: true });
	mkdirSync(join(allowedLocalRoot, "allowed-app"), { recursive: true });
	mkdirSync(join(forbiddenLocalRoot, "outside-app"), { recursive: true });

	const gitHttp = await startBareGitHttpServer(tempDir);
	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db);
	const templates = await loadRoleTemplatesFromDir(resolve(process.cwd(), "roles"));
	const dialogBroker = new DialogBroker();
	const previewManager = new PreviewManager();
	const orchestrator = new TeamOrchestrator({
		store,
		templates,
		onDialog: (ctx) => dialogBroker.requestApproval(ctx),
		workerFactory: (options) => new MultiTenantTestWorker(options),
	});

	const { server } = createPersonalAgentServer({
		store,
		orchestrator,
		templates,
		previewManager,
		dialogBroker,
		requireAuth: true,
		dataDir,
		defaultWorkspacesRoot: workspacesRoot,
		uploadsDir: join(tempDir, "uploads"),
		webDistDir: resolve(process.cwd(), "web/dist"),
	});
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const baseUrl = `http://127.0.0.1:${address.port}`;

	try {
		// 1. Require-auth first run: unauthenticated requests blocked & needsAdminSetup is true
		const initSession = (await (await fetch(`${baseUrl}/api/auth/session`)).json()) as {
			authenticated: boolean;
			permissionRequired: boolean;
			needsAdminSetup: boolean;
			registrationMode: string;
		};
		assert.equal(initSession.authenticated, false);
		assert.equal(initSession.permissionRequired, true);
		assert.equal(initSession.needsAdminSetup, true);
		assert.equal(initSession.registrationMode, "open_review");

		assert.equal((await fetch(`${baseUrl}/api/bootstrap`)).status, 401);

		// CSRF origin check rejects mismatched browser Origin on mutating endpoints
		const badOriginRes = await fetch(`${baseUrl}/api/auth/setup-admin`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: "https://evil.attacker" },
			body: JSON.stringify({ email: "admin@acme.dev", password: "password123", displayName: "Super Admin" }),
		});
		assert.equal(badOriginRes.status, 403);

		// 2. Super admin bootstrap once-only lock
		const setupRes = await fetch(`${baseUrl}/api/auth/setup-admin`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "admin@acme.dev", password: "password123", displayName: "Super Admin" }),
		});
		assert.equal(setupRes.status, 201);
		const adminCookie = extractSessionCookie(setupRes);
		const secondSetupRes = await fetch(`${baseUrl}/api/auth/setup-admin`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "hacker@acme.dev", password: "password123", displayName: "Attacker" }),
		});
		assert.equal(secondSetupRes.status, 409);

		// Security headers present on responses
		assert.equal(setupRes.headers.get("x-frame-options"), "DENY");
		assert.equal(setupRes.headers.get("referrer-policy"), "no-referrer");

		// 3. Default registration mode ("open_review"): Bob sits pending_review until Super Admin approves
		const bobReg = await fetch(`${baseUrl}/api/auth/register`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "bob@team-b.dev", password: "bob-password-1", displayName: "Bob" }),
		});
		assert.equal(bobReg.status, 201);
		const bobRegBody = (await bobReg.json()) as {
			pendingApproval: boolean;
			accountUser: { id: string; status: string };
		};
		assert.equal(bobRegBody.pendingApproval, true);
		assert.equal(bobRegBody.accountUser.status, "pending_review");
		const bobCookie = extractSessionCookie(bobReg);
		assert.equal((await fetch(`${baseUrl}/api/bootstrap`, { headers: { Cookie: bobCookie } })).status, 403);

		// Switch temporarily to "open_auto" -> Alice registers with email + password and enters active immediately
		const openAutoPatch = await fetch(`${baseUrl}/api/admin/settings`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Cookie: adminCookie },
			body: JSON.stringify({ registrationMode: "open_auto" }),
		});
		assert.equal(openAutoPatch.status, 200);

		const aliceReg = await fetch(`${baseUrl}/api/auth/register`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "alice@team-a.dev", password: "alice-password-1", displayName: "Alice" }),
		});
		assert.equal(aliceReg.status, 201);
		const aliceCookie = extractSessionCookie(aliceReg);

		// Logout revokes server-side session token permanently
		const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
			method: "POST",
			headers: { Cookie: aliceCookie, "Content-Type": "application/json" },
			body: "{}",
		});
		assert.equal(logoutRes.status, 200);
		assert.equal((await fetch(`${baseUrl}/api/bootstrap`, { headers: { Cookie: aliceCookie } })).status, 401);

		// Re-login with email+password
		const aliceLogin = await fetch(`${baseUrl}/api/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "alice@team-a.dev", password: "alice-password-1" }),
		});
		assert.equal(aliceLogin.status, 200);
		const aliceFreshCookie = extractSessionCookie(aliceLogin);

		// Alice creates her own org with only QA Manager & Engineering Manager AI roles enabled
		const orgARes = await fetch(`${baseUrl}/api/organizations`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: aliceFreshCookie },
			body: JSON.stringify({
				name: "Team Alpha",
				gitEmailDomain: "team-a.dev",
				aiMemberIds: ["engineering-manager", "qa-manager"],
				primaryAiMemberId: "engineering-manager",
			}),
		});
		assert.equal(orgARes.status, 201);
		const { organization: orgA } = (await orgARes.json()) as {
			organization: { id: string; slug: string; workspacesDir: string };
		};
		assert.ok(orgA.workspacesDir.startsWith(workspacesRoot));

		// Non-admin Alice is blocked from /api/admin/overview
		assert.equal(
			(await fetch(`${baseUrl}/api/admin/overview`, { headers: { Cookie: aliceFreshCookie } })).status,
			403,
		);

		// Per-org AI role filtering enforced: Product Manager is disabled in orgA
		const assessA = (await (
			await fetch(`${baseUrl}/api/matters/assess`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Cookie: aliceFreshCookie },
				body: JSON.stringify({ orgId: orgA.id, prompt: "请规划产品路线图和代码验收测试" }),
			})
		).json()) as { candidates: Array<{ memberId: string }> };
		assert.ok(assessA.candidates.every((c) => c.memberId !== "product-manager"));

		const disabledRoleRes = await fetch(`${baseUrl}/api/matters`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: aliceFreshCookie },
			body: JSON.stringify({
				orgId: orgA.id,
				mode: "discussion",
				prompt: "尝试调用被本组织禁用的产品经理",
				preferredMemberId: "product-manager",
			}),
		});
		assert.equal(disabledRoleRes.status, 403);

		// 4. Super admin configures local path allowlist & tests git clone + local path boundary
		const adminSettingsPatch = await fetch(`${baseUrl}/api/admin/settings`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Cookie: adminCookie },
			body: JSON.stringify({
				allowLocalWorkspacePath: true,
				localWorkspaceAllowlist: [allowedLocalRoot],
				registrationMode: "open_review",
			}),
		});
		assert.equal(adminSettingsPatch.status, 200);

		// Rejected paths: .data internal dir + outside allowlist
		const dataDirWs = await fetch(`${baseUrl}/api/workspaces`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: aliceFreshCookie },
			body: JSON.stringify({ orgId: orgA.id, name: "leak-data", sourceType: "local", repoPath: dataDir }),
		});
		assert.equal(dataDirWs.status, 403);

		const outsideWs = await fetch(`${baseUrl}/api/workspaces`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: aliceFreshCookie },
			body: JSON.stringify({
				orgId: orgA.id,
				name: "outside",
				sourceType: "local",
				repoPath: join(forbiddenLocalRoot, "outside-app"),
			}),
		});
		assert.equal(outsideWs.status, 403);

		// Allowed local root works
		const allowedWsRes = await fetch(`${baseUrl}/api/workspaces`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: aliceFreshCookie },
			body: JSON.stringify({
				orgId: orgA.id,
				name: "allowed-local",
				sourceType: "local",
				repoPath: join(allowedLocalRoot, "allowed-app"),
			}),
		});
		assert.equal(allowedWsRes.status, 201);

		// Git clone into <workspacesRoot>/<orgSlug>/ over ephemeral http://127.0.0.1 bare server
		const clonedWsRes = await fetch(`${baseUrl}/api/workspaces`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: aliceFreshCookie },
			body: JSON.stringify({
				orgId: orgA.id,
				name: "cloned-sample",
				sourceType: "clone",
				cloneUrl: gitHttp.cloneUrl,
				visibility: "restricted",
				allowedUserIds: [],
			}),
		});
		assert.equal(clonedWsRes.status, 201);
		const { workspace: clonedWs } = (await clonedWsRes.json()) as {
			workspace: { id: string; repoPath: string; sourceType: string; visibility: string };
		};
		assert.equal(clonedWs.sourceType, "cloned");
		assert.equal(clonedWs.visibility, "restricted");
		assert.ok(clonedWs.repoPath.startsWith(orgA.workspacesDir));
		assert.ok(existsSync(join(clonedWs.repoPath, "README.md")));

		// 5. Super admin approves Bob (pending from default open_review) and grants maxOrgs=1, canDispatchAi=true
		const approveBob = await fetch(`${baseUrl}/api/admin/users/${bobRegBody.accountUser.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Cookie: adminCookie },
			body: JSON.stringify({ status: "active", maxOrgs: 1, maxActiveDispatches: 2, canDispatchAi: true }),
		});
		assert.equal(approveBob.status, 200);

		const bobBoot = (await (await fetch(`${baseUrl}/api/bootstrap`, { headers: { Cookie: bobCookie } })).json()) as {
			organizations: Array<{ id: string }>;
			workspaces: Array<{ id: string }>;
			matters: Array<{ id: string }>;
		};
		assert.equal(bobBoot.organizations.length, 0);
		assert.equal(bobBoot.workspaces.length, 0);

		// Bob can create 1 org, second blocked by maxOrgs=1 quota
		const orgBRes = await fetch(`${baseUrl}/api/organizations`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: bobCookie },
			body: JSON.stringify({ name: "Team Beta" }),
		});
		assert.equal(orgBRes.status, 201);
		const quotaExceededOrg = await fetch(`${baseUrl}/api/organizations`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: bobCookie },
			body: JSON.stringify({ name: "Team Beta 2" }),
		});
		assert.equal(quotaExceededOrg.status, 403);

		// 6. Cross-org + private matter + upload ACL + SSE isolation
		const aliceUploadMatter = await fetch(`${baseUrl}/api/matters`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: aliceFreshCookie },
			body: JSON.stringify({
				orgId: orgA.id,
				mode: "discussion",
				visibility: "private",
				prompt: "Alice 的私密事项",
				files: [{ kind: "pasted_text", name: "secret.txt", mimeType: "text/plain", content: "top-secret-alice" }],
			}),
		});
		assert.equal(aliceUploadMatter.status, 201);
		const aliceCreated = (await aliceUploadMatter.json()) as {
			matter: { id: string; visibility: string };
			message: { metadata?: { files?: Array<{ url?: string }> } };
		};
		assert.equal(aliceCreated.matter.visibility, "private");
		const uploadUrl = aliceCreated.message.metadata?.files?.[0]?.url;
		assert.ok(uploadUrl);

		// Bob cannot view Alice's matter, uploaded file, or restricted workspace
		assert.equal(
			(await fetch(`${baseUrl}/api/matters/${aliceCreated.matter.id}`, { headers: { Cookie: bobCookie } })).status,
			403,
		);
		assert.equal((await fetch(`${baseUrl}${uploadUrl}`, { headers: { Cookie: bobCookie } })).status, 403);
		assert.equal((await fetch(`${baseUrl}${uploadUrl}`, { headers: { Cookie: aliceFreshCookie } })).status, 200);

		// An unindexed upload cannot be accessed by account users, even if a message references it.
		db.prepare("DELETE FROM uploads_index WHERE filename = ?").run(uploadUrl.split("/").at(-1)!);
		assert.equal((await fetch(`${baseUrl}${uploadUrl}`, { headers: { Cookie: bobCookie } })).status, 403);
		assert.equal((await fetch(`${baseUrl}${uploadUrl}`, { headers: { Cookie: aliceFreshCookie } })).status, 403);
		writeFileSync(join(tempDir, "uploads", "unreferenced.txt"), "An orphaned upload");
		assert.equal(
			(await fetch(`${baseUrl}/api/uploads/unreferenced.txt`, { headers: { Cookie: aliceFreshCookie } })).status,
			403,
		);

		// Open SSE for Bob and create a matter in orgA -> Bob must NOT receive orgA SSE event
		const bobSseAbort = new AbortController();
		const bobSseRes = await fetch(`${baseUrl}/api/events`, {
			headers: { Cookie: bobCookie },
			signal: bobSseAbort.signal,
		});
		assert.equal(bobSseRes.status, 200);
		const bobSseReader = bobSseRes.body!.getReader();
		const bobSseChunks: string[] = [];
		const bobReadTask = (async () => {
			const decoder = new TextDecoder();
			while (true) {
				const { done, value } = await bobSseReader.read();
				if (done) break;
				bobSseChunks.push(decoder.decode(value, { stream: true }));
			}
		})().catch(() => {});

		await fetch(`${baseUrl}/api/matters`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: aliceFreshCookie },
			body: JSON.stringify({
				orgId: orgA.id,
				mode: "discussion",
				visibility: "org",
				prompt: "orgA 公开组织讨论，不应推送给 Bob",
			}),
		});
		await new Promise((r) => setTimeout(r, 60));
		bobSseAbort.abort();
		await bobReadTask;
		assert.equal(bobSseChunks.join("").includes("不应推送给 Bob"), false);

		// 7. Invite Bob into Team Alpha as org_member:
		// Bob sees orgA matters with visibility='org', CAN dispatch AI directly,
		// CANNOT read Alice's visibility='private' matter or Alice's 'restricted' clonedWs!
		const inviteCreate = await fetch(`${baseUrl}/api/organizations/${orgA.id}/invites`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: aliceFreshCookie },
			body: JSON.stringify({ orgRole: "org_member", maxUses: 5, expiresInHours: 24 }),
		});
		assert.equal(inviteCreate.status, 201);
		const { rawToken: orgInviteToken } = (await inviteCreate.json()) as { rawToken: string };
		assert.match(orgInviteToken, /^orginv_/);

		// Invite preview works unauthenticated (returns org name/role safely) and flags alreadyMember for Alice
		const anonPreview = (await (
			await fetch(`${baseUrl}/api/auth/invite-preview?token=${encodeURIComponent(orgInviteToken)}`)
		).json()) as { valid: boolean; orgName?: string; orgRole?: string; alreadyMember?: boolean };
		assert.equal(anonPreview.valid, true);
		assert.equal(anonPreview.orgName, "Team Alpha");
		assert.equal(anonPreview.orgRole, "org_member");
		assert.equal(anonPreview.alreadyMember, false);

		const alicePreview = (await (
			await fetch(`${baseUrl}/api/auth/invite-preview?token=${encodeURIComponent(orgInviteToken)}`, {
				headers: { Cookie: aliceFreshCookie },
			})
		).json()) as { valid: boolean; alreadyMember?: boolean; existingRole?: string };
		assert.equal(alicePreview.valid, true);
		assert.equal(alicePreview.alreadyMember, true);
		assert.equal(alicePreview.existingRole, "org_owner");

		// Consuming own invite does not burn invite usage count
		const aliceSelfJoin = (await (
			await fetch(`${baseUrl}/api/organizations/join`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Cookie: aliceFreshCookie },
				body: JSON.stringify({ inviteToken: orgInviteToken }),
			})
		).json()) as { membership: { orgRole: string } };
		assert.equal(aliceSelfJoin.membership.orgRole, "org_owner");
		const invitesBeforeBob = (await (
			await fetch(`${baseUrl}/api/organizations/${orgA.id}/invites`, { headers: { Cookie: aliceFreshCookie } })
		).json()) as { invites: Array<{ usedCount: number }> };
		assert.equal(invitesBeforeBob.invites[0]?.usedCount, 0);

		const bobJoin = await fetch(`${baseUrl}/api/organizations/join`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: bobCookie },
			body: JSON.stringify({ inviteToken: orgInviteToken }),
		});
		assert.equal(bobJoin.status, 200);

		const bobAfterJoinBoot = (await (
			await fetch(`${baseUrl}/api/bootstrap`, { headers: { Cookie: bobCookie } })
		).json()) as {
			workspaces: Array<{ id: string }>;
			matters: Array<{ id: string }>;
		};
		// Restricted workspace still hidden from Bob
		assert.equal(
			bobAfterJoinBoot.workspaces.some((w) => w.id === clonedWs.id),
			false,
		);
		// Private matter still hidden from Bob
		assert.equal(
			bobAfterJoinBoot.matters.some((m) => m.id === aliceCreated.matter.id),
			false,
		);

		const sharedMatter = store.createMatter({
			title: "Shared discussion",
			leadMemberId: "product-manager",
			orgId: orgA.id,
			createdByUserId: bobRegBody.accountUser.id,
		});
		const mismatchedWorkspace = await fetch(`${baseUrl}/api/matters/${sharedMatter.id}/messages`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: bobCookie },
			body: JSON.stringify({ workspaceId: clonedWs.id, prompt: "Follow up within the current matter" }),
		});
		assert.equal(mismatchedWorkspace.status, 409);
		assert.equal(store.getMatter(sharedMatter.id)?.workspaceId, null);
		assert.equal(store.listMessages(sharedMatter.id).length, 0);

		// Ordinary org_member Bob CAN trigger AI directly inside orgA!
		const bobDispatch = await fetch(`${baseUrl}/api/matters`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: bobCookie },
			body: JSON.stringify({
				orgId: orgA.id,
				mode: "dispatch",
				prompt: "Bob 作为普通组织成员直接触发 AI 分析",
			}),
		});
		assert.equal(bobDispatch.status, 202);
		const { matter: bobMatter } = (await bobDispatch.json()) as { matter: { id: string } };
		for (let i = 0; i < 40; i++) {
			const detail = (await (
				await fetch(`${baseUrl}/api/matters/${bobMatter.id}`, { headers: { Cookie: bobCookie } })
			).json()) as { userMessages: Array<{ senderType: string; content: string }> };
			if (detail.userMessages.some((m) => m.senderType === "member")) {
				assert.match(
					detail.userMessages.find((m) => m.senderType === "member")?.content ?? "",
					/成员直接触发 AI 成功/,
				);
				break;
			}
			await new Promise((r) => setTimeout(r, 20));
		}

		// Demote Bob to org_viewer -> blocked from dispatch
		const bobViewerPatch = await fetch(
			`${baseUrl}/api/organizations/${orgA.id}/members/${bobRegBody.accountUser.id}`,
			{
				method: "PATCH",
				headers: { "Content-Type": "application/json", Cookie: aliceFreshCookie },
				body: JSON.stringify({ orgRole: "org_viewer" }),
			},
		);
		assert.equal(bobViewerPatch.status, 200);
		const viewerDispatch = await fetch(`${baseUrl}/api/matters`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: bobCookie },
			body: JSON.stringify({ orgId: orgA.id, mode: "dispatch", prompt: "只读访客尝试派发 AI" }),
		});
		assert.equal(viewerDispatch.status, 403);

		// 8. Admin overview + audit logs + login brute-force rate limit
		const adminOverview = (await (
			await fetch(`${baseUrl}/api/admin/overview`, { headers: { Cookie: adminCookie } })
		).json()) as {
			users: Array<{ email: string }>;
			auditLogs: Array<{ action: string }>;
		};
		assert.ok(adminOverview.users.some((u) => u.email === "alice@team-a.dev"));
		assert.ok(adminOverview.auditLogs.some((l) => l.action === "admin.update_settings"));

		for (let i = 0; i < 22; i++) {
			await fetch(`${baseUrl}/api/auth/login`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email: "alice@team-a.dev", password: "wrong-password" }),
			});
		}
		const rateLimitedLogin = await fetch(`${baseUrl}/api/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "alice@team-a.dev", password: "wrong-password" }),
		});
		assert.equal(rateLimitedLogin.status, 429);
	} finally {
		await previewManager.stopAll();
		await gitHttp.close();
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		db.close();
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("Team event streams share the resource ACL and logout closes only the current session", async () => {
	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db);
	const templates = await loadRoleTemplatesFromDir(resolve("roles"));
	const orchestrator = new TeamOrchestrator({ store, templates });
	const org = store.ensureDefaultOrganization();
	const owner = store.createUser({
		email: "events-owner@example.test",
		displayName: "Owner",
		password: "FixturePass1!",
		status: "active",
		platformRole: "super_admin",
	});
	const teammate = store.createUser({
		email: "events-member@example.test",
		displayName: "Teammate",
		password: "FixturePass2!",
		status: "active",
	});
	store.upsertOrgMember({ orgId: org.id, userId: owner.id, orgRole: "org_owner" });
	store.upsertOrgMember({ orgId: org.id, userId: teammate.id, orgRole: "org_member" });
	const memberId = "product-manager";
	const workspace = store.upsertWorkspace({
		name: "Restricted fixture",
		repoPath: "/fixture/events-private",
		orgId: org.id,
		visibility: "restricted",
	});
	const matter = store.createMatter({
		title: "Private fixture",
		leadMemberId: memberId,
		workspaceId: workspace.id,
		orgId: org.id,
		createdByUserId: owner.id,
		visibility: "private",
	});
	const [delivery] = store.recordDeliverables([
		{ matterId: matter.id, memberId, type: "document", title: "Fixture", contentOrPath: "Document" },
	]);
	assert.ok(delivery);
	const ownerCookie = `pa_session=${store.createSession(owner.id).rawToken}`;
	const otherOwnerCookie = `pa_session=${store.createSession(owner.id).rawToken}`;
	const teammateCookie = `pa_session=${store.createSession(teammate.id).rawToken}`;
	const { server } = createPersonalAgentServer({
		store,
		orchestrator,
		templates,
		previewManager: new PreviewManager(),
		dialogBroker: new DialogBroker(),
		requireAuth: true,
	});
	await new Promise<void>((listen) => server.listen(0, "127.0.0.1", listen));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const baseUrl = `http://127.0.0.1:${address.port}`;
	const controller = new AbortController();
	const openStream = async (cookie: string) => {
		const response = await fetch(`${baseUrl}/api/events`, {
			headers: { Cookie: cookie },
			signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]),
		});
		assert.equal(response.status, 200);
		return response;
	};
	const post = (route: string, cookie: string, body: unknown) =>
		fetch(`${baseUrl}${route}`, {
			method: "POST",
			headers: { Cookie: cookie, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	const readThrough = async (response: Response, marker: string) => {
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let content = "";
		try {
			while (!content.includes(marker)) {
				const { value, done } = await reader.read();
				assert.equal(done, false, "SSE closed before the expected event");
				content += decoder.decode(value, { stream: true });
			}
			return content;
		} finally {
			await reader.cancel();
		}
	};

	try {
		const signedOutStream = await openStream(ownerCookie);
		const ownerStream = await openStream(otherOwnerCookie);
		const teammateStream = await openStream(teammateCookie);
		assert.equal((await post("/api/auth/logout", ownerCookie, {})).status, 200);
		assert.match(await signedOutStream.text(), /event: connected/);

		const privateMemory = await post("/api/memories", otherOwnerCookie, {
			memberId,
			scope: "project_private",
			workspaceId: workspace.id,
			content: "RESTRICTED_PROJECT_MEMORY",
		});
		assert.equal(privateMemory.status, 201);
		const { memory } = (await privateMemory.json()) as { memory: { id: string } };
		const applicationsUrl = `${baseUrl}/api/memories/${memory.id}/applications`;
		assert.equal((await fetch(applicationsUrl, { headers: { Cookie: otherOwnerCookie } })).status, 200);
		assert.equal((await fetch(applicationsUrl, { headers: { Cookie: teammateCookie } })).status, 403);

		assert.equal(
			(
				await post("/api/previews", otherOwnerCookie, {
					title: "RESTRICTED_PREVIEW",
					url: "https://preview.example.test/",
					deliverableId: delivery.id,
				})
			).status,
			201,
		);
		assert.equal(
			(await post("/api/memories", otherOwnerCookie, { memberId, content: "VISIBLE_MEMORY_SIGNAL" })).status,
			201,
		);
		const [ownerEvents, teammateEvents] = await Promise.all([
			readThrough(ownerStream, "VISIBLE_MEMORY_SIGNAL"),
			readThrough(teammateStream, "VISIBLE_MEMORY_SIGNAL"),
		]);
		assert.match(ownerEvents, /RESTRICTED_PROJECT_MEMORY/);
		assert.match(ownerEvents, /RESTRICTED_PREVIEW/);
		assert.doesNotMatch(teammateEvents, /RESTRICTED_PROJECT_MEMORY|RESTRICTED_PREVIEW/);
	} finally {
		controller.abort();
		await new Promise<void>((close) => server.close(() => close()));
		await orchestrator.shutdown();
		db.close();
	}
});

test("Loopback trial upgrade to requireAuth preserves usr_local_owner org membership and trial data", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pa-upgrade-"));
	const trialRepoDir = join(tempDir, "trial-repo");
	mkdirSync(trialRepoDir, { recursive: true });
	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db);
	const defaultOrg = store.ensureDefaultOrganization();
	const ownerCollab = store.ensureOwnerCollaborator("Local Owner");
	const localAdmin = store.ensureLocalBootstrapAdmin(ownerCollab.name);
	store.upsertOrgMember({
		orgId: defaultOrg.id,
		userId: localAdmin.id,
		orgRole: "org_owner",
		roleTitle: "超级管理员",
	});
	const templates = await loadRoleTemplatesFromDir(resolve(process.cwd(), "roles"));

	const startServerWithAuth = async (requireAuth: boolean) => {
		const dialogBroker = new DialogBroker();
		const previewManager = new PreviewManager();
		const orchestrator = new TeamOrchestrator({
			store,
			templates,
			onDialog: (ctx) => dialogBroker.requestApproval(ctx),
			workerFactory: (options) => new MultiTenantTestWorker(options),
		});
		const { server } = createPersonalAgentServer({
			store,
			orchestrator,
			templates,
			previewManager,
			dialogBroker,
			requireAuth,
			dataDir: join(tempDir, "data"),
			defaultWorkspacesRoot: join(tempDir, "workspaces-root"),
			uploadsDir: join(tempDir, "uploads"),
			webDistDir: resolve(process.cwd(), "web/dist"),
		});
		await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
		const addr = server.address();
		assert.ok(addr && typeof addr === "object");
		return {
			baseUrl: `http://127.0.0.1:${addr.port}`,
			close: async () => {
				await previewManager.stopAll();
				await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
			},
		};
	};

	let loopbackSrv: Awaited<ReturnType<typeof startServerWithAuth>> | null = null;
	let authSrv: Awaited<ReturnType<typeof startServerWithAuth>> | null = null;
	try {
		// Phase 1: Personal passwordless loopback trial creates workspace & matter in defaultOrg
		loopbackSrv = await startServerWithAuth(false);
		const personalHtml = await (await fetch(loopbackSrv.baseUrl)).text();
		assert.match(personalHtml, /<title>Personal Agent · 个人版<\/title>/);
		assert.doesNotMatch(personalHtml, /<title>.*V4.*<\/title>/);
		const loopbackSession = (await (await fetch(`${loopbackSrv.baseUrl}/api/auth/session`)).json()) as {
			requireAuth: boolean;
		};
		assert.equal(loopbackSession.requireAuth, false);
		const loopbackBoot = (await (await fetch(`${loopbackSrv.baseUrl}/api/bootstrap`)).json()) as {
			platformPolicy?: { requireAuth?: boolean };
		};
		assert.equal(loopbackBoot.platformPolicy?.requireAuth, false);

		const wsRes = await fetch(`${loopbackSrv.baseUrl}/api/workspaces`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				orgId: defaultOrg.id,
				name: "trial-local",
				sourceType: "local",
				repoPath: trialRepoDir,
			}),
		});
		assert.equal(wsRes.status, 201);
		const { workspace: trialWs } = (await wsRes.json()) as { workspace: { id: string } };

		const matterRes = await fetch(`${loopbackSrv.baseUrl}/api/matters`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				mode: "discussion",
				workspaceId: trialWs.id,
				prompt: "免密试用期创建的本地事项",
			}),
		});
		assert.equal(matterRes.status, 201);
		const { matter: trialMatter } = (await matterRes.json()) as {
			matter: { id: string; orgId: string | null; createdByUserId?: string | null };
		};
		assert.equal(trialMatter.orgId, defaultOrg.id);
		assert.equal(trialMatter.createdByUserId, "usr_local_owner");

		await loopbackSrv.close();
		loopbackSrv = null;

		// Phase 2: Switch same DB to PA_REQUIRE_AUTH=1 -> in-place upgrade of usr_local_owner
		authSrv = await startServerWithAuth(true);
		const teamHtml = await (await fetch(authSrv.baseUrl)).text();
		assert.match(teamHtml, /<title>Personal Agent · 团队版<\/title>/);
		assert.doesNotMatch(teamHtml, /<title>.*V4.*<\/title>/);
		const sessionRes = (await (await fetch(`${authSrv.baseUrl}/api/auth/session`)).json()) as {
			authenticated: boolean;
			requireAuth: boolean;
			needsAdminSetup: boolean;
			registrationMode: string;
		};
		assert.equal(sessionRes.authenticated, false);
		assert.equal(sessionRes.requireAuth, true);
		assert.equal(sessionRes.needsAdminSetup, true);
		assert.equal(sessionRes.registrationMode, "open_review");

		const setupRes = await fetch(`${authSrv.baseUrl}/api/auth/setup-admin`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "owner@company.dev", password: "owner-password-1", displayName: "Owner" }),
		});
		assert.equal(setupRes.status, 201);
		const setupJson = (await setupRes.json()) as { accountUser: { id: string; email: string } };
		assert.equal(setupJson.accountUser.id, "usr_local_owner");
		assert.equal(setupJson.accountUser.email, "owner@company.dev");
		const adminCookie = extractSessionCookie(setupRes);

		const bootRes = (await (
			await fetch(`${authSrv.baseUrl}/api/bootstrap`, { headers: { Cookie: adminCookie } })
		).json()) as {
			platformPolicy?: { requireAuth?: boolean };
			organizations: Array<{ id: string; orgRole: string }>;
			workspaces: Array<{ id: string }>;
			matters: Array<{ id: string }>;
		};
		assert.equal(bootRes.platformPolicy?.requireAuth, true);
		assert.ok(bootRes.organizations.some((o) => o.id === defaultOrg.id && o.orgRole === "org_owner"));
		assert.ok(bootRes.workspaces.some((w) => w.id === trialWs.id));
		assert.ok(bootRes.matters.some((m) => m.id === trialMatter.id));
	} finally {
		if (loopbackSrv) await loopbackSrv.close();
		if (authSrv) await authSrv.close();
		db.close();
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("Deliverables API enforces org, restricted workspace, private visibility, org_viewer, and RSI access boundaries", async () => {
	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db);
	const templates = await loadRoleTemplatesFromDir(resolve(process.cwd(), "roles"));
	const orchestrator = new TeamOrchestrator({
		store,
		templates,
		noSession: true,
		defaultCwd: process.cwd(),
		workerFactory: (opts) => {
			if (opts.args?.includes("--tools") && opts.args[opts.args.indexOf("--tools") + 1] === "") {
				const baseWorker = new MultiTenantTestWorker(opts);
				return {
					start: async () => {},
					stop: () => baseWorker.stop(),
					getState: () => baseWorker.getState(),
					onNotice: () => baseWorker.onNotice(),
					setDialogHandler: () => baseWorker.setDialogHandler(),
					onEvent: () => baseWorker.onEvent(),
					options: baseWorker.options,
					runPromptAndWait: async () => ({
						disposition: "started",
						aborted: false,
						assistantText: JSON.stringify({
							candidates: [
								{
									memberId: "product-manager",
									scope: "company_private",
									category: "domain_constraint",
									content: "Alpha org deliverables must record acceptance criteria.",
									rationale: "Verified from orgA review",
								},
							],
						}),
						assistantMessages: [],
						toolExecutions: [],
						notices: [],
						dialogs: [],
						events: [],
					}),
				};
			}
			return new MultiTenantTestWorker(opts);
		},
	});
	const previewManager = new PreviewManager();
	const dialogBroker = new DialogBroker();
	const { server } = createPersonalAgentServer({
		store,
		orchestrator,
		templates,
		previewManager,
		dialogBroker,
		requireAuth: true,
	});
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
	const addr = server.address();
	assert.ok(addr && typeof addr === "object");
	const base = `http://127.0.0.1:${addr.port}`;

	try {
		const orgA = store.upsertOrganization({ name: "Alpha Org", isDefault: true });
		const orgB = store.upsertOrganization({ name: "Beta Org" });
		const ownerA = store.createUser({
			email: "owner-a@test.local",
			displayName: "OwnerA",
			password: "Pass123456!",
			status: "active",
		});
		const memberA = store.createUser({
			email: "member-a@test.local",
			displayName: "MemberA",
			password: "Pass123456!",
			status: "active",
		});
		const peerA = store.createUser({
			email: "peer-a@test.local",
			displayName: "PeerA",
			password: "Pass123456!",
			status: "active",
		});
		const viewerA = store.createUser({
			email: "viewer-a@test.local",
			displayName: "ViewerA",
			password: "Pass123456!",
			status: "active",
		});
		const ownerB = store.createUser({
			email: "owner-b@test.local",
			displayName: "OwnerB",
			password: "Pass123456!",
			status: "active",
		});

		store.upsertOrgMember({ orgId: orgA.id, userId: ownerA.id, orgRole: "org_owner" });
		store.upsertOrgMember({ orgId: orgA.id, userId: memberA.id, orgRole: "org_member" });
		store.upsertOrgMember({ orgId: orgA.id, userId: peerA.id, orgRole: "org_member" });
		store.upsertOrgMember({ orgId: orgA.id, userId: viewerA.id, orgRole: "org_viewer" });
		// Give ownerA membership in orgB too so we test multi-org filtering via ?orgId=
		store.upsertOrgMember({ orgId: orgB.id, userId: ownerA.id, orgRole: "org_member" });
		store.upsertOrgMember({ orgId: orgB.id, userId: ownerB.id, orgRole: "org_owner" });

		const wsAOpen = store.upsertWorkspace({
			name: "Alpha Open",
			repoPath: "/tmp/alpha-open",
			orgId: orgA.id,
			visibility: "org",
		});
		const wsARestricted = store.upsertWorkspace({
			name: "Alpha Restricted",
			repoPath: "/tmp/alpha-secret",
			orgId: orgA.id,
			visibility: "restricted",
		});
		store.setWorkspaceAccess(wsARestricted.id, "restricted", [memberA.id]);
		const wsBOpen = store.upsertWorkspace({
			name: "Beta Open",
			repoPath: "/tmp/beta-open",
			orgId: orgB.id,
			visibility: "org",
		});

		const mAOpen = store.createMatter({
			title: "Alpha Shared",
			leadMemberId: "product-manager",
			orgId: orgA.id,
			workspaceId: wsAOpen.id,
			createdByUserId: memberA.id,
			visibility: "org",
		});
		const mAPrivate = store.createMatter({
			title: "Alpha Private",
			leadMemberId: "product-manager",
			orgId: orgA.id,
			workspaceId: wsAOpen.id,
			createdByUserId: memberA.id,
			visibility: "private",
		});
		const mARestricted = store.createMatter({
			title: "Alpha Restricted Matter",
			leadMemberId: "product-manager",
			orgId: orgA.id,
			workspaceId: wsARestricted.id,
			createdByUserId: memberA.id,
			visibility: "org",
		});
		const mBOpen = store.createMatter({
			title: "Beta Shared",
			leadMemberId: "product-manager",
			orgId: orgB.id,
			workspaceId: wsBOpen.id,
			createdByUserId: ownerB.id,
			visibility: "org",
		});

		const [dAOpen] = store.recordDeliverables([
			{
				matterId: mAOpen.id,
				memberId: "product-manager",
				type: "document",
				title: "Alpha Open Spec",
				contentOrPath: "Open spec",
			},
		]);
		const [dAPrivate] = store.recordDeliverables([
			{
				matterId: mAPrivate.id,
				memberId: "product-manager",
				type: "document",
				title: "Alpha Secret Spec",
				contentOrPath: "Private spec",
			},
		]);
		const [dARestricted] = store.recordDeliverables([
			{
				matterId: mARestricted.id,
				memberId: "product-manager",
				type: "document",
				title: "Alpha Restricted Spec",
				contentOrPath: "Restricted spec",
			},
		]);
		const [dBOpen] = store.recordDeliverables([
			{
				matterId: mBOpen.id,
				memberId: "product-manager",
				type: "document",
				title: "Beta Open Spec",
				contentOrPath: "Beta spec",
			},
		]);
		assert.ok(dAOpen && dAPrivate && dARestricted && dBOpen);
		store.appendMessage({
			matterId: mAOpen.id,
			channel: "user",
			senderType: "member",
			senderId: "product-manager",
			content: "Published Alpha Open Spec",
			metadata: {
				orgId: orgA.id,
				workspaceId: wsAOpen.id,
				repoPath: resolve("/tmp/alpha-open"),
				deliverableIds: [dAOpen.id],
			},
		});

		const ownerACookie = `pa_session=${store.createSession(ownerA.id).rawToken}`;
		const memberACookie = `pa_session=${store.createSession(memberA.id).rawToken}`;
		const peerACookie = `pa_session=${store.createSession(peerA.id).rawToken}`;
		const viewerACookie = `pa_session=${store.createSession(viewerA.id).rawToken}`;
		const ownerBCookie = `pa_session=${store.createSession(ownerB.id).rawToken}`;

		// Space documents use workspace access and reject stale updates.
		const spaceId = `spc_ws_${wsAOpen.id}`;
		const createPage = await fetch(`${base}/api/spaces/${spaceId}/documents`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: memberACookie },
			body: JSON.stringify({ matterId: mAOpen.id, title: "Working plan", content: "Draft" }),
		});
		assert.equal(createPage.status, 201);
		const spacePage = (
			(await createPage.json()) as { document: { id: string; revision: number; headCommit: string } }
		).document;
		const sendFeedback = (cookie: string) =>
			fetch(`${base}/api/spaces/documents/${spacePage.id}/feedback`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Cookie: cookie },
				body: JSON.stringify({ commitHash: spacePage.headCommit, feedback: "Needs work", rating: "negative" }),
			});
		assert.equal((await sendFeedback(viewerACookie)).status, 403);
		assert.equal((await sendFeedback(ownerBCookie)).status, 403);
		assert.equal((await sendFeedback(memberACookie)).status, 200);
		const feedbackResponse = await fetch(`${base}/api/spaces/documents/${spacePage.id}/feedback`, {
			headers: { Cookie: viewerACookie },
		});
		assert.equal(feedbackResponse.status, 200);
		assert.equal(((await feedbackResponse.json()) as { feedback: unknown[] }).feedback.length, 1);
		const editPage = (cookie: string, revision: number, content: string) =>
			fetch(`${base}/api/spaces/documents/${spacePage.id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json", Cookie: cookie },
				body: JSON.stringify({ title: "Working plan", revision, content }),
			});
		assert.equal((await editPage(viewerACookie, 1, "Forbidden")).status, 403);
		assert.equal((await editPage(memberACookie, 1, "Second draft")).status, 200);
		assert.equal((await editPage(memberACookie, 1, "Stale draft")).status, 409);
		assert.equal((await sendFeedback(memberACookie)).status, 200);
		const invalidFeedback = await fetch(`${base}/api/spaces/documents/${spacePage.id}/feedback`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: memberACookie },
			body: JSON.stringify({ commitHash: "a".repeat(40), feedback: "unrelated" }),
		});
		assert.equal(invalidFeedback.status, 400);
		const pageHistory = await fetch(`${base}/api/spaces/documents/${spacePage.id}/commits`, {
			headers: { Cookie: viewerACookie },
		});
		assert.equal(pageHistory.status, 200);
		assert.equal(((await pageHistory.json()) as { commits: unknown[] }).commits.length, 2);
		assert.equal(
			(await fetch(`${base}/api/spaces/documents/${spacePage.id}`, { headers: { Cookie: ownerBCookie } })).status,
			403,
		);

		// 1. Multi-org filtering for OwnerA (belongs to both orgA & orgB)
		const allOwnerA = (await (
			await fetch(`${base}/api/deliverables`, { headers: { Cookie: ownerACookie } })
		).json()) as { deliverables: Array<{ id: string }> };
		assert.deepEqual(
			allOwnerA.deliverables.map((d) => d.id).sort(),
			[dAOpen.id, dAPrivate.id, dARestricted.id, dBOpen.id].sort(),
		);
		const onlyOrgA = (await (
			await fetch(`${base}/api/deliverables?orgId=${encodeURIComponent(orgA.id)}`, {
				headers: { Cookie: ownerACookie },
			})
		).json()) as { deliverables: Array<{ id: string }> };
		assert.deepEqual(
			onlyOrgA.deliverables.map((d) => d.id).sort(),
			[dAOpen.id, dAPrivate.id, dARestricted.id].sort(),
		);
		const onlyOrgB = (await (
			await fetch(`${base}/api/deliverables?orgId=${encodeURIComponent(orgB.id)}`, {
				headers: { Cookie: ownerACookie },
			})
		).json()) as { deliverables: Array<{ id: string }> };
		assert.deepEqual(
			onlyOrgB.deliverables.map((d) => d.id),
			[dBOpen.id],
		);
		const onlyPrivateA = (await (
			await fetch(`${base}/api/deliverables?orgId=${encodeURIComponent(orgA.id)}&visibility=private`, {
				headers: { Cookie: ownerACookie },
			})
		).json()) as { deliverables: Array<{ id: string }> };
		assert.deepEqual(
			onlyPrivateA.deliverables.map((d) => d.id),
			[dAPrivate.id],
		);

		// 2. PeerA (org_member not on private matter or restricted workspace) cannot see or fetch them, nor query orgB
		const peerList = (await (
			await fetch(`${base}/api/deliverables`, { headers: { Cookie: peerACookie } })
		).json()) as { deliverables: Array<{ id: string }> };
		assert.deepEqual(
			peerList.deliverables.map((d) => d.id),
			[dAOpen.id],
		);
		assert.equal(
			(await fetch(`${base}/api/deliverables/${dAPrivate.id}`, { headers: { Cookie: peerACookie } })).status,
			403,
		);
		assert.equal(
			(await fetch(`${base}/api/deliverables/${dARestricted.id}`, { headers: { Cookie: peerACookie } })).status,
			403,
		);
		assert.equal(
			(await fetch(`${base}/api/deliverables/${dBOpen.id}`, { headers: { Cookie: peerACookie } })).status,
			403,
		);
		assert.equal(
			(
				await fetch(`${base}/api/deliverables?orgId=${encodeURIComponent(orgB.id)}`, {
					headers: { Cookie: peerACookie },
				})
			).status,
			403,
		);

		// 3. Creator MemberA tightens dAOpen from org -> private; PeerA immediately loses visibility
		const tightenRes = await fetch(`${base}/api/matters/${mAOpen.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Cookie: memberACookie },
			body: JSON.stringify({ visibility: "private" }),
		});
		assert.equal(tightenRes.status, 200);
		assert.equal(
			(await fetch(`${base}/api/spaces/documents/${spacePage.id}`, { headers: { Cookie: peerACookie } })).status,
			403,
		);
		const peerSpace = (await (
			await fetch(`${base}/api/spaces/${spaceId}/documents`, { headers: { Cookie: peerACookie } })
		).json()) as { documents: Array<{ id: string }> };
		assert.ok(!peerSpace.documents.some((page) => page.id === spacePage.id));
		assert.equal(
			(await fetch(`${base}/api/deliverables/${dAOpen.id}`, { headers: { Cookie: peerACookie } })).status,
			403,
		);
		const peerListAfterTighten = (await (
			await fetch(`${base}/api/deliverables`, { headers: { Cookie: peerACookie } })
		).json()) as { deliverables: Array<{ id: string }> };
		assert.equal(peerListAfterTighten.deliverables.length, 0);

		// Re-open mAOpen to org for viewer/feedback/distill tests
		assert.equal(
			(
				await fetch(`${base}/api/matters/${mAOpen.id}`, {
					method: "PATCH",
					headers: { "Content-Type": "application/json", Cookie: memberACookie },
					body: JSON.stringify({ visibility: "org" }),
				})
			).status,
			200,
		);

		// 4. org_viewer is read-only on deliverables (cannot submit feedback, tighten visibility, or distill)
		assert.equal(
			(
				await fetch(`${base}/api/deliverables/${dAOpen.id}/feedback`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Cookie: viewerACookie },
					body: JSON.stringify({ rating: "positive", feedback: "viewer hack" }),
				})
			).status,
			403,
		);
		assert.equal(
			(
				await fetch(`${base}/api/matters/${mAOpen.id}`, {
					method: "PATCH",
					headers: { "Content-Type": "application/json", Cookie: viewerACookie },
					body: JSON.stringify({ visibility: "private" }),
				})
			).status,
			403,
		);
		assert.equal(
			(
				await fetch(`${base}/api/rsi/distill`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Cookie: viewerACookie },
					body: JSON.stringify({ matterId: mAOpen.id }),
				})
			).status,
			403,
		);

		// 5. org_member cannot trigger RSI distillation or autoDistill; org_owner can trigger RSI distillation for its own matter
		assert.equal(
			(
				await fetch(`${base}/api/rsi/distill`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Cookie: memberACookie },
					body: JSON.stringify({ matterId: mAOpen.id }),
				})
			).status,
			403,
		);
		assert.equal(
			(
				await fetch(`${base}/api/deliverables/${dAOpen.id}/feedback`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Cookie: memberACookie },
					body: JSON.stringify({ rating: "positive", autoDistill: true }),
				})
			).status,
			403,
		);
		// OrgA owner CAN distill on an orgA matter & save company_private memory, but CANNOT mutate global role_general memory
		const ownerADistill = await fetch(`${base}/api/rsi/distill`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: ownerACookie },
			body: JSON.stringify({ matterId: mAOpen.id }),
		});
		assert.equal(ownerADistill.status, 200);
		assert.equal(
			(
				await fetch(`${base}/api/memories`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Cookie: ownerACookie },
					body: JSON.stringify({
						memberId: "product-manager",
						scope: "role_general",
						content: "Cross-org hijack",
					}),
				})
			).status,
			403,
		);
		assert.equal(
			(
				await fetch(`${base}/api/memories`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Cookie: ownerACookie },
					body: JSON.stringify({
						memberId: "product-manager",
						scope: "company_private",
						orgId: orgA.id,
						content: "Alpha org deliverable checklist",
					}),
				})
			).status,
			201,
		);
		// OrgB owner cannot touch orgA deliverables
		assert.equal(
			(
				await fetch(`${base}/api/rsi/distill`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Cookie: ownerBCookie },
					body: JSON.stringify({ matterId: mAOpen.id }),
				})
			).status,
			403,
		);
	} finally {
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		await orchestrator.shutdown();
		db.close();
	}
});

test("Team sandbox script seeds multi-org RBAC & deliverable scenarios and boots an isolated auth server", async () => {
	const sandboxDir = mkdtempSync(join(tmpdir(), "pa-team-sandbox-test-"));
	try {
		const sandboxScript = resolve(process.cwd(), "scripts/start-team-sandbox.mjs");
		const seedStdout = execFileSync(process.execPath, [sandboxScript, "--seed-only", `--dir=${sandboxDir}`], {
			encoding: "utf8",
		});
		const seededSummary = JSON.parse(seedStdout);
		assert.equal(seededSummary.seeded, true);
		assert.equal(seededSummary.deliverableCount, 6);
		assert.deepEqual(seededSummary.organizations, ["Alpha Studio", "Beta Labs"]);
		assert.ok(seededSummary.inviteToken?.startsWith("orginv_"));

		// Re-running on an already seeded dir is idempotent
		const secondStdout = execFileSync(process.execPath, [sandboxScript, "--seed-only", `--dir=${sandboxDir}`], {
			encoding: "utf8",
		});
		const secondSummary = JSON.parse(secondStdout);
		assert.equal(secondSummary.seeded, false);
		assert.equal(secondSummary.deliverableCount, 6);

		// Reserve an ephemeral loopback port cleanly before spawning the sandbox server
		const probe = createServer();
		await new Promise<void>((resolveListen) => probe.listen(0, "127.0.0.1", () => resolveListen()));
		const addr = probe.address();
		assert.ok(addr && typeof addr === "object");
		const port = addr.port;
		await new Promise<void>((resolveClose) => probe.close(() => resolveClose()));

		const child = spawn(
			process.execPath,
			[sandboxScript, `--dir=${sandboxDir}`, `--port=${port}`, "--host=127.0.0.1"],
			{
				cwd: process.cwd(),
				stdio: ["ignore", "pipe", "pipe", "ipc"],
			},
		);
		let output = "";
		child.stdout?.on("data", (chunk) => {
			output += chunk.toString();
		});
		child.stderr?.on("data", (chunk) => {
			output += chunk.toString();
		});
		const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, rejectExit) => {
			child.once("error", rejectExit);
			child.once("exit", (code, signal) => resolveExit({ code, signal }));
		});

		try {
			const deadline = Date.now() + 12_000;
			while (!output.includes("团队版独立验证沙盒已就绪")) {
				if (child.exitCode !== null || Date.now() > deadline) {
					throw new Error(`Sandbox startup timed out: ${output}`);
				}
				await new Promise((resolveWait) => setTimeout(resolveWait, 40));
			}

			const base = `http://127.0.0.1:${port}`;
			assert.equal((await fetch(`${base}/api/bootstrap`)).status, 401);
			const anonSession = (await (await fetch(`${base}/api/auth/session`)).json()) as {
				authenticated: boolean;
				requireAuth: boolean;
				needsAdminSetup: boolean;
			};
			assert.equal(anonSession.authenticated, false);
			assert.equal(anonSession.requireAuth, true);
			assert.equal(anonSession.needsAdminSetup, false);

			const signIn = async (email: string): Promise<string> => {
				const res = await fetch(`${base}/api/auth/login`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ email, password: seededSummary.password }),
				});
				assert.equal(res.status, 200, `Login failed for ${email}`);
				const setCookie = res.headers.get("set-cookie");
				assert.ok(setCookie);
				return setCookie.split(";")[0]!;
			};

			const ownerCookie = await signIn("owner@alpha.local");
			const peerCookie = await signIn("peer@alpha.local");
			const viewerCookie = await signIn("viewer@alpha.local");
			const adminCookie = await signIn("admin@sandbox.local");

			const ownerDelivs = (await (
				await fetch(`${base}/api/deliverables`, { headers: { Cookie: ownerCookie } })
			).json()) as { deliverables: Array<{ id: string; title: string; version: number; orgId: string | null }> };
			assert.equal(ownerDelivs.deliverables.length, 6);

			const ownerBoot = (await (
				await fetch(`${base}/api/bootstrap`, { headers: { Cookie: ownerCookie } })
			).json()) as { organizations: Array<{ id: string; slug: string }> };
			const betaOrg = ownerBoot.organizations.find((o) => o.slug === "beta-labs");
			assert.ok(betaOrg);
			const ownerBetaOnly = (await (
				await fetch(`${base}/api/deliverables?orgId=${betaOrg.id}`, { headers: { Cookie: ownerCookie } })
			).json()) as { deliverables: Array<{ title: string }> };
			assert.equal(ownerBetaOnly.deliverables.length, 2);
			assert.ok(ownerBetaOnly.deliverables.every((d) => d.title === "Beta 开放平台接口规范"));

			const peerDelivs = (await (
				await fetch(`${base}/api/deliverables`, { headers: { Cookie: peerCookie } })
			).json()) as { deliverables: Array<{ title: string }> };
			assert.equal(peerDelivs.deliverables.length, 2);
			assert.ok(peerDelivs.deliverables.every((d) => d.title === "Q4 发布计划与架构方案"));

			const viewerDelivs = (await (
				await fetch(`${base}/api/deliverables`, { headers: { Cookie: viewerCookie } })
			).json()) as { deliverables: Array<{ id: string; title: string }> };
			assert.equal(viewerDelivs.deliverables.length, 2);
			assert.equal(
				(
					await fetch(`${base}/api/deliverables/${viewerDelivs.deliverables[0]!.id}/feedback`, {
						method: "POST",
						headers: { "Content-Type": "application/json", Cookie: viewerCookie },
						body: JSON.stringify({ feedback: "Viewer blocked", rating: "positive" }),
					})
				).status,
				403,
			);

			const adminOverview = (await (
				await fetch(`${base}/api/admin/overview`, { headers: { Cookie: adminCookie } })
			).json()) as { users: Array<{ email: string; status: string }> };
			assert.ok(
				adminOverview.users.some((u) => u.email === "pending@sandbox.local" && u.status === "pending_review"),
			);

			assert.ok(child.connected, "Expected IPC channel to sandbox wrapper");
			child.send("shutdown");
			const exitRes = await Promise.race([
				exited,
				new Promise<never>((_, rejectTimeout) =>
					setTimeout(() => rejectTimeout(new Error("Sandbox shutdown timed out")), 5000),
				),
			]);
			assert.deepEqual(exitRes, { code: 0, signal: null });
		} finally {
			if (child.exitCode === null) child.kill("SIGKILL");
			await exited.catch(() => {});
		}
	} finally {
		rmSync(sandboxDir, { recursive: true, force: true });
	}
});
