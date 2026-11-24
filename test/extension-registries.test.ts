import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { builtinWebExtensions, getToolDisplay } from "../apps/web/src/extensions/registry.ts";
import {
	builtinServerExtensions,
	findServerExtension,
	listServerExtensionSummaries,
} from "../packages/server/src/extensions/registry.ts";

test("server and web extension registries stay aligned and resolve declared built-in Pi assets", () => {
	const summaries = listServerExtensionSummaries();
	assert.deepEqual(
		summaries.map((item) => item.name),
		["team-extension", "human-question", "skill-catalog", "web-access"],
	);
	assert.deepEqual(
		builtinWebExtensions.map((item) => item.name),
		["team-extension", "human-question", "skill-catalog", "web-access"],
	);

	for (const { extension } of builtinServerExtensions) {
		assert.equal(findServerExtension(extension.name), extension);
		if (extension.builtinPiEntry) {
			assert.ok(
				existsSync(resolve(extension.builtinPiEntry)),
				`Missing built-in Pi entry for ${extension.name}: ${extension.builtinPiEntry}`,
			);
		}
		if (extension.builtinSkillPackage) {
			assert.ok(
				existsSync(resolve(extension.builtinSkillPackage)),
				`Missing built-in Pi skill package for ${extension.name}: ${extension.builtinSkillPackage}`,
			);
		}
		for (const tool of extension.tools) {
			assert.ok(getToolDisplay(tool), `Missing web tool display spec for ${extension.name}:${tool}`);
		}
	}

	assert.equal(findServerExtension("web-access")?.piPackage, "pi-web-access");
	assert.equal(getToolDisplay("request_pi_command")?.successLabel, "已提交");
	assert.equal(getToolDisplay("web_search")?.category, "web");
});
