/** Opt-in real Pi walkthrough. No user database or prefilled deliverables are used. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TeamOrchestrator } from "../orchestrator/team-orchestrator.ts";
import { loadRoleTemplatesFromDir } from "../roles/template-loader.ts";
import { InnerMatterDemo } from "../server/inner-matter.ts";
import { openPersonalAgentDatabase } from "../storage/database.ts";
import { PersonalAgentStore } from "../storage/repositories.ts";
import { INNER_MATTER_GUIDE } from "./inner-matter-definition.ts";

const root = await mkdtemp(join(tmpdir(), "personal-agent-inner-demo-"));
console.log(`Isolated walkthrough evidence: ${root}`);
const db = openPersonalAgentDatabase(join(root, "proof.db"));
const store = new PersonalAgentStore(db);
const templates = (await loadRoleTemplatesFromDir(resolve("roles"))).map((template) => ({
	...template,
	thinkingLevel: "off" as const,
}));
const orchestrator = new TeamOrchestrator({ store, templates, defaultCwd: root, sessionDir: join(root, "sessions") });
try {
	const workspace = join(root, "inner-matter");
	const matter = await new InnerMatterDemo(store, workspace).prepare();
	assert.equal(store.listDeliverables().length, 0);
	const turns = [];
	for (const step of INNER_MATTER_GUIDE.steps) {
		if (step.id === "revise") {
			const first = store.listDeliverables(matter.id).find((item) => item.version === 1);
			assert.ok(first);
			store.recordDeliverableFeedback(first.id, step.feedback);
		}
		const turn = await orchestrator.dispatchMatter({
			matterId: matter.id,
			prompt: step.prompt + (step.id === "revise" ? `\n\n本次反馈：\n${step.feedback}` : ""),
			timeoutMs: 180_000,
		});
		assert.equal(turn.runResult.aborted, false);
		turns.push({
			step: step.id,
			reply: turn.replyText,
			tools: turn.runResult.toolExecutions.map((tool) => ({ name: tool.toolName, isError: tool.isError })),
			deliverable: turn.deliverable,
		});
		await writeFile(join(root, "turns.json"), JSON.stringify(turns, null, 2));
		if (step.id === "discuss" || step.id === "collaborate") assert.equal(store.listDeliverables(matter.id).length, 0);
		if (step.id === "collaborate") {
			for (const id of INNER_MATTER_GUIDE.collaborationMemberIds)
				assert.ok(
					store
						.listMessages(matter.id, "internal_collab")
						.some(
							(msg) =>
								msg.senderId === id &&
								typeof msg.metadata?.requestMessageId === "string" &&
								!msg.metadata.failed,
						),
				);
		}
		if (step.id === "deliver" || step.id === "revise") {
			assert.equal(turn.deliverable?.title, INNER_MATTER_GUIDE.deliverableTitle);
			assert.equal(turn.deliverable?.version, step.id === "deliver" ? 1 : 2);
			assert.ok(
				turn.runResult.toolExecutions.some((tool) => tool.toolName === "publish_deliverable" && !tool.isError),
			);
			assert.ok(
				(await readFile(join(workspace, `deliverables/feedback-box-v${turn.deliverable!.version}.md`), "utf8"))
					.length > 0,
			);
		}
		console.log(`PASS ${step.label}: ${store.listDeliverables(matter.id).length} formal versions`);
	}
	assert.equal(db.prepare("SELECT count(*) AS n FROM matter_execution_leases").get()?.n, 0);
	console.log("PASS real four-stage walkthrough; sessions, turns.json and proof.db retained");
} finally {
	await orchestrator.shutdown();
	db.close();
}
