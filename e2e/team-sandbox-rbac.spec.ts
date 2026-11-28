import { expect, test } from "@playwright/test";
import { type IsolatedPaServer, startIsolatedPaServer } from "./fixtures/server.ts";

let server: IsolatedPaServer | undefined;

test.beforeEach(async () => {
	server = await startIsolatedPaServer({ authMode: "team-sandbox", seedBoard: true });
});

test.afterEach(async () => {
	await server?.stop();
	server = undefined;
});

test("team sandbox enforces auth gate, org isolation in Spaces, and read-only viewer ACL on Board", async ({
	browser,
}) => {
	const activeServer = server!;
	const pageErrors: Error[] = [];
	const matterId = activeServer.seededBoardMatterId!;

	// 1. Owner context: unauthenticated shows AuthGateView, login reveals Alpha Studio deliverables + Board controls.
	const ownerCtx = await browser.newContext();
	const ownerPage = await ownerCtx.newPage();
	ownerPage.on("pageerror", (error) => pageErrors.push(error));

	await ownerPage.goto(activeServer.baseUrl);
	await expect(ownerPage.getByRole("heading", { name: "Personal Agent 团队工作台", level: 1 })).toBeVisible();

	await ownerPage.getByLabel("邮箱").fill("owner@alpha.local");
	await ownerPage.getByLabel("密码").fill(activeServer.sandboxPassword);
	await ownerPage.getByRole("button", { name: "登录进入工作台" }).click();

	await expect(ownerPage.getByRole("button", { name: "展开工作台与设置菜单" })).toBeVisible();
	await expect(ownerPage.getByRole("button", { name: "Alpha 所有者 · 成员" })).toBeVisible();

	await ownerPage.goto(`${activeServer.baseUrl}/#/deliverables`);
	await expect(ownerPage.getByRole("heading", { name: "资料空间", level: 1 })).toBeVisible();
	await expect(ownerPage.getByRole("button", { name: /^资料 Q4 发布计划与架构方案/ })).toBeVisible();

	await ownerPage.goto(`${activeServer.baseUrl}/#/chats/${encodeURIComponent(matterId)}`);
	await ownerPage.getByRole("button", { name: "打开看板" }).click();
	const ownerPane = ownerPage.getByRole("complementary", { name: "团队公告板面板" });
	await expect(
		ownerPane.locator(".board-member-card", { hasText: "@builder-ui" }).getByRole("button", { name: "暂停" }),
	).toBeVisible();
	await ownerCtx.close();

	// 2. Read-only org_viewer context: sees Alpha public docs (never Beta docs) and has no member control actions.
	const viewerCtx = await browser.newContext();
	const viewerPage = await viewerCtx.newPage();
	viewerPage.on("pageerror", (error) => pageErrors.push(error));

	await viewerPage.goto(activeServer.baseUrl);
	await expect(viewerPage.getByRole("heading", { name: "Personal Agent 团队工作台", level: 1 })).toBeVisible();
	await viewerPage.getByLabel("邮箱").fill("viewer@alpha.local");
	await viewerPage.getByLabel("密码").fill(activeServer.sandboxPassword);
	await viewerPage.getByRole("button", { name: "登录进入工作台" }).click();
	await expect(viewerPage.getByRole("button", { name: "展开工作台与设置菜单" })).toBeVisible();

	await viewerPage.goto(`${activeServer.baseUrl}/#/deliverables`);
	await expect(viewerPage.getByRole("button", { name: /^资料 Q4 发布计划与架构方案/ })).toBeVisible();
	await expect(viewerPage.getByText("Beta 开放平台接口规范")).toHaveCount(0);

	// Verify org_viewer read-only Board access + 403 server guard on direct post attempt.
	await viewerPage.goto(`${activeServer.baseUrl}/#/chats/${encodeURIComponent(matterId)}`);
	await viewerPage.getByRole("button", { name: "打开看板" }).click();
	const viewerPane = viewerPage.getByRole("complementary", { name: "团队公告板面板" });
	await expect(viewerPane).toBeVisible();
	await expect(viewerPane.getByRole("button", { name: "暂停" })).toHaveCount(0);
	await expect(viewerPane.getByRole("button", { name: "退场" })).toHaveCount(0);

	const deniedPost = await viewerPage.request.post(
		`${activeServer.baseUrl}/api/matters/${encodeURIComponent(matterId)}/board/posts`,
		{
			data: { kind: "clarification", summary: "viewer should be denied", autoResume: false },
		},
	);
	expect(deniedPost.status()).toBe(403);
	await viewerCtx.close();

	expect(pageErrors, `Unexpected uncaught page errors: ${pageErrors.map((e) => e.message).join("; ")}`).toEqual([]);
});
