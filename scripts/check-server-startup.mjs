// Exercise the selected entry points with disposable databases and no model requests.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const entries = {
	"--source": ["src/server/main.ts"],
	"--prebuilt": ["dist/server/main.js"],
};
const [mode, ...extra] = process.argv.slice(2);
assert.ok(extra.length === 0 && (mode === undefined || Object.hasOwn(entries, mode)), "Use --source or --prebuilt");
const selectedEntries = mode ? entries[mode] : Object.values(entries).flat();

const directory = await mkdtemp(join(tmpdir(), "personal-agent-startup-"));
try {
	for (const { entry, memory } of selectedEntries.flatMap((entry) => [
		{ entry, memory: false },
		{ entry, memory: true },
	])) {
		const probe = createServer();
		await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
		const address = probe.address();
		assert.ok(address && typeof address !== "string");
		const port = address.port;
		await new Promise((resolve) => probe.close(resolve));
		const cwd = join(directory, String(port));
		await mkdir(join(cwd, "web"), { recursive: true });
		await cp(resolve("roles"), join(cwd, "roles"), { recursive: true });
		await symlink(resolve("web/dist"), join(cwd, "web/dist"), process.platform === "win32" ? "junction" : "dir");
		const child = spawn(process.execPath, [resolve(entry)], {
			cwd,
			env: {
				...process.env,
				PA_HOST: "127.0.0.1",
				PORT: String(port),
				PA_DB_PATH: memory ? ":memory:" : join(directory, `${port}.db`),
			},
			stdio: ["ignore", "pipe", "pipe", "ipc"],
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
			assert.match(output, /Pi CLI (?:startup check failed:|[^\n]+\()/);
			assert.equal(bootstrap.members.filter((m) => m.id !== "role-architect").length, 4);
			assert.ok(bootstrap.members.some((m) => m.id === "role-architect"));
			assert.equal(bootstrap.matters.length, 0);
			assert.equal(bootstrap.authKind, "loopback");
			assert.ok(bootstrap.accountUser?.id);
			assert.equal("deliverables" in bootstrap, false);
			assert.equal("collaborators" in bootstrap, false);
			const recent = await (await fetch(`${base}/api/spaces/recent`)).json();
			assert.deepEqual(recent.documents, []);
			assert.equal("innerDemoAvailable" in bootstrap, false);
			assert.equal((await fetch(`${base}/api/demos/inner-matter`, { method: "POST" })).status, 404);
			if (memory) {
				const memberResponse = await fetch(`${base}/api/members`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ id: "startup-probe", name: "启动验证", title: "Startup probe", tools: [] }),
				});
				assert.equal(memberResponse.status, 201);
				await assert.rejects(lstat(join(cwd, "roles/startup-probe.md")), { code: "ENOENT" });
			}
			assert.equal((await fetch(base)).status, 200);
			const shutdownViaIpc = process.platform === "win32" || memory;
			if (shutdownViaIpc) {
				assert.ok(child.connected, "IPC shutdown channel is unavailable");
				child.send("shutdown");
			} else {
				child.kill("SIGTERM");
			}
			const result = await Promise.race([
				exited,
				new Promise((_, reject) => {
					const timer = setTimeout(() => reject(new Error("Shutdown timed out")), 5000);
					timer.unref();
				}),
			]);
			assert.deepEqual(result, { code: 0, signal: null });
			console.log(
				`PASS ${entry} (${memory ? "memory DB, isolated role creation" : "file DB, clean bootstrap"}): bootstrap, built UI and graceful ${shutdownViaIpc ? "IPC" : "SIGTERM"} shutdown`,
			);
		} finally {
			if (child.exitCode === null) child.kill("SIGKILL");
			await exited;
		}
	}
} finally {
	await rm(directory, { recursive: true, force: true });
}
