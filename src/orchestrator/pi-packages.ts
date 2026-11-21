import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";
import { preparePstackRuntime } from "../../pi-extensions/pstack-methods/methods.js";

const execFileAsync = promisify(execFile);
const PSTACK_PACKAGE = "git:github.com/backnotprop/pstack";
const PSTACK_SOURCE =
	/^ {2}(?:git:)?(?:https:\/\/|ssh:\/\/git@|git@)?github\.com[/:]backnotprop\/pstack(?:\.git)?(?:[@#]\S+)?(?: \(filtered\))?$/i;
export const PI_WEB_ACCESS_SOURCE = "npm:pi-web-access";
const WEB_ACCESS_SOURCE = /^ {2}npm:pi-web-access(?:@[^\s]+)?(?: \(filtered\))?$/;
export const PI_WEB_SEARCH_TOOLS = ["web_search", "get_search_content"] as const;
const WEB_ACCESS_TOOLS = new Set<string>([...PI_WEB_SEARCH_TOOLS, "web_enable", "source_check", "fetch_content"]);

export function isPiWebAccessTool(name: string): boolean {
	return WEB_ACCESS_TOOLS.has(name);
}

export interface InstalledPiWebAccess {
	entry: string;
	version: string;
}

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

async function listUserPackagePaths(
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

export async function findInstalledPstack(executable: string, listPackages = listPiPackages): Promise<string | null> {
	for (const path of await listUserPackagePaths(executable, PSTACK_SOURCE, listPackages)) {
		try {
			return (await preparePstackRuntime(path)).root;
		} catch {
			// Pi may retain an installation record after the package files have been removed.
		}
	}
	return null;
}

export async function findInstalledPiWebAccess(
	executable: string,
	listPackages = listPiPackages,
): Promise<InstalledPiWebAccess | null> {
	for (const path of await listUserPackagePaths(executable, WEB_ACCESS_SOURCE, listPackages)) {
		try {
			const root = await realpath(path);
			const manifest: unknown = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
			if (
				!manifest ||
				typeof manifest !== "object" ||
				!("name" in manifest) ||
				manifest.name !== "pi-web-access" ||
				!("version" in manifest) ||
				typeof manifest.version !== "string" ||
				!("pi" in manifest) ||
				!manifest.pi ||
				typeof manifest.pi !== "object" ||
				!("extensions" in manifest.pi) ||
				!Array.isArray(manifest.pi.extensions) ||
				manifest.pi.extensions.length !== 1
			)
				continue;
			const [entry] = manifest.pi.extensions;
			if (typeof entry !== "string" || isAbsolute(entry)) continue;
			const declared = resolve(root, entry);
			// Pi's automatic package discovery loads the actual index file of a directory entry.
			const target = await realpath((await stat(declared)).isDirectory() ? resolve(declared, "index.js") : declared);
			const within = relative(root, target);
			if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) continue;
			if (!(await stat(target)).isFile()) continue;
			return { entry: target, version: manifest.version };
		} catch {
			// A removed installation or invalid manifest cannot supply an extension entry.
		}
	}
	return null;
}

export async function installPiWebAccess(executable: string): Promise<InstalledPiWebAccess> {
	const existing = await findInstalledPiWebAccess(executable);
	if (existing) return existing;
	try {
		await execFileAsync(executable, ["install", PI_WEB_ACCESS_SOURCE, "--no-approve"], {
			timeout: 120_000,
			maxBuffer: 1024 * 1024,
			windowsHide: true,
		});
	} catch (cause) {
		throw new Error(`Pi 安装 pi-web-access 失败。可在服务主机运行 pi install ${PI_WEB_ACCESS_SOURCE} 查看错误。`, {
			cause,
		});
	}
	const installed = await findInstalledPiWebAccess(executable);
	if (!installed) throw new Error("Pi 安装完成，但未找到可用的 pi-web-access 扩展入口。请运行 pi list 核对安装。");
	return installed;
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
