import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

/** Git-backed storage engine where each space owns an isolated Git repository under spacesDir/<spaceId>. */
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
		const repoDir = resolve(this.rootDir, safeId);
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

	async listCommits(spaceId: string, filePath?: string, limit = 50): Promise<SpaceGitCommit[]> {
		const repoDir = this.resolveRepoDir(spaceId);
		if (!existsSync(join(repoDir, ".git"))) return [];
		const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
		const args = [
			"log",
			`-n`,
			String(safeLimit),
			"--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e",
			...(filePath ? ["--follow", "--", normalizeSafeRepoFilePath(filePath)] : []),
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
