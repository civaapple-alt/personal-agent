import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { preparePstackRuntime, readPstackResource } from "../../pi-extensions/pstack-methods/methods.js";
import { TeamOrchestrator } from "../orchestrator/team-orchestrator.ts";
import { loadRoleTemplatesFromDir } from "../roles/template-loader.ts";
import { openPersonalAgentDatabase } from "../storage/database.ts";
import { PersonalAgentStore } from "../storage/repositories.ts";
import { selectDemoModel } from "./model-selection.ts";
import { hasPstackReadEvidence } from "./pstack-evidence.ts";

async function snapshot(root: string, relative = ""): Promise<Record<string, string>> {
	const result: Record<string, string> = {};
	for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
		const path = join(relative, entry.name);
		if (entry.isDirectory()) Object.assign(result, await snapshot(root, path));
		else if (entry.isFile())
			result[path] = createHash("sha256")
				.update(await readFile(join(root, path)))
				.digest("hex");
	}
	return result;
}

async function main() {
	const { values } = parseArgs({
		options: {
			help: { type: "boolean" },
			source: { type: "string" },
			provider: { type: "string" },
			model: { type: "string" },
		},
		strict: true,
	});
	if (values.help) {
		console.log(
			"demo:pstack --source <complete pstack directory> [--provider <id>] [--model <id>]\nUses real Pi/model calls in disposable workspaces. Copies the approved method pack; preserves report.json, sessions and proof.db. Checks actual method loads, role permissions and real task outcomes. --help calls no model.",
		);
		return;
	}
	const source = values.source ?? process.env.PA_PSTACK_DIR;
	if (!source) throw new Error("Provide --source or PA_PSTACK_DIR (complete pstack pack with poteto-mode)");
	const sourceRuntime = await preparePstackRuntime(source);
	const root = await mkdtemp(join(tmpdir(), "personal-agent-pstack-"));
	console.log(`Isolated pstack evidence: ${root}`);
	const pack = join(root, "methods");
	await mkdir(pack);
	await cp(join(sourceRuntime.root, "skills"), join(pack, "skills"), { recursive: true });
	await cp(join(sourceRuntime.root, "plugin.json"), join(pack, "plugin.json"));
	const frozen = await snapshot(pack);
	const methods = new Map(
		await Promise.all(
			["poteto-mode", "principle-fix-root-causes", "principle-prove-it-works"].map(
				async (name) => [name, await readPstackResource(pack, name)] as const,
			),
		),
	);
	const workspace = join(root, "countdown");
	await mkdir(workspace);
	await writeFile(
		join(workspace, "remaining.mjs"),
		"export function remaining(deadline, now) { return Math.ceil((now - deadline) / 1000); }\n",
	);
	const tests =
		"import assert from 'node:assert/strict';\nimport { remaining } from './remaining.mjs';\nassert.equal(remaining(10000, 5000), 5);\nassert.equal(remaining(10000, 12000), 0);\nassert.equal(remaining(10000, 10000), 0);\nconsole.log('COUNTDOWN_OK');\n";
	await writeFile(join(workspace, "remaining.test.mjs"), tests);
	const baseline = spawnSync(process.execPath, ["remaining.test.mjs"], { cwd: workspace, encoding: "utf8" });
	assert.notEqual(baseline.status, 0, "Synthetic defect must fail before the agent runs");
	const db = openPersonalAgentDatabase(join(root, "proof.db"));
	const store = new PersonalAgentStore(db);
	if (values.provider || values.model)
		store.updatePlatformSettings({ defaultModelSelection: await selectDemoModel(root, values) });
	const templates = (await loadRoleTemplatesFromDir(resolve("roles"))).map((template) => ({
		...template,
		...(template.id === "product-manager" ? { tools: [] } : {}),
	}));
	const orchestrator = new TeamOrchestrator({
		store,
		templates,
		defaultCwd: root,
		pstackDir: pack,
		sessionDir: join(root, "sessions"),
	});
	const records: Array<Record<string, unknown>> = [];
	let passed = false;
	try {
		const discussion = await orchestrator.dispatchMatter({
			preferredMemberId: "product-manager",
			aiMemberIds: ["product-manager"],
			timeoutMs: 180_000,
			prompt:
				"只讨论一个本地倒计时小工具的需求，不编码、不发布、不提交 Git。合成试用反馈：有人要求截止时间一到就显示 0，有人要求到期后继续显示超时了多久。这两种预期还没有决定。请按本次 pstack 方法工作，先明确一个会影响首版范围的关键问题，保留不确定性，最多问我两句，不替我决定。",
		});
		const discussionTools = discussion.runResult.toolExecutions;
		const loaded = (tools: typeof discussionTools, name: string) => {
			const expected = methods.get(name);
			return expected !== undefined && hasPstackReadEvidence(tools, expected);
		};
		assert.ok(loaded(discussionTools, "poteto-mode"), "Product role must actually load poteto-mode");
		assert.equal(discussion.deliverable, null);
		assert.equal(
			discussionTools.some((tool) => ["read", "bash", "write", "edit"].includes(tool.toolName)),
			false,
			"Method loading must not grant filesystem or shell tools",
		);
		records.push({ scenario: "product_discussion", reply: discussion.replyText, run: discussion.runResult });
		console.log("PASS product: actual poteto-mode load without business filesystem tools; no premature delivery");

		const ws = store.upsertWorkspace({ name: "Synthetic countdown", repoPath: workspace });
		const fix = await orchestrator.dispatchMatter({
			preferredMemberId: "engineering-manager",
			aiMemberIds: ["engineering-manager"],
			workspaceId: ws.id,
			timeoutMs: 180_000,
			prompt:
				"修复这个合成倒计时工具：未来截止时间应返回剩余秒数，已到期和过期均返回 0。remaining.test.mjs 已固定这次范围。请按 pstack 方法先运行失败用例、核对根因，再只修 remaining.mjs，重跑同一测试。不修改测试、方法包、其他文件或模型配置，不联网、不提交 Git、不发布成果。最后用几句说明根因与实际验证。",
		});
		records.push({ scenario: "engineering_fix", reply: fix.replyText, run: fix.runResult });
		const final = spawnSync(process.execPath, ["remaining.test.mjs"], { cwd: workspace, encoding: "utf8" });
		assert.equal(final.status, 0, final.stderr);
		assert.equal(await readFile(join(workspace, "remaining.test.mjs"), "utf8"), tests);
		assert.ok(loaded(fix.runResult.toolExecutions, "poteto-mode"));
		assert.ok(
			loaded(fix.runResult.toolExecutions, "principle-fix-root-causes"),
			"Must load actual root-cause principle, not merely mention its name",
		);
		assert.ok(
			loaded(fix.runResult.toolExecutions, "principle-prove-it-works"),
			"Must load actual verification principle",
		);
		assert.ok(fix.runResult.toolExecutions.some((tool) => tool.toolName === "bash" && !tool.isError));
		assert.equal(store.listDeliverables().length, 0);
		assert.deepEqual(await snapshot(pack), frozen, "Method source must remain unchanged");
		console.log(
			"PASS engineering: actual mode and principles, real defect repaired, identical tests pass; no delivery",
		);
		passed = true;
	} finally {
		await orchestrator.shutdown();
		await writeFile(
			join(root, "report.json"),
			JSON.stringify(
				{
					passed,
					scope: "Integration and targeted deterministic behavior only; no general quality uplift claim",
					package: { version: sourceRuntime.version, modeSha256: sourceRuntime.modeSha256 },
					baseline: { exitCode: baseline.status, stderr: baseline.stderr },
					records,
				},
				null,
				2,
			),
		);
		db.close();
		console.log(`Retained report: ${join(root, "report.json")}`);
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
