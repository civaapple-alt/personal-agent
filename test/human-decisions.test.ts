import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import {
	BUILTIN_ROLE_ARCHITECT_TEMPLATE,
	createPersonalAgentServer,
	DialogBroker,
	loadRoleTemplatesFromDir,
	openPersonalAgentDatabase,
	PersonalAgentStore,
	PreviewManager,
	type PromptRunResult,
	type RpcWorkerLike,
	resolveBuiltinExtensionPath,
	TeamOrchestrator,
} from "../packages/server/src/index.ts";
import { readHumanDecision } from "../packages/server/src/orchestrator/human-decision.ts";
import type { MatterMessage } from "../packages/server/src/storage/types.ts";
import { invokeTool, reportReady } from "./worker-helpers.ts";

const completed = (assistantText: string): PromptRunResult => ({
	disposition: "started",
	aborted: false,
	assistantText,
	assistantMessages: [],
	toolExecutions: [],
	notices: [],
	dialogs: [],
	events: [],
});

async function waitFor<T>(read: () => T | null | undefined): Promise<T> {
	for (let attempt = 0; attempt < 80; attempt++) {
		const value = read();
		if (value != null) return value;
		await setTimeout(25);
	}
	throw new Error("Expected a persisted turn result");
}

test("planning decisions preserve delegation provenance, require the assigned human, and resume once after restart", async () => {
	const tmp = mkdtempSync(join(tmpdir(), "pa-human-decisions-"));
	const databasePath = join(tmp, "matters.db");
	let db = openPersonalAgentDatabase(databasePath);
	let store = new PersonalAgentStore(db);
	const templates = await loadRoleTemplatesFromDir(resolve("roles"));
	const org = store.ensureDefaultOrganization();
	const password = "LocalFixture123!";
	const owner = store.createUser({ email: "owner@example.test", displayName: "Owner", password, status: "active" });
	const peer = store.createUser({
		email: "peer@example.test",
		displayName: "Peer",
		password,
		status: "active",
		canDispatchAi: false,
	});
	const viewer = store.createUser({ email: "viewer@example.test", displayName: "Viewer", password, status: "active" });
	store.upsertOrgMember({ orgId: org.id, userId: owner.id, orgRole: "org_owner" });
	store.upsertOrgMember({ orgId: org.id, userId: peer.id, orgRole: "org_member" });
	store.upsertOrgMember({ orgId: org.id, userId: viewer.id, orgRole: "org_viewer" });
	const cookie = (id: string) => `pa_session=${store.createSession(id).rawToken}`;
	const ownerCookie = cookie(owner.id);
	const peerCookie = cookie(peer.id);
	const viewerCookie = cookie(viewer.id);
	const dialogBroker = new DialogBroker();
	let allowedDialogs = 0;
	let blockedObserver = false;
	let resumeCount = 0;
	let reachedSpecialist = false;
	dialogBroker.onEvent(({ type }) => {
		if (type === "dialog_requested") allowedDialogs++;
	});

	const makeOrchestrator = () =>
		new TeamOrchestrator({
			store,
			templates,
			defaultCwd: tmp,
			noSession: true,
			workerFactory(options) {
				let dialog: Parameters<RpcWorkerLike["setDialogHandler"]>[0];
				const tool = (name: string, args: unknown) => invokeTool(options, name, args);
				return {
					start: () => reportReady(options, JSON.parse(options.env?.PA_REQUIRED_TOOLS ?? "[]")),
					stop: async () => {},
					getState: async () => ({ sessionId: crypto.randomUUID() }),
					onNotice: () => () => {},
					setDialogHandler: (handler) => {
						dialog = handler;
					},
					async runPromptAndWait(prompt) {
						const memberId = options.env?.PA_MEMBER_ID;
						const system = options.env?.PA_MEMBER_CONTEXT ?? "";
						const questionLoaded = options.args?.includes(resolveBuiltinExtensionPath("human-question"));
						if (system.includes("## Observer participation")) {
							assert.equal(questionLoaded, false);
							await assert.rejects(tool("request_clarification", { question: "Observer cannot ask directly" }));
							assert.deepEqual(
								await dialog?.({
									type: "extension_ui_request",
									method: "input",
									id: "observer",
									title: "Observer question",
								}),
								{
									cancelled: true,
								},
							);
							blockedObserver = true;
							return completed("[SILENT]");
						}
						assert.equal(questionLoaded, true);
						if (memberId === "qa-manager") {
							if (prompt.includes("Apply the recorded decision")) {
								reachedSpecialist = true;
								return completed("Continued verification with the user's decision.");
							}
							assert.deepEqual(
								await dialog?.({
									type: "extension_ui_request",
									method: "select",
									id: "internal",
									title: "Include legacy data?",
									options: ["Yes", "No"],
								}),
								{ cancelled: true },
							);
							return completed("I can test the new path independently.");
						}
						if (memberId === "engineering-manager") {
							if (prompt.includes("Apply the recorded decision")) {
								await tool("delegate_to_member", {
									memberId: "qa-manager",
									task: "Apply the recorded decision to the original migration risk checks.",
								});
								return completed("Continued verification.");
							}
							const qa = await tool("delegate_to_member", {
								memberId: "qa-manager",
								task: "Find migration risks",
							});
							assert.match(JSON.stringify(qa), /needs_clarification/);
							await tool("request_clarification", {
								question: "Include legacy data?",
								context: "Only migration tests depend on this choice",
								sourceAssignmentNumber: 2,
								options: ["Include migration", "Skip migration"],
							});
							return completed("Existing flows mapped.");
						}
						if (prompt.includes("原委托：@QA Manager: Find migration risks")) {
							resumeCount++;
							if (resumeCount === 1) throw new Error("Fixture interrupted continuation");
							const answer = /(?:Include|Skip) migration/.exec(prompt)?.[0];
							assert.ok(answer);
							await tool("delegate_to_member", {
								memberId: "engineering-manager",
								task: `Apply the recorded decision: ${answer}`,
							});
							return completed("The decision was passed back.");
						}
						const handoff = await tool("delegate_to_member", {
							memberId: "engineering-manager",
							task: "Assess the migration effort",
						});
						assert.match(JSON.stringify(handoff), /needs_clarification/);
						await tool("request_clarification", {
							question: "Migrate historical records?",
							context: "Only the migration depends on the answer.",
							options: ["Include migration", "Skip migration"],
							sourceAssignmentNumber: 1,
						});
						// The model may still stage output, but a turn waiting for a decision cannot finalize it.
						await tool("save_space_page", {
							type: "document",
							title: "Premature",
							content: "pending",
							changeNote: "pending",
						});
						return completed("Independent planning is complete.");
					},
				};
			},
		});

	let orchestrator = makeOrchestrator();
	const matter = store.createMatter({
		title: "Migration scope",
		orgId: org.id,
		createdByUserId: owner.id,
		leadMemberId: "product-manager",
		aiMemberIds: ["product-manager", "engineering-manager", "qa-manager"],
		consultMemberIds: ["engineering-manager", "qa-manager"],
		observerMemberIds: ["qa-manager"],
		collaboratorIds: [peer.id, viewer.id],
	});
	let server: ReturnType<typeof createPersonalAgentServer>["server"] | undefined;
	async function start() {
		({ server } = createPersonalAgentServer({
			store,
			orchestrator,
			templates,
			dialogBroker,
			previewManager: new PreviewManager(),
			requireAuth: true,
		}));
		await new Promise<void>((ready) => server?.listen(0, "127.0.0.1", ready));
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		return `http://127.0.0.1:${address.port}`;
	}

	try {
		const result = await orchestrator.dispatchMatter({
			matterId: matter.id,
			actorUserId: owner.id,
			prompt: "Plan the release.",
		});
		assert.equal(result.matter.status, "waiting_user");
		assert.equal(store.spaces.listDocuments({ matterId: matter.id }).length, 1);
		assert.equal(allowedDialogs, 0);
		assert.ok(blockedObserver);
		const message = store.listMessages(matter.id, "user").find((item) => readHumanDecision(item.metadata));
		assert.ok(message);
		const decision = readHumanDecision(message.metadata);
		assert.equal(decision?.source?.memberId, "qa-manager");
		assert.equal(decision?.source?.assignmentNumber, 2);
		assert.deepEqual(decision?.requests[0]?.options, ["Include migration", "Skip migration"]);
		assert.equal(decision?.assignedUserId, owner.id);
		const blockedQa = store.listMessages(matter.id, "internal_collab").find((item) => item.senderId === "qa-manager");
		assert.ok(blockedQa?.metadata?.clarification);

		await orchestrator.shutdown();
		db.close();
		db = openPersonalAgentDatabase(databasePath);
		store = new PersonalAgentStore(db);
		orchestrator = makeOrchestrator();
		const base = await start();
		const endpoint = `${base}/api/matters/${matter.id}/messages/${message.id}/human-decision`;
		const send = (session: string, input: unknown) =>
			fetch(endpoint, {
				method: "POST",
				headers: { cookie: session, "Content-Type": "application/json" },
				body: JSON.stringify(input),
			});
		assert.equal((await send(viewerCookie, { action: "answer", revision: 1, answer: "Read only" })).status, 403);
		assert.equal((await send(peerCookie, { action: "answer", revision: 1, answer: "Unassigned" })).status, 403);
		assert.equal((await send(ownerCookie, { action: "assign", revision: 1, assignedUserId: viewer.id })).status, 403);
		assert.equal((await send(ownerCookie, { action: "assign", revision: 1, assignedUserId: peer.id })).status, 200);
		assert.equal((await send(ownerCookie, { action: "answer", revision: 1, answer: "Stale" })).status, 409);
		assert.equal((await send(ownerCookie, { action: "answer", revision: 2, answer: "Unassigned" })).status, 403);
		const responses = await Promise.all(
			["Skip migration", "Include migration"].map((answer) =>
				send(peerCookie, { action: "answer", revision: 2, answer }),
			),
		);
		assert.deepEqual(responses.map(({ status }) => status).sort(), [200, 409]);
		const saved = readHumanDecision(store.getMessage(message.id)?.metadata);
		assert.equal(saved?.status, "answered");
		if (saved?.status !== "answered") throw new Error("Decision was not saved");
		assert.equal(saved.answeredBy.userId, peer.id);
		assert.equal(saved.answeredBy.name, "Peer");
		assert.equal((await send(peerCookie, { action: "resume", revision: 2 })).status, 403);
		assert.equal(
			store.listMessages(matter.id, "user").some((item) => item.metadata?.humanDecisionSourceId === message.id),
			false,
		);
		const firstResume = await send(ownerCookie, { action: "resume", revision: 2 });
		assert.equal(firstResume.status, 200);
		await waitFor(() => store.listMessages(matter.id, "user").find((item) => item.metadata?.failed));
		const retry = await send(ownerCookie, { action: "resume", revision: 2 });
		assert.equal(retry.status, 200);
		assert.equal(((await retry.json()) as { resumed: boolean }).resumed, true);
		await waitFor(() => (orchestrator.isMatterRunning(matter.id) ? null : true));
		const continuations = store
			.listMessages(matter.id, "user")
			.filter((item) => item.metadata?.humanDecisionSourceId === message.id);
		assert.equal(continuations.length, 2);
		for (const attempt of continuations) {
			assert.equal(attempt.content, saved.answer);
			assert.equal(attempt.metadata?.authorName, "Peer");
		}
		assert.ok(reachedSpecialist);
		assert.equal(resumeCount, 2);
		const again = await send(ownerCookie, { action: "resume", revision: 2 });
		assert.equal(again.status, 200);
		assert.equal(((await again.json()) as { resumed: boolean }).resumed, false);
	} finally {
		await orchestrator.shutdown();
		server?.closeAllConnections();
		server?.close();
		db.close();
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("role clarification cannot authorize creation and final confirmation records the applied scope and actor", async () => {
	const tmp = mkdtempSync(join(tmpdir(), "pa-role-decision-"));
	const db = openPersonalAgentDatabase(":memory:");
	const store = new PersonalAgentStore(db);
	const org = store.ensureDefaultOrganization();
	const templates = [...(await loadRoleTemplatesFromDir(resolve("roles"))), BUILTIN_ROLE_ARCHITECT_TEMPLATE];
	const architectOutput = (answered: boolean) =>
		JSON.stringify({
			reply: "Proposed records reviewer",
			followUpQuestions: answered ? [] : ["Should this role edit records?"],
			blueprints: [
				{
					id: "records-reviewer",
					name: "Records Reviewer",
					title: "Records Reviewer",
					oneJob: "Review records",
					workspaceScope: "read_only_repo",
				},
			],
		});
	const orchestrator = new TeamOrchestrator({
		store,
		templates,
		defaultCwd: tmp,
		noSession: true,
		workerFactory: (options) => ({
			start: () => reportReady(options, JSON.parse(options.env?.PA_REQUIRED_TOOLS ?? "[]")),
			stop: async () => {},
			getState: async () => ({ sessionId: crypto.randomUUID() }),
			onNotice: () => () => {},
			setDialogHandler: () => {},
			runPromptAndWait: async (prompt) => completed(architectOutput(prompt.includes("Review only"))),
		}),
	});
	const { server } = createPersonalAgentServer({
		store,
		orchestrator,
		templates,
		dialogBroker: new DialogBroker(),
		previewManager: new PreviewManager(),
		rolesDir: join(tmp, "roles"),
		skillsDir: join(tmp, "skills"),
	});
	try {
		await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		const first = await orchestrator.dispatchMatter({
			prompt: "Create an AI role for reviewing records",
			orgId: org.id,
		});
		const matterId = first.matter.id;
		const drafts = () =>
			store
				.listMessages(matterId, "user")
				.filter(
					(item): item is MatterMessage => item.senderType === "member" && Boolean(item.metadata?.roleProposals),
				);
		const initial = drafts()[0]!;
		const post = (message: MatterMessage, action: string, data: unknown) =>
			fetch(`http://127.0.0.1:${address.port}/api/matters/${matterId}/messages/${message.id}/${action}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(data),
			});
		const creation = {
			action: "apply",
			members: [
				{
					id: "records-reviewer",
					name: "Records Reviewer",
					title: "Records Reviewer",
					responsibilities: "Review records",
					roleScope: "org",
					ownerOrgId: org.id,
					tools: ["read"],
				},
			],
		};
		assert.equal((await post(initial, "apply-role-proposals", creation)).status, 409);
		assert.equal(
			(await post(initial, "human-decision", { action: "answer", answer: "Review only", revision: 1 })).status,
			200,
		);
		const proposed = await waitFor(() => (drafts().length > 1 ? drafts().at(-1) : null));
		assert.equal(
			store.listMembers().some((member) => member.displayName === "Records Reviewer"),
			false,
		);
		assert.equal((await post(initial, "apply-role-proposals", creation)).status, 409);
		const response = await post(proposed, "apply-role-proposals", creation);
		assert.equal(response.status, 200, await response.text());
		const persisted = store.getMessage(proposed.id)?.metadata?.roleProposals as {
			confirmation: { name: string; proposalMessageId: string; roles: unknown[] };
		};
		assert.ok(persisted.confirmation.name);
		assert.equal(persisted.confirmation.proposalMessageId, proposed.id);
		const [newRole] = store.listMembers().filter((member) => member.displayName === "Records Reviewer");
		assert.ok(newRole);
		assert.deepEqual(persisted.confirmation.roles, [
			{
				id: newRole.id,
				name: "Records Reviewer",
				scope: "org",
				orgId: org.id,
				tools: ["read"],
				skills: [],
			},
		]);
		assert.equal((await post(proposed, "apply-role-proposals", creation)).status, 409);
	} finally {
		await orchestrator.shutdown();
		server.closeAllConnections();
		server.close();
		db.close();
		rmSync(tmp, { recursive: true, force: true });
	}
});
