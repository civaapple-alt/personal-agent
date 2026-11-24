import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
	installPiPackage,
	listPiPackages,
	listUserPackagePaths,
	summarizePiCommandError,
} from "../../rpc/pi-packages.ts";

const PI_WEB_ACCESS_SOURCE = "npm:pi-web-access";
const WEB_ACCESS_SOURCE = /^ {2}npm:pi-web-access(?:@[^\s]+)?(?: \(filtered\))?$/;

export interface InstalledPiWebAccess {
	entry: string;
	version: string;
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
		await installPiPackage(executable, PI_WEB_ACCESS_SOURCE);
	} catch (cause) {
		const detail = summarizePiCommandError(cause);
		throw new Error(
			`Pi 安装 pi-web-access 失败${detail ? `（${detail}）` : ""}。可在服务主机运行 pi install ${PI_WEB_ACCESS_SOURCE} 查看错误。`,
			{ cause },
		);
	}
	const installed = await findInstalledPiWebAccess(executable);
	if (!installed) throw new Error("Pi 安装完成，但未找到可用的 pi-web-access 扩展入口。请运行 pi list 核对安装。");
	return installed;
}
