import { parseModelSelection } from "../../rpc/model-selection.ts";
import { HttpRequestError, sendJson } from "../http.ts";
import type { RouteRequest, ServerRouteContext } from "./context.ts";

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

export async function handleModelSettingsRoutes(ctx: ServerRouteContext, r: RouteRequest): Promise<boolean> {
	if (r.method !== "GET" || r.pathname !== "/api/models") return false;
	const query = new URL(r.req.url ?? "/api/models", "http://localhost").searchParams;
	const selection =
		query.has("provider") || query.has("model")
			? await validateModelSelection(ctx, { provider: query.get("provider"), model: query.get("model") })
			: null;
	const catalog = await ctx.orchestrator.getPiModels(selection ?? undefined).catch(() => {
		throw new HttpRequestError(503, "读取 Pi 模型失败，请检查服务账号是否安装并配置了 Pi");
	});
	if (selection) {
		const effective = catalog.defaultModel;
		sendJson(r.res, 200, {
			defaultModel:
				effective?.provider === selection.provider && effective.model === selection.model ? effective : null,
		});
		return true;
	}
	sendJson(r.res, 200, {
		...catalog,
		platformDefault: ctx.store.getPlatformSettings().defaultModelSelection,
	});
	return true;
}
