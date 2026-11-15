import assert from "node:assert/strict";
import test from "node:test";
import teamExtension, { type PiExtensionApi } from "../src/rpc/team-extension.ts";
import { createTeamToolBridge } from "../src/rpc/team-tool-bridge.ts";

test("bridge rejects unauthenticated requests, validates arguments, and deduplicates transport retries", async () => {
	let calls = 0;
	const controller = new AbortController();
	const bridge = await createTeamToolBridge(async () => {
		calls++;
		return { answer: "one execution" };
	}, controller.signal);
	const post = (body: unknown, token = bridge.env.PA_TEAM_BRIDGE_TOKEN) =>
		fetch(`${bridge.env.PA_TEAM_BRIDGE_URL}/tool`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}` },
			body: JSON.stringify(body),
		});
	try {
		assert.equal((await post({}, "wrong")).status, 403);
		assert.equal(
			(await post({ tool: "delegate_to_member", callId: "bad", args: { memberId: "pm", task: "" } })).status,
			400,
		);
		const call = { tool: "delegate_to_member", callId: "id", args: { memberId: "pm", task: "review" } };
		assert.equal((await post(call)).status, 200);
		assert.equal((await post(call)).status, 200);
		assert.equal(calls, 1);
		assert.equal((await post({ ...call, args: { memberId: "qa", task: "different" } })).status, 400);
	} finally {
		controller.abort();
		await bridge.close();
	}
});

test("capability handshake waits for asynchronously registered MCP tools and exposes only the declared loadout", async () => {
	const controller = new AbortController();
	const bridge = await createTeamToolBridge(async () => null, controller.signal);
	const envBefore = { ...process.env };
	let onStart: (() => Promise<void>) | undefined;
	let available = ["read", "unrelated_tool", "delegate_to_member", "publish_deliverable"];
	let active: string[] = [];
	Object.assign(process.env, bridge.env, {
		PA_REQUIRED_TOOLS: JSON.stringify(["read", "delegate_to_member", "publish_deliverable", "mcp__local__*"]),
	});
	try {
		const api: PiExtensionApi = {
			registerTool() {},
			on: (event, handler) => {
				if (event === "session_start") onStart = handler as () => Promise<void>;
			},
			getActiveTools: () => active,
			getAllTools: () => available.map((name) => ({ name })),
			setActiveTools: (tools) => {
				active = tools;
			},
		};
		teamExtension(api);
	} finally {
		for (const key of [...Object.keys(bridge.env), "PA_REQUIRED_TOOLS"]) {
			if (envBefore[key] === undefined) delete process.env[key];
			else process.env[key] = envBefore[key];
		}
	}
	try {
		await onStart?.();
		available = [...available, "mcp__local__lookup", "mcp__other__secret"];
		assert.deepEqual(await bridge.waitReady(), [
			"read",
			"delegate_to_member",
			"publish_deliverable",
			"mcp__local__lookup",
		]);
	} finally {
		controller.abort();
		await bridge.close();
	}
});
