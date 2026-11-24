import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	buildCompactionCarryover,
	type CompactBranchEntry,
	PA_COMPACTION_CARRYOVER_CUSTOM_TYPE,
} from "../pa-extensions/worker-runtime/pi/compaction-carryover.ts";
import workerRuntimeExtension, { type WorkerRuntimeExtensionApi } from "../pa-extensions/worker-runtime/pi/index.ts";

test("buildCompactionCarryover restores read & block Skills, strips frontmatter, enforces budget, and preserves space/delegation anchors", () => {
	const dir = mkdtempSync(join(tmpdir(), "pa-compact-carryover-"));
	try {
		const skillADir = join(dir, "skills", "alpha-sop");
		const skillBDir = join(dir, "skills", "beta-release");
		mkdirSync(skillADir, { recursive: true });
		mkdirSync(skillBDir, { recursive: true });
		const skillAPath = join(skillADir, "SKILL.md");
		const skillBPath = join(skillBDir, "SKILL.md");
		writeFileSync(skillAPath, "---\nname: alpha-sop\ndescription: Alpha SOP\n---\n\n# Alpha\nAlways verify A.\n");
		writeFileSync(
			skillBPath,
			`---\nname: beta-release\ndescription: Beta release\n---\n\n# Beta\n${"Run preflight checks. ".repeat(40)}\n`,
		);

		const entries: CompactBranchEntry[] = [
			{
				id: "e1",
				type: "message",
				message: {
					role: "user",
					content: `<skill name="alpha-sop" location="${skillAPath}">ignored inline body</skill>`,
				},
			},
			{
				id: "e2",
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "tc-read", name: "read", arguments: { path: skillBPath } },
						{
							type: "toolCall",
							id: "tc-space",
							name: "save_space_page",
							arguments: { title: "v0.8.1 方案", docType: "plan" },
						},
						{
							type: "toolCall",
							id: "tc-del",
							name: "delegate_to_member",
							arguments: { memberId: "qa-manager", task: "独立验收预构建包启动与边界门禁" },
						},
					],
				},
			},
			{
				id: "e3",
				type: "message",
				message: { role: "toolResult", toolCallId: "tc-read", isError: false, content: "ok" },
			},
			{
				id: "e4",
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "tc-space",
					isError: false,
					content: JSON.stringify({ page: { id: "doc_123", title: "v0.8.1 方案" } }),
				},
			},
			{
				id: "e5",
				type: "message",
				message: { role: "toolResult", toolCallId: "tc-del", isError: false, content: "done" },
			},
			{
				id: "e-kept",
				type: "message",
				message: { role: "user", content: "continue after compaction" },
			},
		];

		const carryover = buildCompactionCarryover(entries, {
			cwd: dir,
			firstKeptEntryId: "e-kept",
			maxSkillChars: 240,
			maxTotalChars: 1000,
		});
		assert.ok(carryover);
		assert.match(carryover, /Saved Space pages: 「v0\.8\.1 方案」 \(doc_123\) \[plan\]/);
		assert.match(carryover, /Completed delegations: qa-manager: 独立验收预构建包启动与边界门禁/);
		assert.match(carryover, /<restored_skill name="alpha-sop"/);
		assert.match(carryover, /Always verify A\./);
		assert.doesNotMatch(carryover, /description: Alpha SOP/);
		assert.match(carryover, /<restored_skill name="beta-release"[^>]*> \[truncated/);
		// Most recently loaded skill appears last
		assert.ok(carryover.indexOf('name="alpha-sop"') < carryover.indexOf('name="beta-release"'));

		// Empty / no-skill session returns undefined
		assert.equal(
			buildCompactionCarryover([{ id: "u1", type: "message", message: { role: "user", content: "hello" } }]),
			undefined,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("workerRuntimeExtension emits non-triggering carryover message on session_compact", () => {
	const dir = mkdtempSync(join(tmpdir(), "pa-compact-hook-"));
	try {
		const skillDir = join(dir, "skills", "deploy-check");
		mkdirSync(skillDir, { recursive: true });
		const skillPath = join(skillDir, "SKILL.md");
		writeFileSync(skillPath, "---\nname: deploy-check\n---\nCheck SHA256SUMS before upload.\n");

		let compactHandler:
			| ((
					event: { compactionEntry?: { firstKeptEntryId?: string } },
					ctx?: { cwd?: string; sessionManager?: { getBranch?(): readonly CompactBranchEntry[] } },
			  ) => void)
			| undefined;
		const sent: Array<{ message: { customType: string; content: string; display: boolean }; options?: unknown }> = [];
		const fakePi: WorkerRuntimeExtensionApi = {
			on(event: string, handler: unknown) {
				if (event === "session_compact") {
					compactHandler = handler as typeof compactHandler;
				}
			},
			sendMessage(message, options) {
				sent.push({ message, options });
			},
			getActiveTools: () => [],
			getAllTools: () => [],
			setActiveTools: () => {},
		};
		workerRuntimeExtension(fakePi);
		assert.ok(compactHandler);

		compactHandler(
			{ compactionEntry: { firstKeptEntryId: "kept" } },
			{
				cwd: dir,
				sessionManager: {
					getBranch: () => [
						{
							id: "e1",
							type: "message",
							message: {
								role: "assistant",
								content: [{ type: "toolCall", id: "r1", name: "read", arguments: { path: skillPath } }],
							},
						},
						{
							id: "e2",
							type: "message",
							message: { role: "toolResult", toolCallId: "r1", isError: false, content: "ok" },
						},
						{ id: "kept", type: "message", message: { role: "user", content: "next" } },
					],
				},
			},
		);

		assert.equal(sent.length, 1);
		assert.equal(sent[0]?.message.customType, PA_COMPACTION_CARRYOVER_CUSTOM_TYPE);
		assert.equal(sent[0]?.message.display, false);
		assert.deepEqual(sent[0]?.options, { triggerTurn: false });
		assert.match(sent[0]?.message.content ?? "", /Check SHA256SUMS before upload/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
