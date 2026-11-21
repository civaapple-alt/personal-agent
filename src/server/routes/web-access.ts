import { buildRuntimeOverview, probePiCli } from "../../orchestrator/runtime-info.ts";
import { createSystemOneClassifier } from "../../orchestrator/system-one.ts";
import {
	isManagedEnvKey,
	type ManagedEnvKey,
	readDotEnvMap,
	resolveEnvFilePath,
	updateManagedDotEnv,
} from "../../pa-extensions/env-credentials.ts";
import { findInstalledPiWebAccess } from "../../pa-extensions/web-access/package.ts";
import { isWebAccessRole } from "../../pa-extensions/web-access/runtime.ts";
import type { RequestActor } from "../auth.ts";
import { HttpRequestError, readJsonBody, sendJson } from "../http.ts";
import { auditActorAction, type RouteRequest, type ServerRouteContext } from "./context.ts";

/** Settings routes called only after the platform administrator check. */
export async function handleWebAccessRoutes(
	ctx: ServerRouteContext,
	{ req, res, method, pathname }: RouteRequest,
	actor: RequestActor,
): Promise<boolean> {
	const installing = method === "POST" && pathname === "/api/admin/runtime/web-access/install";
	const configuring = method === "PATCH" && pathname === "/api/admin/runtime/web-access";
	const updatingEnv = method === "PATCH" && pathname === "/api/admin/runtime/env";
	if (!installing && !configuring && !updatingEnv) return false;

	const { store, orchestrator } = ctx;
	if (updatingEnv) {
		const body = await readJsonBody(req);
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
			orchestrator.setClassifier(key ? createSystemOneClassifier(key) : undefined);
		}
		auditActorAction(ctx, req, actor, {
			action: "admin.env_credentials_update",
			targetType: "runtime_env",
			targetId: ".env",
			detail: { keys: auditSummary },
		});
	} else if (installing) {
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
	} else {
		const { roleIds } = await readJsonBody(req);
		if (!Array.isArray(roleIds) || !roleIds.every((id): id is string => typeof id === "string")) {
			throw new HttpRequestError(400, "请提供允许使用网页检索的岗位列表");
		}
		const ids = [...new Set(roleIds)];
		if (ids.length > 0) {
			const pi = await (ctx.probePiCli ?? probePiCli)();
			if (!pi.available || !(await findInstalledPiWebAccess(pi.executable))) {
				throw new HttpRequestError(409, "请先安装 pi-web-access");
			}
		}
		const grants = ids.map((id) => {
			const member = store.getMember(id);
			if (!member || !isWebAccessRole(member, orchestrator.getTemplateForMember(member))) {
				throw new HttpRequestError(400, "请选择可参与业务事项的岗位");
			}
			return [id, member.createdAt] as const;
		});
		store.updatePlatformSettings({ webAccessRoleGrants: Object.fromEntries(grants) }, ctx.defaultWorkspacesRoot);
		auditActorAction(ctx, req, actor, {
			action: "admin.web_access_configure",
			targetType: "runtime_extension",
			targetId: "pi-web-access",
			detail: { roleIds: ids },
		});
	}

	const overview = await buildRuntimeOverview({
		config: orchestrator.getRuntimeConfig(),
		serverConfig: ctx.getServerRuntimeConfig?.(),
		activeMembers: store.listMembers(),
		isOwner: true,
		probePiCli: ctx.probePiCli,
	});
	sendJson(res, 200, { overview });
	return true;
}
