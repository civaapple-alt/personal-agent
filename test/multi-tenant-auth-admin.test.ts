import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
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
		const sessionRes = (await (await fetch(`${authSrv.baseUrl}/api/auth/session`)).json()) as {
			authenticated: boolean;
			needsAdminSetup: boolean;
			registrationMode: string;
		};
		assert.equal(sessionRes.authenticated, false);
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
			organizations: Array<{ id: string; orgRole: string }>;
			workspaces: Array<{ id: string }>;
			matters: Array<{ id: string }>;
		};
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
