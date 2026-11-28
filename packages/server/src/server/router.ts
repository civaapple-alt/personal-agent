import type { IncomingMessage, ServerResponse } from "node:http";
import { v } from "@pa/contracts/schemas";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { WorkspaceMutationError } from "../storage/repositories.ts";
import { isSuperAdminActor, type RequestActor } from "./auth.ts";
import { BASE_SECURITY_HEADERS, HttpRequestError, readJsonBody } from "./http.ts";
import type { ServerRouteContext } from "./routes/context.ts";

export interface ApiRouterBindings {
	routeCtx: ServerRouteContext;
	actor: RequestActor | null;
	requireAuth: boolean;
	nodeReq?: IncomingMessage;
	nodeRes?: ServerResponse;
}

export type ApiRouterEnv = {
	Bindings: ApiRouterBindings;
	Variables: ApiRouterBindings;
};

export type ApiRouteContext = Context<ApiRouterEnv>;

const ROUTE_MISS_HEADER = "x-pa-route-miss";

function jsonErrorResponse(statusCode: number, message: string): Response {
	return new Response(JSON.stringify({ error: message }), {
		status: statusCode,
		headers: {
			...BASE_SECURITY_HEADERS,
			"content-type": "application/json; charset=utf-8",
		},
	});
}

function formatValiIssues(issues: [v.BaseIssue<unknown>, ...v.BaseIssue<unknown>[]]): string {
	return issues[0].message || "Invalid request payload";
}

async function parseWebRequestJsonObject(request: Request): Promise<Record<string, unknown>> {
	const raw = (await request.text()).trim();
	if (raw.length === 0) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch {
		throw new HttpRequestError(400, "Invalid JSON request body");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new HttpRequestError(400, "Request body must be a JSON object");
	}
	return parsed as Record<string, unknown>;
}

/** Create a Hono API router pre-configured with request context injection, unified error mapping, and route-miss signal. */
export function createApiRouter(): Hono<ApiRouterEnv> {
	const app = new Hono<ApiRouterEnv>();

	app.use("*", async (c, next) => {
		c.set("routeCtx", c.env.routeCtx);
		c.set("actor", c.env.actor);
		c.set("requireAuth", c.env.requireAuth);
		c.set("nodeReq", c.env.nodeReq);
		c.set("nodeRes", c.env.nodeRes);
		await next();
	});

	app.onError((error) => {
		if (error instanceof HttpRequestError || error instanceof WorkspaceMutationError) {
			return jsonErrorResponse(error.statusCode, error.message);
		}
		if (v.isValiError(error)) {
			return jsonErrorResponse(400, formatValiIssues(error.issues));
		}
		const message = error instanceof Error ? error.message : String(error);
		return jsonErrorResponse(500, message);
	});

	app.notFound((c) => c.body(null, 404, { [ROUTE_MISS_HEADER]: "1" }));

	return app;
}

/** Middleware requiring an authenticated, active actor (`401` / `403`). */
export const requireAuthMiddleware: MiddlewareHandler<ApiRouterEnv> = async (c, next) => {
	const actor = c.var.actor;
	if (!actor) {
		throw new HttpRequestError(401, "未认证，请登录或通过有效邀请进入工作台");
	}
	if (actor.authKind === "session" && actor.user) {
		if (actor.user.status === "pending_review") {
			throw new HttpRequestError(403, "账号正在等待管理员审核");
		}
		if (actor.user.status === "disabled") {
			throw new HttpRequestError(403, "当前账号已被禁用，请联系管理员");
		}
	}
	await next();
};

/** Middleware requiring a platform super_admin (or loopback owner when auth is off). */
export const requireSuperAdminMiddleware: MiddlewareHandler<ApiRouterEnv> = async (c, next) => {
	if (!isSuperAdminActor(c.var.actor)) {
		throw new HttpRequestError(403, "仅超级管理员可执行此操作");
	}
	await next();
};

/** Parse the JSON request body (capped at 36MB via `readJsonBody`) and optionally validate with a Valibot schema. */
export async function parseJsonBody(c: ApiRouteContext): Promise<Record<string, unknown>>;
export async function parseJsonBody<TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
	c: ApiRouteContext,
	schema: TSchema,
): Promise<v.InferOutput<TSchema>>;
export async function parseJsonBody<TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
	c: ApiRouteContext,
	schema?: TSchema,
): Promise<Record<string, unknown> | v.InferOutput<TSchema>> {
	const rawObject = c.var.nodeReq ? await readJsonBody(c.var.nodeReq) : await parseWebRequestJsonObject(c.req.raw);
	if (!schema) return rawObject;
	const parsed = v.safeParse(schema, rawObject);
	if (!parsed.success) {
		throw new HttpRequestError(400, formatValiIssues(parsed.issues), "VALIDATION_ERROR");
	}
	return parsed.output;
}

/**
 * Bridge a Node HTTP request/response through a Hono router.
 * Returns `false` cleanly without touching `res` when no Hono route matched.
 */
export async function dispatchHonoRequest(
	app: Hono<ApiRouterEnv>,
	req: IncomingMessage,
	res: ServerResponse,
	env: ApiRouterBindings,
): Promise<boolean> {
	const headers = new Headers();
	for (const [key, value] of Object.entries(req.headers)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) {
			for (const entry of value) headers.append(key, entry);
		} else {
			headers.set(key, value);
		}
	}
	const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1").toString();
	const request = new Request(requestUrl, {
		method: req.method ?? "GET",
		headers,
	});

	const response = await app.fetch(request, { ...env, nodeReq: req, nodeRes: res });
	if (res.writableEnded) return true;
	if (response.headers.get(ROUTE_MISS_HEADER) === "1") return false;

	const outHeaders: Record<string, string | string[]> = { ...BASE_SECURITY_HEADERS };
	for (const [key, value] of response.headers.entries()) {
		if (key.toLowerCase() === "set-cookie") continue;
		outHeaders[key] = value;
	}
	const setCookies = response.headers.getSetCookie();
	if (setCookies.length > 0) {
		outHeaders["Set-Cookie"] = setCookies.length === 1 ? setCookies[0]! : setCookies;
	}
	const bodyBuffer = Buffer.from(await response.arrayBuffer());
	outHeaders["Content-Length"] = String(bodyBuffer.byteLength);
	res.writeHead(response.status, outHeaders);
	res.end(bodyBuffer);
	return true;
}
