// Exercise both entry points against disposable databases, without a model request or user data mutation.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "personal-agent-startup-"));
try {
	for (const entry of ["src/server/main.ts", "dist/server/main.js"]) {
		const probe = createServer();
		await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
		const address = probe.address();
		assert.ok(address && typeof address !== "string");
		const port = address.port;
		await new Promise((resolve) => probe.close(resolve));
		const child = spawn(process.execPath, [entry], {
			env: { ...process.env, PORT: String(port), PA_DB_PATH: join(directory, `${port}.db`) },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		child.stdout.on("data", (chunk) => {
			output += chunk;
		});
		child.stderr.on("data", (chunk) => {
			output += chunk;
		});
		const exited = new Promise((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", (code, signal) => resolve({ code, signal }));
		});
		try {
			const deadline = Date.now() + 10_000;
			while (!output.includes("workbench listening")) {
				if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Startup failed: ${output}`);
				await new Promise((resolve) => setTimeout(resolve, 30));
			}
			const base = `http://127.0.0.1:${port}`;
			const bootstrap = await (await fetch(`${base}/api/bootstrap`)).json();
			assert.equal(bootstrap.members.length, 4);
			assert.equal(bootstrap.matters.length, 0);
			assert.equal(bootstrap.deliverables.length, 0);
			assert.equal((await fetch(base)).status, 200);
			child.kill("SIGTERM");
			const result = await Promise.race([
				exited,
				new Promise((_, reject) => {
					const timer = setTimeout(() => reject(new Error("Shutdown timed out")), 5000);
					timer.unref();
				}),
			]);
			assert.deepEqual(result, { code: 0, signal: null });
			console.log(`PASS ${entry}: bootstrap, built UI and graceful shutdown`);
		} finally {
			if (child.exitCode === null) child.kill("SIGKILL");
			await exited;
		}
	}
} finally {
	await rm(directory, { recursive: true, force: true });
}
