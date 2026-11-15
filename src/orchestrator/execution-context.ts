import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RoleTemplate } from "../roles/types.ts";
import type { TeamToolCall } from "../rpc/team-tool-bridge.ts";
import type { WorkerSessionRecord } from "../storage/types.ts";

const skillsDir = fileURLToPath(new URL("../../skills/", import.meta.url));

export async function resolveRoleSkills(template: RoleTemplate | undefined): Promise<string[]> {
	return await Promise.all(
		(template?.skills ?? []).map(async (name) => {
			const path = isAbsolute(name)
				? name
				: name.includes("/")
					? resolve(template?.sourcePath ? dirname(template.sourcePath) : skillsDir, name)
					: resolve(skillsDir, name, "SKILL.md");
			const info = await stat(path).catch(() => {
				throw new Error(`Skill ${name} is not installed: ${path}`);
			});
			if (!info.isFile()) throw new Error(`Skill must point to a SKILL.md file: ${path}`);
			return path;
		}),
	);
}

/** Pi --session accepts missing paths by creating new sessions. Reject missing or foreign saved sessions ourselves. */
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

export type DeliveryDraft = Extract<TeamToolCall, { tool: "publish_deliverable" }>;

export async function validateDelivery(draft: DeliveryDraft, cwd: string): Promise<DeliveryDraft> {
	if (draft.type === "document") return draft;
	if (draft.type === "service_url") {
		const url = new URL(draft.content);
		if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Service URL must use http(s)");
		return { ...draft, content: url.href };
	}
	const root = await realpath(cwd);
	const path = await realpath(resolve(root, draft.content));
	const local = relative(root, path);
	if (local === ".." || local.startsWith("../") || isAbsolute(local))
		throw new Error("Deliverable file must be inside the current workspace");
	if (!(await stat(path)).isFile()) throw new Error("Deliverable path must be an existing file");
	return { ...draft, content: path };
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
