import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BoardMemberDto, BoardPostSummaryDto, MatterBoardSnapshotDto, MatterEventDto } from "@pa/contracts/board";
import {
	applyBoardMemberUpdatedEvent,
	applyBoardPostCreatedEvent,
	canSwapBoardMemberModel,
	filterBoardPosts,
	formatBoardEventPayload,
	groupBoardMembers,
	summarizeBoardStatus,
} from "../apps/web/src/hooks/useMatterBoard.ts";

function makeMember(overrides: Partial<BoardMemberDto> & Pick<BoardMemberDto, "agentId">): BoardMemberDto {
	return {
		matterId: "matter-1",
		agentId: overrides.agentId,
		sourceMemberId: null,
		displayName: overrides.displayName ?? overrides.agentId,
		boardRole: overrides.boardRole ?? "builder",
		brief: overrides.brief ?? "",
		skills: overrides.skills ?? [],
		status: overrides.status ?? "waiting",
		ownedScope: overrides.ownedScope ?? [],
		acceptanceCriteria: overrides.acceptanceCriteria ?? "",
		lastReadPostNo: overrides.lastReadPostNo ?? 0,
		activePostNo: overrides.activePostNo ?? null,
		modelOverride: overrides.modelOverride ?? null,
		worktreePath: overrides.worktreePath ?? null,
		metrics: overrides.metrics ?? null,
		updatedAt: overrides.updatedAt ?? "2026-11-27T08:00:00.000Z",
	};
}

function makePost(overrides: Partial<BoardPostSummaryDto> & Pick<BoardPostSummaryDto, "postNo">): BoardPostSummaryDto {
	return {
		id: `bpost-${overrides.postNo}`,
		matterId: "matter-1",
		postNo: overrides.postNo,
		authorType: overrides.authorType ?? "agent",
		authorId: overrides.authorId ?? "coordinator",
		kind: overrides.kind ?? "assign",
		mentions: overrides.mentions ?? [],
		refPostNos: overrides.refPostNos ?? [],
		summary: overrides.summary ?? `Post #${overrides.postNo}`,
		hasBody: overrides.hasBody ?? true,
		artifacts: overrides.artifacts ?? null,
		verification: overrides.verification ?? null,
		orgId: null,
		workspaceId: null,
		createdAt: overrides.createdAt ?? "2026-11-27T08:00:00.000Z",
	};
}

describe("board UI projections & SSE reducers", () => {
	it("summarizeBoardStatus prioritizes blocked_human, then working, then idle", () => {
		const blocked = summarizeBoardStatus(
			[
				makeMember({ agentId: "coordinator", boardRole: "coordinator", status: "waiting" }),
				makeMember({ agentId: "builder-a", status: "working" }),
				makeMember({ agentId: "builder-b", status: "blocked_human" }),
			],
			3,
		);
		assert.equal(blocked.tone, "blocked");
		assert.equal(blocked.blockedHuman, 1);
		assert.match(blocked.label, /待人工确认/);

		const working = summarizeBoardStatus(
			[
				makeMember({ agentId: "coordinator", boardRole: "coordinator", status: "waiting" }),
				makeMember({ agentId: "builder-a", status: "working" }),
				makeMember({ agentId: "verifier", boardRole: "verifier", status: "waiting" }),
			],
			2,
		);
		assert.equal(working.tone, "working");
		assert.equal(working.label, "Board · 1 执行中 / 2 待命");

		const idle = summarizeBoardStatus(
			[
				makeMember({ agentId: "coordinator", boardRole: "coordinator", status: "waiting" }),
				makeMember({ agentId: "builder-a", status: "retired" }),
			],
			4,
		);
		assert.equal(idle.tone, "idle");
		assert.equal(idle.label, "Board · 1 待命 / 1 已退场");

		const empty = summarizeBoardStatus([], 0);
		assert.equal(empty.tone, "idle");
		assert.equal(empty.label, "Board · 待组队");
	});

	it("groupBoardMembers pins coordinator and orders dynamic agents by live status", () => {
		const members: BoardMemberDto[] = [
			makeMember({ agentId: "old-builder", status: "retired" }),
			makeMember({ agentId: "verifier", boardRole: "verifier", status: "waiting" }),
			makeMember({ agentId: "coordinator", boardRole: "coordinator", status: "waiting" }),
			makeMember({ agentId: "ui-builder", status: "working" }),
			makeMember({ agentId: "api-builder", status: "blocked_human" }),
			makeMember({ agentId: "paused-builder", status: "stopped" }),
		];
		const grouped = groupBoardMembers(members);
		assert.equal(grouped.coordinator?.agentId, "coordinator");
		assert.deepEqual(
			grouped.groups.map((g) => g.status),
			["working", "blocked_human", "waiting", "stopped", "retired"],
		);
		assert.deepEqual(
			grouped.groups.map((g) => g.members.map((m) => m.agentId)),
			[["ui-builder"], ["api-builder"], ["verifier"], ["paused-builder"], ["old-builder"]],
		);
	});

	it("filterBoardPosts matches kind and free-text query across postNo, author, mentions, and summary", () => {
		const posts: BoardPostSummaryDto[] = [
			makePost({ postNo: 1, kind: "assign", authorId: "coordinator", mentions: ["builder-a"], summary: "Build UI" }),
			makePost({
				postNo: 2,
				kind: "handoff",
				authorId: "builder-a",
				mentions: ["verifier"],
				summary: "Implemented MatterBoardPane",
			}),
			makePost({
				postNo: 3,
				kind: "verify_rework",
				authorId: "verifier",
				mentions: ["builder-a"],
				summary: "Missing keyboard focus",
				verification: { target: "MatterBoardPane", verdict: "rework" },
			}),
		];

		assert.deepEqual(
			filterBoardPosts(posts, { query: "", kind: "verify_rework" }).map((p) => p.postNo),
			[3],
		);
		assert.deepEqual(
			filterBoardPosts(posts, { query: "#2", kind: "all" }).map((p) => p.postNo),
			[2],
		);
		assert.deepEqual(
			filterBoardPosts(posts, { query: "@verifier", kind: "all" }).map((p) => p.postNo),
			[2],
		);
		assert.deepEqual(
			filterBoardPosts(posts, { query: "keyboard", kind: "all" }).map((p) => p.postNo),
			[3],
		);
	});

	it("canSwapBoardMemberModel only allows waiting members", () => {
		assert.equal(canSwapBoardMemberModel({ status: "waiting" }), true);
		assert.equal(canSwapBoardMemberModel({ status: "working" }), false);
		assert.equal(canSwapBoardMemberModel({ status: "blocked_human" }), false);
		assert.equal(canSwapBoardMemberModel({ status: "stopped" }), false);
		assert.equal(canSwapBoardMemberModel({ status: "retired" }), false);
	});

	it("applyBoardPostCreatedEvent incrementally appends unique posts and ignores other matters", () => {
		const snapshot: MatterBoardSnapshotDto = {
			matterId: "matter-1",
			collaborationMode: "board",
			coordinatorMemberId: "em",
			members: [],
			posts: [makePost({ postNo: 1, summary: "Initial assign" })],
			latestPostNo: 1,
		};

		const ignored = applyBoardPostCreatedEvent(snapshot, {
			matterId: "matter-other",
			postNo: 2,
			kind: "handoff",
			authorId: "builder-a",
			mentions: ["verifier"],
			summary: "Other matter",
			createdAt: "2026-11-27T08:05:00.000Z",
		});
		assert.equal(ignored, snapshot);

		const next = applyBoardPostCreatedEvent(snapshot, {
			matterId: "matter-1",
			postNo: 2,
			kind: "handoff",
			authorId: "builder-a",
			mentions: ["verifier"],
			summary: "Ready for verification",
			createdAt: "2026-11-27T08:05:00.000Z",
		});
		assert.equal(next?.posts.length, 2);
		assert.equal(next?.latestPostNo, 2);
		assert.equal(next?.posts[1]?.summary, "Ready for verification");

		// Duplicate postNo is a no-op
		const deduped = applyBoardPostCreatedEvent(next, {
			matterId: "matter-1",
			postNo: 2,
			kind: "handoff",
			authorId: "builder-a",
			mentions: ["verifier"],
			summary: "Duplicate",
			createdAt: "2026-11-27T08:05:00.000Z",
		});
		assert.equal(deduped?.posts.length, 2);
	});

	it("applyBoardMemberUpdatedEvent patches existing member and signals refresh for newly spawned member", () => {
		const snapshot: MatterBoardSnapshotDto = {
			matterId: "matter-1",
			collaborationMode: "board",
			coordinatorMemberId: "em",
			members: [makeMember({ agentId: "builder-a", status: "waiting", activePostNo: null })],
			posts: [],
			latestPostNo: 0,
		};

		const patched = applyBoardMemberUpdatedEvent(snapshot, {
			matterId: "matter-1",
			agentId: "builder-a",
			status: "working",
			activePostNo: 4,
			metrics: { linesAdded: 120, testsPassed: 5, testsTotal: 5 },
			updatedAt: "2026-11-27T08:10:00.000Z",
		});
		assert.equal(patched.needsRefresh, false);
		assert.equal(patched.snapshot?.members[0]?.status, "working");
		assert.equal(patched.snapshot?.members[0]?.activePostNo, 4);
		assert.equal(patched.snapshot?.members[0]?.metrics?.linesAdded, 120);

		const unknown = applyBoardMemberUpdatedEvent(patched.snapshot, {
			matterId: "matter-1",
			agentId: "verifier",
			status: "waiting",
			activePostNo: null,
			metrics: null,
			updatedAt: "2026-11-27T08:11:00.000Z",
		});
		assert.equal(unknown.needsRefresh, true);
	});

	it("formatBoardEventPayload highlights monitor_alert and summarizes tool events", () => {
		const alertEvent: MatterEventDto = {
			id: "mevt-1",
			matterId: "matter-1",
			runId: "run-1",
			agentId: "system_monitor",
			boardPostNo: 3,
			eventType: "monitor_alert",
			payload: { targetAgentId: "coordinator", reason: "全部成员停滞超过 30 秒", nudgeCount: 2 },
			createdAt: "2026-11-27T08:12:00.000Z",
		};
		assert.equal(formatBoardEventPayload(alertEvent), "@coordinator · 全部成员停滞超过 30 秒（第 2 次提醒）");

		const toolEvent: MatterEventDto = {
			id: "mevt-2",
			matterId: "matter-1",
			runId: "run-1",
			agentId: "builder-a",
			boardPostNo: 2,
			eventType: "tool_end",
			payload: { toolName: "bash", summary: "npm test", status: "ok" },
			createdAt: "2026-11-27T08:13:00.000Z",
		};
		assert.equal(formatBoardEventPayload(toolEvent), "bash · npm test · [ok]");
	});
});
