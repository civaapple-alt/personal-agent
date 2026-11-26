import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
	resolveAllowedSkillRoots,
	resolveRoleSkillPath,
	type SkillResolutionOptions,
} from "../../roles/capabilities.ts";
import type { RoleTemplate } from "../../roles/types.ts";
import type { WorkerSessionRecord } from "../../storage/types.ts";

function isInsideRootDir(rootDir: string, realTarget: string): boolean {
	const rel = relative(rootDir, realTarget);
	return rel !== "" && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}

export async function resolveRoleSkills(
	template: RoleTemplate | undefined,
	options?: SkillResolutionOptions,
): Promise<string[]> {
	const allowedRoots = await Promise.all(
		resolveAllowedSkillRoots(template, options).map((root) => realpath(root).catch(() => resolve(root))),
	);
	return await Promise.all(
		(template?.skills ?? []).map(async (name) => {
			const path = resolveRoleSkillPath(name, template, options);
			const info = await stat(path).catch(() => {
				throw new Error(`Skill ${name} is not installed: ${path}`);
			});
			if (!info.isFile()) throw new Error(`Skill must point to a SKILL.md file: ${path}`);
			const realTarget = await realpath(path);
			if (!allowedRoots.some((root) => isInsideRootDir(root, realTarget))) {
				throw new Error(`Skill ${name} resolves outside allowed skill scope boundaries`);
			}
			return realTarget;
		}),
	);
}

/** Pi --session accepts missing paths by creating new sessions. Reject missing or foreign saved sessions ourselves. */
/** Encode a working directory identically to native Pi (~/.pi/agent/sessions/--<path>--/). */
export function encodePiSessionCwdDir(cwd: string): string {
	return `--${resolve(cwd)
		.replace(/^[/\\]/, "")
		.replace(/[/\\:]/g, "-")}--`;
}

/** Resolve the per-cwd Pi session directory under the configured session root. */
export function resolveScopedPiSessionDir(baseSessionDir: string | undefined, cwd: string): string | undefined {
	if (!baseSessionDir) return undefined;
	return resolve(baseSessionDir, encodePiSessionCwdDir(cwd));
}

export async function validateSavedSession(session: WorkerSessionRecord, cwd: string): Promise<string> {
	if (!session.sessionFile) throw new Error("Saved session has no file");
	const file = await open(session.sessionFile, "r");
	try {
		const buffer = Buffer.alloc(16_384);
		const { bytesRead } = await file.read(buffer);
		const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0] ?? "";
		const header: unknown = JSON.parse(firstLine);
		if (
			!header ||
			typeof header !== "object" ||
			!("type" in header) ||
			header.type !== "session" ||
			!("id" in header) ||
			header.id !== session.piSessionId ||
			!("cwd" in header) ||
			typeof header.cwd !== "string" ||
			(await realpath(header.cwd)) !== (await realpath(cwd))
		) {
			throw new Error("Saved Pi session identity or workspace does not match");
		}
	} finally {
		await file.close();
	}
	return session.sessionFile;
}

type PublicationCall = {
	tool: "save_space_page";
	callId: string;
	title: string;
	summary: string;
	changeNote: string;
} & (
	| { type: "document"; sourcePath: string; content?: never }
	| { type: "document" | "artifact" | "prototype_image" | "service_url"; content: string; sourcePath?: never }
);
type PublicationMetadata = Pick<PublicationCall, "tool" | "callId" | "title" | "summary" | "changeNote">;
export type DeliveryDraft = PublicationMetadata &
	(
		| {
				type: "document";
				content: string;
				source: { kind: "inline" } | { kind: "workspace_file"; path: string; realPath: string; sha256: string };
		  }
		| { type: "artifact" | "prototype_image" | "service_url"; content: string }
	);

async function resolveWorkspaceFile(sourcePath: string, cwd: string): Promise<string> {
	const root = await realpath(cwd);
	const path = await realpath(resolve(cwd, sourcePath));
	const local = relative(root, path);
	if (local === ".." || local.startsWith("../") || isAbsolute(local))
		throw new Error("Deliverable file must be inside the current workspace");
	if (!(await stat(path)).isFile()) throw new Error("Deliverable path must be an existing file");
	return path;
}

export async function readWorkspaceDocument(sourcePath: string, cwd: string) {
	const path = resolve(cwd, sourcePath);
	const resolved = await resolveWorkspaceFile(path, cwd);
	const maxBytes = 1_048_576;
	if ((await stat(resolved)).size > maxBytes) throw new Error(`Document source exceeds ${maxBytes} bytes`);
	const bytes = await readFile(resolved);
	if (bytes.length > maxBytes) throw new Error(`Document source exceeds ${maxBytes} bytes`);
	let content: string;
	try {
		content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		throw new Error("Document source must be UTF-8 text");
	}
	if (!content.trim()) throw new Error("Document source must contain nonempty text");
	return { path, realPath: resolved, sha256: createHash("sha256").update(bytes).digest("hex"), content };
}

const FOLDER_IMPORT_SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo", ".cache"]);
const FOLDER_IMPORT_MAX_FILES = 50;
const FOLDER_IMPORT_MAX_FILE_BYTES = 256 * 1024;
const FOLDER_IMPORT_MAX_TOTAL_BYTES = 2 * 1024 * 1024;

function isSkippedImportFile(name: string): boolean {
	return name === ".DS_Store" || name === "Thumbs.db" || name === ".env" || name.startsWith(".env.");
}

/** Read a workspace-contained directory into a bounded UTF-8 file batch for `save_space_page({ sourceDir })`. */
export async function readWorkspaceFolder(
	rawSourceDir: string,
	cwd: string,
): Promise<{ realDir: string; relDir: string; files: Array<{ subPath: string; content: string }> }> {
	let cleaned = rawSourceDir.trim();
	if (cleaned.startsWith("file://")) cleaned = cleaned.slice("file://".length);
	if (cleaned.startsWith("@")) cleaned = cleaned.slice(1);
	const root = await realpath(cwd);
	const resolvedDir = await realpath(resolve(cwd, cleaned));
	const relFromRoot = relative(root, resolvedDir);
	if (relFromRoot === ".." || relFromRoot.startsWith("../") || isAbsolute(relFromRoot)) {
		throw new Error("sourceDir must be inside the current workspace");
	}
	if (!(await stat(resolvedDir)).isDirectory()) {
		throw new Error("sourceDir must be an existing directory");
	}

	const collected: Array<{ subPath: string; content: string }> = [];
	const refused: string[] = [];
	let totalBytes = 0;

	const walk = async (dir: string, prefix: string): Promise<void> => {
		const entries = await readdir(dir, { withFileTypes: true });
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			const subPath = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (FOLDER_IMPORT_SKIP_DIRS.has(entry.name)) continue;
				await walk(resolve(dir, entry.name), subPath);
				continue;
			}
			if (isSkippedImportFile(entry.name)) continue;
			if (!entry.isFile() && !entry.isSymbolicLink()) continue;

			const fullPath = resolve(dir, entry.name);
			let realFile: string;
			try {
				realFile = await realpath(fullPath);
			} catch {
				refused.push(`- ${subPath}: broken link or unreadable path`);
				continue;
			}
			const relToDir = relative(resolvedDir, realFile);
			if (relToDir === ".." || relToDir.startsWith("../") || isAbsolute(relToDir)) {
				refused.push(`- ${subPath}: symlink escapes sourceDir`);
				continue;
			}
			const info = await stat(realFile);
			if (!info.isFile()) continue;
			if (collected.length >= FOLDER_IMPORT_MAX_FILES) {
				refused.push(`- ${subPath}: exceeds max ${FOLDER_IMPORT_MAX_FILES} files per folder import`);
				continue;
			}
			if (info.size > FOLDER_IMPORT_MAX_FILE_BYTES) {
				refused.push(`- ${subPath}: exceeds ${FOLDER_IMPORT_MAX_FILE_BYTES} bytes`);
				continue;
			}
			totalBytes += info.size;
			if (totalBytes > FOLDER_IMPORT_MAX_TOTAL_BYTES) {
				refused.push(`- ${subPath}: total folder size exceeds ${FOLDER_IMPORT_MAX_TOTAL_BYTES} bytes`);
				continue;
			}
			const bytes = await readFile(realFile);
			if (bytes.includes(0)) {
				refused.push(`- ${subPath}: binary file (NUL byte) is not supported in text space folder`);
				continue;
			}
			try {
				const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
				collected.push({ subPath, content });
			} catch {
				refused.push(`- ${subPath}: must be valid UTF-8 text`);
			}
		}
	};

	await walk(resolvedDir, "");
	if (refused.length > 0) {
		throw new Error(
			`save_space_page(sourceDir): nothing was published because these paths were refused:\n${refused.join("\n")}`,
		);
	}
	if (collected.length === 0) {
		throw new Error("save_space_page(sourceDir): directory contains no publishable UTF-8 text files");
	}
	return {
		realDir: resolvedDir,
		relDir: relFromRoot ? relFromRoot.replace(/\\/g, "/") : ".",
		files: collected,
	};
}

/** Resolve one authoritative source once; file-backed documents retain their exact text snapshot. */
export async function prepareDelivery(call: PublicationCall, cwd: string): Promise<DeliveryDraft> {
	const metadata: PublicationMetadata = {
		tool: call.tool,
		callId: call.callId,
		title: call.title,
		summary: call.summary,
		changeNote: call.changeNote,
	};
	if (call.type === "document") {
		if (call.sourcePath !== undefined) {
			const { content, ...source } = await readWorkspaceDocument(call.sourcePath, cwd);
			return { ...metadata, type: "document", content, source: { kind: "workspace_file", ...source } };
		}
		return { ...metadata, type: "document", content: call.content, source: { kind: "inline" } };
	}
	return validateDelivery({ ...metadata, type: call.type, content: call.content }, cwd);
}

/** Recheck at successful turn commit; do not silently publish a changed, unreviewed file. */
export async function validateDelivery(draft: DeliveryDraft, cwd: string): Promise<DeliveryDraft> {
	if (draft.type === "document") {
		if (draft.source.kind === "workspace_file") {
			const current = await readWorkspaceDocument(draft.source.path, cwd);
			if (current.realPath !== draft.source.realPath || current.sha256 !== draft.source.sha256)
				throw new Error(
					"Document source changed after saving; save the latest file to space before completing the turn",
				);
		}
		return draft;
	}
	if (draft.type === "service_url") {
		const url = new URL(draft.content);
		if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Service URL must use http(s)");
		return { ...draft, content: url.href };
	}
	return { ...draft, content: await resolveWorkspaceFile(draft.content, cwd) };
}

/**
 * Read effective Git user identity (`user.name` and `user.email`) from a repository or
 * host Git config so commits can preserve the real user as Committer alongside per-role Author.
 */
export function resolveRepoGitUserIdentity(cwd?: string | null): { name: string; email: string } | null {
	if (!cwd || !existsSync(cwd)) return null;
	try {
		const raw = execFileSync("git", ["config", "--get-regexp", "^user\\.(name|email)$"], {
			cwd,
			encoding: "utf8",
			timeout: 1500,
			stdio: ["ignore", "pipe", "ignore"],
		});
		let name = "";
		let email = "";
		for (const line of raw.split(/\r?\n/)) {
			const spaceIdx = line.search(/\s/);
			if (spaceIdx <= 0) continue;
			const key = line.slice(0, spaceIdx);
			const value = line.slice(spaceIdx + 1).trim();
			if (key === "user.name" && value) name = value;
			else if (key === "user.email" && value) email = value;
		}
		if (name && email) return { name, email };
		return null;
	} catch {
		return null;
	}
}

/**
 * List immediate non-VCS files and subdirectories of a workspace so read-only roles without
 * `bash`/`ls` can directly locate manifests and documentation inside the target repository.
 */
export function listWorkspaceTopLevelEntries(workspacePath?: string | null, limit = 40): string[] {
	if (!workspacePath || !existsSync(workspacePath)) return [];
	try {
		const entries = readdirSync(workspacePath, { withFileTypes: true })
			.filter((entry) => entry.name !== ".git" && entry.name !== ".DS_Store")
			.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
			.sort((a, b) => a.localeCompare(b));
		if (entries.length <= limit) return entries;
		return [...entries.slice(0, limit), `... (+${entries.length - limit} more)`];
	} catch {
		return [];
	}
}

const SAFE_SCOPE_SEGMENT_RE = /^[a-zA-Z0-9._-]+$/;

/**
 * Return existing scoped Skill directories (`global`, `orgs/<orgId>`, `users/<userId>`)
 * so Skills confirmed via `propose_skill` are natively discovered by Pi on subsequent turns
 * without leaking across organizations or users.
 */
export function resolveScopedDiscoveredSkillDirs(options: {
	skillsDir?: string;
	orgId?: string | null;
	userId?: string | null;
}): string[] {
	if (!options.skillsDir) return [];
	const candidates: string[] = [resolve(options.skillsDir, "global")];
	if (options.orgId && SAFE_SCOPE_SEGMENT_RE.test(options.orgId)) {
		candidates.push(resolve(options.skillsDir, "orgs", options.orgId));
	}
	if (options.userId && SAFE_SCOPE_SEGMENT_RE.test(options.userId)) {
		candidates.push(resolve(options.skillsDir, "users", options.userId));
	}
	return candidates.filter((dir) => existsSync(dir));
}

const DEFAULT_WORKSPACE_AGENTS_MD = `# Default Workspace

This directory is the default working directory for Personal Agent matters that are not bound to a specific repository workspace.

- General discussions, drafts, and scratch files created without a bound project workspace live here rather than inside the Personal Agent source repository.
- You can customize this file with your own general instructions for unbound matters.
`;

/**
 * Ensure the dedicated default workspace directory (by default \`~/.pa/workspaces/default\`)
 * exists and has a minimal \`AGENTS.md\` when first created.
 */
export function ensureDefaultWorkspaceDir(dirPath: string): string {
	const resolved = resolve(dirPath);
	mkdirSync(resolved, { recursive: true });
	const agentsPath = join(resolved, "AGENTS.md");
	if (!existsSync(agentsPath)) {
		writeFileSync(agentsPath, DEFAULT_WORKSPACE_AGENTS_MD, "utf8");
	}
	return resolved;
}

function canonicalizeFsPath(targetPath: string): string {
	const resolved = resolve(targetPath);
	try {
		return realpathSync(resolved);
	} catch {
		return resolved;
	}
}

function sameFsPath(left: string, right: string): boolean {
	if (process.platform === "win32") {
		return left.toLowerCase() === right.toLowerCase();
	}
	return left === right;
}

/** Resolve Pi's agent configuration directory (respecting \`PI_CODING_AGENT_DIR\`). */
export function resolvePiAgentDir(): string {
	const configured = process.env.PI_CODING_AGENT_DIR?.trim();
	if (configured) {
		if (configured === "~") return homedir();
		if (configured.startsWith("~/") || configured.startsWith("~\\")) {
			return join(homedir(), configured.slice(2));
		}
		return resolve(configured);
	}
	return join(homedir(), ".pi", "agent");
}

export interface PiProjectTrustState {
	decision: boolean | null;
	matchedPath: string | null;
}

/**
 * Read Pi's saved project trust state from \`~/.pi/agent/trust.json\` using Pi's
 * nearest-ancestor lookup rule. Returns both the decision and the matched path.
 */
export function readPiProjectTrustState(cwd: string, agentDir?: string): PiProjectTrustState {
	const trustPath = join(agentDir ?? resolvePiAgentDir(), "trust.json");
	if (!existsSync(trustPath)) return { decision: null, matchedPath: null };
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(trustPath, "utf8").replace(/^\uFEFF/, ""));
	} catch {
		return { decision: null, matchedPath: null };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { decision: null, matchedPath: null };
	const entries = Object.entries(parsed as Record<string, unknown>)
		.filter(([, value]) => value === true || value === false)
		.map(([key, value]) => ({ rawKey: key, path: canonicalizeFsPath(key), decision: value as boolean }));
	if (entries.length === 0) return { decision: null, matchedPath: null };

	let currentDir = canonicalizeFsPath(cwd);
	while (true) {
		const matched = entries.find((entry) => sameFsPath(entry.path, currentDir));
		if (matched) return { decision: matched.decision, matchedPath: matched.rawKey };
		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) return { decision: null, matchedPath: null };
		currentDir = parentDir;
	}
}

/**
 * Read Pi's saved project trust decision from \`~/.pi/agent/trust.json\` using Pi's
 * nearest-ancestor lookup rule. Returns \`true\`, \`false\`, or \`null\` if undecided.
 */
export function readPiProjectTrustDecision(cwd: string, agentDir?: string): boolean | null {
	return readPiProjectTrustState(cwd, agentDir).decision;
}

/**
 * Update a directory's trust decision in Pi's native \`~/.pi/agent/trust.json\` file
 * (\`true\`, \`false\`, or \`null\` to clear an explicit entry for \`cwd\`).
 */
export function writePiProjectTrustDecision(
	cwd: string,
	decision: boolean | null,
	agentDir?: string,
): PiProjectTrustState {
	const dir = agentDir ?? resolvePiAgentDir();
	const trustPath = join(dir, "trust.json");
	mkdirSync(dir, { recursive: true });
	const data: Record<string, boolean> = {};
	if (existsSync(trustPath)) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(trustPath, "utf8").replace(/^\uFEFF/, ""));
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
					if (value === true || value === false) data[key] = value;
				}
			}
		} catch {
			// Fall back to a clean object if the existing file is unreadable or corrupt.
		}
	}
	const canonicalCwd = canonicalizeFsPath(cwd);
	for (const existingKey of Object.keys(data)) {
		if (sameFsPath(canonicalizeFsPath(existingKey), canonicalCwd)) {
			delete data[existingKey];
		}
	}
	if (decision === true || decision === false) {
		data[canonicalCwd] = decision;
	}
	const tempPath = `${trustPath}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
	renameSync(tempPath, trustPath);
	return readPiProjectTrustState(cwd, agentDir);
}

/**
 * Build Pi's resource discovery & project trust CLI flags for a worker pass:
 * - Isolated / team / cloned workspaces: \`--no-extensions --no-approve\`
 * - Inherited local personal mode + explicit local workspace:
 *   \`--offline --approve\` unless \`~/.pi/agent/trust.json\` explicitly sets \`false\` (\`--offline --no-approve\`)
 * - Inherited local personal mode + unbound matter:
 *   \`--offline\` when using a dedicated default workspace dir (\`~/.pa/workspaces/default\`),
 *   or \`--offline --no-approve\` when falling back to the host repo cwd.
 */
export function resolveLocalWorkspacePiArgs(options: {
	inheritsLocalResources: boolean;
	hasWorkspace: boolean;
	cwd: string;
	hasDedicatedDefaultWorkspace: boolean;
	agentDir?: string;
}): string[] {
	if (!options.inheritsLocalResources) {
		return ["--no-extensions", "--no-approve"];
	}
	if (options.hasWorkspace) {
		const savedDecision = readPiProjectTrustDecision(options.cwd, options.agentDir);
		return savedDecision === false ? ["--offline", "--no-approve"] : ["--offline", "--approve"];
	}
	return options.hasDedicatedDefaultWorkspace ? ["--offline"] : ["--offline", "--no-approve"];
}
