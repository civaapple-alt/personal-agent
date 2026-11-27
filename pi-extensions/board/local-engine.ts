import { type RoleDefinition, resolveRoleDefinition } from "../roles/loader.ts";
import { runLocalPiRpcWorker } from "./local-rpc-worker.ts";
import { LocalBoardStore, resolveDefaultBoardDir, sanitizeSlug } from "./local-store.ts";
import type {
	BoardMemberRecord,
	BoardPostRecord,
	BoardPostSummary,
	BoardRole,
	BoardUiContext,
	LocalWorkerExecutor,
	PostToBoardArgs,
	ReadBoardPostArgs,
	SpawnBoardAgentArgs,
} from "./types.ts";

export interface LocalBoardEngineOptions {
	cwd: string;
	boardId?: string;
	boardDir?: string;
	boardRole?: BoardRole;
	agentId?: string;
	isSubWorker?: boolean;
	extensionEntryPath: string;
	maxWakeupTurns?: number;
	executor?: LocalWorkerExecutor;
}

const DEFAULT_MAX_WAKEUP_TURNS = 16;

function formatSummaryLine(summary: BoardPostSummary): string {
	const mentions = summary.mentions.map((m) => (m.startsWith("@") ? m : `@${m}`)).join(", ");
	const refs = summary.refPostNos.length > 0 ? ` refs=[${summary.refPostNos.map((n) => `#${n}`).join(",")}]` : "";
	const bodyHint = summary.hasBody ? " [hasBody: call read_board_post if details needed]" : "";
	return `#${summary.postNo} [${summary.kind}] ${summary.authorId} -> ${mentions || "@none"}${refs}: ${summary.summary}${bodyHint}`;
}

function buildWakeupPrompt(
	member: BoardMemberRecord,
	unreadSummaries: BoardPostSummary[],
	role?: RoleDefinition,
): string {
	const scopeText = member.ownedScope.length > 0 ? member.ownedScope.join(", ") : "(unspecified)";
	const criteriaText = member.acceptanceCriteria?.trim() || "(none specified)";
	const roleLines = role
		? [
				`Inherited role persona: ${role.name} (${role.id})`,
				...(role.antiJobs.length ? [`Role boundaries: ${role.antiJobs.join("; ")}`] : []),
				...(role.body ? ["", role.body] : []),
			]
		: [];
	const verifyRules =
		member.boardRole === "verifier"
			? [
					"- You are a READ-ONLY Verifier: edit and write tools are disabled.",
					"- Never approve your own work or any post you authored; check evidence against files and tests.",
					"- Reply with post_to_board using kind 'verify_pass' or 'verify_rework', explicit verification { target, verdict, criteria }, and mention the builder (on rework) or @coordinator (on pass).",
				]
			: [
					"- Stay within your ownedScope when editing files.",
					"- When your implementation and checks are complete, call post_to_board (kind 'handoff' to a verifier or 'summary' to @coordinator).",
				];
	return [
		`[Board Wakeup for @${member.agentId} (${member.boardRole})]`,
		`Mission brief: ${member.brief}`,
		`Owned scope: ${scopeText}`,
		`Acceptance criteria: ${criteriaText}`,
		...roleLines,
		"",
		"Incremental board updates since your last turn:",
		...unreadSummaries.map(formatSummaryLine),
		"",
		"Execution rules:",
		...verifyRules,
		"- Use read_board_post(postNo) only when you need the full body/artifacts of a referenced post.",
	].join("\n");
}

export class LocalBoardEngine {
	readonly cwd: string;
	readonly boardId: string;
	readonly store: LocalBoardStore;
	readonly boardRole: BoardRole;
	readonly agentId: string;
	readonly isSubWorker: boolean;
	readonly extensionEntryPath: string;
	readonly maxWakeupTurns: number;
	readonly executor: LocalWorkerExecutor;

	constructor(options: LocalBoardEngineOptions) {
		this.cwd = options.cwd;
		this.boardId = sanitizeSlug(options.boardId ?? "default", "boardId");
		const boardDir = options.boardDir?.trim() || resolveDefaultBoardDir(this.cwd, this.boardId);
		this.store = new LocalBoardStore(boardDir, this.boardId);
		this.boardRole = options.boardRole ?? (options.isSubWorker ? "builder" : "coordinator");
		this.agentId = sanitizeSlug(options.agentId ?? "coordinator", "agentId");
		this.isSubWorker = Boolean(options.isSubWorker);
		this.extensionEntryPath = options.extensionEntryPath;
		this.maxWakeupTurns = options.maxWakeupTurns ?? DEFAULT_MAX_WAKEUP_TURNS;
		this.executor = options.executor ?? runLocalPiRpcWorker;

		if (!this.isSubWorker && this.boardRole === "coordinator") {
			this.store.ensureCoordinator(this.agentId);
		}
	}

	spawnBoardAgent(args: SpawnBoardAgentArgs): { member: BoardMemberRecord } {
		if (this.boardRole !== "coordinator" || this.isSubWorker) {
			throw new Error("spawn_board_agent is restricted to the root coordinator");
		}
		if (args.boardRole !== "builder" && args.boardRole !== "verifier") {
			throw new Error(
				`spawn_board_agent boardRole must be "builder" or "verifier", got "${String(args.boardRole)}"`,
			);
		}
		if (!args.brief?.trim()) {
			throw new Error("spawn_board_agent requires a non-empty brief");
		}
		const member = this.store.upsertMember({
			agentId: args.agentId,
			boardRole: args.boardRole,
			displayName: args.displayName,
			sourceMemberId: args.sourceMemberId,
			brief: args.brief,
			skills: args.skills,
			ownedScope: args.ownedScope,
			acceptanceCriteria: args.acceptanceCriteria,
			modelOverride: args.modelOverride,
		});
		return { member };
	}

	readBoardPost(args: ReadBoardPostArgs): BoardPostRecord {
		const post = this.store.getPost(args.postNo);
		if (!post) {
			throw new Error(`Board post #${args.postNo} not found`);
		}
		return post;
	}

	async postToBoard(
		args: PostToBoardArgs,
		signal?: AbortSignal,
		ctx?: BoardUiContext,
	): Promise<{
		post: BoardPostRecord;
		clarificationReply?: BoardPostRecord;
		awaitingHuman?: boolean;
		wakeupsExecuted?: number;
		pendingMentions?: string[];
		recentPosts?: BoardPostSummary[];
	}> {
		signal?.throwIfAborted();
		const post = this.store.createPost({
			kind: args.kind,
			authorType: "agent",
			authorId: this.agentId,
			mentions: args.mentions,
			refPostNos: args.refPostNos,
			summary: args.summary,
			body: args.body,
			artifacts: args.artifacts,
			verification: args.verification,
		});

		this.store.advanceCursor(this.agentId, post.postNo);

		if (post.kind === "clarification" && post.mentions.some((m) => m.replace(/^@/, "") === "user")) {
			this.store.setMemberStatus(this.agentId, "blocked_human", post.postNo);
			if (ctx?.hasUI && ctx.ui?.input) {
				const answer = await ctx.ui.input(`[Board @${this.agentId}] ${post.summary}`, post.body, { signal });
				signal?.throwIfAborted();
				if (answer?.trim()) {
					const userPost = this.store.createPost({
						kind: "clarification",
						authorType: "user",
						authorId: "user",
						mentions: [this.agentId],
						refPostNos: [post.postNo],
						summary: answer.trim(),
					});
					this.store.setMemberStatus(this.agentId, "waiting", userPost.postNo);
					return { post, clarificationReply: userPost };
				}
			}
			return { post, awaitingHuman: true };
		}

		if (this.isSubWorker || this.boardRole !== "coordinator") {
			return { post };
		}

		const queue = this.store.resolveMentionTargets(post.mentions, this.agentId);
		let wakeupsExecuted = 0;

		while (queue.length > 0 && wakeupsExecuted < this.maxWakeupTurns) {
			signal?.throwIfAborted();
			const targetId = queue.shift()!;
			const member = this.store.getMember(targetId);
			if (!member || member.boardRole === "coordinator") continue;
			if (member.status === "stopped" || member.status === "done") continue;

			const unread = this.store.listPostSummaries(member.lastReadPostNo);
			if (unread.length === 0) continue;

			const beforePostNo = this.store.readPosts().at(-1)?.postNo ?? 0;
			this.store.setMemberStatus(targetId, "working");
			wakeupsExecuted += 1;

			try {
				const inheritedRole = member.sourceMemberId
					? resolveRoleDefinition(member.sourceMemberId, { cwd: this.cwd })
					: undefined;
				const workerPrompt = buildWakeupPrompt(member, unread, inheritedRole);
				await this.executor(
					{
						cwd: this.cwd,
						agentId: targetId,
						boardRole: member.boardRole,
						readOnly: member.boardRole === "verifier",
						sessionFile: this.store.getSessionFile(targetId),
						extensionEntryPath: this.extensionEntryPath,
						prompt: workerPrompt,
						modelOverride: member.modelOverride,
						env: {
							PA_LOCAL_BOARD_DIR: this.store.boardDir,
							PA_LOCAL_BOARD_ID: this.store.boardId,
							PA_LOCAL_BOARD_SUBWORKER: "1",
							PA_BOARD_ROLE: member.boardRole,
							PA_BOARD_AGENT_ID: targetId,
						},
					},
					signal,
				);
				const currentStatus = this.store.getMember(targetId)?.status;
				if (currentStatus !== "blocked_human") {
					this.store.setMemberStatus(targetId, "waiting");
				}
				const latestReadNo = unread[unread.length - 1]?.postNo ?? member.lastReadPostNo;
				this.store.advanceCursor(targetId, latestReadNo);
			} catch (error) {
				this.store.setMemberStatus(targetId, "waiting");
				throw error;
			}

			const newPosts = this.store.readPosts().filter((entry) => entry.postNo > beforePostNo);
			for (const created of newPosts) {
				if (created.kind === "clarification" && created.mentions.some((m) => m.replace(/^@/, "") === "user")) {
					if (ctx?.hasUI && ctx.ui?.input) {
						const answer = await ctx.ui.input(`[Board @${created.authorId}] ${created.summary}`, created.body, {
							signal,
						});
						signal?.throwIfAborted();
						if (answer?.trim()) {
							this.store.createPost({
								kind: "clarification",
								authorType: "user",
								authorId: "user",
								mentions: [created.authorId],
								refPostNos: [created.postNo],
								summary: answer.trim(),
							});
							this.store.setMemberStatus(created.authorId, "waiting");
							if (!queue.includes(created.authorId)) queue.push(created.authorId);
							continue;
						}
					}
					this.store.setMemberStatus(created.authorId, "blocked_human", created.postNo);
					continue;
				}
				for (const nextTarget of this.store.resolveMentionTargets(created.mentions, created.authorId)) {
					if (!queue.includes(nextTarget)) {
						queue.push(nextTarget);
					}
				}
			}
		}

		const latestPosts = this.store.listPostSummaries(post.postNo - 1, 10);
		if (latestPosts.length > 0) {
			this.store.advanceCursor(this.agentId, latestPosts[latestPosts.length - 1]!.postNo);
		}
		return {
			post,
			wakeupsExecuted,
			pendingMentions: queue,
			recentPosts: latestPosts,
		};
	}

	formatStatus(): string {
		const members = this.store.listMembers();
		const posts = this.store.listPostSummaries(0, 10);
		const memberLines =
			members.length > 0
				? members.map(
						(m) =>
							`- @${m.agentId} (${m.boardRole}, ${m.status}, cursor=#${m.lastReadPostNo}${m.ownedScope.length ? `, scope=${m.ownedScope.join(",")}` : ""})`,
					)
				: ["- (no members yet)"];
		const postLines = posts.length > 0 ? posts.map(formatSummaryLine) : ["- (no board posts yet)"];
		return [
			`Board: ${this.boardId} (${this.store.boardDir})`,
			"Members:",
			...memberLines,
			"Recent posts:",
			...postLines,
		].join("\n");
	}

	formatPosts(limit = 10): string {
		const posts = this.store.listPostSummaries(0, limit);
		if (posts.length === 0) {
			return `Board "${this.boardId}" has no posts yet.`;
		}
		return [`Board "${this.boardId}" recent posts:`, ...posts.map(formatSummaryLine)].join("\n");
	}
}
