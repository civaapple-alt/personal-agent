import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import humanQuestionExtension, { type HumanQuestionExtensionApi } from "../pi-extensions/human-question/index.ts";
import { createTeamToolBridge } from "../src/rpc/team-tool-bridge.ts";

function captureTool(
	t: TestContext,
	env?: { PA_TEAM_BRIDGE_URL: string; PA_TEAM_BRIDGE_TOKEN: string },
	enabled = true,
) {
	const set = (key: string, value?: string) => {
		const previous = process.env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
		t.after(() => {
			if (previous === undefined) delete process.env[key];
			else process.env[key] = previous;
		});
	};
	set("PA_TEAM_BRIDGE_URL", env?.PA_TEAM_BRIDGE_URL);
	set("PA_TEAM_BRIDGE_TOKEN", env?.PA_TEAM_BRIDGE_TOKEN);
	set("PA_HUMAN_QUESTION_ENABLED", String(enabled));
	let tool: Parameters<HumanQuestionExtensionApi["registerTool"]>[0] | undefined;
	humanQuestionExtension({
		registerTool: (registered) => {
			tool = registered;
		},
	});
	return tool;
}

test("standalone human-question uses native select, input, cancellation and headless results", async (t) => {
	const tool = captureTool(t);
	assert.ok(tool);
	assert.equal(tool.name, "request_clarification");
	const controller = new AbortController();
	const calls: string[] = [];
	const ctx = {
		hasUI: true,
		ui: {
			async select(title: string, options: string[], opts?: { signal?: AbortSignal }) {
				calls.push(title);
				assert.equal(opts?.signal, controller.signal);
				return options[1];
			},
			async input(title: string) {
				calls.push(title);
				return title === "Why?" ? " Because it preserves the data. " : undefined;
			},
		},
	};
	const choice = await tool.execute(
		"choice",
		{ question: "Keep history?", context: "Affects migration", options: ["Keep", "Archive"] },
		controller.signal,
		undefined,
		ctx,
	);
	assert.deepEqual(choice.details, { status: "answered", answer: "Archive" });
	const text = await tool.execute("text", { question: "Why?" }, undefined, undefined, ctx);
	assert.deepEqual(text.details, { status: "answered", answer: "Because it preserves the data." });
	const cancel = await tool.execute("cancel", { question: "Stop?" }, undefined, undefined, ctx);
	assert.deepEqual(cancel.details, { status: "cancelled" });
	assert.match((await tool.execute("headless", { question: "Why?" })).content[0]!.text, /unavailable/);
	assert.deepEqual(calls, ["Keep history?\n\nAffects migration", "Why?", "Stop?"]);
});

test("PA human-question forwards to the authenticated bridge without opening a dialog", async (t) => {
	const controller = new AbortController();
	const bridge = await createTeamToolBridge(async (call) => {
		assert.equal(call.tool, "request_clarification");
		assert.equal(call.question, "Include legacy data?");
		assert.equal(call.sourceAssignmentNumber, 2);
		return { status: "staged_for_human" };
	}, controller.signal);
	t.after(async () => {
		controller.abort();
		await bridge.close();
	});
	const tool = captureTool(t, bridge.env);
	assert.ok(tool);
	assert.deepEqual(
		(await tool.execute("pa", { question: "Include legacy data?", sourceAssignmentNumber: 2 })).details,
		{ result: { status: "staged_for_human" } },
	);
});

test("host-disabled human-question registers no tool even when explicitly loaded", (t) => {
	assert.equal(
		captureTool(t, { PA_TEAM_BRIDGE_URL: "http://127.0.0.1:1", PA_TEAM_BRIDGE_TOKEN: "unused" }, false),
		undefined,
	);
});
