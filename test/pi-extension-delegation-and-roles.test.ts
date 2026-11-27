import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadRoleTemplatesFromDir } from "../packages/server/src/roles/template-loader.ts";
import { createDelegationExtension } from "../pi-extensions/delegation/index.ts";
import { createRolesExtension } from "../pi-extensions/roles/index.ts";
import { getBundledRolesDir, listRoleDefinitions, resolveRoleDefinition } from "../pi-extensions/roles/loader.ts";
import type { WorkerModelOverride } from "../pi-extensions/shared/local-rpc-worker.ts";
import { buildSharedWorkerPiArgs } from "../pi-extensions/shared/local-rpc-worker.ts";

interface HarnessTool {
	name: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	execute(
		callId: string,
		args: unknown,
		signal?: AbortSignal,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
}

function createHarness() {
	const tools = new Map<string, HarnessTool>();
	const commands = new Map<string, { handler(args: string): Promise<string | undefined> | string | undefined }>();
	const sentMessages: string[] = [];
	return {
		api: {
			registerTool(def: HarnessTool) {
				tools.set(def.name, def);
			},
			registerCommand(
				name: string,
				def: { handler(args: string): Promise<string | undefined> | string | undefined },
			) {
				commands.set(name, def);
			},
			sendUserMessage(content: string) {
				sentMessages.push(content);
			},
		},
		tools,
		commands,
		sentMessages,
	};
}

test("pi-extensions/roles is single source of truth for the 4 default business roles and loads cleanly into PA", async () => {
	const bundledDir = getBundledRolesDir();
	for (const id of ["product-manager", "engineering-manager", "qa-manager", "marketing-lead"]) {
		assert.equal(existsSync(join(bundledDir, `${id}.md`)), true, `missing portable role ${id}.md`);
		assert.equal(
			existsSync(resolve(process.cwd(), "roles", `${id}.md`)),
			false,
			`duplicate role ${id}.md should not remain in root roles/`,
		);
	}

	const hostTemplates = await loadRoleTemplatesFromDir(resolve(process.cwd(), "roles"));
	assert.deepEqual(hostTemplates.map((t) => t.id).sort(), [
		"engineering-manager",
		"marketing-lead",
		"pi-default",
		"product-manager",
		"qa-manager",
		"role-architect",
	]);

	// Standalone registers list_roles + /roles.
	const standalone = createHarness();
	createRolesExtension({ env: {}, cwd: mkdtempSync(join(tmpdir(), "pa-roles-empty-")) })(standalone.api);
	assert.deepEqual(Array.from(standalone.tools.keys()), ["list_roles"]);
	assert.equal(standalone.commands.has("roles"), true);

	const res = await standalone.tools.get("list_roles")!.execute("r1", { includeBody: true });
	const parsed = JSON.parse(res.content[0]!.text) as {
		roles: Array<{ id: string; antiJobs: string[]; body?: string }>;
	};
	assert.deepEqual(
		parsed.roles.map((r) => r.id),
		["engineering-manager", "marketing-lead", "product-manager", "qa-manager"],
	);
	assert.ok(parsed.roles.every((r) => Boolean(r.body)));

	const cmdText = await standalone.commands.get("roles")!.handler("");
	assert.match(cmdText ?? "", /engineering-manager/);
	assert.match(cmdText ?? "", /qa-manager/);

	// PA host mode suppresses standalone role tools cleanly.
	const paMode = createHarness();
	createRolesExtension({ env: { PA_TEAM_BRIDGE_URL: "http://127.0.0.1:9999" } })(paMode.api);
	assert.equal(paMode.tools.size, 0);
	assert.equal(paMode.commands.size, 0);
});

test("pi-extensions/delegation routes PA Bridge vs standalone Lead delegate_to_member cleanly", async () => {
	const received: Array<{ auth?: string; body: Record<string, unknown> }> = [];
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			received.push({
				auth: req.headers.authorization,
				body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
			});
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ assignmentNumber: 1, replyText: "bridge ok" }));
		});
	});
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const url = `http://127.0.0.1:${address.port}`;

	const dir = mkdtempSync(join(tmpdir(), "pa-delegation-standalone-"));
	try {
		// 1. PA bridge routing forwards exact delegate_to_member payload.
		const paHarness = createHarness();
		createDelegationExtension({
			env: { PA_TEAM_BRIDGE_URL: url, PA_TEAM_BRIDGE_TOKEN: "del-tok" },
		})(paHarness.api);
		assert.deepEqual(Array.from(paHarness.tools.keys()), ["delegate_to_member"]);

		const paRes = await paHarness.tools.get("delegate_to_member")!.execute("c1", {
			memberId: "qa-manager",
			task: "Verify release candidate",
			handoffDocumentIds: ["doc-1"],
		});
		assert.equal(JSON.parse(paRes.content[0]!.text).assignmentNumber, 1);
		assert.equal(received[0]?.auth, "Bearer del-tok");
		assert.equal(received[0]?.body.tool, "delegate_to_member");

		// 2. Standalone mode auto-feeds bundled role definition & strips edit/write when verification is passed.
		const capturedRequests: Array<{ readOnly: boolean; args: string[]; prompt: string; sessionFile: string }> = [];
		const localHarness = createHarness();
		createDelegationExtension({
			cwd: dir,
			env: {},
			executor: async (req) => {
				capturedRequests.push({
					readOnly: req.readOnly,
					args: buildSharedWorkerPiArgs(req),
					prompt: req.prompt,
					sessionFile: req.sessionFile,
				});
				return { assistantText: req.readOnly ? "verified ok" : "built ok" };
			},
		})(localHarness.api);

		const qaRes = await localHarness.tools.get("delegate_to_member")!.execute("d1", {
			memberId: "qa-manager",
			task: "Audit clamp.js and run tests",
			verification: {
				target: { kind: "file", reference: "clamp.js" },
				criteria: "All edge tests pass",
			},
			modelOverride: {
				provider: "opencode-go",
				model: "deepseek-v4.1-flash",
				thinkingLevel: "high",
			} satisfies WorkerModelOverride,
		});
		const qaPayload = JSON.parse(qaRes.content[0]!.text) as {
			memberId: string;
			resolvedFromRoleFile: boolean;
			readOnly: boolean;
			assistantText: string;
		};
		assert.equal(qaPayload.resolvedFromRoleFile, true);
		assert.equal(qaPayload.readOnly, true);
		assert.equal(qaPayload.assistantText, "verified ok");
		assert.match(capturedRequests[0]!.prompt, /\[Delegated Specialist: QA Manager \(qa-manager\)\]/);
		assert.match(capturedRequests[0]!.prompt, /Independent Verification Mode — READ-ONLY/);
		assert.ok(capturedRequests[0]!.args.includes("--exclude-tools"));
		assert.ok(capturedRequests[0]!.args.includes("--provider"));
		assert.ok(capturedRequests[0]!.args.includes("deepseek-v4.1-flash"));
		assert.ok(capturedRequests[0]!.sessionFile.endsWith("qa-manager.jsonl"));

		// 3. Metadata match by frontmatter name/keyword resolves cleanly; unknown specialist label runs ad-hoc cleanly.
		const aliasRes = await localHarness.tools.get("delegate_to_member")!.execute("d2", {
			memberId: "研发经理",
			task: "Fix parser edge case",
		});
		const aliasPayload = JSON.parse(aliasRes.content[0]!.text) as {
			memberId: string;
			roleTitle: string;
			resolvedFromRoleFile: boolean;
			readOnly: boolean;
		};
		assert.equal(aliasPayload.memberId, "engineering-manager");
		assert.equal(aliasPayload.roleTitle, "Engineering Manager");
		assert.equal(aliasPayload.resolvedFromRoleFile, true);
		assert.equal(aliasPayload.readOnly, false);

		const customRes = await localHarness.tools.get("delegate_to_member")!.execute("d3", {
			memberId: "安全审计专家",
			task: "Audit auth headers",
		});
		const customPayload = JSON.parse(customRes.content[0]!.text) as {
			memberId: string;
			resolvedFromRoleFile: boolean;
			readOnly: boolean;
			sessionFile: string;
			assistantText: string;
		};
		assert.equal(customPayload.memberId, "安全审计专家");
		assert.equal(customPayload.resolvedFromRoleFile, false);
		assert.equal(customPayload.readOnly, false);
		assert.equal(customPayload.assistantText, "built ok");
		assert.match(customPayload.sessionFile, /role-[0-9a-f]{12}\.jsonl$/);
		assert.equal(capturedRequests[2]!.args.includes("--exclude-tools"), false);

		// 4. Child sub-worker guard disables nested delegate_to_member registration.
		const childHarness = createHarness();
		createDelegationExtension({ cwd: dir, env: { PA_LOCAL_DELEGATE_SUBWORKER: "1" } })(childHarness.api);
		assert.equal(childHarness.tools.size, 0);

		// Verify role resolution helper respects custom PA_ROLES_DIR override without hardcoded alias tables.
		const overrideDir = join(dir, "custom-roles");
		const list = listRoleDefinitions({ cwd: dir, env: { PA_ROLES_DIR: overrideDir } });
		assert.equal(list.length, 4);
		assert.equal(resolveRoleDefinition("product-manager", { cwd: dir })?.id, "product-manager");
		assert.equal(resolveRoleDefinition("QA Manager", { cwd: dir })?.id, "qa-manager");
		assert.equal(resolveRoleDefinition("测试", { cwd: dir })?.id, "qa-manager");
		assert.equal(resolveRoleDefinition("nonexistent-shorthand", { cwd: dir }), undefined);

		// Verify promptGuidelines feed the available roles index & natural-language /delegate dispatches cleanly.
		const toolGuidelines = localHarness.tools.get("delegate_to_member")!.promptGuidelines ?? [];
		assert.ok(toolGuidelines.length >= 2);
		assert.ok(toolGuidelines.some((line) => line.includes("engineering-manager") && line.includes("qa-manager")));
		assert.equal(localHarness.commands.has("delegate"), true);

		const usage = await localHarness.commands.get("delegate")!.handler("");
		assert.match(usage ?? "", /Usage: \/delegate/);
		assert.equal(localHarness.sentMessages.length, 0);

		await localHarness.commands.get("delegate")!.handler("把 auth.ts 的空指针修掉，再找负责质量的同学独立验证");
		assert.equal(localHarness.sentMessages.length, 1);
		assert.match(localHarness.sentMessages[0]!, /把 auth\.ts 的空指针修掉/);
		assert.match(localHarness.sentMessages[0]!, /engineering-manager/);
		assert.match(localHarness.sentMessages[0]!, /qa-manager/);
		assert.match(localHarness.sentMessages[0]!, /verification/);
	} finally {
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		rmSync(dir, { recursive: true, force: true });
	}
});
