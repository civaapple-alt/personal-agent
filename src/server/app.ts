import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, resolve } from "node:path";
import type { DispatchMatterResult, TeamOrchestrator } from "../orchestrator/team-orchestrator.ts";
import { parseRoleTemplateMarkdown, serializeRoleTemplateMarkdown } from "../roles/template-loader.ts";
import type { RoleTemplate } from "../roles/types.ts";
import type { RpcExtensionUIResponsePayload, ThinkingLevel } from "../rpc/types.ts";
import type { PersonalAgentStore } from "../storage/repositories.ts";
import type { DeliverableType, MemoryScope } from "../storage/types.ts";
import type { DialogBroker } from "./dialog-broker.ts";
import type { PreviewManager } from "./preview-manager.ts";

export interface PersonalAgentServerOptions {
	store: PersonalAgentStore;
	orchestrator: TeamOrchestrator;
	templates: RoleTemplate[];
	previewManager: PreviewManager;
	dialogBroker: DialogBroker;
	webDistDir?: string;
	rolesDir?: string;
}

const MIME_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
};

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
	}
	const raw = Buffer.concat(chunks).toString("utf8").trim();
	if (raw.length === 0) return {};
	const parsed = JSON.parse(raw) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Request body must be a JSON object");
	}
	return parsed as Record<string, unknown>;
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
	const body = JSON.stringify(data);
	res.writeHead(statusCode, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(body),
	});
	res.end(body);
}

function sendError(res: ServerResponse, statusCode: number, message: string): void {
	sendJson(res, statusCode, { error: message });
}

function formatMemoryMap(store: PersonalAgentStore): Record<string, unknown[]> {
	const result: Record<string, unknown[]> = {};
	for (const member of store.listMembers()) {
		result[member.id] = store.listRelevantMemories(member.id, null);
	}
	return result;
}

/**
 * Create the Phase 3 HTTP + SSE server backing the V4 workbench UI.
 */
export function createPersonalAgentServer(options: PersonalAgentServerOptions): {
	server: Server;
	broadcast: (eventName: string, payload: unknown) => void;
} {
	const { store, orchestrator, previewManager, dialogBroker, webDistDir, rolesDir } = options;
	const sseClients = new Set<ServerResponse>();

	const broadcast = (eventName: string, payload: unknown) => {
		const frame = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
		for (const client of [...sseClients]) {
			if (client.destroyed || client.writableEnded) {
				sseClients.delete(client);
				continue;
			}
			client.write(frame);
		}
	};

	const offDialog = dialogBroker.onEvent((evt) => {
		broadcast(evt.type, evt);
	});

	const runDispatchInBackground = (input: {
		matterId: string;
		title?: string;
		prompt: string;
		preferredMemberId?: string;
		workspaceId?: string;
		deliverableTitle?: string;
		deliverableType?: DeliverableType;
	}) => {
		broadcast("matter_started", { matterId: input.matterId });
		void orchestrator
			.dispatchMatter({
				matterId: input.matterId,
				title: input.title,
				prompt: input.prompt,
				preferredMemberId: input.preferredMemberId,
				workspaceId: input.workspaceId,
				deliverableTitle: input.deliverableTitle,
				deliverableType: input.deliverableType,
				onTextDelta: (delta) => {
					broadcast("text_delta", { matterId: input.matterId, delta });
				},
				onProgress: (progress) => {
					broadcast("matter_progress", { matterId: input.matterId, ...progress });
				},
			})
			.then((result: DispatchMatterResult) => {
				broadcast("matter_settled", {
					matterId: result.matter.id,
					matter: result.matter,
					deliverable: result.deliverable,
					assignedMemberId: result.assignedMember.id,
				});
			})
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				store.appendMessage({
					matterId: input.matterId,
					channel: "notice",
					senderType: "system",
					senderId: "orchestrator",
					content: JSON.stringify({ method: "error", message }),
				});
				store.updateMatterStatus(input.matterId, "open");
				broadcast("matter_failed", { matterId: input.matterId, error: message });
			});
	};

	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const method = req.method ?? "GET";
		const pathname = url.pathname;

		try {
			if (method === "GET" && pathname === "/api/events") {
				res.writeHead(200, {
					"Content-Type": "text/event-stream; charset=utf-8",
					"Cache-Control": "no-cache, no-transform",
					Connection: "keep-alive",
				});
				res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);
				sseClients.add(res);
				const heartbeat = setInterval(() => {
					if (!res.destroyed && !res.writableEnded) {
						res.write(": ping\n\n");
					}
				}, 15000);
				req.on("close", () => {
					clearInterval(heartbeat);
					sseClients.delete(res);
				});
				return;
			}

			if (method === "GET" && pathname === "/api/bootstrap") {
				const liveTemplates = orchestrator.listTemplates();
				sendJson(res, 200, {
					members: store.listMembers(),
					templates: liveTemplates.map((t) => ({
						id: t.id,
						name: t.name,
						title: t.title,
						version: t.version,
						skills: t.skills,
						tools: t.tools,
						keywords: t.keywords,
						shareable: t.shareable,
						responsibilities: t.sections.responsibilitiesAndBoundaries,
					})),
					workspaces: store.listWorkspaces(),
					matters: store.listMatters(),
					deliverables: store.listDeliverables(),
					pendingDialogs: dialogBroker.listPending(),
					previews: previewManager.listPreviews(),
					memoriesByMember: formatMemoryMap(store),
				});
				return;
			}

			const matterDetailMatch = pathname.match(/^\/api\/matters\/([^/]+)$/);
			if (method === "GET" && matterDetailMatch) {
				const matterId = decodeURIComponent(matterDetailMatch[1]!);
				const matter = store.getMatter(matterId);
				if (!matter) {
					sendError(res, 404, `Matter not found: ${matterId}`);
					return;
				}
				sendJson(res, 200, {
					matter,
					userMessages: store.listMessages(matterId, "user"),
					internalCollabMessages: store.listMessages(matterId, "internal_collab"),
					noticeMessages: store.listMessages(matterId, "notice"),
					deliverables: store.listDeliverables(matterId),
					pendingDialogs: dialogBroker.listPending(matterId),
				});
				return;
			}

			if (method === "POST" && pathname === "/api/matters") {
				const body = await readJsonBody(req);
				const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
				if (!prompt) {
					sendError(res, 400, "prompt is required");
					return;
				}
				const preferredMemberId =
					typeof body.preferredMemberId === "string" && body.preferredMemberId.length > 0
						? body.preferredMemberId
						: undefined;
				const workspaceId =
					typeof body.workspaceId === "string" && body.workspaceId.length > 0 ? body.workspaceId : undefined;
				const title =
					typeof body.title === "string" && body.title.trim().length > 0 ? body.title.trim() : undefined;
				const deliverableTitle =
					typeof body.deliverableTitle === "string" && body.deliverableTitle.trim().length > 0
						? body.deliverableTitle.trim()
						: undefined;
				const deliverableType =
					typeof body.deliverableType === "string" ? (body.deliverableType as DeliverableType) : undefined;

				const leadMember = orchestrator.routeMemberForRequest(prompt, preferredMemberId);
				const matter = store.createMatter({
					title: title ?? prompt.slice(0, 60),
					leadMemberId: leadMember.id,
					workspaceId: workspaceId ?? null,
				});

				runDispatchInBackground({
					matterId: matter.id,
					title,
					prompt,
					preferredMemberId: leadMember.id,
					workspaceId,
					deliverableTitle,
					deliverableType,
				});

				sendJson(res, 202, { matter, assignedMember: leadMember });
				return;
			}

			const matterMsgMatch = pathname.match(/^\/api\/matters\/([^/]+)\/messages$/);
			if (method === "POST" && matterMsgMatch) {
				const matterId = decodeURIComponent(matterMsgMatch[1]!);
				const matter = store.getMatter(matterId);
				if (!matter) {
					sendError(res, 404, `Matter not found: ${matterId}`);
					return;
				}
				const body = await readJsonBody(req);
				const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
				if (!prompt) {
					sendError(res, 400, "prompt is required");
					return;
				}
				const preferredMemberId =
					typeof body.preferredMemberId === "string" && body.preferredMemberId.length > 0
						? body.preferredMemberId
						: (matter.leadMemberId ?? undefined);
				const workspaceId =
					typeof body.workspaceId === "string" && body.workspaceId.length > 0
						? body.workspaceId
						: (matter.workspaceId ?? undefined);
				const deliverableTitle =
					typeof body.deliverableTitle === "string" && body.deliverableTitle.trim().length > 0
						? body.deliverableTitle.trim()
						: undefined;

				runDispatchInBackground({
					matterId: matter.id,
					prompt,
					preferredMemberId,
					workspaceId,
					deliverableTitle,
				});

				sendJson(res, 202, { accepted: true, matterId: matter.id });
				return;
			}

			const dialogMatch = pathname.match(/^\/api\/dialogs\/([^/]+)\/respond$/);
			if (method === "POST" && dialogMatch) {
				const dialogId = decodeURIComponent(dialogMatch[1]!);
				const body = await readJsonBody(req);
				let payload: RpcExtensionUIResponsePayload;
				if (body.cancelled === true) {
					payload = { cancelled: true };
				} else if (typeof body.confirmed === "boolean") {
					payload = { confirmed: body.confirmed };
				} else if (typeof body.value === "string") {
					payload = { value: body.value };
				} else {
					sendError(res, 400, "Expected confirmed, value, or cancelled");
					return;
				}

				const matched = dialogBroker.respond(dialogId, payload);
				if (!matched) {
					sendError(res, 404, `Pending dialog not found: ${dialogId}`);
					return;
				}
				sendJson(res, 200, { ok: true, dialogId });
				return;
			}

			const feedbackMatch = pathname.match(/^\/api\/deliverables\/([^/]+)\/feedback$/);
			if (method === "POST" && feedbackMatch) {
				const deliverableId = decodeURIComponent(feedbackMatch[1]!);
				const body = await readJsonBody(req);
				const feedback = typeof body.feedback === "string" ? body.feedback.trim() : "";
				if (!feedback) {
					sendError(res, 400, "feedback is required");
					return;
				}
				store.addDeliverableFeedback(deliverableId, feedback);
				broadcast("deliverable_updated", { deliverableId, feedback });
				sendJson(res, 200, { ok: true, deliverableId, feedback });
				return;
			}

			if (method === "POST" && pathname === "/api/workspaces") {
				const body = await readJsonBody(req);
				const name = typeof body.name === "string" ? body.name.trim() : "";
				const repoPath = typeof body.repoPath === "string" ? body.repoPath.trim() : "";
				if (!name || !repoPath) {
					sendError(res, 400, "name and repoPath are required");
					return;
				}
				const ws = store.upsertWorkspace({
					name,
					repoPath,
					defaultBranch: typeof body.defaultBranch === "string" ? body.defaultBranch : "main",
					description: typeof body.description === "string" ? body.description : "",
				});
				broadcast("workspace_updated", ws);
				sendJson(res, 201, { workspace: ws });
				return;
			}

			if (method === "POST" && pathname === "/api/members") {
				const body = await readJsonBody(req);
				const name = typeof body.name === "string" ? body.name.trim() : "";
				const title = typeof body.title === "string" ? body.title.trim() : "";
				const responsibilities =
					typeof body.responsibilities === "string" && body.responsibilities.trim().length > 0
						? body.responsibilities.trim()
						: `- 承担 ${name} 的核心岗位职责与交付产出。`;
				if (!name || !title) {
					sendError(res, 400, "name and title are required");
					return;
				}
				const rawId =
					typeof body.id === "string" && body.id.trim().length > 0
						? body.id.trim()
						: title
								.toLowerCase()
								.replace(/[^a-z0-9]+/g, "-")
								.replace(/^-|-$/g, "") || `role-${Date.now()}`;
				const keywords = Array.isArray(body.keywords)
					? body.keywords.map(String).filter(Boolean)
					: typeof body.keywords === "string"
						? body.keywords
								.split(/[,，\s]+/)
								.map((s) => s.trim())
								.filter(Boolean)
						: [];
				const skills = Array.isArray(body.skills) ? body.skills.map(String).filter(Boolean) : [];
				const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : "kimi-for-coding";
				const provider =
					typeof body.provider === "string" && body.provider.trim() ? body.provider.trim() : "kimi-coding";
				const thinkingLevel = (
					typeof body.thinkingLevel === "string" ? body.thinkingLevel : "high"
				) as ThinkingLevel;
				const isPrimaryContact = body.isPrimaryContact === true;

				const rawBody = [
					"## 职责与边界",
					responsibilities,
					"",
					"## 技能与工作方法",
					"- 围绕明确问题开展调研或实现，交付可验证的结果。",
					"",
					"## 工具与环境依赖",
					"- 按需调用文档读取与工作区工具。",
					"",
					"## 协作和沟通约定",
					"- 平时静默推进，关键节点请用户确认，内部协作留痕。",
					"",
					"## 交付与验证方式",
					"- 产出结构化说明或可执行验证结果。",
				].join("\n");

				const template: RoleTemplate = {
					id: rawId,
					name,
					title,
					version: "1.0.0",
					shareable: true,
					defaultProvider: provider,
					defaultModel: model,
					thinkingLevel,
					isPrimaryContact,
					keywords,
					tools: ["read", "bash"],
					skills,
					mcpDependencies: [],
					sections: {
						responsibilitiesAndBoundaries: responsibilities,
						skillsAndMethods: "- 围绕明确问题开展调研或实现，交付可验证的结果。",
						toolsAndEnvironment: "- 按需调用文档读取与工作区工具。",
						collaborationConventions: "- 平时静默推进，关键节点请用户确认，内部协作留痕。",
						deliveryAndVerification: "- 产出结构化说明或可执行验证结果。",
					},
					rawBody,
				};

				if (rolesDir) {
					await mkdir(rolesDir, { recursive: true });
					await writeFile(join(rolesDir, `${rawId}.md`), serializeRoleTemplateMarkdown(template), "utf8");
				}

				const member = orchestrator.registerRoleTemplate(template);
				broadcast("team_updated", { memberId: member.id });
				sendJson(res, 201, { member });
				return;
			}

			const memberPrimaryMatch = pathname.match(/^\/api\/members\/([^/]+)\/primary$/);
			if (method === "POST" && memberPrimaryMatch) {
				const memberId = decodeURIComponent(memberPrimaryMatch[1]!);
				const member = store.setPrimaryContact(memberId);
				broadcast("team_updated", { memberId: member.id });
				sendJson(res, 200, { member });
				return;
			}

			const memberExportMatch = pathname.match(/^\/api\/members\/([^/]+)\/export$/);
			if (method === "GET" && memberExportMatch) {
				const memberId = decodeURIComponent(memberExportMatch[1]!);
				const member = store.getMember(memberId);
				if (!member) {
					sendError(res, 404, `Member not found: ${memberId}`);
					return;
				}
				const template = orchestrator.getTemplateForMember(member);
				if (!template) {
					sendError(res, 404, `Role template not found for member: ${memberId}`);
					return;
				}
				const markdown = serializeRoleTemplateMarkdown(template);
				sendJson(res, 200, { id: template.id, filename: `${template.id}.md`, markdown });
				return;
			}

			if (method === "POST" && pathname === "/api/members/import") {
				const body = await readJsonBody(req);
				const markdown = typeof body.markdown === "string" ? body.markdown : "";
				if (!markdown.trim()) {
					sendError(res, 400, "markdown is required");
					return;
				}
				const parsed = parseRoleTemplateMarkdown(markdown);
				if (rolesDir) {
					await mkdir(rolesDir, { recursive: true });
					await writeFile(join(rolesDir, `${parsed.id}.md`), serializeRoleTemplateMarkdown(parsed), "utf8");
				}
				const member = orchestrator.registerRoleTemplate(parsed);
				broadcast("team_updated", { memberId: member.id });
				sendJson(res, 201, { member });
				return;
			}

			if (method === "POST" && pathname === "/api/memories") {
				const body = await readJsonBody(req);
				const memberId = typeof body.memberId === "string" ? body.memberId.trim() : "";
				const content = typeof body.content === "string" ? body.content.trim() : "";
				const scope = (typeof body.scope === "string" ? body.scope : "role_general") as MemoryScope;
				if (!memberId || !content) {
					sendError(res, 400, "memberId and content are required");
					return;
				}
				const memory = store.addMemory({
					memberId,
					scope,
					workspaceId: typeof body.workspaceId === "string" && body.workspaceId ? body.workspaceId : null,
					content,
					sourceMatterId:
						typeof body.sourceMatterId === "string" && body.sourceMatterId ? body.sourceMatterId : null,
					verified: true,
				});
				broadcast("memory_updated", { memberId, memory });
				sendJson(res, 201, { memory });
				return;
			}

			if (method === "GET" && pathname === "/api/previews") {
				sendJson(res, 200, { previews: previewManager.listPreviews() });
				return;
			}

			if (method === "POST" && pathname === "/api/previews") {
				const body = await readJsonBody(req);
				const title = typeof body.title === "string" ? body.title.trim() : "独立预览服务";
				const deliverableId = typeof body.deliverableId === "string" ? body.deliverableId : null;

				if (typeof body.url === "string" && body.url.trim().length > 0) {
					const info = previewManager.registerExternalPreview({
						title,
						url: body.url.trim(),
						deliverableId,
					});
					broadcast("preview_updated", info);
					sendJson(res, 201, { preview: info });
					return;
				}

				const command = typeof body.command === "string" ? body.command.trim() : "";
				if (!command) {
					sendError(res, 400, "command or url is required");
					return;
				}
				const args = Array.isArray(body.args) ? body.args.map(String) : [];
				const cwd = typeof body.cwd === "string" && body.cwd.length > 0 ? body.cwd : process.cwd();
				const port = typeof body.port === "number" ? body.port : undefined;

				const info = await previewManager.startCommandPreview({
					title,
					command,
					args,
					cwd,
					port,
					deliverableId,
				});
				broadcast("preview_updated", info);
				sendJson(res, 201, { preview: info });
				return;
			}

			const previewStopMatch = pathname.match(/^\/api\/previews\/([^/]+)\/stop$/);
			if (method === "POST" && previewStopMatch) {
				const previewId = decodeURIComponent(previewStopMatch[1]!);
				const info = await previewManager.stopPreview(previewId);
				if (!info) {
					sendError(res, 404, `Preview not found: ${previewId}`);
					return;
				}
				broadcast("preview_updated", info);
				sendJson(res, 200, { preview: info });
				return;
			}

			// Serve built V4 React frontend assets when available.
			if (method === "GET" && webDistDir && existsSync(webDistDir)) {
				const safeRel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
				const targetPath = resolve(webDistDir, safeRel);
				if (targetPath.startsWith(resolve(webDistDir)) && existsSync(targetPath)) {
					const content = await readFile(targetPath);
					const mime = MIME_TYPES[extname(targetPath)] ?? "application/octet-stream";
					res.writeHead(200, { "Content-Type": mime, "Content-Length": content.byteLength });
					res.end(content);
					return;
				}
				const indexHtml = join(webDistDir, "index.html");
				if (existsSync(indexHtml) && !pathname.startsWith("/api/")) {
					const content = await readFile(indexHtml);
					res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": content.byteLength });
					res.end(content);
					return;
				}
			}

			sendError(res, 404, `Not found: ${method} ${pathname}`);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			sendError(res, 500, message);
		}
	});

	server.once("close", () => {
		offDialog();
		dialogBroker.cancelAll();
		for (const client of sseClients) {
			client.end();
		}
		sseClients.clear();
	});

	return { server, broadcast };
}
