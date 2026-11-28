import type { Hono } from "hono";
import { parseModelSelection } from "../../rpc/model-selection.ts";
import { HttpRequestError } from "../http.ts";
import type { ApiRouterEnv } from "../router.ts";
import type { ServerRouteContext } from "./context.ts";

export async function validateModelSelection(ctx: ServerRouteContext, value: unknown) {
	let selection: ReturnType<typeof parseModelSelection>;
	try {
		selection = parseModelSelection(value);
	} catch (error) {
		throw new HttpRequestError(400, error instanceof Error ? error.message : String(error));
	}
	if (!selection) return null;
	const { models } = await ctx.orchestrator.getPiModels().catch(() => {
		throw new HttpRequestError(503, "读取 Pi 模型失败，请检查服务账号是否安装并配置了 Pi");
	});
	const model = models.find((item) => item.provider === selection.provider && item.model === selection.model);
	if (!model) throw new HttpRequestError(400, "当前 Pi 账号未提供此模型，请先在 Pi 中配置供应商");
	if (selection.thinkingLevel && !model.thinkingLevels.includes(selection.thinkingLevel)) {
		throw new HttpRequestError(400, "该模型不支持选定的思考等级");
	}
	return selection;
}

/** Register runtime model catalog and default selection routes. */
export function registerModelSettingsRoutes(app: Hono<ApiRouterEnv>): void {
	app.get("/api/models", async (c) => {
		const ctx = c.var.routeCtx;
		const provider = c.req.query("provider");
		const model = c.req.query("model");
		const selection =
			provider !== undefined || model !== undefined
				? await validateModelSelection(ctx, { provider: provider ?? null, model: model ?? null })
				: null;
		const catalog = await ctx.orchestrator.getPiModels(selection ?? undefined).catch(() => {
			throw new HttpRequestError(503, "读取 Pi 模型失败，请检查服务账号是否安装并配置了 Pi");
		});
		if (selection) {
			const effective = catalog.defaultModel;
			return c.json({
				defaultModel:
					effective?.provider === selection.provider && effective.model === selection.model ? effective : null,
			});
		}
		return c.json({
			...catalog,
			platformDefault: ctx.store.getPlatformSettings().defaultModelSelection,
		});
	});
}
