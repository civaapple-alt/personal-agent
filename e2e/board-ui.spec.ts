import { expect, test } from "@playwright/test";
import { type IsolatedPaServer, startIsolatedPaServer } from "./fixtures/server.ts";

let server: IsolatedPaServer | undefined;

test.beforeEach(async () => {
	server = await startIsolatedPaServer({ authMode: "personal", seedBoard: true });
});

test.afterEach(async () => {
	await server?.stop();
	server = undefined;
});

test("0.9.0 Board UI M1-M4: members governance, lazy feed, graph jump, paginated events, and live SSE push", async ({
	page,
}) => {
	const activeServer = server!;
	const pageErrors: Error[] = [];
	page.on("pageerror", (error) => {
		pageErrors.push(error);
	});

	const matterId = activeServer.seededBoardMatterId;
	expect(matterId).toBeTruthy();

	await page.goto(`${activeServer.baseUrl}/#/chats/${encodeURIComponent(matterId!)}`);

	const strip = page.getByRole("region", { name: "公告板协作状态" });
	await expect(strip).toBeVisible();
	await strip.getByRole("button", { name: "打开看板" }).click();

	const pane = page.getByRole("complementary", { name: "团队公告板面板" });
	await expect(pane).toBeVisible();
	await expect(pane.getByRole("heading", { name: "团队公告板", level: 2 })).toBeVisible();

	// 1. Members tab: Coordinator pinned without retire button, hideInactive toggle, collapsed Retired group,
	//    pause/resume, waiting-only model hot-swap modal, working disabled guard, and retire transition.
	const coordinatorSection = pane.getByRole("region", { name: "交付总控" });
	await expect(coordinatorSection).toContainText("@product-manager");
	await expect(coordinatorSection.getByRole("button", { name: "退场" })).toHaveCount(0);

	// Retired group starts collapsed by default; expand it to verify Round-1 member visibility.
	const retiredSection = pane.getByRole("region", { name: "已退场" });
	await expect(retiredSection.getByText("@contracts-m1")).toHaveCount(0);
	await retiredSection.getByRole("button", { name: "展开" }).click();
	await expect(retiredSection.getByText("@contracts-m1")).toBeVisible();
	await retiredSection.getByRole("button", { name: "收起" }).click();

	// Toggle "隐藏非活跃" on and back off.
	const hideInactiveBtn = pane.getByRole("button", { name: "隐藏非活跃" });
	await hideInactiveBtn.click();
	await expect(pane.getByRole("button", { name: "已隐藏非活跃成员" })).toHaveAttribute("aria-pressed", "true");
	await expect(pane.getByRole("region", { name: "已退场" })).toHaveCount(0);
	await pane.getByRole("button", { name: "已隐藏非活跃成员" }).click();
	await expect(pane.getByRole("region", { name: "已退场" })).toBeVisible();

	// Working member (@verifier-qa) disables model swap and hides retire button.
	const workingCard = pane.locator(".board-member-card", { hasText: "@verifier-qa" });
	await expect(workingCard.getByRole("button", { name: "切换模型" })).toBeDisabled();
	await expect(workingCard.getByText("执行中不可换模型")).toBeVisible();
	await expect(workingCard.getByRole("button", { name: "退场" })).toHaveCount(0);

	// Waiting member (@builder-ui) supports pause/resume and opening the model hot-swap modal.
	const waitingCard = pane.locator(".board-member-card", { hasText: "@builder-ui" });
	await waitingCard.getByRole("button", { name: "暂停" }).click();
	await expect(waitingCard.getByRole("button", { name: "恢复" })).toBeVisible();
	await waitingCard.getByRole("button", { name: "恢复" }).click();
	await expect(waitingCard.getByRole("button", { name: "暂停" })).toBeVisible();

	await waitingCard.getByRole("button", { name: "切换模型" }).click();
	const modal = page.getByRole("dialog");
	await expect(modal).toContainText("为 @builder-ui 热切换模型");
	await modal.getByRole("button", { name: "确认切换" }).click();
	await expect(modal).toBeHidden();

	// Stopped non-coordinator member (@builder-api) supports one-click retire.
	const stoppedCard = pane.locator(".board-member-card", { hasText: "@builder-api" });
	await stoppedCard.getByRole("button", { name: "退场" }).click();
	await expect(pane.locator(".board-member-card", { hasText: "@builder-api" })).toHaveCount(0);

	// 2. Board tab: search/kind filtering, lazy Markdown body load/collapse, and direct post composer.
	await pane.getByRole("tab", { name: /公告板/ }).click();
	await pane.getByRole("button", { name: "验收打回" }).click();
	await expect(pane.locator(".board-post-card")).toHaveCount(1);
	await expect(pane.getByText("打回重修：请补充懒加载正文边界与空态测试")).toBeVisible();
	await pane.getByRole("button", { name: "全部", exact: true }).click();
	await expect(pane.locator(".board-post-card")).toHaveCount(5);

	const searchInput = pane.getByLabel("搜索公告板帖子");
	await searchInput.fill("#4");
	await expect(pane.locator(".board-post-card")).toHaveCount(1);
	const post4Card = pane.locator(".board-post-card").first();
	await post4Card.getByRole("button", { name: "查看正文" }).click();
	await expect(post4Card.getByText("E2E Lazy Body Marker")).toBeVisible();
	await post4Card.getByRole("button", { name: "收起正文" }).click();
	await expect(post4Card.getByText("E2E Lazy Body Marker")).toHaveCount(0);
	await searchInput.fill("");

	// Submit a post without mentions from the UI composer (avoids triggering offline Pi wakeups).
	await pane.getByLabel("公告板摘要").fill("来自 Playwright 浏览器的直接板帖");
	await pane.getByRole("button", { name: "发布板帖" }).click();
	await expect(pane.getByText("来自 Playwright 浏览器的直接板帖")).toBeVisible();

	// 3. Graph tab: SVG @mention graph renders and clicking @agentId chip jumps to filtered Board tab.
	await pane.getByRole("tab", { name: "关系图" }).click();
	const svg = pane.getByRole("img", { name: "团队 @mention 协作关系图" });
	await expect(svg).toBeVisible();
	await expect(svg.locator("g.board-graph-node")).toHaveCount(6);

	await pane.getByRole("button", { name: "显示全部历史" }).click();
	await expect(pane.getByRole("button", { name: "仅看活跃成员" })).toHaveAttribute("aria-pressed", "true");
	await expect(svg.locator("g.board-graph-node")).toHaveCount(3);
	await pane.getByRole("button", { name: "仅看活跃成员" }).click();

	await pane.locator(".board-graph-node-filters").getByRole("button", { name: "@verifier-qa" }).click();
	await expect(pane.getByLabel("搜索公告板帖子")).toHaveValue("@verifier-qa");
	await pane.getByLabel("搜索公告板帖子").fill("");

	// 4. Events tab: monitor_alert highlight, type filter, and cursor pagination ("加载更多").
	await pane.getByRole("tab", { name: "事件轨迹" }).click();
	await expect(pane.locator(".board-event-row")).toHaveCount(30);
	await expect(pane.locator(".board-event-row.is-alert")).toContainText("停滞告警");

	await pane.getByRole("button", { name: "停滞告警" }).click();
	await expect(pane.locator(".board-event-row")).toHaveCount(1);
	await pane.getByRole("button", { name: "全部事件" }).click();
	await expect(pane.locator(".board-event-row")).toHaveCount(30);

	await pane.getByRole("button", { name: "加载更多" }).click();
	await expect(pane.locator(".board-event-row")).toHaveCount(55);
	await expect(pane.getByRole("button", { name: "加载更多" })).toHaveCount(0);

	// 5. Shared /api/events SSE push updates Board UI live without page reload.
	await pane.getByRole("tab", { name: /公告板/ }).click();
	await expect(page.locator(".sidebar-footer-bar .pill.live")).toBeVisible();
	const pushRes = await page.request.post(
		`${activeServer.baseUrl}/api/matters/${encodeURIComponent(matterId!)}/board/posts`,
		{
		data: {
			kind: "progress",
			summary: "SSE 实时增量推送验证",
			body: "通过 /api/events 实时抵达浏览器看板",
			autoResume: false,
		},
	});
	expect(pushRes.status()).toBe(201);
	await expect(pane.getByText("SSE 实时增量推送验证")).toBeVisible();

	expect(pageErrors, `Unexpected uncaught page errors: ${pageErrors.map((e) => e.message).join("; ")}`).toEqual([]);
});
