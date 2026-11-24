import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { resolveRoleSkills } from "../packages/server/src/orchestrator/execution-context.ts";
import { type RpcWorkerLike, TeamOrchestrator } from "../packages/server/src/orchestrator/team-orchestrator.ts";
import {
	assessRoleCapabilities,
	listScopedSkillCatalog,
	resolveRoleSkillPath,
} from "../packages/server/src/roles/capabilities.ts";
import { BUILTIN_ROLE_ARCHITECT_TEMPLATE } from "../packages/server/src/roles/role-architect.ts";
import {
	loadRoleTemplatesWithCustomDir,
	serializeRoleTemplateMarkdown,
} from "../packages/server/src/roles/template-loader.ts";
import { createPersonalAgentServer } from "../packages/server/src/server/app.ts";
import { DialogBroker } from "../packages/server/src/server/dialog-broker.ts";
import { PreviewManager } from "../packages/server/src/server/preview-manager.ts";
import { openPersonalAgentDatabase } from "../packages/server/src/storage/database.ts";
import { PersonalAgentStore } from "../packages/server/src/storage/repositories.ts";
import { reportReady } from "./worker-helpers.ts";

function extractCookie(res: Response): string {
	const header = res.headers.get("set-cookie");
	assert.ok(header, "Expected Set-Cookie header");
	return header.split(";")[0]!;
}

test("Scoped loader reads global roles, supports role package dirs, and blocks scope spoofing", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pa-scoped-loader-"));
	try {
		const rolesDir = join(dir, "roles");
		const skillsDir = join(dir, "skills");
		await mkdir(rolesDir, { recursive: true });
		await mkdir(join(rolesDir, "orgs", "org_a", "contract-ops", "skills", "clause-check"), { recursive: true });
		await mkdir(join(rolesDir, "users", "usr_alice", "daily-brief"), { recursive: true });
		await mkdir(join(skillsDir, "users", "usr_alice", "alice-secret"), { recursive: true });
		await mkdir(join(skillsDir, "orgs", "org_a", "org-checklist"), { recursive: true });
		await mkdir(join(skillsDir, "global", "shared-addon"), { recursive: true });

		// Root role -> global
		const builtin = await loadRoleTemplatesWithCustomDir(resolve("roles"));
		const uxTemplate = serializeRoleTemplateMarkdown({
			...builtin[0]!,
			id: "ux-designer",
			name: "UX Designer",
			title: "UX Designer",
			isPrimaryContact: false,
		});
		await writeFile(join(rolesDir, "ux-designer.md"), uxTemplate, "utf8");
		await mkdir(join(rolesDir, "global"));
		await writeFile(
			join(rolesDir, "global", "ux-designer.md"),
			uxTemplate.replace("UX Designer", "Ignored override"),
		);

		// Org role package attempting to spoof roleScope: global inside frontmatter -> forced to org/org_a
		const orgSpoofed = serializeRoleTemplateMarkdown({
			...builtin[0]!,
			id: "contract-ops",
			name: "Contract Ops",
			title: "Contract Ops",
			isPrimaryContact: true,
			roleScope: "global",
			skills: ["skills/clause-check/SKILL.md", "org-checklist", "shared-addon"],
		});
		await writeFile(join(rolesDir, "orgs", "org_a", "contract-ops", "contract-ops.md"), orgSpoofed, "utf8");
		await writeFile(
			join(rolesDir, "orgs", "org_a", "contract-ops", "skills", "clause-check", "SKILL.md"),
			"---\nname: clause-check\ndescription: Check contract clauses\n---\n\n# Clause Check\n",
			"utf8",
		);
		await writeFile(
			join(skillsDir, "orgs", "org_a", "org-checklist", "SKILL.md"),
			"---\nname: org-checklist\ndescription: Org checklist\n---\n\n# Org Checklist\n",
			"utf8",
		);
		await writeFile(
			join(skillsDir, "global", "shared-addon", "SKILL.md"),
			"---\nname: shared-addon\ndescription: Global shared addon\n---\n\n# Shared\n",
			"utf8",
		);
		await writeFile(
			join(skillsDir, "users", "usr_alice", "alice-secret", "SKILL.md"),
			"---\nname: alice-secret\ndescription: Alice private SOP\n---\n\n# Alice\n",
			"utf8",
		);

		// Personal role attempting to override built-in product-manager ID -> ignored by loader!
		const builtinOverrideSpoof = serializeRoleTemplateMarkdown({
			...builtin[0]!,
			id: "product-manager",
			name: "Evil PM",
			title: "Product Manager",
		});
		await writeFile(join(rolesDir, "users", "usr_alice", "product-manager.md"), builtinOverrideSpoof, "utf8");

		const loaded = await loadRoleTemplatesWithCustomDir(resolve("roles"), rolesDir);
		const ux = loaded.find((t) => t.id === "ux-designer");
		assert.equal(ux?.roleScope, "global");
		assert.equal(ux?.name, "UX Designer");
		assert.equal(ux?.ownerOrgId ?? null, null);
		assert.equal(ux?.ownerUserId ?? null, null);

		const pm = loaded.find((t) => t.id === "product-manager");
		assert.notEqual(pm?.name, "Evil PM");
		assert.equal(pm?.roleScope, "global");

		const contract = loaded.find((t) => t.id === "contract-ops");
		assert.equal(contract?.roleScope, "org");
		assert.equal(contract?.ownerOrgId, "org_a");
		assert.equal(contract?.isPrimaryContact, false);
		assert.deepEqual(
			(await assessRoleCapabilities(contract!, { skillsDir })).skills.map((s) => s.state),
			["file_present", "file_present", "file_present"],
		);
		assert.equal((await resolveRoleSkills(contract!, { skillsDir })).length, 3);

		// Cross-scope skill containment checks
		const orgCatalog = await listScopedSkillCatalog({
			skillsDir,
			roleScope: "org",
			ownerOrgId: "org_a",
			ownerUserId: null,
		});
		assert.ok(orgCatalog.some((s) => s.name === "org-checklist"));
		assert.ok(orgCatalog.some((s) => s.name === "shared-addon"));
		assert.ok(!orgCatalog.some((s) => s.name === "alice-secret"));

		const orgBBadSkill = await assessRoleCapabilities(
			{
				...contract!,
				id: "orgb-role",
				ownerOrgId: "org_b",
				skills: ["org-checklist", "alice-secret", "../../etc/passwd", "/etc/passwd"],
			},
			{ skillsDir },
		);
		assert.deepEqual(
			orgBBadSkill.skills.map((s) => s.state),
			["missing", "missing", "missing", "missing"],
		);

		assert.throws(() => resolveRoleSkillPath("../../etc/passwd", contract), /Unsafe/);
		assert.throws(() => resolveRoleSkillPath("/etc/passwd", contract), /Unsafe/);

		// Symlink outside scope root must be blocked at runtime execution check
		const escapedSkillDir = join(rolesDir, "orgs", "org_a", "contract-ops", "skills", "evil-link");
		const outsideFile = join(dir, "outside.md");
		await writeFile(outsideFile, "secret host file", "utf8");
		await mkdir(escapedSkillDir, { recursive: true });
		await symlink(outsideFile, join(escapedSkillDir, "SKILL.md"));
		await assert.rejects(
			() => resolveRoleSkills({ ...contract!, skills: ["skills/evil-link/SKILL.md"] }, { skillsDir }),
			/outside allowed skill scope boundaries/,
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("Multi-tenant Role Architect, confirmed-only New Skills disk creation, personal quota, and strict user isolation", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pa-scoped-roles-mt-"));
	const db = openPersonalAgentDatabase(join(dir, "agent.db"));
	const store = new PersonalAgentStore(db);
	const rolesDir = join(dir, "roles");
	const skillsDir = join(dir, "skills");
	const loadedBuiltin = await loadRoleTemplatesWithCustomDir(resolve("roles"));
	const templates = [...loadedBuiltin, BUILTIN_ROLE_ARCHITECT_TEMPLATE];
	const capturedSkillArgs: string[][] = [];

	const orchestrator = new TeamOrchestrator({
		store,
		templates,
		defaultCwd: dir,
		skillsDir,
		noSession: true,
		workerFactory: (workerOptions) => {
			capturedSkillArgs.push(workerOptions.args ?? []);
			return {
				start: async () => {
					if (workerOptions.env?.PA_TEAM_BRIDGE_URL) {
						await reportReady(workerOptions);
					}
				},
				stop: async () => {},
				onNotice: () => () => {},
				setDialogHandler: () => {},
				getState: async () => ({ sessionId: "s-scoped" }),
				runPromptAndWait: async (promptText: string) => {
					if (promptText.includes("Role Architect") || promptText.includes("Typed Role Designer")) {
						if (promptText.includes('"verificationPlan"')) {
							return {
								disposition: "started",
								aborted: false,
								assistantText: JSON.stringify({
									id: "note-coach",
									name: "Note Coach",
									title: "Note Coach",
									oneJob: "Summarize personal weekly engineering notes.",
									antiJobs: ["Do not modify repository files or run commands"],
									quietWhen: "Return [SILENT] when not addressed",
									keywords: ["weekly", "notes"],
									skills: ["deliverable-writing"],
									newSkills: [
										{
											name: "note-digest-sop",
											description: "Personal weekly engineering digest checklist",
											body: "# Note Digest SOP\n\n1. Group accomplishments by project.",
											storageScope: "role_local",
										},
									],
									interactionStyle: "lead_direct",
									workspaceScope: "no_repo_docs",
									communicationStyle: "Bullet summary first",
									verificationPlan: {
										task: "Summarize sample notes",
										successCriteria: "Produces three grouped bullets",
										boundaryCheck: "Runs with zero write tools",
									},
									designRationale: "Personal productivity assistant.",
								}),
								assistantMessages: [],
								toolExecutions: [],
								notices: [],
								dialogs: [],
								events: [],
							};
						}
						return {
							disposition: "started",
							aborted: false,
							assistantText: JSON.stringify({
								reply: "已生成个人助手草案与配套新 Skill 草案。",
								followUpQuestions: [],
								blueprints: [
									{
										id: "weekly-helper",
										name: "Weekly Helper",
										title: "Weekly Helper",
										oneJob: "Draft concise weekly status recaps for one member.",
										antiJobs: ["Do not edit code or publish to shared org channels automatically"],
										skills: ["deliverable-writing"],
										newSkills: [
											{
												name: "weekly-template",
												description: "Weekly recap structure checklist",
												body: "# Weekly Template\n\n- Highlights\n- Next steps",
												storageScope: "role_local",
											},
										],
										interactionStyle: "lead_direct",
										workspaceScope: "no_repo_docs",
										verificationPlan: "Summarize 2 notes without mutating files",
										rationale: "Lightweight personal recap specialist",
									},
								],
							}),
							assistantMessages: [],
							toolExecutions: [],
							notices: [],
							dialogs: [],
							events: [],
						};
					}
					return {
						disposition: "started",
						aborted: false,
						assistantText: "已完成私人整理回复。",
						assistantMessages: [],
						toolExecutions: [],
						notices: [],
						dialogs: [],
						events: [],
					};
				},
			} as unknown as RpcWorkerLike;
		},
	});

	const { server } = createPersonalAgentServer({
		store,
		orchestrator,
		templates,
		rolesDir,
		skillsDir,
		uploadsDir: join(dir, "uploads"),
		defaultWorkspacesRoot: join(dir, "workspaces"),
		dataDir: dir,
		requireAuth: true,
		dialogBroker: new DialogBroker(),
		previewManager: new PreviewManager(),
	});

	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
	const port = (server.address() as AddressInfo).port;
	const base = `http://127.0.0.1:${port}`;

	try {
		// 1. Setup super_admin + 2 orgs + org_admin + org_member Alice & Bob + org_viewer Victor
		const setupRes = await fetch(`${base}/api/auth/setup-admin`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: "root@platform.test",
				password: "RootPassword123!",
				displayName: "Root Admin",
			}),
		});
		assert.equal(setupRes.status, 201);
		const adminLogin = await fetch(`${base}/api/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "root@platform.test", password: "RootPassword123!" }),
		});
		const adminCookie = extractCookie(adminLogin);

		const orgARes = await fetch(`${base}/api/organizations`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: adminCookie },
			body: JSON.stringify({ name: "Org Alpha", gitEmailDomain: "alpha.test" }),
		});
		const orgAId = ((await orgARes.json()) as { organization: { id: string } }).organization.id;

		const orgBRes = await fetch(`${base}/api/organizations`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: adminCookie },
			body: JSON.stringify({ name: "Org Beta", gitEmailDomain: "beta.test" }),
		});
		const orgBId = ((await orgBRes.json()) as { organization: { id: string } }).organization.id;

		const registerAndApprove = async (email: string, name: string, orgId: string, role: string) => {
			const user = store.createUser({ email, displayName: name, password: "UserPass123!", status: "active" });
			store.upsertOrgMember({ orgId, userId: user.id, orgRole: role as "org_admin" | "org_member" | "org_viewer" });
			const login = await fetch(`${base}/api/auth/login`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email, password: "UserPass123!" }),
			});
			return { user, cookie: extractCookie(login) };
		};

		const orgAdminA = await registerAndApprove("admin-a@alpha.test", "Admin A", orgAId, "org_admin");
		const alice = await registerAndApprove("alice@alpha.test", "Alice", orgAId, "org_member");
		const bob = await registerAndApprove("bob@alpha.test", "Bob", orgAId, "org_member");
		const victor = await registerAndApprove("victor@alpha.test", "Victor", orgAId, "org_viewer");
		const orgAdminB = await registerAndApprove("admin-b@beta.test", "Admin B", orgBId, "org_admin");

		// Configure Org A AI roles (so we verify personal role still works when org AI roles are restricted)
		await fetch(`${base}/api/organizations/${orgAId}/ai-roles`, {
			method: "PUT",
			headers: { "Content-Type": "application/json", Cookie: orgAdminA.cookie },
			body: JSON.stringify({
				roles: [{ memberId: "product-manager", enabled: true, isPrimaryContact: true }],
			}),
		});

		// 2. Super admin configures defaultMaxPersonalRoles and tightens Alice's quota to 2
		const settingsRes = await fetch(`${base}/api/admin/settings`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Cookie: adminCookie },
			body: JSON.stringify({ defaultMaxPersonalRoles: 4 }),
		});
		assert.equal(settingsRes.status, 200);
		assert.equal(
			((await settingsRes.json()) as { settings: { defaultMaxPersonalRoles: number } }).settings
				.defaultMaxPersonalRoles,
			4,
		);

		const quotaRes = await fetch(`${base}/api/admin/users/${alice.user.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Cookie: adminCookie },
			body: JSON.stringify({ maxPersonalRoles: 2 }),
		});
		assert.equal(quotaRes.status, 200);
		assert.equal(((await quotaRes.json()) as { user: { maxPersonalRoles: number } }).user.maxPersonalRoles, 2);

		// 3. org_viewer Victor is blocked from role design, architect chat, role creation & import
		assert.equal(
			(
				await fetch(`${base}/api/members/design`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Cookie: victor.cookie },
					body: JSON.stringify({ oneJob: "Help me", roleScope: "personal" }),
				})
			).status,
			403,
		);
		assert.equal(
			(
				await fetch(`${base}/api/members/architect/chat`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Cookie: victor.cookie },
					body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], roleScope: "personal" }),
				})
			).status,
			403,
		);
		assert.equal(
			(
				await fetch(`${base}/api/members`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Cookie: victor.cookie },
					body: JSON.stringify({ name: "ViewerBot", title: "ViewerBot", roleScope: "personal" }),
				})
			).status,
			403,
		);

		// 4. org_member Alice gets model Role Design + Architect Chat drafts with proposed newSkills WITHOUT writing disk
		const designModelRes = await fetch(`${base}/api/members/design`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: alice.cookie },
			body: JSON.stringify({
				oneJob: "Summarize my weekly notes",
				roleScope: "personal",
				mode: "model",
			}),
		});
		assert.equal(designModelRes.status, 200);
		const modelDraft = (await designModelRes.json()) as {
			template: { id: string; roleScope: string };
			newSkills?: Array<{ name: string; description: string; body: string; storageScope: string }>;
		};
		assert.equal(modelDraft.template.roleScope, "personal");
		assert.equal(modelDraft.newSkills?.[0]?.name, "note-digest-sop");
		assert.equal(existsSync(join(rolesDir, "users", alice.user.id)), false);

		const designRulesRes = await fetch(`${base}/api/members/design`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: alice.cookie },
			body: JSON.stringify({
				oneJob: "Summarize my weekly notes",
				roleScope: "personal",
				mode: "rules",
			}),
		});
		assert.equal(designRulesRes.status, 200);
		const rulesDraft = (await designRulesRes.json()) as {
			template: { roleScope: string };
			newSkills?: Array<{ name: string; storageScope: string }>;
		};
		assert.equal(rulesDraft.template.roleScope, "personal");
		assert.ok((rulesDraft.newSkills?.length ?? 0) >= 1, "Rules design should propose an optional newSkill draft");
		assert.equal(rulesDraft.newSkills?.[0]?.storageScope, "role_local");
		assert.equal(existsSync(join(rolesDir, "users", alice.user.id)), false);

		const chatRes = await fetch(`${base}/api/members/architect/chat`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: alice.cookie },
			body: JSON.stringify({
				messages: [{ role: "user", content: "给我规划一个个人周报角色" }],
				roleScope: "personal",
			}),
		});
		assert.equal(chatRes.status, 200);
		const chatResult = (await chatRes.json()) as {
			blueprints: Array<{ draft: { template: { id: string }; newSkills?: Array<{ name: string }> } }>;
		};
		assert.equal(chatResult.blueprints[0]?.draft.newSkills?.[0]?.name, "weekly-template");
		assert.equal(existsSync(join(rolesDir, "users", alice.user.id)), false);

		// 5. Alice tries illegal scopes/privileges -> rejected 403 / 400
		assert.equal(
			(
				await fetch(`${base}/api/members`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Cookie: alice.cookie },
					body: JSON.stringify({ name: "GlobalHack", title: "Global Hack", roleScope: "global" }),
				})
			).status,
			403,
		);
		assert.equal(
			(
				await fetch(`${base}/api/members`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Cookie: alice.cookie },
					body: JSON.stringify({ name: "OrgHack", title: "Org Hack", roleScope: "org", ownerOrgId: orgAId }),
				})
			).status,
			403,
		);
		assert.equal(
			(
				await fetch(`${base}/api/members`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Cookie: alice.cookie },
					body: JSON.stringify({
						name: "SkillScopeHack",
						title: "Skill Scope Hack",
						roleScope: "personal",
						newSkills: [
							{
								name: "evil-global-skill",
								description: "desc",
								body: "# Bad",
								storageScope: "global",
							},
						],
					}),
				})
			).status,
			400,
		);

		const duplicateDraft = {
			name: "duplicate-batch-skill",
			description: "Draft checklist",
			body: "# Draft checklist",
			storageScope: "personal",
		};
		const duplicateBatch = await fetch(`${base}/api/members/batch`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: alice.cookie },
			body: JSON.stringify({
				members: ["draft-one", "draft-two"].map((id) => ({
					id,
					name: id,
					title: id,
					roleScope: "personal",
					newSkills: [duplicateDraft],
				})),
			}),
		});
		assert.equal(duplicateBatch.status, 409);
		assert.equal(existsSync(join(skillsDir, "users", alice.user.id, duplicateDraft.name, "SKILL.md")), false);
		assert.ok(
			!store.listMembers().some((entry) => entry.displayName === "draft-one" || entry.displayName === "draft-two"),
		);

		// 6. Alice confirms creating her personal role #1 with confirmed role_local Skill + personal shared Skill!
		const createAlice1 = await fetch(`${base}/api/members`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: alice.cookie },
			body: JSON.stringify({
				id: modelDraft.template.id,
				name: "Note Coach",
				title: "Note Coach",
				roleScope: "personal",
				skills: ["deliverable-writing"],
				mcpDependencies: ["alice-private-mcp"],
				newSkills: [
					modelDraft.newSkills![0],
					{
						name: "alice-personal-lib",
						description: "Alice reusable personal checklist",
						body: "# Personal Lib\n\n1. Be concise.",
						storageScope: "personal",
					},
				],
			}),
		});
		assert.equal(createAlice1.status, 201);
		const aliceRole1 = (
			(await createAlice1.json()) as {
				member: { id: string; roleScope: string; ownerUserId: string };
			}
		).member;
		assert.equal(aliceRole1.roleScope, "personal");
		assert.equal(aliceRole1.ownerUserId, alice.user.id);
		assert.ok(existsSync(join(rolesDir, "users", alice.user.id, aliceRole1.id, `${aliceRole1.id}.md`)));
		assert.ok(
			existsSync(join(rolesDir, "users", alice.user.id, aliceRole1.id, "skills", "note-digest-sop", "SKILL.md")),
		);
		const personalSkill = join(skillsDir, "users", alice.user.id, "alice-personal-lib", "SKILL.md");
		const originalSkill = await readFile(personalSkill, "utf8");
		const conflict = await fetch(`${base}/api/members`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: alice.cookie },
			body: JSON.stringify({
				id: "conflicting-role",
				name: "Conflicting Role",
				title: "Conflicting Role",
				roleScope: "personal",
				newSkills: [
					{ ...duplicateDraft, name: "unwritten-skill" },
					{ ...duplicateDraft, name: "alice-personal-lib" },
				],
			}),
		});
		assert.equal(conflict.status, 409);
		assert.equal(await readFile(personalSkill, "utf8"), originalSkill);
		assert.equal(existsSync(join(skillsDir, "users", alice.user.id, "unwritten-skill", "SKILL.md")), false);
		assert.ok(!store.listMembers().some((entry) => entry.displayName === "Conflicting Role"));

		// Create Alice personal role #2 (single .md without role_local skills) + verify 3rd hits quota 403
		const createAlice2 = await fetch(`${base}/api/members`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: alice.cookie },
			body: JSON.stringify({
				id: "reading-helper",
				name: "Reading Helper",
				title: "Reading Helper",
				roleScope: "personal",
			}),
		});
		assert.equal(createAlice2.status, 201);
		const aliceRole2Id = ((await createAlice2.json()) as { member: { id: string } }).member.id;

		const createAlice3 = await fetch(`${base}/api/members`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: alice.cookie },
			body: JSON.stringify({
				id: "third-personal",
				name: "Third Role",
				title: "Third Role",
				roleScope: "personal",
			}),
		});
		assert.equal(createAlice3.status, 403);

		// 7. Strict Personal Role Isolation: Bob, Org Admin A, AND Super Admin cannot see or touch Alice's personal role
		for (const otherCookie of [bob.cookie, orgAdminA.cookie, adminCookie]) {
			const boot = (await (await fetch(`${base}/api/bootstrap`, { headers: { Cookie: otherCookie } })).json()) as {
				members: Array<{ id: string }>;
				templates: Array<{ id: string }>;
			};
			assert.ok(!boot.members.some((m) => m.id === aliceRole1.id), "Other actor bootstrap leaked personal member");
			assert.ok(
				!boot.templates.some((t) => t.id === aliceRole1.id),
				"Other actor bootstrap leaked personal template",
			);

			const rt = (await (await fetch(`${base}/api/runtime`, { headers: { Cookie: otherCookie } })).json()) as {
				extensions: Array<{ id: string; declaredByRoles?: string[]; mcpServers?: string[] }>;
			};
			const mcpExt = rt.extensions.find((ext) => ext.id === "pi-builtin-mcp");
			assert.ok(mcpExt, "Expected pi-builtin-mcp extension item in /api/runtime");
			assert.ok(
				!(mcpExt.mcpServers ?? []).includes("alice-private-mcp"),
				"Other actor runtime leaked personal MCP server",
			);
			assert.ok(
				!(mcpExt.declaredByRoles ?? []).includes("Note Coach"),
				"Other actor runtime leaked personal declaredByRoles",
			);

			assert.equal(
				(await fetch(`${base}/api/members/${aliceRole1.id}/export`, { headers: { Cookie: otherCookie } })).status,
				403,
			);
			assert.equal(
				(
					await fetch(`${base}/api/members/${aliceRole1.id}`, {
						method: "PATCH",
						headers: { "Content-Type": "application/json", Cookie: otherCookie },
						body: JSON.stringify({ displayName: "Hijacked" }),
					})
				).status,
				403,
			);
			assert.equal(
				(
					await fetch(`${base}/api/members/${aliceRole1.id}`, {
						method: "DELETE",
						headers: { Cookie: otherCookie },
					})
				).status,
				403,
			);
		}

		// Bob cannot use Alice's personal role in matters or assess, AND org AI roles endpoint refuses personal roles
		assert.equal(
			(
				await fetch(`${base}/api/matters`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Cookie: bob.cookie },
					body: JSON.stringify({ prompt: "use alice bot", orgId: orgAId, preferredMemberId: aliceRole1.id }),
				})
			).status,
			403,
		);
		assert.equal(
			(
				await fetch(`${base}/api/organizations/${orgAId}/ai-roles`, {
					method: "PUT",
					headers: { "Content-Type": "application/json", Cookie: orgAdminA.cookie },
					body: JSON.stringify({
						roles: [
							{ memberId: "product-manager", enabled: true, isPrimaryContact: true },
							{ memberId: aliceRole1.id, enabled: true },
						],
					}),
				})
			).status,
			400,
		);
		assert.ok(!store.resolveEffectiveOrgMembers(orgAId).some((m) => m.id === aliceRole1.id));

		// 8. Alice CAN dispatch her own personal role in Org A and it loads her role_local + personal SKILL.md paths!
		capturedSkillArgs.length = 0;
		const aliceDispatch = await fetch(`${base}/api/matters`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: alice.cookie },
			body: JSON.stringify({
				prompt: "整理我的周报笔记",
				orgId: orgAId,
				visibility: "private",
				preferredMemberId: aliceRole1.id,
			}),
		});
		assert.equal(aliceDispatch.status, 202);
		const aliceMatterId = ((await aliceDispatch.json()) as { matter: { id: string } }).matter.id;
		for (let i = 0; i < 80; i++) {
			const detail = (await (
				await fetch(`${base}/api/matters/${aliceMatterId}`, { headers: { Cookie: alice.cookie } })
			).json()) as { activeRun: unknown };
			if (capturedSkillArgs.length > 0 && !detail.activeRun) break;
			await new Promise((r) => setTimeout(r, 25));
		}
		assert.ok(capturedSkillArgs.length > 0);
		const argsJoined = capturedSkillArgs[0]!.join(" ");
		assert.ok(argsJoined.includes("note-digest-sop/SKILL.md"));
		assert.ok(argsJoined.includes("alice-personal-lib/SKILL.md"));
		const workerCount = capturedSkillArgs.length;
		const distillation = await fetch(`${base}/api/rsi/distill`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: adminCookie },
			body: JSON.stringify({ matterId: aliceMatterId }),
		});
		assert.equal(distillation.status, 403);
		assert.equal(capturedSkillArgs.length, workerCount, "Personal role review must stop before worker creation");
		const aliceRt = (await (await fetch(`${base}/api/runtime`, { headers: { Cookie: alice.cookie } })).json()) as {
			extensions: Array<{ id: string; declaredByRoles?: string[]; mcpServers?: string[] }>;
		};
		const aliceMcp = aliceRt.extensions.find((ext) => ext.id === "pi-builtin-mcp");
		assert.ok(aliceMcp?.mcpServers?.includes("alice-private-mcp"));
		assert.ok(aliceMcp?.declaredByRoles?.includes("Note Coach"));

		// 9. Org Admin creates org-scoped role in Org A (with role-local skill) -> Org B admin cannot see/use/manage it
		const createOrgRole = await fetch(`${base}/api/members`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: orgAdminA.cookie },
			body: JSON.stringify({
				id: "alpha-qa",
				name: "Alpha QA",
				title: "Alpha QA",
				roleScope: "org",
				ownerOrgId: orgAId,
				newSkills: [
					{
						name: "alpha-gate",
						description: "Org Alpha release gate",
						body: "# Alpha Gate\n\n- Run tests.",
						storageScope: "org",
					},
				],
			}),
		});
		assert.equal(createOrgRole.status, 201);
		const orgRole = ((await createOrgRole.json()) as { member: { id: string; roleScope: string } }).member;
		assert.ok(existsSync(join(rolesDir, "orgs", orgAId, `${orgRole.id}.md`)));
		assert.ok(existsSync(join(skillsDir, "orgs", orgAId, "alpha-gate", "SKILL.md")));

		const bootB = (await (
			await fetch(`${base}/api/bootstrap`, { headers: { Cookie: orgAdminB.cookie } })
		).json()) as {
			members: Array<{ id: string }>;
		};
		assert.ok(!bootB.members.some((m) => m.id === orgRole.id));
		assert.equal(
			(await fetch(`${base}/api/members/${orgRole.id}`, { method: "DELETE", headers: { Cookie: orgAdminB.cookie } }))
				.status,
			403,
		);
		// Cannot create role into Org Beta using Org Alpha admin session
		assert.equal(
			(
				await fetch(`${base}/api/members`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Cookie: orgAdminA.cookie },
					body: JSON.stringify({ name: "CrossOrg", title: "Cross Org", roleScope: "org", ownerOrgId: orgBId }),
				})
			).status,
			403,
		);

		// Cannot promote non-global role to global primary contact
		assert.equal(
			(
				await fetch(`${base}/api/members/${orgRole.id}/primary`, {
					method: "POST",
					headers: { Cookie: adminCookie },
				})
			).status,
			400,
		);

		// 10. Malicious markdown import trying scope escalation + skill path traversal
		const evilMd = [
			"---",
			"id: evil-import",
			"name: Evil Import",
			"title: Evil Import",
			"roleScope: global",
			"version: 1.0.0",
			"shareable: true",
			"defaultProvider: kimi-coding",
			"defaultModel: kimi-for-coding",
			"thinkingLevel: low",
			"isPrimaryContact: true",
			"keywords: [evil]",
			"tools: [read]",
			"skills: [../../etc/passwd]",
			"mcpDependencies: []",
			"---",
			"",
			"## Responsibilities and Boundaries",
			"- Evil",
		].join("\n");
		assert.equal(
			(
				await fetch(`${base}/api/members/import`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Cookie: bob.cookie },
					body: JSON.stringify({ markdown: evilMd, roleScope: "personal" }),
				})
			).status,
			400,
		);
		// Clean markdown claiming roleScope: global imported by Bob -> forced to Bob's personal scope!
		const cleanMd = evilMd.replace("skills: [../../etc/passwd]", "skills: [deliverable-writing]");
		const importBob = await fetch(`${base}/api/members/import`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: bob.cookie },
			body: JSON.stringify({ markdown: cleanMd, roleScope: "personal" }),
		});
		assert.equal(importBob.status, 201);
		const importedBob = (
			(await importBob.json()) as {
				member: { id: string; roleScope: string; ownerUserId: string; isPrimaryContact: boolean };
			}
		).member;
		assert.equal(importedBob.roleScope, "personal");
		assert.equal(importedBob.ownerUserId, bob.user.id);
		assert.equal(importedBob.isPrimaryContact, false);

		// 11. Deleting Alice's unused personal role #2 removes its disk file; wait for turn and verify package deletion works cleanly
		const delRes2 = await fetch(`${base}/api/members/${aliceRole2Id}`, {
			method: "DELETE",
			headers: { Cookie: alice.cookie },
		});
		assert.equal(delRes2.status, 200);
		assert.equal(existsSync(join(rolesDir, "users", alice.user.id, `${aliceRole2Id}.md`)), false);
		const delOrgRole = await fetch(`${base}/api/members/${orgRole.id}`, {
			method: "DELETE",
			headers: { Cookie: orgAdminA.cookie },
		});
		assert.equal(delOrgRole.status, 200);
		assert.equal(existsSync(join(rolesDir, "orgs", orgAId, `${orgRole.id}.md`)), false);

		// Confirm org_member can apply a role proposal with confirmed newSkills via /api/matters/:id/messages/:messageId/apply-role-proposals
		const proposalMsg = store.appendMessage({
			matterId: aliceMatterId,
			channel: "user",
			senderType: "member",
			senderId: aliceRole1.id,
			content: "建议新增个人整理助手",
			metadata: { roleProposals: { status: "pending" } },
		});
		const applyProposalRes = await fetch(
			`${base}/api/matters/${aliceMatterId}/messages/${proposalMsg.id}/apply-role-proposals`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json", Cookie: alice.cookie },
				body: JSON.stringify({
					action: "apply",
					matterJoinMode: "consult",
					members: [
						{
							id: "proposal-researcher",
							name: "Personal Researcher",
							title: "Personal Researcher",
							roleScope: "personal",
							responsibilities: ["Collect and structure private notes"],
							keywords: ["notes", "summary"],
							skills: ["deliverable-writing"],
							newSkills: [
								{
									name: "proposal-digest",
									description: "Confirmed digest template from proposal card",
									body: "# Proposal Digest\n\n- Summarize key points.",
									storageScope: "role_local",
								},
							],
						},
					],
				}),
			},
		);
		assert.equal(applyProposalRes.status, 200);
		const appliedPayload = (await applyProposalRes.json()) as {
			createdMembers: Array<{ id: string; roleScope: string }>;
		};
		assert.equal(appliedPayload.createdMembers.length, 1);
		assert.equal(appliedPayload.createdMembers[0]?.roleScope, "personal");
		const appliedRoleId = appliedPayload.createdMembers[0]!.id;
		assert.ok(existsSync(join(rolesDir, "users", alice.user.id, appliedRoleId, `${appliedRoleId}.md`)));
		assert.ok(
			existsSync(join(rolesDir, "users", alice.user.id, appliedRoleId, "skills", "proposal-digest", "SKILL.md")),
		);

		// Confirm Note Coach exported package stays clean and reloadable
		const aliceExport = await fetch(`${base}/api/members/${aliceRole1.id}/export`, {
			headers: { Cookie: alice.cookie },
		});
		assert.equal(aliceExport.status, 200);
		const exportedBody = (await aliceExport.json()) as { markdown: string };
		assert.match(exportedBody.markdown, /skills\/note-digest-sop\/SKILL\.md/);
		const skillOnDisk = await readFile(
			join(rolesDir, "users", alice.user.id, aliceRole1.id, "skills", "note-digest-sop", "SKILL.md"),
			"utf8",
		);
		assert.match(skillOnDisk, /name: note-digest-sop/);

		// 12. Regression: non-superAdmin session user who owns/belongs to an org can start Role Architect (even if orgId: null is sent)
		store.createUser({
			email: "orphan@test.local",
			displayName: "Orphan",
			password: "UserPass123!",
			status: "active",
		});
		const orphanLogin = await fetch(`${base}/api/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "orphan@test.local", password: "UserPass123!" }),
		});
		const orphanCookie = extractCookie(orphanLogin);
		assert.equal(
			(
				await fetch(`${base}/api/matters`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Cookie: orphanCookie },
					body: JSON.stringify({
						mode: "dispatch",
						prompt: "No org yet",
						preferredMemberId: BUILTIN_ROLE_ARCHITECT_TEMPLATE.id,
						aiMemberIds: [BUILTIN_ROLE_ARCHITECT_TEMPLATE.id],
						orgId: null,
					}),
				})
			).status,
			403,
		);
		const orphanOrgRes = await fetch(`${base}/api/organizations`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: orphanCookie },
			body: JSON.stringify({ name: "civa-team" }),
		});
		assert.equal(orphanOrgRes.status, 201);
		const orphanOrgId = ((await orphanOrgRes.json()) as { organization: { id: string } }).organization.id;
		const architectCreateRes = await fetch(`${base}/api/matters`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: orphanCookie },
			body: JSON.stringify({
				mode: "dispatch",
				prompt: "提供一个 github ci 检查的角色",
				preferredMemberId: BUILTIN_ROLE_ARCHITECT_TEMPLATE.id,
				aiMemberIds: [BUILTIN_ROLE_ARCHITECT_TEMPLATE.id],
				observersEnabled: false,
				observerMemberIds: [],
				orgId: null,
			}),
		});
		assert.equal(architectCreateRes.status, 202);
		const architectMatter = ((await architectCreateRes.json()) as { matter: { id: string; orgId: string | null } })
			.matter;
		assert.equal(architectMatter.orgId, orphanOrgId);
		for (let i = 0; i < 80; i++) {
			const detail = (await (
				await fetch(`${base}/api/matters/${architectMatter.id}`, { headers: { Cookie: orphanCookie } })
			).json()) as { activeRun: unknown };
			if (!detail.activeRun) break;
			await new Promise((r) => setTimeout(r, 25));
		}
	} finally {
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		await orchestrator.shutdown();
		db.close();
		await rm(dir, { recursive: true, force: true });
	}
});
