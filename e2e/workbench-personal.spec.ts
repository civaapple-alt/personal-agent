import { expect, test } from "@playwright/test";
import { type IsolatedPaServer, startIsolatedPaServer } from "./fixtures/server.ts";

let server: IsolatedPaServer | undefined;

test.beforeEach(async () => {
	server = await startIsolatedPaServer({ authMode: "personal" });
});

test.afterEach(async () => {
	await server?.stop();
	server = undefined;
});

test("personal workbench renders SPA views, creates discussion matter, and switches lead/board mode", async ({
	page,
}) => {
	const activeServer = server!;
	const pageErrors: Error[] = [];
	page.on("pageerror", (error) => {
		pageErrors.push(error);
	});

	await page.goto(activeServer.baseUrl);

	await expect(page.getByText("Personal Agent")).toBeVisible();
	await expect(page.getByRole("region", { name: "新事项参与安排" })).toBeVisible();

	// Toggle collaboration mode in initiation panel between Lead and Board, verifying mode-specific controls.
	const boardModeBtn = page.getByRole("button", { name: "团队公告板 (Board)" });
	const leadModeBtn = page.getByRole("button", { name: "轻量主责" });
	await expect(leadModeBtn).toHaveAttribute("aria-pressed", "true");
	await page.getByRole("button", { name: "调整参与方式" }).click();
	await expect(page.getByLabel("新事项主责 AI")).toBeVisible();
	await expect(page.getByRole("group", { name: "可委托成员设置" })).toBeVisible();

	await boardModeBtn.click();
	await expect(boardModeBtn).toHaveAttribute("aria-pressed", "true");
	await expect(page.getByText(/团队公告板 ·/)).toBeVisible();
	await expect(page.getByLabel("新事项交付总控 AI")).toBeVisible();
	await expect(page.getByRole("group", { name: "可委托成员设置" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "请 AI 决策阵型" })).toHaveCount(0);

	await leadModeBtn.click();
	await expect(leadModeBtn).toHaveAttribute("aria-pressed", "true");
	await expect(page.getByRole("group", { name: "可委托成员设置" })).toBeVisible();

	// Navigate across secondary workbench views via the sidebar footer menu.
	const menuTrigger = page.getByRole("button", { name: "展开工作台与设置菜单" });
	await menuTrigger.click();
	await page.getByRole("menuitem", { name: "资料空间" }).click();
	await expect(page.getByRole("heading", { name: "资料空间", level: 1 })).toBeVisible();

	await menuTrigger.click();
	await page.getByRole("menuitem", { name: /AI 团队/ }).click();
	await expect(page.getByRole("heading", { name: "AI 团队", level: 1 })).toBeVisible();

	await menuTrigger.click();
	await page.getByRole("menuitem", { name: /^设置/ }).click();
	await expect(page.getByRole("heading", { name: "设置", level: 1 })).toBeVisible();

	// Create a no-LLM discussion matter via HTTP API, open it, and toggle Lead <-> Board in the L1 strip.
	const created = await page.request.post(`${activeServer.baseUrl}/api/matters`, {
		data: {
			mode: "discussion",
			title: "E2E 模式切换验证事项",
			prompt: "仅用于无模型模式切换验证",
			collaborationMode: "lead",
		},
	});
	expect(created.status()).toBe(201);
	const payload = (await created.json()) as { matter: { id: string } };
	await page.goto(`${activeServer.baseUrl}/#/chats/${encodeURIComponent(payload.matter.id)}`);

	const strip = page.getByRole("region", { name: "公告板协作状态" });
	await expect(strip).toBeVisible();
	await expect(strip.getByText("当前为轻量主责模式（Lead）")).toBeVisible();

	await strip.getByRole("button", { name: "升级为 Board 团队交付" }).click();
	await expect(strip.getByRole("button", { name: "切回轻量主责" })).toBeVisible();
	await expect(strip.getByRole("button", { name: "打开看板" })).toBeVisible();

	expect(pageErrors, `Unexpected uncaught page errors: ${pageErrors.map((e) => e.message).join("; ")}`).toEqual([]);
});
