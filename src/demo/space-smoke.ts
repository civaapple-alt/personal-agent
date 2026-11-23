/** Real-model Space workflow through authenticated HTTP, in an isolated synthetic environment. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TeamOrchestrator } from "../orchestrator/team-orchestrator.ts";
import { loadRoleTemplatesFromDir } from "../roles/template-loader.ts";
import { createPersonalAgentServer } from "../server/app.ts";
import { DialogBroker } from "../server/dialog-broker.ts";
import { PreviewManager } from "../server/preview-manager.ts";
import { openPersonalAgentDatabase } from "../storage/database.ts";
import { PersonalAgentStore } from "../storage/repositories.ts";
import { selectDemoModel } from "./model-selection.ts";

const root = await mkdtemp(join(tmpdir(), "personal-agent-space-smoke-"));
console.log(`Isolated Space evidence directory: ${root}`);
const workspacePath = join(root, "workspace");
await mkdir(workspacePath);
const db = openPersonalAgentDatabase(join(root, "proof.db"));
const store = new PersonalAgentStore(db, { spacesDir: join(root, "spaces") });
store.updatePlatformSettings({ defaultModelSelection: await selectDemoModel(root, { thinkingLevel: "off" }) });
const templates = (await loadRoleTemplatesFromDir(resolve("roles"))).map((template) => ({
	...template,
	tools: ["read"],
}));
const orchestrator = new TeamOrchestrator({
	store,
	templates,
	defaultCwd: workspacePath,
	sessionDir: join(root, "sessions"),
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
	dataDir: root,
});
try {
	const org = store.upsertOrganization({ name: "合成空间验证组织", isDefault: true });
	const owner = store.createUser({
		email: "space-owner@example.test",
		displayName: "空间创建者",
		password: "SyntheticPass123!",
		status: "active",
	});
	const peer = store.createUser({
		email: "space-peer@example.test",
		displayName: "同组织成员",
		password: "SyntheticPass123!",
		status: "active",
	});
	const outsider = store.createUser({
		email: "space-outsider@example.test",
		displayName: "组织外成员",
		password: "SyntheticPass123!",
		status: "active",
	});
	store.upsertOrgMember({ orgId: org.id, userId: owner.id, orgRole: "org_owner" });
	store.upsertOrgMember({ orgId: org.id, userId: peer.id, orgRole: "org_member" });
	const workspace = store.upsertWorkspace({
		name: "合成工作区",
		repoPath: workspacePath,
		orgId: org.id,
		visibility: "org",
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const base = `http://127.0.0.1:${address.port}`;
	const login = async (email: string) => {
		const response = await fetch(`${base}/api/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email, password: "SyntheticPass123!" }),
		});
		assert.equal(response.status, 200);
		const cookie = response.headers.get("set-cookie")?.match(/pa_session=[^;]+/)?.[0];
		assert.ok(cookie);
		return cookie;
	};
	const ownerCookie = await login(owner.email);
	const peerCookie = await login(peer.email);
	const outsiderCookie = await login(outsider.email);
	const request = (path: string, cookie: string, method = "GET", body?: object) =>
		fetch(`${base}${path}`, {
			method,
			headers: { Cookie: cookie, ...(body ? { "Content-Type": "application/json" } : {}) },
			...(body ? { body: JSON.stringify(body) } : {}),
		});
	const start = await request("/api/matters", ownerCookie, "POST", {
		mode: "dispatch",
		orgId: org.id,
		workspaceId: workspace.id,
		preferredMemberId: "product-manager",
		visibility: "org",
		prompt:
			"这是独立的空间验证，不涉及真实客户。请调用 save_space_page 保存一篇标题为「空间协作验证稿」的 document，正文写入 SPACE_TEST_4827 和一句说明：这只是合成资料，尚未经过真实客户验收。不要调用同事，不要写工作区文件。",
	});
	assert.equal(start.status, 202, await start.clone().text());
	const { matter } = (await start.json()) as { matter: { id: string } };
	let detail:
		| {
				activeRun: unknown;
				userMessages: Array<{ senderType: string; content: string }>;
				spaceDocuments: Array<{ id: string; spaceId: string; headCommit: string; revision: number; title: string }>;
		  }
		| undefined;
	const deadline = Date.now() + 180_000;
	while (Date.now() < deadline) {
		const response = await request(`/api/matters/${matter.id}`, ownerCookie);
		assert.equal(response.status, 200);
		detail = (await response.json()) as typeof detail;
		if (detail && !detail.activeRun && detail.userMessages.some((m) => m.senderType === "member")) break;
		await new Promise((done) => setTimeout(done, 500));
	}
	assert.ok(
		detail && !detail.activeRun && detail.userMessages.some((m) => m.senderType === "member"),
		"Model turn did not finish successfully",
	);
	const document = detail.spaceDocuments.find((d) => d.title === "空间协作验证稿");
	assert.ok(document, "Model did not save the requested Space document");
	const documentPath = `/api/spaces/documents/${document.id}`;
	const firstRead = await request(documentPath, peerCookie);
	assert.equal(firstRead.status, 200);
	const first = (await firstRead.json()) as { document: { content: string; headCommit: string; revision: number } };
	assert.match(first.document.content, /SPACE_TEST_4827/);
	assert.equal((await request(documentPath, outsiderCookie)).status, 403);
	const feedback = await request(`${documentPath}/feedback`, peerCookie, "POST", {
		commitHash: document.headCommit,
		feedback: "请补充验收边界",
		rating: "negative",
	});
	assert.equal(feedback.status, 200);
	const edited = await request(documentPath, ownerCookie, "PATCH", {
		title: document.title,
		revision: document.revision,
		content: `${first.document.content}\n\n验收边界：仅验证合成资料。`,
	});
	assert.equal(edited.status, 200, await edited.clone().text());
	const second = (await edited.json()) as { document: { headCommit: string; revision: number; content: string } };
	assert.equal(second.document.revision, document.revision + 1);
	assert.notEqual(second.document.headCommit, document.headCommit);
	assert.equal(
		(
			await request(documentPath, ownerCookie, "PATCH", {
				title: document.title,
				revision: document.revision,
				content: "stale",
			})
		).status,
		409,
	);
	const history = await request(`${documentPath}/commits/${document.headCommit}`, peerCookie);
	assert.equal(history.status, 200);
	const previous = (await history.json()) as { detail: { content: string } };
	assert.equal(previous.detail.content, first.document.content);
	const currentHistory = await request(`${documentPath}/commits/${second.document.headCommit}`, peerCookie);
	assert.equal(currentHistory.status, 200);
	const currentCommit = (await currentHistory.json()) as { detail: { diff: string } };
	assert.match(currentCommit.detail.diff, /验收边界：仅验证合成资料/);
	const privateMatterResponse = await request("/api/matters", ownerCookie, "POST", {
		mode: "discussion",
		orgId: org.id,
		workspaceId: workspace.id,
		visibility: "private",
		prompt: "私密资料验证",
	});
	assert.equal(privateMatterResponse.status, 201, await privateMatterResponse.clone().text());
	const privateMatter = (await privateMatterResponse.json()) as { matter: { id: string } };
	const folderResponse = await request(`/api/spaces/${document.spaceId}/documents`, ownerCookie, "POST", {
		matterId: privateMatter.matter.id,
		title: "私密目录",
		entryKind: "folder",
		content: "合成目录",
		extraFiles: [{ path: "index.html", content: "<h1>SPACE_PREVIEW_4827</h1>" }],
	});
	assert.equal(folderResponse.status, 201, await folderResponse.clone().text());
	const folder = (await folderResponse.json()) as { document: { id: string } };
	const previewPath = `/api/spaces/documents/${folder.document.id}/preview/index.html`;
	const preview = await request(previewPath, ownerCookie);
	assert.equal(preview.status, 200);
	assert.match(await preview.text(), /SPACE_PREVIEW_4827/);
	assert.match(preview.headers.get("content-security-policy") ?? "", /sandbox/);
	assert.equal((await request(previewPath, peerCookie)).status, 403);
	assert.equal((await request(`/api/spaces/documents/${folder.document.id}`, peerCookie)).status, 403);
	const feedbackRead = await request(`${documentPath}/feedback`, peerCookie);
	assert.equal(feedbackRead.status, 200);
	const savedFeedback = (await feedbackRead.json()) as { feedback: Array<{ commitHash: string; feedback: string }> };
	assert.ok(
		savedFeedback.feedback.some(
			(item) => item.commitHash === document.headCommit && item.feedback === "请补充验收边界",
		),
	);
	await writeFile(
		join(root, "evidence.json"),
		JSON.stringify(
			{
				matterId: matter.id,
				documentId: document.id,
				initial: first.document,
				revised: second.document,
				feedback: savedFeedback.feedback,
				checks: {
					accountLogin: true,
					realModelHttpDispatch: true,
					sameOrgRead: true,
					otherOrgDenied: true,
					feedbackOnOriginalCommit: true,
					edit: true,
					staleEditConflict: true,
					historicalCommit: true,
					commitDiff: true,
					privateFolderPreview: true,
				},
			},
			null,
			2,
		),
	);
	console.log(
		"PASS authenticated model dispatch, Space document, revision, feedback, stale conflict and organization isolation",
	);
} finally {
	await orchestrator.shutdown();
	await previewManager.stopAll();
	if (server.listening)
		await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
	db.close();
}
