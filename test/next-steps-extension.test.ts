import assert from "node:assert/strict";
import test from "node:test";
import { NEXT_STEPS_TOOL_NAME, normalizeNextSteps, readNextStepsFromMetadata } from "@pa/contracts/next-steps";
import nextStepsWebExtension from "../pa-extensions/next-steps/web/index.ts";
import nextStepsExtension, { normalizePortableNextSteps } from "../pi-extensions/next-steps/index.ts";

test("pi-extensions/next-steps registers suggest_next_steps, deduplicates, and caps at 4 suggestions", async () => {
	let registered:
		| {
				name: string;
				execute: (
					callId: string,
					args: Record<string, unknown>,
				) => Promise<{ content: Array<{ text: string }>; details: { suggestions: unknown[] } }>;
		  }
		| undefined;
	nextStepsExtension({
		registerTool(spec) {
			registered = spec;
		},
	});
	assert.ok(registered);
	assert.equal(registered.name, NEXT_STEPS_TOOL_NAME);

	const out = await registered.execute("call-1", {
		suggestions: [
			{ label: "请 QA 独立验收", prompt: "请 QA 独立验收当前提交", kind: "verify" },
			{ label: "请 QA 独立验收（重复）", prompt: "请 QA 独立验收当前提交", kind: "verify" },
			{ label: "沉淀为 Skill", prompt: "把刚才的发布检查沉淀为 Skill", kind: "capture" },
			"继续实现下一步",
			"第四项",
			"第五项超出上限",
		],
	});
	assert.equal(out.details.suggestions.length, 4);
	assert.match(out.content[0]?.text ?? "", /Suggested 4 next steps/);
	assert.deepEqual(normalizePortableNextSteps(["  测试  "]), [{ label: "测试", prompt: "测试" }]);
});

test("@pa/contracts/next-steps and pa-extensions/next-steps/web normalize and display suggestions", () => {
	const items = normalizeNextSteps([
		{ label: "验收", prompt: "请验收", kind: "verify" },
		{ label: "", prompt: "" },
	]);
	assert.deepEqual(items, [{ label: "验收", prompt: "请验收", kind: "verify" }]);
	assert.deepEqual(readNextStepsFromMetadata({ nextSteps: items }), items);
	assert.deepEqual(readNextStepsFromMetadata(null), []);

	const display = nextStepsWebExtension.toolDisplays?.[NEXT_STEPS_TOOL_NAME];
	assert.ok(display);
	assert.equal(
		display.formatSummary?.({ toolName: NEXT_STEPS_TOOL_NAME, args: { suggestions: items }, summary: "raw" }),
		"给出 1 个下一步建议",
	);
});
