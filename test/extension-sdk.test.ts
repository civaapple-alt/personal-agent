import assert from "node:assert/strict";
import test from "node:test";
import { PA_EXTENSION_SDK_API_VERSION, validateExternalExtensionDescriptor } from "@pa/extension-sdk/manifest";
import { defineExternalServerExtension } from "@pa/extension-sdk/server";
import { defineExternalWebExtension } from "@pa/extension-sdk/web";

test("extension-sdk stamps apiVersion 1.0 and validates curated external extensions", () => {
	const serverExt = defineExternalServerExtension({
		name: "sample-search",
		title: "Sample Search",
		description: "Wraps an upstream Pi search package",
		piPackage: "pi-sample-search",
		tools: ["sample_search"],
	});
	assert.equal(serverExt.apiVersion, PA_EXTENSION_SDK_API_VERSION);
	assert.deepEqual(validateExternalExtensionDescriptor(serverExt), { ok: true, errors: [] });

	const webExt = defineExternalWebExtension({
		name: "sample-search",
		title: "Sample Search",
		toolDisplays: {
			sample_search: { label: "示例检索", category: "web" },
		},
	});
	assert.equal(webExt.apiVersion, PA_EXTENSION_SDK_API_VERSION);
	assert.deepEqual(validateExternalExtensionDescriptor(webExt), { ok: true, errors: [] });
});

test("extension-sdk rejects host-internal fields and incompatible apiVersion", () => {
	const leaked = validateExternalExtensionDescriptor({
		apiVersion: "1.0",
		name: "bad-ext",
		title: "Bad Ext",
		workflowRule: "inject prompt",
		builtinPiEntry: "pa-extensions/worker-runtime/pi/index.ts",
		supersedesPackages: ["pi-web-access"],
	});
	assert.equal(leaked.ok, false);
	assert.equal(leaked.errors.length, 3);

	const wrongVersion = validateExternalExtensionDescriptor({
		apiVersion: "2.0",
		name: "future-ext",
		title: "Future Ext",
	});
	assert.equal(wrongVersion.ok, false);
	assert.match(wrongVersion.errors[0] ?? "", /Unsupported apiVersion/);
});
