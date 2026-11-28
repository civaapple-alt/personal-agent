import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
	AuthLoginSchema,
	CreateBoardPostSchema,
	CreateSpaceSchema,
	DialogRespondSchema,
	UpdateSkillTrustSchema,
	v,
} from "@pa/contracts/schemas";
import type { RequestActor } from "../packages/server/src/server/auth.ts";
import { HttpRequestError, readJsonBody, readRawBody } from "../packages/server/src/server/http.ts";
import {
	type ApiRouterBindings,
	createApiRouter,
	dispatchHonoRequest,
	parseJsonBody,
	requireAuthMiddleware,
	requireSuperAdminMiddleware,
} from "../packages/server/src/server/router.ts";
import type { ServerRouteContext } from "../packages/server/src/server/routes/context.ts";
import { WorkspaceMutationError } from "../packages/server/src/storage/repositories.ts";

function makeActor(
	platformRole: "super_admin" | "user" = "user",
	status: "active" | "disabled" = "active",
): RequestActor {
	return {
		authKind: "session",
		viaToken: false,
		collaborator: {
			id: "collab_1",
			orgId: "org_1",
			name: "Tester",
			roleTitle: "Member",
			permissionRole: platformRole === "super_admin" ? "owner" : "collaborator",
			createdAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:00:00Z",
		},
		user: {
			id: "usr_1",
			email: "tester@example.com",
			displayName: "Tester",
			passwordHash: "scrypt:mock",
			platformRole,
			status,
			maxOrgs: 3,
			maxActiveDispatches: 3,
			maxPersonalRoles: 5,
			canDispatchAi: true,
			createdAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:00:00Z",
		},
	};
}

test("@pa/contracts/schemas validates boundary payloads accurately", () => {
	assert.equal(v.safeParse(DialogRespondSchema, { confirmed: true }).success, true);
	assert.equal(v.safeParse(DialogRespondSchema, { cancelled: true }).success, true);
	assert.equal(v.safeParse(DialogRespondSchema, { value: "ok" }).success, true);
	const badDialog = v.safeParse(DialogRespondSchema, {});
	assert.equal(badDialog.success, false);
	if (!badDialog.success) {
		assert.equal(badDialog.issues[0].message, "Expected confirmed, value, or cancelled");
	}

	const goodBoard = v.safeParse(CreateBoardPostSchema, { summary: "  Implement router  ", kind: "progress" });
	assert.equal(goodBoard.success, true);
	if (goodBoard.success) {
		assert.equal(goodBoard.output.summary, "Implement router");
	}
	assert.equal(v.safeParse(CreateBoardPostSchema, { summary: "   " }).success, false);

	assert.equal(
		v.safeParse(UpdateSkillTrustSchema, {
			scope: "global",
			scopeId: "",
			skillName: "pstack",
			trustLevel: "autonomous",
		}).success,
		true,
	);
	assert.equal(
		v.safeParse(UpdateSkillTrustSchema, {
			scope: "invalid",
			scopeId: "",
			skillName: "pstack",
			trustLevel: "autonomous",
		}).success,
		false,
	);

	assert.equal(v.safeParse(CreateSpaceSchema, { name: "Specs" }).success, true);
	assert.equal(v.safeParse(AuthLoginSchema, { email: "a@b.com", password: "secret" }).success, true);
	assert.equal(v.safeParse(AuthLoginSchema, { email: "", password: "secret" }).success, false);
});

test("Hono API router maps middleware auth, Valibot 400s, domain errors, cookies, and route-miss fallthrough", async () => {
	const app = createApiRouter();
	const guarded = app.basePath("/api/protected");
	guarded.use("*", requireAuthMiddleware);
	guarded.post("/dialog", async (c) => {
		const body = await parseJsonBody(c, DialogRespondSchema);
		c.header("Set-Cookie", "pa_test=1; Path=/");
		c.header("Set-Cookie", "pa_test2=2; Path=/", { append: true });
		return c.json({ ok: true, body });
	});
	guarded.get("/admin-only", requireSuperAdminMiddleware, (c) => c.json({ ok: true }));
	app.get("/api/http-err", () => {
		throw new HttpRequestError(409, "Conflict test");
	});
	app.get("/api/ws-err", () => {
		throw new WorkspaceMutationError(409, "Workspace conflict test");
	});

	let activeActor: RequestActor | null = makeActor("user", "active");
	let missCount = 0;

	const server = createServer(async (req, res) => {
		const env: ApiRouterBindings = {
			routeCtx: {} as ServerRouteContext,
			actor: activeActor,
			requireAuth: true,
		};
		// Verify memoized readRawBody can inspect stream without breaking downstream parseJsonBody.
		if (req.method === "POST") {
			const buf1 = await readRawBody(req);
			const buf2 = await readRawBody(req);
			assert.equal(buf1, buf2);
		}
		const matched = await dispatchHonoRequest(app, req, res, env);
		if (!matched) {
			missCount += 1;
			res.writeHead(404, { "content-type": "application/json" });
			res.end(JSON.stringify({ fallback: true }));
		}
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	const base = `http://127.0.0.1:${port}`;

	try {
		// 1. Valid schema + multi Set-Cookie + security headers
		const res1 = await fetch(`${base}/api/protected/dialog`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ confirmed: true }),
		});
		assert.equal(res1.status, 200);
		assert.equal(res1.headers.get("x-content-type-options"), "nosniff");
		assert.equal(res1.headers.getSetCookie().length, 2);
		assert.deepEqual(await res1.json(), { ok: true, body: { confirmed: true } });

		// 2. Invalid schema -> 400 with exact message
		const res2 = await fetch(`${base}/api/protected/dialog`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		assert.equal(res2.status, 400);
		assert.deepEqual(await res2.json(), { error: "Expected confirmed, value, or cancelled" });

		// 3. Super-admin guard -> 403 for user, 200 for super_admin
		const res3 = await fetch(`${base}/api/protected/admin-only`);
		assert.equal(res3.status, 403);
		activeActor = makeActor("super_admin", "active");
		const res4 = await fetch(`${base}/api/protected/admin-only`);
		assert.equal(res4.status, 200);

		// 4. Unauthenticated -> 401
		activeActor = null;
		const res5 = await fetch(`${base}/api/protected/admin-only`);
		assert.equal(res5.status, 401);

		// 5. HttpRequestError & WorkspaceMutationError mapping
		const res6 = await fetch(`${base}/api/http-err`);
		assert.equal(res6.status, 409);
		const res7 = await fetch(`${base}/api/ws-err`);
		assert.equal(res7.status, 409);

		// 6. Unmatched route falls through cleanly without touching response
		const res8 = await fetch(`${base}/api/unmatched`);
		assert.equal(res8.status, 404);
		assert.deepEqual(await res8.json(), { fallback: true });
		assert.equal(missCount, 1);

		// Silence unused readJsonBody typecheck warning by testing direct request path
		assert.equal(typeof readJsonBody, "function");
	} finally {
		await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
	}
});
