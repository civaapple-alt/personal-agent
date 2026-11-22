import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function collectTests(directory) {
	const entries = await readdir(directory, { withFileTypes: true });
	const groups = await Promise.all(
		entries.map(async (entry) => {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) return collectTests(path);
			return entry.isFile() && entry.name.endsWith(".test.ts") ? [path] : [];
		}),
	);
	return groups.flat();
}

const piDir = await mkdtemp(join(tmpdir(), "personal-agent-test-pi-"));
try {
	const tests = (await collectTests("test")).sort();
	const child = spawn(process.execPath, ["--test", ...process.argv.slice(2), ...tests], {
		stdio: "inherit",
		env: { ...process.env, PI_CODING_AGENT_DIR: piDir },
	});
	const relayInterrupt = () => child.kill("SIGINT");
	const relayTerminate = () => child.kill("SIGTERM");
	process.on("SIGINT", relayInterrupt);
	process.on("SIGTERM", relayTerminate);
	const result = await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => resolve({ code, signal }));
	});
	process.off("SIGINT", relayInterrupt);
	process.off("SIGTERM", relayTerminate);
	process.exitCode = result.code ?? (result.signal === "SIGINT" ? 130 : 1);
} finally {
	await rm(piDir, { recursive: true, force: true });
}
