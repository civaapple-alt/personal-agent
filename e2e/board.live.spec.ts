import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { seedBoardSmokeWorkspace } from "../packages/server/src/demo/board-smoke.ts";
import { createE2eRunDir, type E2eRunDir } from "./fixtures/run-dir.ts";
import { type IsolatedPaServer, startIsolatedPaServer } from "./fixtures/server.ts";
import { loadLiveE2eConfig, resolveLiveModelConfig } from "./live/config.ts";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let server: IsolatedPaServer | undefined;
let runDir: E2eRunDir | undefined;

test.afterEach(async () => {
	await server?.stop();
	server = undefined;
});

test("@live 0.9.0 Board UI + real Pi end-to-end delivery with deterministic verification", async ({ page }) => {
	const startedAt = Date.now();
	const loadedCfg = loadLiveE2eConfig(ROOT_DIR);
	const preferredProfile =
		process.env.PA_E2E_PROFILE?.trim() ||
		(loadedCfg?.config.profiles?.["cross-verify"] ? "cross-verify" : undefined);

	const resolved = resolveLiveModelConfig({
		rootDir: ROOT_DIR,
		profile: preferredProfile,
	});
	if (!resolved.provider || !resolved.model) {
		throw new Error("Configure e2e/live.config.json (or PA_E2E_PROVIDER + PA_E2E_MODEL) before running @live E2E.");
	}

	runDir = createE2eRunDir("board-browser-live", ROOT_DIR, {
		kind: "e2e:browser:live",
		profile: resolved.profileName,
		provider: resolved.provider,
		model: resolved.model,
		thinkingLevel: resolved.thinkingLevel,
		verifierProvider: resolved.verifierProvider,
		verifierModel: resolved.verifierModel,
	});

	await seedBoardSmokeWorkspace(runDir.workspaceDir);

	let verdict: "PASS" | "FAIL" = "FAIL";
	let matterId: string | null = null;
	let errorMessage: string | undefined;
	const capturedArtifacts: Record<string, unknown> = {};

	try {
		server = await startIsolatedPaServer({
			authMode: "personal",
			livePi: true,
			persistentRunDir: runDir.dir,
			defaultModelSelection: {
				provider: resolved.provider,
				model: resolved.model,
				...(resolved.thinkingLevel ? { thinkingLevel: resolved.thinkingLevel } : {}),
			},
			registerWorkspace: {
				name: "board-live-fixture",
				repoPath: runDir.workspaceDir,
			},
		});

		const activeServer = server;
		const pageErrors: Error[] = [];
		page.on("pageerror", (error) => {
			pageErrors.push(error);
		});

		await page.goto(activeServer.baseUrl);
		await expect(page.getByRole("region", { name: "新事项参与安排" })).toBeVisible();

		// Select the seeded fixture workspace and switch collaboration mode to Board.
		await page.getByLabel("项目仓库").selectOption(activeServer.registeredWorkspaceId!);
		await page.getByRole("button", { name: "团队公告板 (Board)" }).click();
		await expect(page.getByRole("button", { name: "团队公告板 (Board)" })).toHaveAttribute("aria-pressed", "true");

		const verifierHint =
			resolved.verifierProvider && resolved.verifierModel
				? `（如需指定 verifier 模型，请使用 ${resolved.verifierProvider}/${resolved.verifierModel}）`
				: "";

		const prompt = [
			"请在当前公告板模式下完成一个极小的端到端交付闭环：",
			"1. 由你（Coordinator）调用 `spawn_board_agent` 动态创建两名成员：",
			"   - `builder-math`（boardRole='builder'，ownedScope=['src/math.mjs']）：修复 `src/math.mjs` 中的 `clamp(value, min, max)`，使 `min > max` 抛出 `RangeError` 且边界钳制正确，然后发 `handoff` 帖 `@verifier-math` 请求验收。",
			`   - \`verifier-math\`（boardRole='verifier'，只读/只测，ownedScope=['test/math.test.mjs']，acceptanceCriteria='运行 node --test test/math.test.mjs 全部通过且 src/math.mjs 处理 min > max'）${verifierHint}：独立核查并运行测试，通过则发 \`verify_pass\` 帖 \`@coordinator\`（含 verification.verdict='pass'），未通过则发 \`verify_rework\` 帖 \`@builder-math\`。`,
			"2. 创建完毕后发 `#1 assign` 帖 `@builder-math` 启动任务。",
			"3. 等 `verifier-math` 发出 `verify_pass` 并 `@coordinator` 后，由你发最终 `summary` 帖并向用户汇报结果。",
		].join("\n");

		await page.getByPlaceholder("说说想法、安排工作，或 @ 成员…").fill(prompt);
		await page.getByRole("button", { name: "发送" }).click();

		await page.waitForURL(/#\/chats\/mat_/, { timeout: 30_000 });
		const urlMatch = /#\/chats\/(mat_[^/?#]+)/.exec(page.url());
		expect(urlMatch).toBeTruthy();
		matterId = decodeURIComponent(urlMatch![1]!);

		const strip = page.getByRole("region", { name: "公告板协作状态" });
		await expect(strip).toBeVisible();
		await strip.getByRole("button", { name: "打开看板" }).click();

		const pane = page.getByRole("complementary", { name: "团队公告板面板" });
		await expect(pane).toBeVisible();

		// Wait deterministically for the real Coordinator/Builder/Verifier turn to settle.
		interface LiveBoardSnapshot {
			members: Array<{ agentId: string; boardRole: string; status: string; lastReadPostNo: number }>;
			posts: Array<{ postNo: number; kind: string; authorId: string; mentions: string[]; summary: string }>;
		}
		const settleDeadline = Date.now() + 300_000;
		let finalSnapshot: LiveBoardSnapshot | null = null;

		while (Date.now() < settleDeadline) {
			const [detailRes, boardRes] = await Promise.all([
				page.request.get(`${activeServer.baseUrl}/api/matters/${encodeURIComponent(matterId)}`),
				page.request.get(`${activeServer.baseUrl}/api/matters/${encodeURIComponent(matterId)}/board`),
			]);
			expect(detailRes.ok()).toBe(true);
			expect(boardRes.ok()).toBe(true);

			const detailJson = (await detailRes.json()) as { activeRun: unknown | null };
			const boardJson = (await boardRes.json()) as LiveBoardSnapshot;
			finalSnapshot = boardJson;

			const hasVerify = boardJson.posts.some((p) => p.kind === "verify_pass" || p.kind === "verify_rework");
			if (!detailJson.activeRun && boardJson.posts.length >= 2 && hasVerify) {
				break;
			}
			await page.waitForTimeout(2500);
		}

		expect(finalSnapshot).toBeTruthy();
		await page.waitForTimeout(500);

		// Capture real browser screenshots of Members, Board, and Mention Graph into `.data-e2e/runs/.../logs/`.
		await pane.getByRole("tab", { name: /成员/ }).click();
		const membersShot = join(runDir.logsDir, "board-members.png");
		await page.screenshot({ path: membersShot, fullPage: false });

		await pane.getByRole("tab", { name: /公告板/ }).click();
		const postsShot = join(runDir.logsDir, "board-posts.png");
		await page.screenshot({ path: postsShot, fullPage: false });

		await pane.getByRole("tab", { name: "关系图" }).click();
		const graphShot = join(runDir.logsDir, "board-graph.png");
		await page.screenshot({ path: graphShot, fullPage: false });

		// Deterministic verdict checks (LLM never decides pass):
		const testOutput = execFileSync(process.execPath, ["--test", "test/math.test.mjs"], {
			cwd: runDir.workspaceDir,
			encoding: "utf8",
		});

		const hasCoordinator = finalSnapshot!.members.some((m) => m.boardRole === "coordinator");
		const hasBuilder = finalSnapshot!.members.some((m) => m.boardRole === "builder");
		const hasVerifier = finalSnapshot!.members.some((m) => m.boardRole === "verifier");
		const hasHandoff = finalSnapshot!.posts.some((p) => p.kind === "handoff");
		const hasVerifyPass = finalSnapshot!.posts.some((p) => p.kind === "verify_pass");

		expect(hasCoordinator).toBe(true);
		expect(hasBuilder).toBe(true);
		expect(hasVerifier).toBe(true);
		expect(hasHandoff).toBe(true);
		expect(hasVerifyPass).toBe(true);
		expect(pageErrors, `Unexpected page errors: ${pageErrors.map((e) => e.message).join("; ")}`).toEqual([]);

		const summaryPath = join(runDir.logsDir, "summary.json");
		writeFileSync(
			summaryPath,
			`${JSON.stringify({ matterId, resolved, finalSnapshot, mathTestOutput: testOutput }, null, 2)}\n`,
			"utf8",
		);
		capturedArtifacts.membersShot = membersShot;
		capturedArtifacts.postsShot = postsShot;
		capturedArtifacts.graphShot = graphShot;
		capturedArtifacts.summaryPath = summaryPath;
		capturedArtifacts.memberCount = finalSnapshot!.members.length;
		capturedArtifacts.postCount = finalSnapshot!.posts.length;

		verdict = "PASS";
	} catch (error) {
		errorMessage = error instanceof Error ? error.message : String(error);
		throw error;
	} finally {
		runDir?.recordResult({
			verdict,
			durationMs: Date.now() - startedAt,
			profile: resolved.profileName,
			provider: resolved.provider,
			model: resolved.model,
			thinkingLevel: resolved.thinkingLevel,
			verifierProvider: resolved.verifierProvider,
			verifierModel: resolved.verifierModel,
			matterId,
			artifacts: capturedArtifacts,
			...(errorMessage ? { error: errorMessage } : {}),
		});
	}
});
