import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { createWorkbenchQueryClient, queryKeys } from "../apps/web/src/queries/index.ts";
import { checkImportEdge } from "../scripts/check-module-boundaries.mjs";

const ROOT_DIR = resolve(import.meta.dirname, "..");

test("createWorkbenchQueryClient configures defaults and supports hierarchical SSE invalidation", async () => {
	const client = createWorkbenchQueryClient();
	const defaults = client.getDefaultOptions().queries;
	assert.equal(defaults?.retry, false);
	assert.equal(defaults?.refetchOnWindowFocus, false);

	client.setQueryData(queryKeys.spaces.list(), [{ id: "spc_1" }]);
	client.setQueryData(queryKeys.spaces.documents("spc_1"), [{ id: "doc_1" }]);
	client.setQueryData(queryKeys.workspaces.customizations("ws_1"), { folders: [] });
	client.setQueryData(queryKeys.admin.overview(), { users: [] });

	await client.invalidateQueries({ queryKey: queryKeys.spaces.all });

	assert.equal(client.getQueryState(queryKeys.spaces.list())?.isInvalidated, true);
	assert.equal(client.getQueryState(queryKeys.spaces.documents("spc_1"))?.isInvalidated, true);
	assert.equal(client.getQueryState(queryKeys.workspaces.customizations("ws_1"))?.isInvalidated, false);
	assert.equal(client.getQueryState(queryKeys.admin.overview())?.isInvalidated, false);

	client.clear();
	assert.equal(client.getQueryCache().getAll().length, 0);
});

test("queryKeys expose stable domain prefixes for all query-driven views", () => {
	assert.deepEqual(queryKeys.admin.overview(), ["admin", "overview"]);
	assert.deepEqual(queryKeys.runtime.overview(), ["runtime", "overview"]);
	assert.deepEqual(queryKeys.spaces.commitDetail("doc_1", "abc"), ["spaces", "commitDetail", "doc_1", "abc"]);
	assert.deepEqual(queryKeys.workspaces.customizations("ws_1"), ["workspaces", "customizations", "ws_1", ""]);
	assert.deepEqual(queryKeys.team.memberSkill("role_1", "pstack"), ["team", "memberSkill", "role_1", "pstack"]);
	assert.deepEqual(queryKeys.organizations.invites("org_1"), ["organizations", "invites", "org_1"]);
});

test("checkImportEdge enforces unidirectional queries module boundaries", () => {
	assert.match(
		checkImportEdge(ROOT_DIR, "apps/web/src/queries/queryClient.ts", "../stores/index.ts") ?? "",
		/queries must not depend on UI\/hook\/store layer/,
	);
	assert.match(
		checkImportEdge(ROOT_DIR, "apps/web/src/queries/queryClient.ts", "../hooks/useMatterEventSync.ts") ?? "",
		/queries must not depend on UI\/hook\/store layer/,
	);
	assert.match(
		checkImportEdge(ROOT_DIR, "apps/web/src/stores/workbenchStore.ts", "../queries/index.ts") ?? "",
		/stores must not depend on UI\/hook layer/,
	);
	assert.match(
		checkImportEdge(ROOT_DIR, "apps/web/src/api/client.ts", "../queries/index.ts") ?? "",
		/api must not depend on UI layer/,
	);
	assert.equal(checkImportEdge(ROOT_DIR, "apps/web/src/hooks/useMatterEventSync.ts", "../queries/index.ts"), null);
});
