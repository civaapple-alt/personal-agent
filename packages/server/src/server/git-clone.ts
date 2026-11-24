import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SCP_SSH_RE = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+:[a-zA-Z0-9._~/@+-]+$/;
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

async function runGitCloneCommand(input: { cloneUrl: string; targetDir: string; branch?: string }): Promise<void> {
	const args = ["clone"];
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
