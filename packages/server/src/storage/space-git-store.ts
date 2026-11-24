import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, statSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface SpaceGitCommit {
	hash: string;
	shortHash: string;
	authorName: string;
	authorEmail: string;
	committedAt: string;
	subject: string;
}

export interface SpaceGitCommitDetail {
	commit: SpaceGitCommit;
	diff: string;
	content: string | null;
}

export class SpaceConflictError extends Error {
	readonly currentCommit: string | null;

	constructor(message: string, currentCommit: string | null) {
		super(message);
		this.name = "SpaceConflictError";
		this.currentCommit = currentCommit;
	}
}

const MAX_GIT_BUFFER = 8 * 1024 * 1024;

function normalizeSafeSpaceId(spaceId: string): string {
	const trimmed = spaceId.trim();
	if (!trimmed || !/^[A-Za-z0-9._-]+$/.test(trimmed) || trimmed === "." || trimmed === "..") {
		throw new Error(`Invalid space id: ${spaceId}`);
	}
	return trimmed;
}

export function normalizeSafeRepoFilePath(filePath: string): string {
	const cleaned = filePath.replace(/\\/g, "/").trim().replace(/^\/+/, "");
	if (!cleaned) throw new Error("Document path cannot be empty");
	const normalized = normalize(cleaned).replace(/\\/g, "/");
	if (
		!normalized ||
		normalized === "." ||
		normalized === ".." ||
		normalized.startsWith("../") ||
		normalized.includes("/../") ||
		isAbsolute(normalized)
	) {
		throw new Error(`Invalid space document path: ${filePath}`);
	}
	const segments = normalized.split("/");
	if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment === ".git")) {
		throw new Error(`Invalid space document path: ${filePath}`);
	}
	return normalized;
}

function sanitizeGitIdentity(value: string, fallback: string): string {
	const cleaned = value.replace(/[\r\n<>]/g, " ").trim();
	return cleaned || fallback;
}

/** Map a spaceId to its scoped subdirectory under spacesRoot (aligned with roles/ and skills/). */
export function resolveScopedSpaceRelativeDir(spaceId: string): string {
	const safeId = normalizeSafeSpaceId(spaceId);
	if (safeId.startsWith("spc_org_") && safeId.length > "spc_org_".length) {
		return join("orgs", safeId.slice("spc_org_".length));
	}
	if (safeId.startsWith("spc_ws_") && safeId.length > "spc_ws_".length) {
		return join("workspaces", safeId.slice("spc_ws_".length));
	}
	if (safeId.startsWith("spc_usr_") && safeId.length > "spc_usr_".length) {
		return join("users", safeId.slice("spc_usr_".length));
	}
	if (safeId.startsWith("spc_mem_") && safeId.length > "spc_mem_".length) {
		return join("members", safeId.slice("spc_mem_".length));
	}
	return join("custom", safeId);
}

/** Git-backed storage engine where each space owns an isolated Git repository under spacesDir/<scope>/<id>. */
export class SpaceGitStore {
	readonly rootDir: string;
	private readonly writeQueues = new Map<string, Promise<unknown>>();

	constructor(rootDir?: string) {
		if (rootDir) {
			this.rootDir = resolve(rootDir);
			mkdirSync(this.rootDir, { recursive: true });
		} else {
			this.rootDir = mkdtempSync(join(tmpdir(), "personal-agent-spaces-"));
		}
	}

	resolveRepoDir(spaceId: string): string {
		const safeId = normalizeSafeSpaceId(spaceId);
		const scopedRel = resolveScopedSpaceRelativeDir(safeId);
		const repoDir = resolve(this.rootDir, scopedRel);
		const rel = relative(this.rootDir, repoDir);
		if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
			throw new Error(`Space directory escapes root: ${spaceId}`);
		}
		return repoDir;
	}

	private enqueue<T>(spaceId: string, task: () => Promise<T>): Promise<T> {
		const safeId = normalizeSafeSpaceId(spaceId);
		const previous = this.writeQueues.get(safeId) ?? Promise.resolve();
		const run = previous.then(task, task);
		const settled = run.then(
			() => undefined,
			() => undefined,
		);
		this.writeQueues.set(safeId, settled);
		return run;
	}

	private async runGit(repoDir: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
		const result = await execFileAsync("git", args, {
			cwd: repoDir,
			maxBuffer: MAX_GIT_BUFFER,
			env: {
				...process.env,
				GIT_TERMINAL_PROMPT: "0",
			},
		});
		return { stdout: result.stdout, stderr: result.stderr };
	}

	private async ensureRepoUnlocked(spaceId: string): Promise<string> {
		const repoDir = this.resolveRepoDir(spaceId);
		await mkdir(repoDir, { recursive: true });
		if (!existsSync(join(repoDir, ".git"))) {
			try {
				await this.runGit(repoDir, ["init", "-b", "main"]);
			} catch {
				await this.runGit(repoDir, ["init"]);
				await this.runGit(repoDir, ["symbolic-ref", "HEAD", "refs/heads/main"]).catch(() => {});
			}
		}
		return repoDir;
	}

	async ensureRepo(spaceId: string): Promise<string> {
		return this.enqueue(spaceId, () => this.ensureRepoUnlocked(spaceId));
	}

	private async getLatestFileCommitUnlocked(repoDir: string, filePath: string): Promise<string | null> {
		if (!existsSync(join(repoDir, ".git"))) return null;
		try {
			const { stdout } = await this.runGit(repoDir, ["log", "-n", "1", "--format=%H", "--", filePath]);
			const hash = stdout.trim();
			return hash || null;
		} catch {
			return null;
		}
	}

	async writeDocument(input: {
		spaceId: string;
		filePath: string;
		content: string;
		authorName: string;
		authorEmail: string;
		commitMessage: string;
		expectedCommit?: string | null;
		allowEmpty?: boolean;
	}): Promise<{ commitHash: string; committedAt: string }> {
		const safePath = normalizeSafeRepoFilePath(input.filePath);
		return this.enqueue(input.spaceId, async () => {
			const repoDir = await this.ensureRepoUnlocked(input.spaceId);
			if (input.expectedCommit !== undefined) {
				const currentCommit = await this.getLatestFileCommitUnlocked(repoDir, safePath);
				if (currentCommit !== input.expectedCommit) {
					throw new SpaceConflictError("资料已被修改，请重新加载后再保存", currentCommit);
				}
			}
			const fullPath = resolve(repoDir, safePath);
			const rel = relative(repoDir, fullPath);
			if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
				throw new Error(`Document path escapes repository: ${input.filePath}`);
			}
			await mkdir(dirname(fullPath), { recursive: true });
			await writeFile(fullPath, input.content, "utf8");
			await this.runGit(repoDir, ["add", "--", safePath]);

			const status = await this.runGit(repoDir, ["status", "--porcelain", "--", safePath]);
			const hasChanges = Boolean(status.stdout.trim());
			const currentCommit = await this.getLatestFileCommitUnlocked(repoDir, safePath);

			if (!hasChanges && currentCommit && !input.allowEmpty) {
				const committedAt = (
					await this.runGit(repoDir, ["show", "-s", "--format=%cI", currentCommit])
				).stdout.trim();
				return { commitHash: currentCommit, committedAt: committedAt || new Date().toISOString() };
			}

			const authorName = sanitizeGitIdentity(input.authorName, "Personal Agent");
			const authorEmail = sanitizeGitIdentity(input.authorEmail, "agent@personal-agent.local");
			const message = input.commitMessage.replace(/\r/g, "").trim() || `Update ${safePath}`;
			const commitArgs = [
				"-c",
				`user.name=${authorName}`,
				"-c",
				`user.email=${authorEmail}`,
				"commit",
				...(hasChanges ? [] : ["--allow-empty"]),
				"-m",
				message,
				...(hasChanges ? ["--", safePath] : []),
			];
			await this.runGit(repoDir, commitArgs);
			const headInfo = await this.runGit(repoDir, ["log", "-n", "1", "--format=%H%x1f%cI"]);
			const [commitHash = "", committedAt = ""] = headInfo.stdout.trim().split("\x1f");
			return {
				commitHash,
				committedAt: committedAt || new Date().toISOString(),
			};
		});
	}

	async readDocument(spaceId: string, filePath: string): Promise<string | null> {
		const safePath = normalizeSafeRepoFilePath(filePath);
		const repoDir = this.resolveRepoDir(spaceId);
		const fullPath = resolve(repoDir, safePath);
		const rel = relative(repoDir, fullPath);
		if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
		try {
			return await readFile(fullPath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	}

	async readRawFile(spaceId: string, filePath: string): Promise<Buffer | null> {
		const safePath = normalizeSafeRepoFilePath(filePath);
		const repoDir = this.resolveRepoDir(spaceId);
		const fullPath = resolve(repoDir, safePath);
		const rel = relative(repoDir, fullPath);
		if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
		try {
			return await readFile(fullPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	}

	async listDirectoryFiles(spaceId: string, dirPath: string): Promise<Array<{ path: string; sizeBytes: number }>> {
		const safeDir = normalizeSafeRepoFilePath(dirPath);
		const repoDir = this.resolveRepoDir(spaceId);
		const fullDir = resolve(repoDir, safeDir);
		if (!existsSync(fullDir) || !existsSync(join(repoDir, ".git"))) return [];
		try {
			const { stdout } = await this.runGit(repoDir, [
				"ls-files",
				"-z",
				"--cached",
				"--others",
				"--exclude-standard",
				"--",
				safeDir,
			]);
			const prefix = `${safeDir}/`;
			const entries: Array<{ path: string; sizeBytes: number }> = [];
			for (const raw of stdout.split("\0")) {
				const repoRel = raw.trim();
				if (!repoRel || !repoRel.startsWith(prefix)) continue;
				const subPath = repoRel.slice(prefix.length);
				if (!subPath) continue;
				try {
					const st = await stat(resolve(repoDir, repoRel));
					if (st.isFile()) {
						entries.push({ path: subPath, sizeBytes: st.size });
					}
				} catch {
					// File removed on disk
				}
			}
			entries.sort((a, b) => {
				if (a.path === "README.md") return -1;
				if (b.path === "README.md") return 1;
				return a.path.localeCompare(b.path);
			});
			return entries;
		} catch {
			return [];
		}
	}

	async writeFolderFiles(input: {
		spaceId: string;
		dirPath: string;
		files: Array<{ subPath: string; content: string }>;
		authorName: string;
		authorEmail: string;
		commitMessage: string;
		expectedCommit?: string | null;
		allowEmpty?: boolean;
	}): Promise<{ commitHash: string; committedAt: string }> {
		const safeDir = normalizeSafeRepoFilePath(input.dirPath);
		const files = input.files.map((file) => ({ ...file, subPath: normalizeSafeRepoFilePath(file.subPath) }));
		return this.enqueue(input.spaceId, async () => {
			const repoDir = await this.ensureRepoUnlocked(input.spaceId);
			if (input.expectedCommit !== undefined) {
				const currentCommit = await this.getLatestFileCommitUnlocked(repoDir, safeDir);
				if (currentCommit !== input.expectedCommit) {
					throw new SpaceConflictError("资料已被修改，请重新加载后再保存", currentCommit);
				}
			}
			for (const file of files) {
				const safeSub = file.subPath;
				const fullPath = resolve(repoDir, safeDir, safeSub);
				const rel = relative(resolve(repoDir, safeDir), fullPath);
				if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
					throw new Error(`Sub-file path escapes entry directory: ${file.subPath}`);
				}
				await mkdir(dirname(fullPath), { recursive: true });
				await writeFile(fullPath, file.content, "utf8");
			}
			// Respect entry-level .gitignore automatically by staging the directory path.
			await this.runGit(repoDir, ["add", "-A", "--", safeDir]);

			const status = await this.runGit(repoDir, ["status", "--porcelain", "--", safeDir]);
			const hasChanges = Boolean(status.stdout.trim());
			const currentCommit = await this.getLatestFileCommitUnlocked(repoDir, safeDir);

			if (!hasChanges && currentCommit && !input.allowEmpty) {
				const committedAt = (
					await this.runGit(repoDir, ["show", "-s", "--format=%cI", currentCommit])
				).stdout.trim();
				return { commitHash: currentCommit, committedAt: committedAt || new Date().toISOString() };
			}

			const authorName = sanitizeGitIdentity(input.authorName, "Personal Agent");
			const authorEmail = sanitizeGitIdentity(input.authorEmail, "agent@personal-agent.local");
			const message = input.commitMessage.replace(/\r/g, "").trim() || `Update ${safeDir}`;
			await this.runGit(repoDir, [
				"-c",
				`user.name=${authorName}`,
				"-c",
				`user.email=${authorEmail}`,
				"commit",
				...(hasChanges ? [] : ["--allow-empty"]),
				"-m",
				message,
				...(hasChanges ? ["--", safeDir] : []),
			]);
			const headInfo = await this.runGit(repoDir, ["log", "-n", "1", "--format=%H%x1f%cI"]);
			const [commitHash = "", committedAt = ""] = headInfo.stdout.trim().split("\x1f");
			return { commitHash, committedAt: committedAt || new Date().toISOString() };
		});
	}

	async deleteFolderFile(input: {
		spaceId: string;
		dirPath: string;
		subPath: string;
		authorName: string;
		authorEmail: string;
		commitMessage: string;
	}): Promise<{ commitHash: string; committedAt: string }> {
		const safeDir = normalizeSafeRepoFilePath(input.dirPath);
		const safeSub = normalizeSafeRepoFilePath(input.subPath);
		return this.enqueue(input.spaceId, async () => {
			const repoDir = await this.ensureRepoUnlocked(input.spaceId);
			const fullPath = resolve(repoDir, safeDir, safeSub);
			const rel = relative(resolve(repoDir, safeDir), fullPath);
			if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
				throw new Error(`Sub-file path escapes entry directory: ${input.subPath}`);
			}
			await rm(fullPath, { force: true });
			await this.runGit(repoDir, ["add", "-A", "--", safeDir]);
			const status = await this.runGit(repoDir, ["status", "--porcelain", "--", safeDir]);
			const hasChanges = Boolean(status.stdout.trim());
			const currentCommit = await this.getLatestFileCommitUnlocked(repoDir, safeDir);
			if (!hasChanges && currentCommit) {
				const committedAt = (
					await this.runGit(repoDir, ["show", "-s", "--format=%cI", currentCommit])
				).stdout.trim();
				return { commitHash: currentCommit, committedAt: committedAt || new Date().toISOString() };
			}
			const authorName = sanitizeGitIdentity(input.authorName, "Personal Agent");
			const authorEmail = sanitizeGitIdentity(input.authorEmail, "agent@personal-agent.local");
			const message = input.commitMessage.replace(/\r/g, "").trim() || `Delete ${safeSub}`;
			await this.runGit(repoDir, [
				"-c",
				`user.name=${authorName}`,
				"-c",
				`user.email=${authorEmail}`,
				"commit",
				...(hasChanges ? [] : ["--allow-empty"]),
				"-m",
				message,
				...(hasChanges ? ["--", safeDir] : []),
			]);
			const headInfo = await this.runGit(repoDir, ["log", "-n", "1", "--format=%H%x1f%cI"]);
			const [commitHash = "", committedAt = ""] = headInfo.stdout.trim().split("\x1f");
			return { commitHash, committedAt: committedAt || new Date().toISOString() };
		});
	}

	async promoteFileToFolder(input: {
		spaceId: string;
		oldFilePath: string;
		dirPath: string;
		defaultGitignore: string;
		authorName: string;
		authorEmail: string;
		commitMessage: string;
	}): Promise<{ commitHash: string; committedAt: string }> {
		const safeOld = normalizeSafeRepoFilePath(input.oldFilePath);
		const safeDir = normalizeSafeRepoFilePath(input.dirPath);
		return this.enqueue(input.spaceId, async () => {
			const repoDir = await this.ensureRepoUnlocked(input.spaceId);
			const oldFull = resolve(repoDir, safeOld);
			let existingContent = "";
			try {
				existingContent = await readFile(oldFull, "utf8");
			} catch {
				existingContent = "";
			}
			const targetDirFull = resolve(repoDir, safeDir);
			await mkdir(targetDirFull, { recursive: true });
			await writeFile(resolve(targetDirFull, "README.md"), existingContent, "utf8");
			await writeFile(resolve(targetDirFull, ".gitignore"), input.defaultGitignore, "utf8");
			await rm(oldFull, { force: true });
			await this.runGit(repoDir, ["add", "-A", "--", safeOld, safeDir]);

			const authorName = sanitizeGitIdentity(input.authorName, "Personal Agent");
			const authorEmail = sanitizeGitIdentity(input.authorEmail, "agent@personal-agent.local");
			const message = input.commitMessage.replace(/\r/g, "").trim() || `Convert ${safeOld} to folder entry`;
			await this.runGit(repoDir, [
				"-c",
				`user.name=${authorName}`,
				"-c",
				`user.email=${authorEmail}`,
				"commit",
				"-m",
				message,
				"--",
				safeOld,
				safeDir,
			]);
			const headInfo = await this.runGit(repoDir, ["log", "-n", "1", "--format=%H%x1f%cI"]);
			const [commitHash = "", committedAt = ""] = headInfo.stdout.trim().split("\x1f");
			return { commitHash, committedAt: committedAt || new Date().toISOString() };
		});
	}

	async listCommits(spaceId: string, filePath?: string, limit = 50): Promise<SpaceGitCommit[]> {
		const repoDir = this.resolveRepoDir(spaceId);
		if (!existsSync(join(repoDir, ".git"))) return [];
		const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
		const safePath = filePath ? normalizeSafeRepoFilePath(filePath) : undefined;
		let isDirectory = false;
		if (safePath) {
			try {
				isDirectory = statSync(resolve(repoDir, safePath)).isDirectory();
			} catch {
				isDirectory = false;
			}
		}
		const args = [
			"log",
			`-n`,
			String(safeLimit),
			"--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e",
			...(safePath ? (isDirectory ? ["--", safePath] : ["--follow", "--", safePath]) : []),
		];
		try {
			const { stdout } = await this.runGit(repoDir, args);
			return stdout
				.split("\x1e")
				.map((entry) => entry.trim())
				.filter(Boolean)
				.map((entry) => {
					const [hash = "", shortHash = "", authorName = "", authorEmail = "", committedAt = "", subject = ""] =
						entry.split("\x1f");
					return { hash, shortHash, authorName, authorEmail, committedAt, subject };
				})
				.filter((commit) => Boolean(commit.hash));
		} catch {
			return [];
		}
	}

	/** Check that a full commit belongs to this document's reachable history. */
	async isDocumentCommit(spaceId: string, filePath: string, commitHash: string): Promise<boolean> {
		if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commitHash)) return false;
		const repoDir = this.resolveRepoDir(spaceId);
		const safePath = normalizeSafeRepoFilePath(filePath);
		try {
			await this.runGit(repoDir, ["merge-base", "--is-ancestor", commitHash, "HEAD"]);
			const result = await this.runGit(repoDir, ["log", "-1", "--format=%H", commitHash, "--", safePath]);
			return result.stdout.trim() === commitHash;
		} catch {
			return false;
		}
	}

	async getCommitDetail(spaceId: string, commitHash: string, filePath?: string): Promise<SpaceGitCommitDetail | null> {
		const cleanedHash = commitHash.trim();
		if (!/^[0-9a-fA-F]{7,64}$/.test(cleanedHash)) return null;
		const repoDir = this.resolveRepoDir(spaceId);
		if (!existsSync(join(repoDir, ".git"))) return null;
		const safePath = filePath ? normalizeSafeRepoFilePath(filePath) : undefined;
		try {
			const meta = await this.runGit(repoDir, [
				"show",
				"-s",
				"--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s",
				cleanedHash,
			]);
			const [hash = "", shortHash = "", authorName = "", authorEmail = "", committedAt = "", subject = ""] =
				meta.stdout.trim().split("\x1f");
			if (!hash) return null;

			const diffResult = await this.runGit(repoDir, [
				"show",
				"--format=",
				"--patch",
				cleanedHash,
				...(safePath ? ["--", safePath] : []),
			]);

			let content: string | null = null;
			if (safePath) {
				try {
					const blob = await this.runGit(repoDir, ["show", `${cleanedHash}:${safePath}`]);
					content = blob.stdout;
				} catch {
					content = null;
				}
			}

			return {
				commit: { hash, shortHash, authorName, authorEmail, committedAt, subject },
				diff: diffResult.stdout,
				content,
			};
		} catch {
			return null;
		}
	}

	async deleteRepo(spaceId: string): Promise<void> {
		await this.enqueue(spaceId, async () => {
			const repoDir = this.resolveRepoDir(spaceId);
			await rm(repoDir, { recursive: true, force: true });
		});
	}
}
