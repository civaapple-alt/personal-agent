import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { attachJsonlLineReader, PiRpcWorker, serializeJsonLine } from "../src/index.ts";

function makeInlineMockScript(body: string): { executable: string; leadingArgs: string[] } {
	return {
		executable: process.execPath,
		leadingArgs: ["--input-type=module", "-e", body, "--"],
	};
}

test("attachJsonlLineReader splits strictly on LF and preserves U+2028/U+2029 inside JSON", () => {
	const stream = new PassThrough();
	const lines: string[] = [];
	const detach = attachJsonlLineReader(stream, (line) => lines.push(line));

	const payload1 = { text: "before\u2028middle\u2029after", ok: true };
	const payload2 = { text: "crlf-and-中文-🚀" };

	const raw = `${JSON.stringify(payload1)}\n${JSON.stringify(payload2)}\r\n`;
	const buf = Buffer.from(raw, "utf8");

	// Split in the middle of a multi-byte UTF-8 sequence to verify StringDecoder handling.
	const splitAt = buf.indexOf(Buffer.from("中")) + 1;
	stream.write(buf.subarray(0, splitAt));
	stream.write(buf.subarray(splitAt));
	stream.end();

	detach();

	assert.equal(lines.length, 2);
	assert.deepEqual(JSON.parse(lines[0]!), payload1);
	assert.deepEqual(JSON.parse(lines[1]!), payload2);
});

test("PiRpcWorker correlates concurrent commands by id and surfaces error responses", async () => {
	const mock = makeInlineMockScript(`
		import { StringDecoder } from "node:string_decoder";
		const decoder = new StringDecoder("utf8");
		let buf = "";
		process.stdin.on("data", (chunk) => {
			buf += decoder.write(chunk);
			while (true) {
				const idx = buf.indexOf("\\n");
				if (idx === -1) break;
				const cmd = JSON.parse(buf.slice(0, idx));
				buf = buf.slice(idx + 1);
				if (cmd.type === "get_state") {
					setTimeout(() => {
						process.stdout.write(JSON.stringify({
							id: cmd.id,
							type: "response",
							command: "get_state",
							success: true,
							data: {
								model: { provider: "kimi-coding", id: "kimi-for-coding" },
								thinkingLevel: "high",
								isStreaming: false,
								isCompacting: false,
								steeringMode: "one-at-a-time",
								followUpMode: "one-at-a-time",
								sessionId: "sess-1",
								autoCompactionEnabled: true,
								messageCount: 0,
								pendingMessageCount: 0
							}
						}) + "\\n");
					}, 30);
				} else if (cmd.type === "set_model") {
					process.stdout.write(JSON.stringify({
						id: cmd.id,
						type: "response",
						command: "set_model",
						success: false,
						error: "Model not found: invalid/model"
					}) + "\\n");
				}
			}
		});
	`);

	const worker = new PiRpcWorker({
		executable: mock.executable,
		leadingArgs: mock.leadingArgs,
	});

	await worker.start();
	try {
		const [state, err] = await Promise.all([
			worker.getState(),
			worker.setModel("invalid", "model").catch((e: Error) => e),
		]);
		assert.equal(state.sessionId, "sess-1");
		assert.equal(state.model?.id, "kimi-for-coding");
		assert.ok(err instanceof Error);
		assert.match(err.message, /Model not found/);
	} finally {
		await worker.stop();
	}
});

test("PiRpcWorker resolves handled prompts immediately without waiting for agent_settled", async () => {
	const mock = makeInlineMockScript(`
		let buf = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			buf += chunk;
			while (true) {
				const idx = buf.indexOf("\\n");
				if (idx === -1) break;
				const cmd = JSON.parse(buf.slice(0, idx));
				buf = buf.slice(idx + 1);
				if (cmd.type === "prompt") {
					process.stdout.write(JSON.stringify({
						id: cmd.id,
						type: "response",
						command: "prompt",
						success: true,
						data: { disposition: "handled" }
					}) + "\\n");
				}
			}
		});
	`);

	const worker = new PiRpcWorker({
		executable: mock.executable,
		leadingArgs: mock.leadingArgs,
	});

	await worker.start();
	try {
		const result = await worker.runPromptAndWait("/custom-ext", { timeoutMs: 250 });
		assert.equal(result.disposition, "handled");
		assert.equal(result.aborted, false);
		assert.equal(result.assistantText, "");
	} finally {
		await worker.stop();
	}
});

test("PiRpcWorker handles bidirectional extension_ui_request, notices, streaming, and agent_settled", async () => {
	const mock = makeInlineMockScript(`
		let buf = "";
		process.stdin.setEncoding("utf8");
		const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
		process.stdin.on("data", (chunk) => {
			buf += chunk;
			while (true) {
				const idx = buf.indexOf("\\n");
				if (idx === -1) break;
				const msg = JSON.parse(buf.slice(0, idx));
				buf = buf.slice(idx + 1);

				if (msg.type === "prompt") {
					send({ id: msg.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
					send({ type: "agent_start" });
					send({ type: "extension_ui_request", id: "n-1", method: "notify", message: "scanning repo", notifyType: "info" });
					send({ type: "tool_execution_start", toolCallId: "tc-1", toolName: "bash", args: { command: "rm -rf tmp" } });
					send({ type: "extension_ui_request", id: "dlg-1", method: "confirm", title: "Confirm", message: "Run cleanup?" });
				} else if (msg.type === "extension_ui_response" && msg.id === "dlg-1") {
					send({ type: "tool_execution_end", toolCallId: "tc-1", toolName: "bash", result: { approved: msg.confirmed }, isError: false, durationMs: 12 });
					send({ type: "agent_end", messages: [], willRetry: true });
					send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Done " } });
					send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "safely." } });
					send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done safely." }] } });
					send({ type: "agent_settled", aborted: false });
				}
			}
		});
	`);

	const deltas: string[] = [];
	const worker = new PiRpcWorker({
		executable: mock.executable,
		leadingArgs: mock.leadingArgs,
		onDialog: async (req) => {
			assert.equal(req.method, "confirm");
			return { confirmed: true };
		},
	});

	await worker.start();
	try {
		const result = await worker.runPromptAndWait("Clean temp folder", {
			onTextDelta: (delta) => deltas.push(delta),
		});

		assert.equal(result.disposition, "started");
		assert.equal(result.aborted, false);
		assert.equal(result.assistantText, "Done safely.");
		assert.deepEqual(deltas, ["Done ", "safely."]);
		assert.equal(result.notices.length, 1);
		assert.equal(result.notices[0]?.method, "notify");
		assert.equal(result.dialogs.length, 1);
		assert.deepEqual(result.dialogs[0]?.response, { confirmed: true });
		assert.equal(result.toolExecutions.length, 1);
		assert.equal(result.toolExecutions[0]?.durationMs, 12);
	} finally {
		await worker.stop();
	}
});

test("PiRpcWorker resets idleTimeoutMs while active events keep arriving", async () => {
	const mock = makeInlineMockScript(`
		let buf = "";
		process.stdin.setEncoding("utf8");
		const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
		process.stdin.on("data", (chunk) => {
			buf += chunk;
			while (true) {
				const idx = buf.indexOf("\\n");
				if (idx === -1) break;
				const msg = JSON.parse(buf.slice(0, idx));
				buf = buf.slice(idx + 1);
				if (msg.type === "prompt") {
					send({ id: msg.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
					setTimeout(() => send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "step 1 " } }), 40);
					setTimeout(() => send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "step 2" } }), 85);
					setTimeout(() => {
						send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "step 1 step 2" }] } });
						send({ type: "agent_settled", aborted: false });
					}, 130);
				}
			}
		});
	`);

	const worker = new PiRpcWorker({
		executable: mock.executable,
		leadingArgs: mock.leadingArgs,
	});
	await worker.start();
	try {
		// 130ms total > 75ms idleTimeoutMs, but each event keeps resetting the idle timer.
		const result = await worker.runPromptAndWait("long task", {
			idleTimeoutMs: 75,
			timeoutMs: 1000,
		});
		assert.equal(result.assistantText, "step 1 step 2");
	} finally {
		await worker.stop();
	}
});

test("serializeJsonLine produces strict single-line LF framing", () => {
	const line = serializeJsonLine({ type: "get_state" });
	assert.equal(line, '{"type":"get_state"}\n');
});
