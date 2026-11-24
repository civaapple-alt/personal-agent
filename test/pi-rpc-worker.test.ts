import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { attachJsonlLineReader, PiRpcWorker, serializeJsonLine } from "../packages/server/src/index.ts";

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
			while (buf.includes("\\n")) {
				const idx = buf.indexOf("\\n");
				const msg = JSON.parse(buf.slice(0, idx)); buf = buf.slice(idx + 1);
				if (msg.type === "get_state") {
					send({ id: msg.id, type: "response", command: msg.type, success: true, data: { sessionId: "ready" } });
				} else if (msg.type === "prompt") {
					send({ id: msg.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
					let step = 0;
					const timer = setInterval(() => {
						step++;
						send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "step " + step } });
						if (step === 9) {
							clearInterval(timer);
							send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "all steps" }] } });
							send({ type: "agent_settled", aborted: false });
						}
					}, 100);
				}
			}
		});
	`);
	const worker = new PiRpcWorker({ executable: mock.executable, leadingArgs: mock.leadingArgs });
	await worker.start();
	try {
		// Handshake excludes child JavaScript startup from the short activity window.
		await worker.getState();
		const deltas: string[] = [];
		// Nine 100ms ticks exceed a 500ms idle window, with substantial scheduler margin per tick.
		const result = await worker.runPromptAndWait("long task", {
			idleTimeoutMs: 500,
			timeoutMs: 5000,
			onTextDelta: (delta) => deltas.push(delta),
		});
		assert.equal(result.assistantText, "all steps");
		assert.equal(deltas.length, 9);
	} finally {
		await worker.stop();
	}
});

test("PiRpcWorker still times out when a started model produces no activity", async () => {
	const mock = makeInlineMockScript(`
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", data => {
			const msg = JSON.parse(data.trim());
			process.stdout.write(JSON.stringify({ id: msg.id, type: "response", command: msg.type, success: true,
				data: msg.type === "get_state" ? { sessionId: "ready" } : { disposition: "started" } }) + "\\n");
		});
	`);
	const worker = new PiRpcWorker({ executable: mock.executable, leadingArgs: mock.leadingArgs });
	await worker.start();
	const prevIdleEnv = process.env.PA_IDLE_TIMEOUT_MS;
	try {
		await worker.getState();
		await assert.rejects(
			worker.runPromptAndWait("idle", { idleTimeoutMs: 100, timeoutMs: 1000 }),
			/100ms of inactivity/,
		);
		process.env.PA_IDLE_TIMEOUT_MS = "90";
		await assert.rejects(worker.runPromptAndWait("idle-env-no-hard-cap", { timeoutMs: 0 }), /90ms of inactivity/);
	} finally {
		if (prevIdleEnv === undefined) delete process.env.PA_IDLE_TIMEOUT_MS;
		else process.env.PA_IDLE_TIMEOUT_MS = prevIdleEnv;
		await worker.stop();
	}
});

test("PiRpcWorker suspends idleTimeoutMs during external bridge wait and resumes afterward", async () => {
	const mock = makeInlineMockScript(`
		process.stdin.setEncoding("utf8");
		let buf = "";
		const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
		process.stdin.on("data", (chunk) => {
			buf += chunk;
			while (buf.includes("\\n")) {
				const idx = buf.indexOf("\\n");
				const msg = JSON.parse(buf.slice(0, idx)); buf = buf.slice(idx + 1);
				if (msg.type === "get_state") {
					send({ id: msg.id, type: "response", command: msg.type, success: true, data: { sessionId: "ready" } });
				} else if (msg.type === "prompt") {
					send({ id: msg.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
					if (msg.message === "suspend-then-finish") {
						setTimeout(() => {
							send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "after external wait" }] } });
							send({ type: "agent_settled", aborted: false });
						}, 320);
					}
				}
			}
		});
	`);
	const worker = new PiRpcWorker({ executable: mock.executable, leadingArgs: mock.leadingArgs });
	await worker.start();
	try {
		await worker.getState();
		const release = worker.suspendIdleTimeout();
		setTimeout(() => {
			release();
			release(); // idempotent
		}, 260);
		const result = await worker.runPromptAndWait("suspend-then-finish", {
			idleTimeoutMs: 120,
			timeoutMs: 2000,
		});
		assert.equal(result.aborted, false);
		assert.equal(result.assistantText, "after external wait");

		const releaseShort = worker.suspendIdleTimeout();
		setTimeout(() => releaseShort(), 50);
		await assert.rejects(
			worker.runPromptAndWait("suspend-then-hang", { idleTimeoutMs: 100, timeoutMs: 2000 }),
			/100ms of inactivity/,
		);
	} finally {
		await worker.stop();
	}
});

test("serializeJsonLine produces strict single-line LF framing", () => {
	const line = serializeJsonLine({ type: "get_state" });
	assert.equal(line, '{"type":"get_state"}\n');
});

test("PiRpcWorker forwards exact session paths and surfaces provider error messages instead of empty success", async () => {
	const mock = makeInlineMockScript(`
		process.stdin.setEncoding("utf8");
		let buf = "";
		const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
		process.stdin.on("data", chunk => {
			buf += chunk;
			while (buf.includes("\\n")) {
				const i = buf.indexOf("\\n"); const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
				if (msg.type === "prompt") {
					send({ id: msg.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
					send({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "provider unavailable" } });
					send({ type: "agent_settled", aborted: false });
				} else if (msg.type === "get_state") {
					send({ id: msg.id, type: "response", command: msg.type, success: true, data: { sessionId: process.argv[process.argv.indexOf("--session") + 1] } });
				}
			}
		});
	`);
	const worker = new PiRpcWorker({
		executable: mock.executable,
		leadingArgs: mock.leadingArgs,
		sessionFile: "/tmp/scoped/session.jsonl",
	});
	await worker.start();
	try {
		assert.equal((await worker.getState()).sessionId, "/tmp/scoped/session.jsonl");
		await assert.rejects(worker.runPromptAndWait("prompt"), /provider unavailable/);
	} finally {
		await worker.stop();
	}
});

test("PiRpcWorker signal interrupts an unsettled real subprocess promptly and stop is idempotent", async () => {
	const mock = makeInlineMockScript(`
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", data => {
			const msg = JSON.parse(data.trim());
			process.stdout.write(JSON.stringify({id: msg.id, type:"response", command:msg.type, success:true, data:{disposition:"started"}}) + "\\n");
		});
	`);
	const worker = new PiRpcWorker({ executable: mock.executable, leadingArgs: mock.leadingArgs });
	await worker.start();
	try {
		const controller = new AbortController();
		const running = worker.runPromptAndWait("slow", { signal: controller.signal });
		controller.abort();
		await assert.rejects(running, /cancelled/);
	} finally {
		await Promise.all([worker.stop(), worker.stop()]);
	}
});

test("PiRpcWorker rejects overlapping runPromptAndWait calls and preserves dynamic setDialogHandler updates", async () => {
	const mock = makeInlineMockScript(`
		let buf = "";
		process.stdin.setEncoding("utf8");
		const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
		process.stdin.on("data", (chunk) => {
			buf += chunk;
			while (buf.includes("\\n")) {
				const idx = buf.indexOf("\\n");
				const msg = JSON.parse(buf.slice(0, idx));
				buf = buf.slice(idx + 1);
				if (msg.type === "prompt") {
					send({ id: msg.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
					if (msg.message === "first") {
						setTimeout(() => {
							send({ type: "extension_ui_request", id: "dlg-dyn", method: "confirm", title: "Confirm", message: "Proceed?" });
						}, 40);
					} else {
						send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "second ok" }] } });
						send({ type: "agent_settled", aborted: false });
					}
				} else if (msg.type === "extension_ui_response" && msg.id === "dlg-dyn") {
					send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "confirmed=" + String(msg.confirmed) }] } });
					send({ type: "agent_settled", aborted: false });
				}
			}
		});
	`);
	const worker = new PiRpcWorker({
		executable: mock.executable,
		leadingArgs: mock.leadingArgs,
		onDialog: async () => ({ confirmed: false }),
	});
	await worker.start();
	try {
		const firstRun = worker.runPromptAndWait("first");
		await assert.rejects(worker.runPromptAndWait("overlap"), /already has an active prompt run/);
		let dynamicCalls = 0;
		worker.setDialogHandler(async () => {
			dynamicCalls += 1;
			return { confirmed: true };
		});
		const firstResult = await firstRun;
		assert.equal(firstResult.assistantText, "confirmed=true");
		assert.equal(dynamicCalls, 1);
		assert.equal(firstResult.dialogs.length, 1);

		const secondResult = await worker.runPromptAndWait("second");
		assert.equal(secondResult.assistantText, "second ok");
	} finally {
		await worker.stop();
	}
});
