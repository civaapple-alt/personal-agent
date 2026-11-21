import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";
import { preparePstackRuntime } from "../../pi-extensions/pstack-methods/methods.js";

const execFileAsync = promisify(execFile);
const PSTACK_PACKAGE = "git:github.com/backnotprop/pstack";
const PSTACK_SOURCE =
	/^ {2}(?:git:)?(?:https:\/\/|ssh:\/\/git@|git@)?github\.com[/:]backnotprop\/pstack(?:\.git)?(?:[@#]\S+)?(?: \(filtered\))?$/i;

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

export async function findInstalledPstack(executable: string, listPackages = listPiPackages): Promise<string | null> {
	let lines: string[];
	try {
		lines = stripVTControlCharacters(await listPackages(executable)).split(/\r?\n/);
	} catch {
		return null;
	}
	const userPackages = lines.indexOf("User packages:");
	if (userPackages < 0) return null;

	for (let i = userPackages + 1; i < lines.length && lines[i]?.startsWith("  "); i++) {
		const line = lines[i];
		const path = lines[i + 1]?.match(/^ {4}(\S.*)$/)?.[1]?.trim();
		if (!line || !PSTACK_SOURCE.test(line) || !path || !isAbsolute(path)) continue;
		try {
			return (await preparePstackRuntime(path)).root;
		} catch {
			// Pi may retain an installation record after the package files have been removed.
		}
	}
	return null;
}

export async function installPiPstack(executable: string): Promise<string> {
	const existing = await findInstalledPstack(executable);
	if (existing) return existing;

	try {
		await execFileAsync(executable, ["install", PSTACK_PACKAGE, "--no-approve"], {
			timeout: 120_000,
			maxBuffer: 1024 * 1024,
			windowsHide: true,
		});
	} catch (cause) {
		throw new Error(`Pi 安装 pstack 失败。可在服务主机运行 pi install ${PSTACK_PACKAGE} 查看错误。`, { cause });
	}

	const installed = await findInstalledPstack(executable);
	if (!installed) throw new Error("Pi 安装完成，但未找到可用的 pstack 方法包。请在服务主机运行 pi list 核对路径。");
	return installed;
}
