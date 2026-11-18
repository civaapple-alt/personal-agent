import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { type PstackRuntime, preparePstackRuntime } from "../roles/pstack.ts";

const execFileAsync = promisify(execFile);

export const DEFAULT_PSTACK_CLONE_URL = "https://github.com/backnotprop/pstack.git";

const SCP_SSH_RE = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+:[a-zA-Z0-9._~/@+-]+$/;
const pstackInstallLocks = new Map<string, Promise<InstallPstackResult>>();

export interface InstallPstackResult {
	repoPath: string;
	source: "cloned" | "updated" | "existing";
	runtime: PstackRuntime;
}

export function validateCloneUrl(rawUrl: string): string {
	const trimmed = rawUrl.trim();
	if (!trimmed) throw new Error("请填写 Git 仓库克隆地址");
	if (trimmed.length > 512) throw new Error("克隆地址过长");
	if (
		[...trimmed].some((ch) => {
			const code = ch.charCodeAt(0);
			return code <= 0x1f || code === 0x7f || /\s/.test(ch);
		})
	) {
		throw new Error("克隆地址不能包含空格或控制字符");
	}
	if (trimmed.startsWith("-")) {
		throw new Error("克隆地址格式无效");
	}
	const lower = trimmed.toLowerCase();
	if (lower.startsWith("file://") || lower.startsWith("ext::") || lower.startsWith("fd::")) {
		throw new Error("出于宿主机安全限制，不允许使用 file:// 或自定义传输协议");
	}
	if (lower.startsWith("https://") || lower.startsWith("http://") || lower.startsWith("ssh://")) {
		let parsed: URL;
		try {
			parsed = new URL(trimmed);
		} catch {
			throw new Error("无效的 HTTP/SSH Git 地址");
		}
		if (!parsed.hostname) throw new Error("Git 地址缺少主机名");
		return trimmed;
	}
	if (SCP_SSH_RE.test(trimmed)) {
		return trimmed;
	}
	throw new Error("仅支持 https://、http://、ssh:// 或 git@host:path 格式的 Git 地址");
}

function deriveSafeRepoFolder(name: string, cloneUrl: string): string {
	const cleanedUrl = cloneUrl.trim().replace(/\/+$/, "");
	const fromUrl =
		cleanedUrl
			.split(/[/:]/)
			.pop()
			?.replace(/\.git$/i, "") ?? "";
	const raw = fromUrl || name || "repo";
	const safe = raw
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[.-]+|[.-]+$/g, "")
		.slice(0, 48);
	return safe || `repo-${randomUUID().slice(0, 6)}`;
}

export function resolveOrgWorkspacesDir(workspacesRoot: string, org: { id: string; slug?: string }): string {
	const folder = (org.slug || org.id).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "org";
	return resolve(workspacesRoot, folder);
}

async function runGitCloneCommand(input: {
	cloneUrl: string;
	targetDir: string;
	branch?: string;
	depth?: number;
}): Promise<void> {
	const execClone = async (withDepth: boolean) => {
		const args = ["clone"];
		if (withDepth && input.depth && input.depth > 0) {
			args.push("--depth", String(input.depth));
		}
		if (input.branch) {
			args.push("--branch", input.branch, "--single-branch");
		}
		args.push("--", input.cloneUrl, input.targetDir);
		await execFileAsync("git", args, {
			timeout: 120_000,
			maxBuffer: 4 * 1024 * 1024,
			env: {
				...process.env,
				GIT_TERMINAL_PROMPT: "0",
			},
		});
	};

	const useShallow = Boolean(input.depth && input.depth > 0);
	try {
		await execClone(useShallow);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (useShallow && /shallow|dumb http/i.test(msg)) {
			if (existsSync(input.targetDir)) {
				rmSync(input.targetDir, { recursive: true, force: true });
			}
			await execClone(false);
			return;
		}
		throw err;
	}
}

export async function cloneGitWorkspaceIntoOrgRoot(input: {
	workspacesRoot: string;
	org: { id: string; slug?: string };
	name: string;
	cloneUrl: string;
	branch?: string;
}): Promise<{ repoPath: string; detectedBranch: string }> {
	const cloneUrl = validateCloneUrl(input.cloneUrl);
	const branch = input.branch?.trim() || "";
	if (branch && (branch.startsWith("-") || !/^[a-zA-Z0-9._/-]+$/.test(branch))) {
		throw new Error("默认分支名称包含非法字符");
	}
	const orgDir = resolveOrgWorkspacesDir(input.workspacesRoot, input.org);
	mkdirSync(orgDir, { recursive: true });
	const baseSlug = deriveSafeRepoFolder(input.name, cloneUrl);
	let targetDir = join(orgDir, baseSlug);
	if (existsSync(targetDir)) {
		targetDir = join(orgDir, `${baseSlug}-${randomUUID().slice(0, 6)}`);
	}

	try {
		await runGitCloneCommand({ cloneUrl, targetDir, branch: branch || undefined });
		const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
			cwd: targetDir,
			timeout: 10_000,
		});
		const detectedBranch = stdout.trim() || branch || "main";
		return { repoPath: targetDir, detectedBranch };
	} catch (err) {
		if (existsSync(targetDir)) {
			rmSync(targetDir, { recursive: true, force: true });
		}
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`克隆仓库失败：${msg.slice(0, 320)}`);
	}
}

export function resolveExtensionsRepoRoot(dataDir: string): string {
	return resolve(dataDir, "extensions", "repo");
}

export function resolveDefaultPstackRepoDir(dataDir: string, cloneUrl = DEFAULT_PSTACK_CLONE_URL): string {
	const folder = deriveSafeRepoFolder("pstack", cloneUrl);
	return resolve(resolveExtensionsRepoRoot(dataDir), folder);
}

async function performInstallOrEnablePstackRepo(input: {
	dataDir: string;
	cloneUrl?: string;
	update?: boolean;
}): Promise<InstallPstackResult> {
	const cloneUrl = validateCloneUrl(input.cloneUrl?.trim() || DEFAULT_PSTACK_CLONE_URL);
	const targetDir = resolveDefaultPstackRepoDir(input.dataDir, cloneUrl);
	const parentDir = dirname(targetDir);

	if (existsSync(targetDir)) {
		if (!statSync(targetDir).isDirectory()) {
			throw new Error(`目标路径已存在且不是目录：${targetDir}`);
		}
		const entries = readdirSync(targetDir);
		if (entries.length > 0) {
			let existingRuntime: PstackRuntime;
			try {
				existingRuntime = await preparePstackRuntime(targetDir);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				throw new Error(`目录 ${targetDir} 已存在非空内容但不是有效的 pstack 方法包：${msg}`);
			}
			if (input.update && existsSync(join(targetDir, ".git"))) {
				try {
					await execFileAsync("git", ["pull", "--ff-only"], {
						cwd: targetDir,
						timeout: 120_000,
						maxBuffer: 4 * 1024 * 1024,
						env: {
							...process.env,
							GIT_TERMINAL_PROMPT: "0",
						},
					});
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					throw new Error(`同步更新 pstack 仓库失败：${msg.slice(0, 320)}`);
				}
				const updatedRuntime = await preparePstackRuntime(targetDir);
				return { repoPath: updatedRuntime.root, source: "updated", runtime: updatedRuntime };
			}
			return { repoPath: existingRuntime.root, source: "existing", runtime: existingRuntime };
		}
	}

	mkdirSync(parentDir, { recursive: true });
	const stagingDir = join(parentDir, `.repo-tmp-${randomUUID().slice(0, 8)}`);
	try {
		try {
			await runGitCloneCommand({ cloneUrl, targetDir: stagingDir, depth: 1 });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`克隆 pstack 仓库失败：${msg.slice(0, 320)}`);
		}
		try {
			await preparePstackRuntime(stagingDir);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`已克隆仓库，但缺少完整的 pstack 结构（plugin.json 与 skills/poteto-mode/SKILL.md）：${msg}`);
		}
		if (existsSync(targetDir)) {
			if (readdirSync(targetDir).length > 0) {
				throw new Error(`目标目录在克隆完成前变为非空：${targetDir}`);
			}
			rmdirSync(targetDir);
		}
		renameSync(stagingDir, targetDir);
		const runtime = await preparePstackRuntime(targetDir);
		return { repoPath: runtime.root, source: "cloned", runtime };
	} finally {
		if (existsSync(stagingDir)) {
			rmSync(stagingDir, { recursive: true, force: true });
		}
	}
}

/** Validate or clone the full pstack pack into `<dataDir>/extensions/repo/<repoName>` and return its verified runtime info. */
export async function installOrEnablePstackRepo(input: {
	dataDir: string;
	cloneUrl?: string;
	update?: boolean;
}): Promise<InstallPstackResult> {
	const normalizedUrl = validateCloneUrl(input.cloneUrl?.trim() || DEFAULT_PSTACK_CLONE_URL);
	const lockKey = resolveDefaultPstackRepoDir(input.dataDir, normalizedUrl);
	const active = pstackInstallLocks.get(lockKey);
	if (active) return active;
	const task = performInstallOrEnablePstackRepo(input).finally(() => {
		if (pstackInstallLocks.get(lockKey) === task) {
			pstackInstallLocks.delete(lockKey);
		}
	});
	pstackInstallLocks.set(lockKey, task);
	return task;
}
