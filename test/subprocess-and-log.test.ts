import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { closeLogging, createLogger, initLogging } from "../packages/server/src/log/index.ts";
import { BoundedCommandError, runBounded } from "../packages/server/src/subprocess/index.ts";

test("runBounded returns stdout, enforces timeout, and supports AbortSignal", async () => {
	const ok = await runBounded(process.execPath, ["-e", 'process.stdout.write("hello-bounded")'], { timeoutMs: 5_000 });
	assert.equal(ok.stdout, "hello-bounded");
	assert.equal(ok.exitCode, 0);

	await assert.rejects(
		() => runBounded(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { timeoutMs: 80 }),
		(err: unknown) => err instanceof BoundedCommandError && err.timedOut === true,
	);

	const ac = new AbortController();
	setTimeout(() => ac.abort(), 60);
	await assert.rejects(
		() => runBounded(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { timeoutMs: 5_000, signal: ac.signal }),
		(err: unknown) => err instanceof BoundedCommandError && err.aborted === true,
	);
});

test("structured logger writes JSONL records and rotates when maxBytes is reached", () => {
	const dir = mkdtempSync(join(tmpdir(), "pa-log-test-"));
	try {
		const logFile = initLogging({ dataDir: dir, maxBytes: 120, maxRotatedFiles: 2 });
		const log = createLogger("test.scope");
		log.info("first-event", { n: 1 });
		log.warn("second-event-with-longer-payload-to-trigger-rotation-on-next-write", { n: 2 });
		log.error("third-event", { n: 3 });

		assert.ok(existsSync(logFile));
		assert.ok(existsSync(`${logFile}.1`));
		const latestLines = readFileSync(logFile, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.equal(latestLines.at(-1)?.scope, "test.scope");
		assert.equal(latestLines.at(-1)?.level, "error");
		assert.equal(latestLines.at(-1)?.msg, "third-event");
	} finally {
		closeLogging();
		rmSync(dir, { recursive: true, force: true });
	}
});
