import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";

const execFileAsync = promisify(execFile);

export async function listPiPackages(executable: string): Promise<string> {
	const { stdout } = await execFileAsync(executable, ["list", "--no-approve"], {
		timeout: 2500,
		maxBuffer: 256 * 1024,
		windowsHide: true,
		encoding: "utf8",
		env: { ...process.env, PI_OFFLINE: "1" },
	});
	return stdout;
}

export async function listUserPackagePaths(
	executable: string,
	source: RegExp,
	listPackages: typeof listPiPackages,
): Promise<string[]> {
	let lines: string[];
	try {
		lines = stripVTControlCharacters(await listPackages(executable)).split(/\r?\n/);
	} catch {
		return [];
	}
	const userPackages = lines.indexOf("User packages:");
	if (userPackages < 0) return [];
	const paths: string[] = [];
	for (let i = userPackages + 1; i < lines.length && lines[i]?.startsWith("  "); i++) {
		const line = lines[i];
		const path = lines[i + 1]?.match(/^ {4}(\S.*)$/)?.[1]?.trim();
		if (line && source.test(line) && path && isAbsolute(path)) paths.push(path);
	}
	return paths;
}

export function summarizePiCommandError(error: unknown): string {
	if (!error || typeof error !== "object") return "";
	const record = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
	const raw =
		(typeof record.stderr === "string" && record.stderr.trim()) ||
		(typeof record.stdout === "string" && record.stdout.trim()) ||
		(typeof record.message === "string" ? record.message.trim() : "");
	if (!raw) return "";
	const clean = stripVTControlCharacters(raw);
	const lines = clean
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	return (lines.at(-1) ?? clean).slice(0, 240);
}

export async function installPiPackage(executable: string, source: string): Promise<void> {
	const env = { ...process.env };
	delete env.PI_OFFLINE;
	await execFileAsync(executable, ["install", source, "--no-approve"], {
		timeout: 120_000,
		maxBuffer: 4 * 1024 * 1024,
		windowsHide: true,
		env,
	});
}
