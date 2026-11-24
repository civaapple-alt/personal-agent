import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkImportEdge, checkModuleBoundaries } from "../scripts/check-module-boundaries.mjs";

const rootDir = fileURLToPath(new URL("../", import.meta.url));

test("repository satisfies Three-Ring and dual-half extension boundaries", () => {
	const result = checkModuleBoundaries(rootDir);
	assert.ok(result.filesChecked > 100);
	assert.deepEqual(result.violations, []);
});

test("boundary checker rejects forbidden cross-ring and cross-half edges", () => {
	assert.ok(checkImportEdge(rootDir, "packages/contracts/src/a.ts", "node:fs"));
	assert.ok(checkImportEdge(rootDir, "packages/contracts/src/a.ts", "@pa/server"));
	assert.ok(checkImportEdge(rootDir, "apps/web/src/App.tsx", "@pa/server"));
	assert.ok(checkImportEdge(rootDir, "apps/web/src/App.tsx", "@pa/ext-web-access/server"));
	assert.ok(checkImportEdge(rootDir, "apps/web/src/App.tsx", "../../../packages/server/src/index.ts"));
	assert.ok(checkImportEdge(rootDir, "packages/server/src/index.ts", "@pa/ext-web-access/web"));
	assert.ok(checkImportEdge(rootDir, "apps/cli/src/main.ts", "@pa/web"));
	assert.ok(checkImportEdge(rootDir, "pa-extensions/web-access/web/index.ts", "../server/index.ts"));
	assert.ok(checkImportEdge(rootDir, "pa-extensions/web-access/server/index.ts", "../web/index.ts"));
	assert.ok(checkImportEdge(rootDir, "pi-extensions/human-question/index.ts", "@pa/contracts"));

	// Allowed edges pass cleanly
	assert.equal(checkImportEdge(rootDir, "apps/web/src/App.tsx", "@pa/contracts/human-decision"), null);
	assert.equal(checkImportEdge(rootDir, "apps/web/src/extensions/registry.ts", "@pa/ext-web-access/web"), null);
	assert.equal(
		checkImportEdge(rootDir, "packages/server/src/extensions/registry.ts", "@pa/ext-web-access/server"),
		null,
	);
	assert.equal(checkImportEdge(rootDir, "apps/cli/src/main.ts", "@pa/server/boot"), null);
});
