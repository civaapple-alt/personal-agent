import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	BoardMemberRecord,
	BoardMemberStatus,
	BoardPostKind,
	BoardPostRecord,
	BoardPostSummary,
	BoardPostVerification,
	BoardRole,
	ModelOverride,
} from "./types.ts";

const SAFE_SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function sanitizeSlug(value: string, fieldName = "id"): string {
	const trimmed = value.trim();
	if (!SAFE_SLUG_RE.test(trimmed) || trimmed.includes("..")) {
		throw new Error(`Invalid ${fieldName} "${value}": use alphanumeric characters, ".", "_", or "-"`);
	}
	return trimmed;
}

export function resolveDefaultBoardDir(cwd: string, boardId = "default"): string {
	return join(cwd, ".pi", "boards", sanitizeSlug(boardId, "boardId"));
}

function normalizeStringArray(items?: string[]): string[] {
	if (!Array.isArray(items)) return [];
	return Array.from(new Set(items.map((item) => String(item).trim()).filter(Boolean)));
}

export class LocalBoardStore {
	readonly boardId: string;
	readonly boardDir: string;
	readonly membersFile: string;
	readonly postsFile: string;
	readonly sessionsDir: string;

	constructor(boardDir: string, boardId = "default") {
		this.boardId = sanitizeSlug(boardId, "boardId");
		this.boardDir = boardDir;
		this.membersFile = join(boardDir, "members.json");
		this.postsFile = join(boardDir, "posts.jsonl");
		this.sessionsDir = join(boardDir, "sessions");
	}

	private ensureLayout(): void {
		mkdirSync(this.sessionsDir, { recursive: true });
	}

	getSessionFile(agentId: string): string {
		this.ensureLayout();
		return join(this.sessionsDir, `${sanitizeSlug(agentId, "agentId")}.jsonl`);
	}

	private readMembersFile(): BoardMemberRecord[] {
		if (!existsSync(this.membersFile)) return [];
		const raw = readFileSync(this.membersFile, "utf8").trim();
		if (!raw) return [];
		const parsed = JSON.parse(raw) as { members?: BoardMemberRecord[] } | BoardMemberRecord[];
		if (Array.isArray(parsed)) return parsed;
		return Array.isArray(parsed.members) ? parsed.members : [];
	}

	private writeMembersFile(members: BoardMemberRecord[]): void {
		this.ensureLayout();
		const tmp = `${this.membersFile}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
		writeFileSync(tmp, `${JSON.stringify({ boardId: this.boardId, members }, null, 2)}\n`, "utf8");
		renameSync(tmp, this.membersFile);
	}

	listMembers(): BoardMemberRecord[] {
		return this.readMembersFile();
	}

	getMember(agentId: string): BoardMemberRecord | undefined {
		const id = sanitizeSlug(agentId, "agentId");
		return this.readMembersFile().find((member) => member.agentId === id);
	}

	ensureCoordinator(agentId = "coordinator", displayName = "Coordinator"): BoardMemberRecord {
		const id = sanitizeSlug(agentId, "agentId");
		const members = this.readMembersFile();
		const existing = members.find((member) => member.agentId === id);
		if (existing) return existing;
		const now = new Date().toISOString();
		const created: BoardMemberRecord = {
			agentId: id,
			boardRole: "coordinator",
			displayName: displayName.trim() || "Coordinator",
			brief: "Root coordinator dynamically forming builders/verifiers and closing verified deliverables.",
			skills: [],
			ownedScope: [],
			status: "idle",
			lastReadPostNo: 0,
			createdAt: now,
			updatedAt: now,
		};
		this.writeMembersFile([...members, created]);
		return created;
	}

	upsertMember(input: {
		agentId: string;
		boardRole: BoardRole;
		displayName?: string;
		sourceMemberId?: string;
		brief: string;
		skills?: string[];
		ownedScope?: string[];
		acceptanceCriteria?: string;
		modelOverride?: ModelOverride;
		status?: BoardMemberStatus;
	}): BoardMemberRecord {
		const id = sanitizeSlug(input.agentId, "agentId");
		const members = this.readMembersFile();
		const index = members.findIndex((member) => member.agentId === id);
		const existing = index >= 0 ? members[index] : undefined;
		const now = new Date().toISOString();
		const record: BoardMemberRecord = {
			agentId: id,
			boardRole: input.boardRole,
			displayName: input.displayName?.trim() || existing?.displayName || id,
			...(input.sourceMemberId?.trim() || existing?.sourceMemberId
				? { sourceMemberId: input.sourceMemberId?.trim() || existing?.sourceMemberId }
				: {}),
			brief: input.brief.trim() || existing?.brief || "",
			skills: input.skills ? normalizeStringArray(input.skills) : (existing?.skills ?? []),
			ownedScope: input.ownedScope ? normalizeStringArray(input.ownedScope) : (existing?.ownedScope ?? []),
			...(input.acceptanceCriteria?.trim() || existing?.acceptanceCriteria
				? { acceptanceCriteria: input.acceptanceCriteria?.trim() || existing?.acceptanceCriteria }
				: {}),
			...(input.modelOverride || existing?.modelOverride
				? { modelOverride: input.modelOverride ?? existing?.modelOverride }
				: {}),
			status: input.status ?? existing?.status ?? "waiting",
			lastReadPostNo: existing?.lastReadPostNo ?? 0,
			...(existing?.activePostNo !== undefined ? { activePostNo: existing.activePostNo } : {}),
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
		};
		if (index >= 0) {
			members[index] = record;
		} else {
			members.push(record);
		}
		this.writeMembersFile(members);
		return record;
	}

	setMemberStatus(agentId: string, status: BoardMemberStatus, activePostNo?: number): BoardMemberRecord | undefined {
		const id = sanitizeSlug(agentId, "agentId");
		const members = this.readMembersFile();
		const index = members.findIndex((member) => member.agentId === id);
		if (index < 0) return undefined;
		const existing = members[index]!;
		const updated: BoardMemberRecord = {
			...existing,
			status,
			...(activePostNo !== undefined ? { activePostNo } : {}),
			updatedAt: new Date().toISOString(),
		};
		members[index] = updated;
		this.writeMembersFile(members);
		return updated;
	}

	advanceCursor(agentId: string, postNo: number): BoardMemberRecord | undefined {
		const id = sanitizeSlug(agentId, "agentId");
		const members = this.readMembersFile();
		const index = members.findIndex((member) => member.agentId === id);
		if (index < 0) return undefined;
		const existing = members[index]!;
		const nextCursor = Math.max(existing.lastReadPostNo, Math.max(0, Math.floor(postNo)));
		if (nextCursor === existing.lastReadPostNo) return existing;
		const updated: BoardMemberRecord = {
			...existing,
			lastReadPostNo: nextCursor,
			updatedAt: new Date().toISOString(),
		};
		members[index] = updated;
		this.writeMembersFile(members);
		return updated;
	}

	readPosts(): BoardPostRecord[] {
		if (!existsSync(this.postsFile)) return [];
		const raw = readFileSync(this.postsFile, "utf8");
		const posts: BoardPostRecord[] = [];
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			posts.push(JSON.parse(trimmed) as BoardPostRecord);
		}
		return posts;
	}

	validateVerification(
		authorId: string,
		kind: BoardPostKind,
		refPostNos: number[],
		verification: BoardPostVerification | undefined,
		existingPosts: BoardPostRecord[],
	): void {
		if ((kind === "verify_pass" || kind === "verify_rework") && !verification) {
			throw new Error(`Post kind "${kind}" requires a verification payload`);
		}
		if (!verification) return;
		if (verification.verdict === "pass") {
			if (verification.target === authorId) {
				throw new Error("Self-verification blocked: author cannot verify their own work");
			}
			if (verification.authorAgentId && verification.authorAgentId === verification.target) {
				throw new Error("Self-verification blocked: authorAgentId cannot equal verification target");
			}
			const selfAuthoredRef = refPostNos.some((postNo) =>
				existingPosts.some((post) => post.postNo === postNo && post.authorId === authorId),
			);
			if (selfAuthoredRef) {
				throw new Error("Self-verification blocked: cannot issue verify_pass referencing your own post");
			}
		}
	}

	createPost(input: {
		kind: BoardPostKind;
		authorType: "agent" | "user";
		authorId: string;
		mentions: string[];
		refPostNos?: number[];
		summary: string;
		body?: string;
		artifacts?: Record<string, unknown>;
		verification?: BoardPostVerification;
	}): BoardPostRecord {
		const authorId = input.authorType === "user" ? "user" : sanitizeSlug(input.authorId, "authorId");
		const summary = input.summary.trim();
		if (!summary) throw new Error("post_to_board requires a non-empty summary");
		const mentions = normalizeStringArray(input.mentions);
		const refPostNos = Array.isArray(input.refPostNos)
			? Array.from(new Set(input.refPostNos.filter((n) => Number.isInteger(n) && n >= 1)))
			: [];
		const existing = this.readPosts();
		if (input.authorType === "agent") {
			this.validateVerification(authorId, input.kind, refPostNos, input.verification, existing);
		}
		this.ensureLayout();
		const record: BoardPostRecord = {
			postNo: existing.length + 1,
			kind: input.kind,
			authorType: input.authorType,
			authorId,
			mentions,
			refPostNos,
			summary,
			...(input.body?.trim() ? { body: input.body.trim() } : {}),
			...(input.artifacts && Object.keys(input.artifacts).length > 0 ? { artifacts: input.artifacts } : {}),
			...(input.verification ? { verification: input.verification } : {}),
			createdAt: new Date().toISOString(),
		};
		appendFileSync(this.postsFile, `${JSON.stringify(record)}\n`, "utf8");
		if (input.authorType === "agent") {
			const existingMember = this.getMember(authorId);
			if (existingMember) {
				this.setMemberStatus(authorId, existingMember.status, record.postNo);
			}
		}
		return record;
	}

	getPost(postNo: number): BoardPostRecord | undefined {
		if (!Number.isInteger(postNo) || postNo < 1) return undefined;
		return this.readPosts().find((post) => post.postNo === postNo);
	}

	listPostSummaries(sincePostNo = 0, limit?: number): BoardPostSummary[] {
		const filtered = this.readPosts()
			.filter((post) => post.postNo > sincePostNo)
			.map((post) => ({
				postNo: post.postNo,
				kind: post.kind,
				authorType: post.authorType,
				authorId: post.authorId,
				mentions: post.mentions,
				refPostNos: post.refPostNos,
				summary: post.summary,
				hasBody: Boolean(post.body?.trim()),
				createdAt: post.createdAt,
			}));
		if (limit && limit > 0 && filtered.length > limit) {
			return filtered.slice(filtered.length - limit);
		}
		return filtered;
	}

	resolveMentionTargets(mentions: string[], authorId: string): string[] {
		const members = this.readMembersFile();
		const targets = new Set<string>();
		for (const mention of mentions) {
			const cleaned = mention.replace(/^@/, "").trim();
			if (!cleaned || cleaned === "user" || cleaned === "coordinator") continue;
			if (cleaned === "all") {
				for (const member of members) {
					if (member.boardRole === "coordinator") continue;
					if (member.agentId === authorId) continue;
					if (member.status === "stopped" || member.status === "done") continue;
					targets.add(member.agentId);
				}
				continue;
			}
			const match = members.find((member) => member.agentId === cleaned);
			if (match && match.boardRole !== "coordinator" && match.agentId !== authorId) {
				if (match.status !== "stopped" && match.status !== "done") {
					targets.add(match.agentId);
				}
			}
		}
		return Array.from(targets);
	}
}
