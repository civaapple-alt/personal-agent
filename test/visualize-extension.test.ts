import assert from "node:assert/strict";
import test from "node:test";
import { getToolDisplay, getToolRenderer } from "../apps/web/src/extensions/registry.ts";
import registerVisualize, {
	formatVisualizeMarkdown,
	type VisualizeExtensionApi,
	validateVisualizeParams,
} from "../pi-extensions/visualize/index.ts";

test("pi-extensions/visualize registers visualize tool, validates shapes, and formats markdown", async () => {
	const tools: Array<Parameters<VisualizeExtensionApi["registerTool"]>[0]> = [];
	registerVisualize({
		registerTool(def) {
			tools.push(def);
		},
	});
	const registered = tools[0];
	assert.ok(registered);
	assert.equal(registered.name, "visualize");

	const diagram = await registered.execute("tc-1", {
		type: "diagram",
		title: "Auth Flow",
		mermaid: "flowchart LR\n  A --> B",
	});
	assert.match(diagram.content[0]?.text ?? "", /### Auth Flow[\s\S]*```mermaid[\s\S]*A --> B/);

	const comparison = await registered.execute("tc-2", {
		type: "comparison",
		title: "Storage",
		options: [
			{ name: "SQLite", recommended: true, pros: ["Zero ops"], cons: ["Single writer"] },
			{ name: "Postgres", pros: ["Concurrent writes"] },
		],
	});
	assert.match(comparison.content[0]?.text ?? "", /#### SQLite \(Recommended\)/);

	assert.match(formatVisualizeMarkdown({ type: "file", path: "after.html", before: "before.html" }), /before\.html/);
	assert.throws(() => validateVisualizeParams({ type: "diagram", mermaid: "   " }), /mermaid/);
	assert.throws(() => validateVisualizeParams({ type: "comparison", options: [] }), /options/);
	assert.throws(() => validateVisualizeParams({ type: "file" }), /path/);
});

test("pa-extensions/visualize registers web toolDisplay summary and primary toolRenderer", () => {
	const display = getToolDisplay("visualize");
	assert.equal(display?.label, "可视化卡片");
	assert.equal(
		display?.formatSummary?.({
			toolName: "visualize",
			args: { type: "comparison", options: [{ name: "A" }, { name: "B" }] },
		}),
		"方案对比（2 项）",
	);
	const renderer = getToolRenderer("visualize");
	assert.equal(renderer?.prominence, "primary");
	assert.equal(typeof renderer?.renderer, "function");
});
