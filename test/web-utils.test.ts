import assert from "node:assert/strict";
import test from "node:test";
import {
	collectMatterMemories,
	collectMatterParticipantIds,
	formatElapsedDuration,
	formatNoticeEventLine,
	getMemberThemeById,
	inferDelegationMood,
	isKeyNoticeEvent,
	MEMORY_CATEGORY_LABELS,
	mapDelegationsToMessages,
	parseDeliverableSummary,
	parseMessageImages,
	parseProgressSnapshot,
	pickDefaultWorkspaceId,
} from "../web/src/utils.ts";

test("mapDelegationsToMessages pairs turn delegations for running, completed, and failed outcomes", () => {
	const userMessages = [
		{
			id: "u1",
			matterId: "m1",
			channel: "user" as const,
			senderType: "user" as const,
			senderId: "user",
			content: "开始技术评估",
			createdAt: "2026-11-15T01:00:00.000Z",
		},
		{
			id: "s1",
			matterId: "m1",
			channel: "user" as const,
			senderType: "system" as const,
			senderId: "orchestrator",
			content: "执行异常",
			createdAt: "2026-11-15T01:05:00.000Z",
		},
		{
			id: "u2",
			matterId: "m1",
			channel: "user" as const,
			senderType: "user" as const,
			senderId: "user",
			content: "继续追问",
			createdAt: "2026-11-15T01:06:00.000Z",
		},
	];
	const internalCollab = [
		{
			id: "c-req-1",
			matterId: "m1",
			channel: "internal_collab" as const,
			senderType: "member" as const,
			senderId: "product-manager",
			content: "@研发经理: 评估工作量",
			metadata: { toMemberId: "engineering-manager" },
			createdAt: "2026-11-15T01:00:30.000Z",
		},
		{
			id: "c-res-1",
			matterId: "m1",
			channel: "internal_collab" as const,
			senderType: "member" as const,
			senderId: "engineering-manager",
			content: "需要 3 人日。",
			metadata: { replyToMemberId: "product-manager", requestMessageId: "c-req-1" },
			createdAt: "2026-11-15T01:01:30.000Z",
		},
		{
			id: "c-req-2",
			matterId: "m1",
			channel: "internal_collab" as const,
			senderType: "member" as const,
			senderId: "product-manager",
			content: "@测试经理: 核对验收标准",
			metadata: { toMemberId: "qa-manager" },
			createdAt: "2026-11-15T01:00:35.000Z",
		},
		{
			id: "c-res-2",
			matterId: "m1",
			channel: "internal_collab" as const,
			senderType: "system" as const,
			senderId: "qa-manager",
			content: "内部委托未完成：Prompt cancelled",
			metadata: { requestMessageId: "c-req-2", failed: true },
			createdAt: "2026-11-15T01:04:50.000Z",
		},
		{
			id: "c-req-3",
			matterId: "m1",
			channel: "internal_collab" as const,
			senderType: "member" as const,
			senderId: "product-manager",
			content: "@研发经理: 二次复核",
			metadata: { toMemberId: "engineering-manager" },
			createdAt: "2026-11-15T01:06:10.000Z",
		},
	];

	const placedRunning = mapDelegationsToMessages(userMessages, internalCollab, true);
	assert.equal(placedRunning.byMessageId.get("s1")?.length, 2);
	assert.equal(placedRunning.byMessageId.get("s1")?.[0]?.status, "completed");
	assert.equal(placedRunning.byMessageId.get("s1")?.[0]?.answer, "需要 3 人日。");
	assert.equal(placedRunning.byMessageId.get("s1")?.[1]?.status, "failed");
	assert.equal(placedRunning.byMessageId.get("u2")?.[0]?.status, "running");

	const placedStopped = mapDelegationsToMessages(userMessages, internalCollab, false);
	assert.equal(placedStopped.byMessageId.get("u2")?.[0]?.status, "failed");

	assert.equal(
		formatNoticeEventLine(
			JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "docs/prd.md" } }),
		),
		"开始工具 read (docs/prd.md)",
	);
	assert.equal(inferDelegationMood("读取文件 docs/prd.md"), "tool");
	assert.equal(inferDelegationMood("撰写结论：已完成评估"), "finalizing");
	assert.equal(inferDelegationMood("待你确认方案取舍"), "waiting_user");
	assert.equal(inferDelegationMood("已接入任务"), "starting");
	assert.equal(inferDelegationMood("思考分析"), "thinking");
	assert.equal(getMemberThemeById([{ id: "pm" } as never, { id: "eng" } as never], "eng").bg, "#4e6df5");
});

test("formatElapsedDuration and parseProgressSnapshot safely handle snapshot metadata", () => {
	assert.equal(formatElapsedDuration(0), "0s");
	assert.equal(formatElapsedDuration(31), "31s");
	assert.equal(formatElapsedDuration(179), "2m 59s");
	assert.equal(formatElapsedDuration(1800), "30m 0s");
	assert.equal(formatElapsedDuration(3720), "1h 2m");

	assert.equal(parseProgressSnapshot(null), null);
	assert.equal(parseProgressSnapshot({}), null);
	assert.equal(parseProgressSnapshot({ progressSnapshot: { stage: "unknown", outcome: "failed", label: "x" } }), null);

	const parsed = parseProgressSnapshot({
		progressSnapshot: {
			outcome: "aborted",
			stage: "tool",
			label: "已委托研发经理",
			elapsedSeconds: 45,
			activeDelegations: [
				{ memberId: "engineering-manager", memberName: "研发经理", stageLabel: "思考分析" },
				{ broken: true },
			],
			recentLogs: [{ memberName: "研发经理", summary: "执行命令：npm test", at: "2026-11-15T03:10:00.000Z" }],
		},
	});
	assert.ok(parsed);
	assert.equal(parsed.outcome, "aborted");
	assert.equal(parsed.stage, "tool");
	assert.equal(parsed.elapsedSeconds, 45);
	assert.equal(parsed.activeDelegations?.length, 1);
	assert.equal(parsed.recentLogs?.length, 1);
});

test("collectMatterMemories and collectMatterParticipantIds aggregate multi-role experiences", () => {
	assert.equal(MEMORY_CATEGORY_LABELS.efficiency, "提效方法");
	assert.equal(MEMORY_CATEGORY_LABELS.troubleshooting, "问题排障");

	const sorted = collectMatterMemories(
		{
			"product-manager": [
				{
					id: "m1",
					memberId: "product-manager",
					scope: "role_general",
					category: "collaboration",
					orgId: null,
					workspaceId: null,
					content: "verified pm rule",
					sourceMatterId: "mat-1",
					sourceDeliverableId: null,
					status: "verified",
					verified: true,
					appliedCount: 0,
					positiveCount: 0,
					negativeCount: 0,
					createdAt: "2026-11-15T10:00:00.000Z",
				},
			],
			"engineering-manager": [
				{
					id: "m2",
					memberId: "engineering-manager",
					scope: "role_general",
					category: "troubleshooting",
					orgId: null,
					workspaceId: null,
					content: "candidate eng rule",
					sourceMatterId: "mat-1",
					sourceDeliverableId: "deliv-1",
					status: "candidate",
					verified: false,
					appliedCount: 0,
					positiveCount: 0,
					negativeCount: 0,
					createdAt: "2026-11-15T09:00:00.000Z",
				},
				{
					id: "m3",
					memberId: "engineering-manager",
					scope: "role_general",
					category: "general",
					orgId: null,
					workspaceId: null,
					content: "other matter rule",
					sourceMatterId: "mat-other",
					sourceDeliverableId: null,
					status: "candidate",
					verified: false,
					appliedCount: 0,
					positiveCount: 0,
					negativeCount: 0,
					createdAt: "2026-11-15T11:00:00.000Z",
				},
			],
		},
		"mat-1",
		"deliv-1",
	);
	assert.deepEqual(
		sorted.map((m) => m.id),
		["m2", "m1"],
	);

	const participants = collectMatterParticipantIds({
		matter: {
			id: "mat-1",
			title: "Test",
			summary: "",
			workspaceId: null,
			leadMemberId: "product-manager",
			observerMemberIds: ["qa-manager"],
			status: "open",
			createdAt: "2026-11-15T09:00:00.000Z",
			updatedAt: "2026-11-15T09:00:00.000Z",
		},
		internalCollabMessages: [
			{
				id: "msg-1",
				matterId: "mat-1",
				channel: "internal_collab",
				senderType: "member",
				senderId: "product-manager",
				content: "请研发跟进",
				metadata: { toMemberId: "engineering-manager" },
				createdAt: "2026-11-15T09:05:00.000Z",
			},
		],
	});
	assert.deepEqual(new Set(participants), new Set(["product-manager", "qa-manager", "engineering-manager"]));
});

test("formatNoticeEventLine and isKeyNoticeEvent handle truncated tool JSON notices safely", () => {
	const truncatedRead =
		'{"type":"tool_execution_end","toolCallId":"tool_1","toolName":"read","result":{"content":[{"type":"text","text":"# Huge PRD doc without closing brace...';
	assert.equal(formatNoticeEventLine(truncatedRead), "结束工具 read");
	assert.equal(isKeyNoticeEvent(truncatedRead), false);

	const truncatedFailedBash =
		'{"type":"tool_execution_end","toolCallId":"tool_2","toolName":"bash","isError":true,"result":"long...';
	assert.equal(formatNoticeEventLine(truncatedFailedBash), "结束工具 bash（失败）");
	assert.equal(isKeyNoticeEvent(truncatedFailedBash), true);

	assert.equal(isKeyNoticeEvent('{"method":"error","message":"Timed out"}'), true);
});

test("pickDefaultWorkspaceId prefers memory workspace, then active matter workspace, then first workspace", () => {
	const workspaces = [{ id: "personal-agent" }, { id: "bookshelf" }];
	assert.equal(pickDefaultWorkspaceId(workspaces, null, "bookshelf"), "bookshelf");
	assert.equal(pickDefaultWorkspaceId(workspaces, "personal-agent", "bookshelf"), "personal-agent");
	assert.equal(pickDefaultWorkspaceId(workspaces, "missing-ws", null), "personal-agent");
	assert.equal(pickDefaultWorkspaceId([], null, "bookshelf"), "");
});

test("parseDeliverableSummary extracts lead takeaway and scannable process/evidence bullets", () => {
	const raw =
		"M1 收口：QA 验收通过（10/10），默认档 T1。\n交付依据：v1.6 收口并按用户指示收尾。QA 验收报告已归档。\n固化结论：recall 89.9%（62/69）。p95 T1 达标，待补 S1 实拍。";
	const parsed = parseDeliverableSummary(raw);
	assert.equal(parsed.lead, "M1 收口：QA 验收通过（10/10），默认档 T1。");
	assert.deepEqual(parsed.details, [
		"交付依据：v1.6 收口并按用户指示收尾。QA 验收报告已归档。",
		"固化结论：recall 89.9%（62/69）。p95 T1 达标，待补 S1 实拍。",
	]);

	const inlineLabeled =
		"第一句核心结论。交付依据：补充检查完成。固化结论：所有门禁全部通过，其余指标保持不变，下周继续推进下一阶段内容！";
	const inlineParsed = parseDeliverableSummary(inlineLabeled, 40);
	assert.equal(inlineParsed.lead, "第一句核心结论。");
	assert.ok(inlineParsed.details.length >= 2);
	assert.equal(parseDeliverableSummary("   ").lead, "");
});

test("parseMessageImages extracts valid lightweight image refs from message metadata", () => {
	assert.deepEqual(parseMessageImages(null), []);
	assert.deepEqual(
		parseMessageImages({
			images: [
				{ url: "/api/uploads/a.png", mimeType: "image/png", name: "a.png" },
				{ mimeType: "image/webp" },
				null,
				{},
			],
		}),
		[{ url: "/api/uploads/a.png", mimeType: "image/png", name: "a.png" }, { mimeType: "image/webp" }],
	);
});
