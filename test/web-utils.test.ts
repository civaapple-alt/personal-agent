import assert from "node:assert/strict";
import test from "node:test";
import type { DeliverableDto } from "../web/src/api/deliverables.ts";
import type { MatterMessageDto } from "../web/src/api/matters.ts";
import {
	createPastedTextAttachment,
	isSupportedImageDescriptor as isSupportedImageFile,
	prepareComposerTextFiles as prepareComposerFiles,
	shouldFoldPastedText,
} from "../web/src/textAttachments.ts";
import { groupDeliverableSeries } from "../web/src/utils/deliverableSeries.ts";
import { buildMatterDelegations, liveDelegationEdges } from "../web/src/utils/matterDelegations.ts";
import {
	applyOrgAiRoleOverrides,
	applyPrimaryContactToMembers,
	collectMatterMemories,
	collectMatterParticipantIds,
	formatByteSize,
	formatElapsedDuration,
	formatNoticeEventLine,
	getMemberThemeById,
	inferDelegationMood,
	isKeyNoticeEvent,
	MEMORY_CATEGORY_LABELS,
	parseDeliverableSummary,
	parseMessageFiles,
	parseMessageImages,
	parseProgressSnapshot,
	pickDefaultWorkspaceId,
	resolveEffectivePrimaryContactId,
	stripMarkdownFormatting,
} from "../web/src/utils.ts";

test("deliverable series group versions within each matter and list the latest series first", () => {
	const first: DeliverableDto = {
		id: "v1",
		matterId: "m1",
		memberId: "engineering-manager",
		type: "document",
		title: "验收报告",
		summary: "",
		contentOrPath: "",
		serviceUrl: null,
		version: 1,
		feedback: null,
		createdAt: "2026-11-18T02:00:00.000Z",
	};
	const second = { ...first, id: "v2", version: 2, createdAt: "2026-11-20T02:00:00.000Z" };
	const other = { ...first, id: "other", matterId: "m2", createdAt: "2026-11-19T02:00:00.000Z" };
	const series = groupDeliverableSeries([other, second, first]);

	assert.deepEqual(
		series.map(({ latest, versions }) => [latest.id, versions.map(({ id }) => id)]),
		[
			["v2", ["v1", "v2"]],
			["other", ["other"]],
		],
	);
});

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
		message("unknown", "internal_collab", "member", 7, { sourceUserMessageId: null, toMemberId: "qa" }),
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

	const mdSummary =
		"## 本轮成果 (commit `6a00bd4`)\n- **TS 严格模式**：新增 `tsconfig.json`，参考 [docs](https://example.com)";
	const mdParsed = parseDeliverableSummary(mdSummary);
	assert.equal(mdParsed.lead, "本轮成果 (commit 6a00bd4)");
	assert.deepEqual(mdParsed.details, ["TS 严格模式：新增 tsconfig.json，参考 docs"]);
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
