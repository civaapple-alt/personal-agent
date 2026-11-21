import assert from "node:assert/strict";
import test from "node:test";
import { summarizePromptUsage } from "../src/rpc/prompt-usage.ts";
import type { AgentMessage } from "../src/rpc/types.ts";

test("prompt usage distinguishes the first reported request from tool follow-ups", () => {
	const assistant = { role: "assistant", content: "", provider: "fixture", model: "model" };
	const noUsage = { ...assistant, usage: { input: 0, cacheRead: 0, cacheWrite: 0 } };
	const error = { ...assistant, stopReason: "error", usage: { input: 50, cacheRead: 0, cacheWrite: 0 } };
	const first = { ...assistant, stopReason: "toolUse", usage: { input: 10, cacheRead: 90, cacheWrite: 20 } };
	const second = { ...assistant, stopReason: "stop", usage: { input: 15, cacheRead: 110, cacheWrite: 0 } };
	const messages: AgentMessage[] = [noUsage, error, first, second];
	assert.deepEqual(summarizePromptUsage(messages), {
		firstRequest: { provider: "fixture", model: "model", input: 10, cacheRead: 90, cacheWrite: 20 },
		totals: { input: 25, cacheRead: 200, cacheWrite: 20 },
		requests: 2,
	});
	assert.equal(summarizePromptUsage([noUsage, error]), undefined);
});
