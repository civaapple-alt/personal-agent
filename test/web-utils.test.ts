import assert from "node:assert/strict";
import test from "node:test";
import { getApiBaseUrl, resolveApiUrl, setApiBaseUrl } from "../apps/web/src/api/client.ts";
import type { MatterMessageDto } from "../apps/web/src/api/matters.ts";
import {
	createPastedTextAttachment,
	isSupportedImageDescriptor as isSupportedImageFile,
	prepareComposerTextFiles as prepareComposerFiles,
	shouldFoldPastedText,
} from "../apps/web/src/textAttachments.ts";
import { buildMatterDelegations, liveDelegationEdges } from "../apps/web/src/utils/matterDelegations.ts";
import {
	applyOrgAiRoleOverrides,
	applyPrimaryContactToMembers,
	collectMatterParticipantIds,
	collectTurnToolCalls,
	formatByteSize,
	formatElapsedDuration,
	formatNoticeEventLine,
	getMemberThemeById,
	inferDelegationMood,
	isKeyNoticeEvent,
	parseMessageFiles,
	parseMessageImages,
	parseProgressSnapshot,
	pickDefaultWorkspaceId,
	resolveEffectivePrimaryContactId,
	stripMarkdownFormatting,
} from "../apps/web/src/utils.ts";

test("delegation boards place historical handoffs and keep only the active turn running", () => {
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
			metadata: { sourceUserMessageId: "u1", toMemberId: "engineering-manager" },
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
			metadata: { sourceUserMessageId: "u1", toMemberId: "qa-manager" },
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
			metadata: { sourceUserMessageId: "u2", toMemberId: "engineering-manager" },
			createdAt: "2026-11-15T01:06:10.000Z",
		},
	];

	const ordered = internalCollab.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
	const placedRunning = buildMatterDelegations(userMessages, ordered, "u2");
	const firstRound = placedRunning.byTurn.get("u1");
	assert.deepEqual(
		firstRound?.assignments.map((item) => item.status),
		["completed", "failed"],
	);
	assert.deepEqual(
		firstRound?.posts.map((post) => post.kind),
		["assignment", "assignment", "reply", "failure"],
	);
	assert.equal(firstRound?.posts[2]?.message.content, "需要 3 人日。");
	assert.equal(placedRunning.byTurn.get("u2")?.assignments[0]?.status, "running");

	const placedStopped = buildMatterDelegations(userMessages, ordered);
	assert.equal(placedStopped.byTurn.get("u2")?.assignments[0]?.status, "failed");

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

test("anchored handoffs and nested edges survive intervening user discussion and unrelated active turns", () => {
	const message = (
		id: string,
		channel: MatterMessageDto["channel"],
		senderType: MatterMessageDto["senderType"],
		at: number,
		metadata: NonNullable<MatterMessageDto["metadata"]>,
	): MatterMessageDto => ({
		id,
		channel,
		senderType,
		metadata,
		matterId: "matter",
		senderId: "actor",
		content: id,
		createdAt: new Date(at * 1000).toISOString(),
	});
	const userMessages = [
		message("assign", "user", "user", 1, {}),
		message("human-chat", "user", "user", 2, { mode: "discussion" }),
		message("reply", "user", "member", 7, { sourceUserMessageId: "assign" }),
		message("next", "user", "user", 8, {}),
	];
	const posts = [
		message("one", "internal_collab", "member", 3, {
			sourceUserMessageId: "assign",
			toMemberId: "engineering",
			delegationNumber: 1,
		}),
		message("two", "internal_collab", "member", 4, {
			sourceUserMessageId: "assign",
			toMemberId: "qa",
			delegationNumber: 2,
			parentRequestMessageId: "one",
		}),
		message("two-reply", "internal_collab", "member", 5, { requestMessageId: "two" }),
		message("one-reply", "internal_collab", "member", 6, { requestMessageId: "one" }),
		message("unknown", "internal_collab", "member", 7, { toMemberId: "qa" }),
		message("pending", "internal_collab", "member", 9, {
			sourceUserMessageId: "assign",
			toMemberId: "qa",
			delegationNumber: 3,
		}),
		message("active", "internal_collab", "member", 10, {
			sourceUserMessageId: "next",
			toMemberId: "qa",
			delegationNumber: 1,
		}),
	];
	const projected = buildMatterDelegations(userMessages, posts, "next");
	assert.deepEqual([...projected.byTurn.keys()], ["assign", "next"]);
	const first = projected.byTurn.get("assign");
	assert.deepEqual(
		first?.posts.map(({ message, assignment }) => [message.id, assignment.number]),
		[
			["one", 1],
			["two", 2],
			["two-reply", 2],
			["one-reply", 1],
			["pending", 3],
		],
	);
	assert.equal(first?.assignments.find(({ id }) => id === "two")?.parentRequestMessageId, "one");
	assert.equal(first?.assignments.at(-1)?.status, "failed");
	assert.equal(projected.byTurn.get("next")?.assignments[0]?.status, "running");
	assert.equal(projected.history.posts[0]?.message.id, "unknown");
	const graph = liveDelegationEdges([
		{
			requestMessageId: "one",
			fromMemberName: "PM",
			memberId: "engineering",
			memberName: "Engineering",
			stageLabel: "等待下游回报",
		},
		{
			requestMessageId: "two",
			parentRequestMessageId: "one",
			fromMemberName: "Engineering",
			memberId: "qa",
			memberName: "QA",
			stageLabel: "检查中",
		},
		{ requestMessageId: "three", fromMemberName: "PM", memberId: "qa", memberName: "QA", stageLabel: "测试中" },
	]);
	assert.deepEqual(
		graph.map(({ id, parentId, from, to }) => [id, parentId ?? null, from, to]),
		[
			["one", null, "PM", "Engineering"],
			["two", "one", "Engineering", "QA"],
			["three", null, "PM", "QA"],
		],
	);
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

test("collectMatterParticipantIds aggregates multi-role participants", () => {
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

test("stripMarkdownFormatting removes inline markers", () => {
	assert.equal(
		stripMarkdownFormatting("**结论**：已对齐 `my_snake_case` 与 _斜体_。"),
		"结论：已对齐 my_snake_case 与 斜体。",
	);
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

test("parseMessageFiles extracts valid file and pasted_text refs from message metadata", () => {
	assert.deepEqual(parseMessageFiles(null), []);
	assert.deepEqual(
		parseMessageFiles({
			files: [
				{
					id: "f1",
					kind: "file",
					name: "spec.md",
					mimeType: "text/markdown",
					url: "/api/uploads/123.txt",
					sizeBytes: 120,
					lineCount: 4,
					charCount: 118,
				},
				{
					id: "f2",
					kind: "pasted_text",
					name: "pasted-text-1.txt",
					lineCount: 15,
					charCount: 820,
				},
				{ id: "bad", name: "" },
			],
		}),
		[
			{
				url: "/api/uploads/123.txt",
				kind: "file",
				name: "spec.md",
				mimeType: "text/markdown",
				sizeBytes: 120,
				lineCount: 4,
				charCount: 118,
			},
			{
				kind: "pasted_text",
				name: "pasted-text-1.txt",
				mimeType: "text/plain",
				lineCount: 15,
				charCount: 820,
			},
		],
	);
});

test("formatByteSize, shouldFoldPastedText, and createPastedTextAttachment handle attachments", async () => {
	assert.equal(formatByteSize(512), "512 B");
	assert.equal(formatByteSize(2048), "2.0 KB");
	assert.equal(formatByteSize(1_572_864), "1.5 MB");

	assert.equal(shouldFoldPastedText("short single line"), false);
	assert.equal(shouldFoldPastedText("a".repeat(600)), true);
	assert.equal(shouldFoldPastedText(Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n")), true);

	const pasted = createPastedTextAttachment("line1\r\nline2\r\nline3", 2);
	assert.equal(pasted.kind, "pasted_text");
	assert.equal(pasted.name, "pasted-text-2.txt");
	assert.equal(pasted.lineCount, 3);
	assert.equal(pasted.charCount, 17);

	const textFile = new File(["const x = 1;\n"], "sample.ts", { type: "text/plain" });
	assert.equal(isSupportedImageFile(textFile), false);
	const pngFile = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "pic.png", { type: "image/png" });
	assert.equal(isSupportedImageFile(pngFile), true);

	const prepared = await prepareComposerFiles([textFile], 0);
	assert.equal(prepared.warnings.length, 0);
	assert.equal(prepared.attachments.length, 1);
	assert.equal(prepared.attachments[0]?.name, "sample.ts");
	assert.equal(prepared.attachments[0]?.lineCount, 2);

	const binFile = new File([new Uint8Array([0x00, 0x01, 0x02])], "blob.bin", { type: "application/octet-stream" });
	const binPrepared = await prepareComposerFiles([binFile], 0);
	assert.equal(binPrepared.attachments.length, 0);
	assert.equal(binPrepared.warnings.length, 1);
});

test("resolveEffectivePrimaryContactId and applyPrimaryContactToMembers respect org overrides", () => {
	const baseMembers = [
		{
			id: "product-manager",
			templateId: "product-manager",
			displayName: "Product Manager",
			roleTitle: "产品",
			roleScope: "global" as const,
			keywords: [],
			identitySummary: "产品负责人",
			provider: "kimi",
			model: "k2.5",
			thinkingLevel: "medium" as const,
			isPrimaryContact: true,
			gitName: "Product Manager",
			gitEmail: "product-manager@team.local",
		},
		{
			id: "engineering-manager",
			templateId: "engineering-manager",
			displayName: "Engineering Manager",
			roleTitle: "研发",
			roleScope: "global" as const,
			keywords: [],
			identitySummary: "研发负责人",
			provider: "kimi",
			model: "k2.5",
			thinkingLevel: "medium" as const,
			isPrimaryContact: false,
			gitName: "Engineering Manager",
			gitEmail: "engineering-manager@team.local",
		},
		{
			id: "personal-helper",
			templateId: "personal-helper",
			displayName: "Personal Helper",
			roleTitle: "助手",
			roleScope: "personal" as const,
			keywords: [],
			identitySummary: "个人助手",
			provider: "kimi",
			model: "k2.5",
			thinkingLevel: "medium" as const,
			isPrimaryContact: true,
			gitName: "Personal Helper",
			gitEmail: "personal@team.local",
		},
	];
	const orgAiRoles = {
		org_beta: {
			configured: true,
			effectiveMemberIds: ["engineering-manager", "product-manager"],
			configs: [
				{
					orgId: "org_beta",
					memberId: "engineering-manager",
					enabled: true,
					isPrimaryContact: true,
					displayNameOverride: null,
					modelOverride: null,
					updatedAt: "2026-11-19T00:00:00.000Z",
				},
				{
					orgId: "org_beta",
					memberId: "product-manager",
					enabled: true,
					isPrimaryContact: false,
					displayNameOverride: null,
					modelOverride: null,
					updatedAt: "2026-11-19T00:00:00.000Z",
				},
			],
		},
	};

	assert.equal(resolveEffectivePrimaryContactId(baseMembers, null, orgAiRoles), "product-manager");
	assert.equal(resolveEffectivePrimaryContactId(baseMembers, "org_unconfigured", orgAiRoles), "product-manager");
	assert.equal(resolveEffectivePrimaryContactId(baseMembers, "org_beta", orgAiRoles), "engineering-manager");

	const projected = applyPrimaryContactToMembers(baseMembers, "engineering-manager");
	assert.equal(projected.find((m) => m.id === "engineering-manager")?.isPrimaryContact, true);
	assert.equal(projected.find((m) => m.id === "product-manager")?.isPrimaryContact, false);

	const overridden = applyOrgAiRoleOverrides(baseMembers, "org_beta", {
		org_beta: {
			configured: true,
			effectiveMemberIds: ["engineering-manager", "product-manager"],
			configs: [
				{
					orgId: "org_beta",
					memberId: "engineering-manager",
					enabled: true,
					isPrimaryContact: true,
					displayNameOverride: "Beta Eng",
					modelOverride: null,
					gitNameOverride: "Beta Eng Author",
					gitEmailOverride: "eng@beta.example",
					updatedAt: "2026-11-19T00:00:00.000Z",
				},
			],
		},
	});
	const engOverride = overridden.find((m) => m.id === "engineering-manager");
	assert.equal(engOverride?.displayName, "Beta Eng");
	assert.equal(engOverride?.gitName, "Beta Eng Author");
	assert.equal(engOverride?.gitEmail, "eng@beta.example");
	assert.equal(overridden.find((m) => m.id === "product-manager")?.gitName, "Product Manager");
});

test("execution records group tool starts and results by exact turn, member and scope", () => {
	const meta = { sourceUserMessageId: "turn-1", orgId: "org-1", workspaceId: "ws-1" };
	const reply: MatterMessageDto = {
		id: "reply",
		matterId: "m1",
		channel: "user",
		senderType: "member",
		senderId: "pm",
		content: "done",
		createdAt: "2026-11-23T01:01:00.000Z",
		metadata: meta,
	};
	const snapshot = {
		outcome: "completed" as const,
		stage: "finalizing" as const,
		label: "done",
		startedAt: "2026-11-23T01:00:00.000Z",
		capturedAt: "2026-11-23T01:01:00.000Z",
		elapsedSeconds: 60,
	};
	const event = (
		id: string,
		senderId: string,
		data: object,
		metadata = meta,
		createdAt = "2026-11-23T01:00:30.000Z",
	): MatterMessageDto => ({
		id,
		matterId: "m1",
		channel: "notice",
		senderType: "system",
		senderId,
		content: JSON.stringify(data),
		createdAt,
		metadata,
	});
	const notices = [
		event("1", "pm", {
			type: "tool_execution_start",
			toolCallId: "1",
			toolName: "load_available_skill",
			args: { name: "how" },
		}),
		event("2", "qa", {
			type: "tool_execution_start",
			toolCallId: "1",
			toolName: "read",
			args: { path: "/skills/why/SKILL.md" },
		}),
		event("3", "pm", {
			type: "tool_execution_end",
			toolCallId: "1",
			toolName: "load_available_skill",
			isError: false,
		}),
		event("4", "qa", { type: "tool_execution_end", toolCallId: "1", toolName: "read", isError: true }),
		event("5", "pm", {
			type: "tool_execution_start",
			toolCallId: "2",
			toolName: "bash",
			args: { command: "npm test" },
		}),
		event(
			"6",
			"pm",
			{ type: "tool_execution_start", toolCallId: "3", toolName: "write" },
			{ ...meta, orgId: "other" },
		),
		event(
			"7",
			"pm",
			{ type: "tool_execution_start", toolCallId: "4", toolName: "edit" },
			meta,
			"2026-11-23T01:02:00.000Z",
		),
		event(
			"8",
			"pm",
			{ type: "tool_execution_start", toolCallId: "5", toolName: "read" },
			{ ...meta, sourceUserMessageId: "turn-2" },
		),
	];
	notices.push(
		event("9", "pm", {
			type: "tool_execution_start",
			toolCallId: "6",
			toolName: "read",
			args: { path: "/truncated", skillName: "architect" },
		}),
	);
	const result = collectTurnToolCalls(notices, reply, snapshot);
	assert.deepEqual(
		result.map(({ memberId, toolName, skillName, status }) => ({ memberId, toolName, skillName, status })),
		[
			{ memberId: "pm", toolName: "load_available_skill", skillName: "how", status: "success" },
			{ memberId: "qa", toolName: "read", skillName: "why", status: "error" },
			{ memberId: "pm", toolName: "bash", skillName: undefined, status: "unknown" },
			{ memberId: "pm", toolName: "read", skillName: "architect", status: "unknown" },
		],
	);
	assert.deepEqual(collectTurnToolCalls(notices, { ...reply, metadata: {} }, snapshot), []);
});

test("resolveApiUrl defaults to same-origin and honors configured host base URL", () => {
	try {
		setApiBaseUrl(null);
		assert.equal(getApiBaseUrl(), "");
		assert.equal(resolveApiUrl("/api/events"), "/api/events");
		setApiBaseUrl("https://pa.internal:4310///");
		assert.equal(getApiBaseUrl(), "https://pa.internal:4310");
		assert.equal(resolveApiUrl("/api/events"), "https://pa.internal:4310/api/events");
		assert.equal(resolveApiUrl("api/bootstrap"), "https://pa.internal:4310/api/bootstrap");
		assert.equal(resolveApiUrl("https://other.example/x"), "https://other.example/x");
	} finally {
		setApiBaseUrl(null);
	}
});
