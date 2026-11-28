import type { Hono } from "hono";
import {
	isManagedEnvKey,
	type ManagedEnvKey,
	readDotEnvMap,
	readWebAccessEnvFromDotEnv,
	resolveEnvFilePath,
	updateManagedDotEnv,
} from "../../extensions/env-credentials.ts";
import {
	isWebSearchProviderPreference,
	resolveEffectiveWebSearchProvider,
} from "../../extensions/web-access/runtime.ts";
import { choice, createSystemOneClassifier } from "../../orchestrator/architect/system-one.ts";
import { buildRuntimeOverview } from "../../orchestrator/runtime/runtime-info.ts";
import { HttpRequestError } from "../http.ts";
import { type ApiRouterEnv, parseJsonBody, requireSuperAdminMiddleware } from "../router.ts";
import { auditActorAction, type ServerRouteContext } from "./context.ts";

async function buildAdminRuntimeOverview(ctx: ServerRouteContext) {
	return buildRuntimeOverview({
		config: ctx.orchestrator.getRuntimeConfig(),
		serverConfig: ctx.getServerRuntimeConfig?.(),
		activeMembers: ctx.store.listMembers(),
		isOwner: true,
		probePiCli: ctx.probePiCli,
	});
}

/** Register platform administrator runtime/extension routes on the Hono API router. */
export function registerWebAccessRoutes(app: Hono<ApiRouterEnv>): void {
	app.post("/api/admin/runtime/web-access/test", requireSuperAdminMiddleware, async (c) => {
		const ctx = c.var.routeCtx;
		const { store, orchestrator } = ctx;
		const body = await parseJsonBody(c);
		const query =
			typeof body.query === "string" && body.query.trim() ? body.query.trim().slice(0, 120) : "DeepSeek API";
		const settings = store.getPlatformSettings(ctx.defaultWorkspacesRoot);
		const requestedProvider = isWebSearchProviderPreference(body.provider)
			? body.provider
			: settings.webSearchProvider;
		const envPath = resolveEnvFilePath(orchestrator.getRuntimeConfig().defaultCwd);
		const dotEnvWeb = await readWebAccessEnvFromDotEnv(envPath);
		const provider = resolveEffectiveWebSearchProvider(requestedProvider, dotEnvWeb);
		const startedAt = Date.now();
		if (!provider) {
			return c.json({
				ok: false,
				provider: null,
				latencyMs: Date.now() - startedAt,
				error: "未检测到任何已配置的网页检索密钥（EXA_API_KEY / DEEPSEEK_API_KEY / MOONSHOT_API_KEY）",
			});
		}
		const keyMap = {
			deepseek: process.env.DEEPSEEK_API_KEY?.trim() || dotEnvWeb.DEEPSEEK_API_KEY?.trim() || "",
			exa: process.env.EXA_API_KEY?.trim() || dotEnvWeb.EXA_API_KEY?.trim() || "",
			kimi: process.env.MOONSHOT_API_KEY?.trim() || dotEnvWeb.MOONSHOT_API_KEY?.trim() || "",
		};
		const apiKey = keyMap[provider];
		if (!apiKey) {
			return c.json({
				ok: false,
				provider,
				latencyMs: Date.now() - startedAt,
				error: `当前选择的供应商 ${provider} 未配置对应 API Key`,
			});
		}
		try {
			const signal = AbortSignal.timeout(15_000);
			if (provider === "deepseek") {
				const resp = await fetch("https://api.deepseek.com/v1/tools/search", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${apiKey}`,
					},
					body: JSON.stringify({ query, count: 3, need_content: false }),
					signal,
				});
				if (!resp.ok) {
					const errText = (await resp.text()).slice(0, 240);
					return c.json({
						ok: false,
						provider,
						latencyMs: Date.now() - startedAt,
						error: `HTTP ${resp.status}${errText ? `: ${errText}` : ""}`,
					});
				}
				const data = (await resp.json()) as { results?: Array<{ title?: string; url?: string }> };
				const results = Array.isArray(data.results) ? data.results : [];
				return c.json({
					ok: true,
					provider,
					latencyMs: Date.now() - startedAt,
					resultCount: results.length,
					sampleTitles: results
						.slice(0, 3)
						.map((r) => (typeof r.title === "string" && r.title.trim() ? r.title.trim() : r.url || "（无标题）")),
				});
			}
			if (provider === "exa") {
				const resp = await fetch("https://api.exa.ai/search", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"x-api-key": apiKey,
					},
					body: JSON.stringify({ query, numResults: 3 }),
					signal,
				});
				if (!resp.ok) {
					const errText = (await resp.text()).slice(0, 240);
					return c.json({
						ok: false,
						provider,
						latencyMs: Date.now() - startedAt,
						error: `HTTP ${resp.status}${errText ? `: ${errText}` : ""}`,
					});
				}
				const data = (await resp.json()) as { results?: Array<{ title?: string; url?: string }> };
				const results = Array.isArray(data.results) ? data.results : [];
				return c.json({
					ok: true,
					provider,
					latencyMs: Date.now() - startedAt,
					resultCount: results.length,
					sampleTitles: results
						.slice(0, 3)
						.map((r) => (typeof r.title === "string" && r.title.trim() ? r.title.trim() : r.url || "（无标题）")),
				});
			}
			const resp = await fetch("https://api.moonshot.cn/v1/models", {
				method: "GET",
				headers: { Authorization: `Bearer ${apiKey}` },
				signal,
			});
			if (!resp.ok) {
				const errText = (await resp.text()).slice(0, 240);
				return c.json({
					ok: false,
					provider,
					latencyMs: Date.now() - startedAt,
					error: `HTTP ${resp.status}${errText ? `: ${errText}` : ""}`,
				});
			}
			const data = (await resp.json()) as { data?: Array<{ id?: string }> };
			const count = Array.isArray(data.data) ? data.data.length : 0;
			return c.json({
				ok: true,
				provider,
				latencyMs: Date.now() - startedAt,
				resultCount: count,
				sampleTitles: [`Moonshot API 鉴权通过（可用模型 ${count} 个）`],
			});
		} catch (error) {
			return c.json({
				ok: false,
				provider,
				latencyMs: Date.now() - startedAt,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});

	app.post("/api/admin/runtime/system-one/test", requireSuperAdminMiddleware, async (c) => {
		const ctx = c.var.routeCtx;
		const { store, orchestrator } = ctx;
		const settings = store.getPlatformSettings(ctx.defaultWorkspacesRoot);
		const envPath = resolveEnvFilePath(orchestrator.getRuntimeConfig().defaultCwd);
		const dotEnv = await readDotEnvMap(envPath);
		const apiKey = process.env.TYPESAFE_API_KEY?.trim() || dotEnv.TYPESAFE_API_KEY?.trim() || "";
		const startedAt = Date.now();
		if (!apiKey) {
			return c.json({
				ok: false,
				enabled: settings.systemOneEnabled,
				latencyMs: Date.now() - startedAt,
				error: "未配置 TYPESAFE_API_KEY，请先保存密钥再测试",
			});
		}
		try {
			const classifier = createSystemOneClassifier(apiKey);
			const answers = await classifier.evaluate(
				{
					state: { prompt: "ping" },
					questions: {
						ping: choice("Select ok for connectivity check.", { ok: "Health check ok" }),
					},
				},
				AbortSignal.timeout(10_000),
			);
			const picked = answers.ping?.type === "choice" ? answers.ping.choice : "ok";
			return c.json({
				ok: true,
				enabled: settings.systemOneEnabled,
				latencyMs: Date.now() - startedAt,
				answer: picked,
			});
		} catch (error) {
			return c.json({
				ok: false,
				enabled: settings.systemOneEnabled,
				latencyMs: Date.now() - startedAt,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});

	app.patch("/api/admin/runtime/env", requireSuperAdminMiddleware, async (c) => {
		const ctx = c.var.routeCtx;
		const { store, orchestrator } = ctx;
		const actor = c.var.actor;
		const req = c.var.nodeReq!;
		const body = await parseJsonBody(c);
		const rawValues = body.values;
		if (!rawValues || typeof rawValues !== "object" || Array.isArray(rawValues)) {
			throw new HttpRequestError(400, "请提供要更新的环境变量键值映射");
		}
		const updates: Partial<Record<ManagedEnvKey, string | null>> = {};
		const auditSummary: Record<string, "set" | "cleared"> = {};
		for (const [key, value] of Object.entries(rawValues as Record<string, unknown>)) {
			if (!isManagedEnvKey(key)) {
				throw new HttpRequestError(400, `不允许修改环境变量：${key}`);
			}
			if (value !== null && typeof value !== "string") {
				throw new HttpRequestError(400, `环境变量 ${key} 必须是字符串或 null`);
			}
			if (typeof value === "string" && /[\r\n]/.test(value)) {
				throw new HttpRequestError(400, `环境变量 ${key} 不能包含换行符`);
			}
			const trimmed = typeof value === "string" ? value.trim() : "";
			updates[key] = trimmed || null;
			auditSummary[key] = trimmed ? "set" : "cleared";
		}
		if (Object.keys(updates).length === 0) {
			throw new HttpRequestError(400, "未提供需要更新的配置项");
		}
		const envPath = resolveEnvFilePath(orchestrator.getRuntimeConfig().defaultCwd);
		await updateManagedDotEnv(envPath, updates);
		if (Object.hasOwn(updates, "TYPESAFE_API_KEY") && process.env.TYPESAFE_API_KEY === undefined) {
			const refreshed = await readDotEnvMap(envPath);
			const key = refreshed.TYPESAFE_API_KEY?.trim();
			const enabled = store.getPlatformSettings(ctx.defaultWorkspacesRoot).systemOneEnabled;
			orchestrator.setClassifier(enabled && key ? createSystemOneClassifier(key) : undefined);
		}
		auditActorAction(ctx, req, actor, {
			action: "admin.env_credentials_update",
			targetType: "runtime_env",
			targetId: ".env",
			detail: { keys: auditSummary },
		});
		return c.json({ overview: await buildAdminRuntimeOverview(ctx) });
	});

	app.post("/api/admin/runtime/web-access/install", requireSuperAdminMiddleware, async (c) => {
		const ctx = c.var.routeCtx;
		const actor = c.var.actor;
		const req = c.var.nodeReq!;
		try {
			const installed = await ctx.installWebAccess();
			auditActorAction(ctx, req, actor, {
				action: "admin.web_access_install",
				targetType: "runtime_extension",
				targetId: "pi-web-access",
				detail: { version: installed.version },
			});
		} catch (error) {
			if (error instanceof HttpRequestError) throw error;
			throw new HttpRequestError(502, error instanceof Error ? error.message : String(error));
		}
		return c.json({ overview: await buildAdminRuntimeOverview(ctx) });
	});

	app.patch("/api/admin/runtime/web-access", requireSuperAdminMiddleware, async (c) => {
		const ctx = c.var.routeCtx;
		const actor = c.var.actor;
		const req = c.var.nodeReq!;
		const { provider } = await parseJsonBody(c);
		if (!isWebSearchProviderPreference(provider)) {
			throw new HttpRequestError(400, "不支持的网页检索默认供应商（可选 auto / deepseek / exa / kimi）");
		}
		ctx.store.updatePlatformSettings({ webSearchProvider: provider }, ctx.defaultWorkspacesRoot);
		auditActorAction(ctx, req, actor, {
			action: "admin.web_access_configure",
			targetType: "runtime_extension",
			targetId: "pi-web-access",
			detail: { provider },
		});
		return c.json({ overview: await buildAdminRuntimeOverview(ctx) });
	});
}
