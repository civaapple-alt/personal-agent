import { preparePstackRuntime } from "../../../pi-extensions/pstack-methods/methods.js";
import { installPiPackage, listPiPackages, listUserPackagePaths } from "../../rpc/pi-packages.ts";

export { type PstackRuntime, preparePstackRuntime } from "../../../pi-extensions/pstack-methods/methods.js";

const PSTACK_PACKAGE = "git:github.com/backnotprop/pstack";
const PSTACK_SOURCE =
	/^ {2}(?:git:)?(?:https:\/\/|ssh:\/\/git@|git@)?github\.com[/:]backnotprop\/pstack(?:\.git)?(?:[@#]\S+)?(?: \(filtered\))?$/i;

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

export async function installPiPstack(executable: string): Promise<string> {
	const existing = await findInstalledPstack(executable);
	if (existing) return existing;

	try {
		await installPiPackage(executable, PSTACK_PACKAGE);
	} catch (cause) {
		throw new Error(`Pi 安装 pstack 失败。可在服务主机运行 pi install ${PSTACK_PACKAGE} 查看错误。`, { cause });
	}

	const installed = await findInstalledPstack(executable);
	if (!installed) throw new Error("Pi 安装完成，但未找到可用的 pstack 方法包。请在服务主机运行 pi list 核对路径。");
	return installed;
}
