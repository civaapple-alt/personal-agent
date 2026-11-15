import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, extname, join, resolve } from "node:path";
import { resolveRepoGitUserIdentity } from "../orchestrator/execution-context.ts";
import {
	buildProgressSnapshot,
	type DispatchMatterResult,
	type DispatchProgressEvent,
	type PromptImageAttachment,
	type TeamOrchestrator,
} from "../orchestrator/team-orchestrator.ts";
import { parseRoleTemplateMarkdown, serializeRoleTemplateMarkdown } from "../roles/template-loader.ts";
import type { RoleTemplate } from "../roles/types.ts";
import type { RpcExtensionUIResponsePayload, ThinkingLevel } from "../rpc/types.ts";
import { MemoryValidationError, normalizeMemoryCategory, type PersonalAgentStore } from "../storage/repositories.ts";
import type {
	DeliverableType,
	FeedbackRating,
	MemoryCategory,
	MemoryScope,
	MemoryStatus,
	WorkspaceLink,
} from "../storage/types.ts";
import type { DialogBroker } from "./dialog-broker.ts";
import type { PreviewManager } from "./preview-manager.ts";

const MEMORY_CATEGORIES = new Set<MemoryCategory>([
	"general",
	"efficiency",
	"troubleshooting",
	"collaboration",
	"user_correction",
	"domain_constraint",
]);

function enrichWorkspace(ws: WorkspaceLink): WorkspaceLink {
	return {
		...ws,
		repoGitUser: resolveRepoGitUserIdentity(ws.repoPath),
	};
}

function broadcastDistilledMemories(
	broadcast: (event: string, data: unknown) => void,
	fallbackMemberId: string,
	createdMemories: Array<{ memberId: string }>,
): void {
	if (createdMemories.length === 0) return;
	const memberIds = Array.from(new Set(createdMemories.map((m) => m.memberId)));
	for (const targetMemberId of memberIds) {
		broadcast("memory_updated", {
			memberId: targetMemberId,
			createdMemories: createdMemories.filter((m) => m.memberId === targetMemberId),
		});
	}
	if (!memberIds.includes(fallbackMemberId)) {
		broadcast("memory_updated", { memberId: fallbackMemberId, createdMemories: [] });
	}
}

export interface PersonalAgentServerOptions {
	store: PersonalAgentStore;
	orchestrator: TeamOrchestrator;
	templates: RoleTemplate[];
	previewManager: PreviewManager;
	dialogBroker: DialogBroker;
	webDistDir?: string;
	rolesDir?: string;
	uploadsDir?: string;
}

const MIME_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
};

const MAX_JSON_BODY_BYTES = 36 * 1024 * 1024;
const MAX_UPLOAD_IMAGES = 6;
const MAX_UPLOAD_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_MEMORY_UPLOAD_CACHE = 128;

const IMAGE_EXTENSIONS: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/webp": ".webp",
	"image/gif": ".gif",
};

class HttpRequestError extends Error {
	statusCode: number;

	constructor(statusCode: number, message: string) {
		super(message);
		this.statusCode = statusCode;
	}
}

interface ParsedUploadImage {
	data: string;
	mimeType: string;
	name: string;
	buffer: Buffer;
}

function parseIncomingImages(raw: unknown): ParsedUploadImage[] {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) {
		throw new HttpRequestError(400, "images must be an array");
	}
	if (raw.length > MAX_UPLOAD_IMAGES) {
		throw new HttpRequestError(400, `At most ${MAX_UPLOAD_IMAGES} images per message are allowed`);
	}
	const parsed: ParsedUploadImage[] = [];
	for (let i = 0; i < raw.length; i += 1) {
		const item = raw[i];
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			throw new HttpRequestError(400, `Invalid image entry at index ${i}`);
		}
		const record = item as Record<string, unknown>;
		const rawMime = typeof record.mimeType === "string" ? record.mimeType.trim().toLowerCase() : "";
		const mimeType = rawMime === "image/jpg" ? "image/jpeg" : rawMime;
		if (!IMAGE_EXTENSIONS[mimeType]) {
			throw new HttpRequestError(400, `Unsupported image type: ${rawMime || "unknown"}`);
		}
		const rawData = typeof record.data === "string" ? record.data.trim() : "";
		const dataUrlMatch = rawData.match(/^data:([^;]+);base64,(.+)$/s);
		const base64Text = (dataUrlMatch ? dataUrlMatch[2]! : rawData).replace(/\s+/g, "");
		if (!base64Text || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64Text) || base64Text.length % 4 === 1) {
			throw new HttpRequestError(400, `Invalid base64 image data at index ${i}`);
		}
		const buffer = Buffer.from(base64Text, "base64");
		if (buffer.byteLength === 0) {
			throw new HttpRequestError(400, `Empty image data at index ${i}`);
		}
		if (buffer.byteLength > MAX_UPLOAD_IMAGE_BYTES) {
			throw new HttpRequestError(400, `Image exceeds ${MAX_UPLOAD_IMAGE_BYTES / (1024 * 1024)}MB limit`);
		}
		const rawName = typeof record.name === "string" ? basename(record.name.trim()).slice(0, 120) : "";
		parsed.push({
			data: buffer.toString("base64"),
			mimeType,
			name: rawName || `image-${i + 1}${IMAGE_EXTENSIONS[mimeType]}`,
			buffer,
		});
	}
	return parsed;
}

async function persistUploadedImages(
	items: ParsedUploadImage[],
	uploadsDir: string | undefined,
	memoryUploads: Map<string, { buffer: Buffer; mimeType: string }>,
): Promise<PromptImageAttachment[]> {
	if (items.length === 0) return [];
	if (uploadsDir) {
		await mkdir(resolve(uploadsDir), { recursive: true });
	}
	const stored: PromptImageAttachment[] = [];
	for (const item of items) {
		const ext = IMAGE_EXTENSIONS[item.mimeType] ?? ".bin";
		const filename = `${Date.now()}-${randomUUID().slice(0, 8)}${ext}`;
		if (uploadsDir) {
			await writeFile(join(resolve(uploadsDir), filename), item.buffer);
		} else {
			memoryUploads.set(filename, { buffer: item.buffer, mimeType: item.mimeType });
			while (memoryUploads.size > MAX_MEMORY_UPLOAD_CACHE) {
				const oldestKey = memoryUploads.keys().next().value;
				if (!oldestKey) break;
				memoryUploads.delete(oldestKey);
			}
		}
		stored.push({
			type: "image",
			data: item.data,
			mimeType: item.mimeType,
			name: item.name,
			url: `/api/uploads/${filename}`,
		});
	}
	return stored;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let totalBytes = 0;
	for await (const chunk of req) {
		const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
		totalBytes += buf.byteLength;
		if (totalBytes > MAX_JSON_BODY_BYTES) {
			throw new HttpRequestError(413, "Request body exceeds 36MB limit");
		}
		chunks.push(buf);
	}
	const raw = Buffer.concat(chunks).toString("utf8").trim();
	if (raw.length === 0) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch {
		throw new HttpRequestError(400, "Invalid JSON request body");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new HttpRequestError(400, "Request body must be a JSON object");
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

function responseCancellation(res: ServerResponse): { signal: AbortSignal; dispose: () => void } {
	const controller = new AbortController();
	const onClose = () => {
		if (!res.writableEnded) controller.abort();
	};
	res.on("close", onClose);
	return { signal: controller.signal, dispose: () => res.off("close", onClose) };
}

function formatMemoryMap(store: PersonalAgentStore): Record<string, unknown[]> {
	const result: Record<string, unknown[]> = {};
	for (const member of store.listMembers()) {
		result[member.id] = store.listMemberMemories(member.id);
	}
	return result;
}

function parseObserverMemberIds(raw: unknown, store: PersonalAgentStore): string[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const seen = new Set<string>();
	const ids: string[] = [];
	for (const item of raw) {
		if (typeof item !== "string") continue;
		const trimmed = item.trim();
		if (!trimmed || seen.has(trimmed) || !store.getMember(trimmed)) continue;
		seen.add(trimmed);
		ids.push(trimmed);
	}
	return ids;
}

/**
 * Create the Phase 3 HTTP + SSE server backing the V4 workbench UI.
 */
export function createPersonalAgentServer(options: PersonalAgentServerOptions): {
	server: Server;
	broadcast: (eventName: string, payload: unknown) => void;
} {
	const { store, orchestrator, previewManager, dialogBroker, webDistDir, rolesDir, uploadsDir } = options;
	const sseClients = new Set<ServerResponse>();
	const memoryUploads = new Map<string, { buffer: Buffer; mimeType: string }>();

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

	const activeRuns = new Map<
		string,
		{
			progress: DispatchProgressEvent;
			startedAt: number;
			accumulatedDelta: string;
		}
	>();

	const runDispatchInBackground = (input: {
		matterId: string;
		title?: string;
		prompt: string;
		images?: PromptImageAttachment[];
		preferredMemberId?: string;
		workspaceId?: string;
		observerMemberIds?: string[];
		deliverableTitle?: string;
		deliverableType?: DeliverableType;
	}) => {
		const initialProgress: DispatchProgressEvent = {
			stage: "starting",
			label: "正在准备执行环境...",
		};
		const activeEntry = {
			progress: initialProgress,
			startedAt: Date.now(),
			accumulatedDelta: "",
		};
		activeRuns.set(input.matterId, activeEntry);
		broadcast("matter_started", { matterId: input.matterId });
		let accumulatedDelta = "";
		void orchestrator
			.dispatchMatter({
				matterId: input.matterId,
				title: input.title,
				prompt: input.prompt,
				images: input.images,
				preferredMemberId: input.preferredMemberId,
				workspaceId: input.workspaceId,
				observerMemberIds: input.observerMemberIds,
				deliverableTitle: input.deliverableTitle,
				deliverableType: input.deliverableType,
				onTextDelta: (delta) => {
					accumulatedDelta += delta;
					activeEntry.accumulatedDelta = accumulatedDelta;
					broadcast("text_delta", { matterId: input.matterId, delta });
				},
				onProgress: (progress) => {
					activeEntry.progress = progress;
					broadcast("matter_progress", { matterId: input.matterId, ...progress });
				},
			})
			.then((result: DispatchMatterResult) => {
				activeRuns.delete(input.matterId);
				if (result.runResult.aborted) {
					broadcast("matter_aborted", {
						matterId: result.matter.id,
						matter: result.matter,
					});
					return;
				}
				broadcast("matter_settled", {
					matterId: result.matter.id,
					matter: result.matter,
					deliverable: result.deliverable,
					assignedMemberId: result.assignedMember.id,
				});
			})
			.catch((error: unknown) => {
				const lastActive = activeRuns.get(input.matterId);
				activeRuns.delete(input.matterId);
				const message = error instanceof Error ? error.message : String(error);
				const currentMatter = store.getMatter(input.matterId);
				const leadMember = currentMatter?.leadMemberId ? store.getMember(currentMatter.leadMemberId) : null;
				const lastUserMsg = [...store.listMessages(input.matterId, "user")]
					.reverse()
					.find((msg) => msg.senderType === "user");
				const resolvedWorkspaceId =
					lastUserMsg?.metadata && "workspaceId" in lastUserMsg.metadata
						? ((lastUserMsg.metadata.workspaceId as string | null) ?? null)
						: (input.workspaceId ?? currentMatter?.workspaceId ?? null);
				const workspaceLink = resolvedWorkspaceId ? store.getWorkspace(resolvedWorkspaceId) : null;
				const resolvedRepoPath =
					typeof lastUserMsg?.metadata?.repoPath === "string"
						? lastUserMsg.metadata.repoPath
						: resolve(workspaceLink?.repoPath ?? process.cwd());
				const progressSnapshot = lastActive
					? buildProgressSnapshot({
							outcome: "failed",
							progress: lastActive.progress,
							startedAtMs: lastActive.startedAt,
							leadMember,
						})
					: undefined;
				store.appendMessage({
					matterId: input.matterId,
					channel: "notice",
					senderType: "system",
					senderId: "orchestrator",
					content: JSON.stringify({ method: "error", message }),
				});
				const partialNote = accumulatedDelta.trim() ? `${accumulatedDelta.trim()}\n\n---\n\n` : "";
				store.appendMessage({
					matterId: input.matterId,
					channel: "user",
					senderType: "system",
					senderId: "orchestrator",
					content: `${partialNote}⚠️ 本次执行未完成（${message}）。你可以直接追问继续，或拆分任务范围后重试。`,
					metadata: {
						failed: true,
						error: message,
						workspaceId: resolvedWorkspaceId,
						repoPath: resolvedRepoPath,
						...(progressSnapshot ? { progressSnapshot } : {}),
					},
				});
				store.updateMatterStatus(input.matterId, "open");
				broadcast("matter_failed", {
					matterId: input.matterId,
					error: message,
					...(progressSnapshot ? { progressSnapshot } : {}),
				});
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

			const uploadMatch = pathname.match(/^\/api\/uploads\/([a-zA-Z0-9._-]+)$/);
			if (method === "GET" && uploadMatch) {
				const filename = uploadMatch[1]!;
				const mime = MIME_TYPES[extname(filename).toLowerCase()];
				if (!mime || !mime.startsWith("image/")) {
					sendError(res, 404, "Upload not found");
					return;
				}
				if (uploadsDir) {
					const targetPath = resolve(uploadsDir, filename);
					if (targetPath.startsWith(resolve(uploadsDir)) && existsSync(targetPath)) {
						const content = await readFile(targetPath);
						res.writeHead(200, {
							"Content-Type": mime,
							"Content-Length": content.byteLength,
							"Cache-Control": "public, max-age=31536000, immutable",
						});
						res.end(content);
						return;
					}
				}
				const memEntry = memoryUploads.get(filename);
				if (memEntry) {
					res.writeHead(200, {
						"Content-Type": memEntry.mimeType,
						"Content-Length": memEntry.buffer.byteLength,
						"Cache-Control": "public, max-age=31536000, immutable",
					});
					res.end(memEntry.buffer);
					return;
				}
				sendError(res, 404, "Upload not found");
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
					workspaces: store.listWorkspaces().map(enrichWorkspace),
					organizations: store.listOrganizations(),
					matters: store.listMatters(),
					deliverables: store.listDeliverables(),
					pendingDialogs: dialogBroker.listPending(),
					previews: previewManager.listPreviews(),
					memoriesByMember: formatMemoryMap(store),
					activeRuns: Object.fromEntries(
						[...activeRuns.entries()].map(([matterId, run]) => [
							matterId,
							{ ...run.progress, matterId, startedAt: run.startedAt },
						]),
					),
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
					activeRun: (() => {
						const active = activeRuns.get(matterId);
						return active
							? {
									...active.progress,
									matterId,
									startedAt: active.startedAt,
									streamingDelta: active.accumulatedDelta,
								}
							: null;
					})(),
				});
				return;
			}

			const matterAbortMatch = pathname.match(/^\/api\/matters\/([^/]+)\/abort$/);
			if (method === "POST" && matterAbortMatch) {
				const matterId = decodeURIComponent(matterAbortMatch[1]!);
				const matter = store.getMatter(matterId);
				if (!matter) {
					sendError(res, 404, `Matter not found: ${matterId}`);
					return;
				}
				dialogBroker.cancelForMatter(matterId);
				const aborted = await orchestrator.abortMatter(matterId);
				broadcast("matter_aborted", { matterId, aborted });
				sendJson(res, 200, { ok: true, aborted });
				return;
			}

			if (method === "PATCH" && matterDetailMatch) {
				const matterId = decodeURIComponent(matterDetailMatch[1]!);
				const existing = store.getMatter(matterId);
				if (!existing) {
					sendError(res, 404, `Matter not found: ${matterId}`);
					return;
				}
				const body = await readJsonBody(req);
				const hasWorkspaceUpdate = Object.hasOwn(body, "workspaceId");
				const hasOrgUpdate = Object.hasOwn(body, "orgId");
				const hasObserverUpdate = Object.hasOwn(body, "observerMemberIds");
				const workspaceId =
					typeof body.workspaceId === "string" && body.workspaceId.trim().length > 0
						? body.workspaceId.trim()
						: null;
				if (hasWorkspaceUpdate && workspaceId && !store.getWorkspace(workspaceId)) {
					sendError(res, 404, `Workspace not found: ${workspaceId}`);
					return;
				}
				const nextOrgId =
					body.orgId === null
						? null
						: typeof body.orgId === "string" && body.orgId.trim().length > 0
							? body.orgId.trim()
							: null;
				if (hasOrgUpdate && body.orgId !== null && typeof body.orgId !== "string") {
					sendError(res, 400, "orgId must be a string or null");
					return;
				}
				if (hasOrgUpdate && nextOrgId && !store.getOrganization(nextOrgId)) {
					sendError(res, 404, `Organization not found: ${nextOrgId}`);
					return;
				}
				const observerMemberIds = hasObserverUpdate
					? parseObserverMemberIds(body.observerMemberIds, store)
					: undefined;
				if (hasObserverUpdate && !observerMemberIds) {
					sendError(res, 400, "observerMemberIds must be an array of member IDs");
					return;
				}
				if ((hasWorkspaceUpdate || hasOrgUpdate) && orchestrator.isMatterRunning(matterId)) {
					sendError(res, 409, "Stop the active turn before switching workspaces or organizations");
					return;
				}
				let updated = existing;
				if (hasOrgUpdate) {
					updated = store.updateMatterOrganization(matterId, nextOrgId);
					broadcast("matter_updated", { matterId, orgId: updated.orgId, workspaceId: updated.workspaceId });
				}
				if (hasWorkspaceUpdate) {
					updated = store.updateMatterWorkspace(matterId, workspaceId);
					broadcast("workspace_updated", { matterId, workspaceId, orgId: updated.orgId });
				}
				if (observerMemberIds !== undefined) {
					updated = store.updateMatterObservers(matterId, observerMemberIds);
					broadcast("matter_updated", { matterId, observerMemberIds: updated.observerMemberIds });
				}
				sendJson(res, 200, { matter: updated });
				return;
			}

			if (method === "POST" && pathname === "/api/matters") {
				const body = await readJsonBody(req);
				const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
				const parsedImages = parseIncomingImages(body.images);
				if (!prompt && parsedImages.length === 0) {
					sendError(res, 400, "prompt or images is required");
					return;
				}
				const preferredMemberId =
					typeof body.preferredMemberId === "string" && body.preferredMemberId.length > 0
						? body.preferredMemberId
						: undefined;
				const workspaceId =
					typeof body.workspaceId === "string" && body.workspaceId.length > 0 ? body.workspaceId : undefined;
				const boundWorkspace = workspaceId ? store.getWorkspace(workspaceId) : null;
				if (workspaceId && !boundWorkspace) {
					sendError(res, 404, `Workspace not found: ${workspaceId}`);
					return;
				}
				const hasExplicitOrg = Object.hasOwn(body, "orgId");
				if (hasExplicitOrg && body.orgId !== null && typeof body.orgId !== "string") {
					sendError(res, 400, "orgId must be a string or null");
					return;
				}
				const requestedOrgId =
					typeof body.orgId === "string" && body.orgId.trim().length > 0 ? body.orgId.trim() : null;
				if (requestedOrgId && !store.getOrganization(requestedOrgId)) {
					sendError(res, 404, `Organization not found: ${requestedOrgId}`);
					return;
				}
				const orgId = boundWorkspace
					? boundWorkspace.orgId
					: hasExplicitOrg
						? requestedOrgId
						: (store.getDefaultOrganization()?.id ?? null);
				const title =
					typeof body.title === "string" && body.title.trim().length > 0 ? body.title.trim() : undefined;
				const deliverableTitle =
					typeof body.deliverableTitle === "string" && body.deliverableTitle.trim().length > 0
						? body.deliverableTitle.trim()
						: undefined;
				const deliverableType =
					typeof body.deliverableType === "string" ? (body.deliverableType as DeliverableType) : undefined;
				const observerMemberIds = parseObserverMemberIds(body.observerMemberIds, store);
				const images = await persistUploadedImages(parsedImages, uploadsDir, memoryUploads);

				const leadMember = orchestrator.routeMemberForRequest(prompt, preferredMemberId);
				const fallbackTitle = prompt
					? prompt.slice(0, 60)
					: images.length === 1
						? `图片：${images[0]?.name ?? "上传图片"}`.slice(0, 60)
						: `上传了 ${images.length} 张图片`;
				const matter = store.createMatter({
					title: title ?? fallbackTitle,
					leadMemberId: leadMember.id,
					workspaceId: workspaceId ?? null,
					orgId,
					observerMemberIds,
				});

				runDispatchInBackground({
					matterId: matter.id,
					title,
					prompt,
					images: images.length > 0 ? images : undefined,
					preferredMemberId: leadMember.id,
					workspaceId,
					observerMemberIds,
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
				if (orchestrator.isMatterRunning(matterId)) {
					sendError(res, 409, "Matter already has an active turn");
					return;
				}
				const body = await readJsonBody(req);
				const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
				const parsedImages = parseIncomingImages(body.images);
				if (!prompt && parsedImages.length === 0) {
					sendError(res, 400, "prompt or images is required");
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
				const observerMemberIds = parseObserverMemberIds(body.observerMemberIds, store);
				const images = await persistUploadedImages(parsedImages, uploadsDir, memoryUploads);

				runDispatchInBackground({
					matterId: matter.id,
					prompt,
					images: images.length > 0 ? images : undefined,
					preferredMemberId,
					workspaceId,
					observerMemberIds,
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
				const existing = store.getDeliverable(deliverableId);
				if (!existing) {
					sendError(res, 404, `Deliverable not found: ${deliverableId}`);
					return;
				}
				const body = await readJsonBody(req);
				const feedback = typeof body.feedback === "string" ? body.feedback.trim() : "";
				const rawRating = body.rating;
				const rating: FeedbackRating | undefined =
					rawRating === "positive" || rawRating === "negative" || rawRating === "neutral" ? rawRating : undefined;
				if (!feedback && !rating) {
					sendError(res, 400, "feedback or rating is required");
					return;
				}
				const { deliverable: updatedDeliverable, evaluatedMemories } = store.recordDeliverableFeedback(
					deliverableId,
					feedback || existing.feedback || "",
					rating,
				);
				const evaluatedMemoryIds = evaluatedMemories.map((memory) => memory.id);
				for (const memberId of new Set(evaluatedMemories.map((memory) => memory.memberId)))
					broadcast("memory_updated", { memberId, evaluatedMemoryIds });
				let distilledMemories: unknown[] = [];
				let distillationError: string | undefined;
				if (body.autoDistill === true) {
					const cancellation = responseCancellation(res);
					try {
						const distilled = await orchestrator.distillExperiences({
							matterId: existing.matterId,
							deliverableId: existing.id,
							feedback,
							rating: rating ?? null,
							scopeMode: body.scopeMode === "single" || body.scopeMode === "team" ? body.scopeMode : undefined,
							signal: cancellation.signal,
						});
						distilledMemories = distilled.createdMemories;
						broadcastDistilledMemories(broadcast, distilled.member.id, distilled.createdMemories);
					} catch (error) {
						distillationError = error instanceof Error ? error.message : String(error);
					} finally {
						cancellation.dispose();
					}
				}
				broadcast("deliverable_updated", {
					deliverableId,
					feedback: updatedDeliverable?.feedback ?? feedback,
					rating: updatedDeliverable?.feedbackRating ?? null,
				});
				sendJson(res, 200, {
					ok: true,
					deliverableId,
					feedback: updatedDeliverable?.feedback ?? feedback,
					rating: updatedDeliverable?.feedbackRating ?? null,
					evaluatedMemoryIds,
					distilledMemories,
					distillationError,
				});
				return;
			}

			if (method === "GET" && pathname === "/api/organizations") {
				sendJson(res, 200, { organizations: store.listOrganizations() });
				return;
			}

			if (method === "POST" && pathname === "/api/organizations") {
				const body = await readJsonBody(req);
				const name = typeof body.name === "string" ? body.name.trim() : "";
				if (!name) {
					sendError(res, 400, "name is required");
					return;
				}
				const organization = store.upsertOrganization({
					id: typeof body.id === "string" && body.id.trim() ? body.id.trim() : undefined,
					name,
					gitEmailDomain: typeof body.gitEmailDomain === "string" ? body.gitEmailDomain : "",
					description: typeof body.description === "string" ? body.description : "",
					isDefault: typeof body.isDefault === "boolean" ? body.isDefault : undefined,
				});
				broadcast("organization_updated", { organization });
				sendJson(res, 201, { organization });
				return;
			}

			const orgDefaultMatch = pathname.match(/^\/api\/organizations\/([^/]+)\/default$/);
			if (method === "POST" && orgDefaultMatch) {
				const orgId = decodeURIComponent(orgDefaultMatch[1]!);
				if (!store.getOrganization(orgId)) {
					sendError(res, 404, `Organization not found: ${orgId}`);
					return;
				}
				const organization = store.setDefaultOrganization(orgId);
				broadcast("organization_updated", { organization });
				sendJson(res, 200, { organization });
				return;
			}

			const orgPatchMatch = pathname.match(/^\/api\/organizations\/([^/]+)$/);
			if (method === "PATCH" && orgPatchMatch) {
				const orgId = decodeURIComponent(orgPatchMatch[1]!);
				if (!store.getOrganization(orgId)) {
					sendError(res, 404, `Organization not found: ${orgId}`);
					return;
				}
				const body = await readJsonBody(req);
				const organization = store.updateOrganization(orgId, {
					name: typeof body.name === "string" ? body.name : undefined,
					gitEmailDomain: typeof body.gitEmailDomain === "string" ? body.gitEmailDomain : undefined,
					description: typeof body.description === "string" ? body.description : undefined,
					isDefault: typeof body.isDefault === "boolean" ? body.isDefault : undefined,
				});
				broadcast("organization_updated", { organization });
				sendJson(res, 200, { organization });
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
				let orgId: string | null | undefined =
					body.orgId === null
						? null
						: typeof body.orgId === "string" && body.orgId.trim()
							? body.orgId.trim()
							: undefined;
				if (orgId && !store.getOrganization(orgId)) {
					sendError(res, 404, `Organization not found: ${orgId}`);
					return;
				}
				if (orgId === undefined) {
					const fallbackOrg = store.getDefaultOrganization() ?? store.ensureDefaultOrganization();
					orgId = fallbackOrg.id;
				}
				const ws = enrichWorkspace(
					store.upsertWorkspace({
						orgId,
						name,
						repoPath,
						defaultBranch: typeof body.defaultBranch === "string" ? body.defaultBranch : "main",
						description: typeof body.description === "string" ? body.description : "",
					}),
				);
				broadcast("workspace_updated", ws);
				sendJson(res, 201, { workspace: ws });
				return;
			}

			const wsPatchMatch = pathname.match(/^\/api\/workspaces\/([^/]+)$/);
			if (method === "PATCH" && wsPatchMatch) {
				const workspaceId = decodeURIComponent(wsPatchMatch[1]!);
				if (!store.getWorkspace(workspaceId)) {
					sendError(res, 404, `Workspace not found: ${workspaceId}`);
					return;
				}
				const body = await readJsonBody(req);
				const orgId =
					body.orgId === null
						? null
						: typeof body.orgId === "string" && body.orgId.trim()
							? body.orgId.trim()
							: undefined;
				if (orgId && !store.getOrganization(orgId)) {
					sendError(res, 404, `Organization not found: ${orgId}`);
					return;
				}
				const ws = enrichWorkspace(
					store.updateWorkspace(workspaceId, {
						orgId,
						name: typeof body.name === "string" ? body.name : undefined,
						defaultBranch: typeof body.defaultBranch === "string" ? body.defaultBranch : undefined,
						description: typeof body.description === "string" ? body.description : undefined,
					}),
				);
				broadcast("workspace_updated", ws);
				sendJson(res, 200, { workspace: ws });
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

				const registered = orchestrator.registerRoleTemplate(template);
				const member =
					typeof body.gitName === "string" ||
					typeof body.gitEmail === "string" ||
					typeof body.identitySummary === "string"
						? store.updateMemberIdentity(registered.id, {
								gitName: typeof body.gitName === "string" ? body.gitName : undefined,
								gitEmail: typeof body.gitEmail === "string" ? body.gitEmail : undefined,
								identitySummary: typeof body.identitySummary === "string" ? body.identitySummary : undefined,
							})
						: registered;
				broadcast("team_updated", { memberId: member.id });
				sendJson(res, 201, { member });
				return;
			}

			const memberPatchMatch = pathname.match(/^\/api\/members\/([^/]+)$/);
			if (method === "PATCH" && memberPatchMatch) {
				const memberId = decodeURIComponent(memberPatchMatch[1]!);
				if (!store.getMember(memberId)) {
					sendError(res, 404, `Member not found: ${memberId}`);
					return;
				}
				const body = await readJsonBody(req);
				const member = store.updateMemberIdentity(memberId, {
					displayName: typeof body.displayName === "string" ? body.displayName : undefined,
					roleTitle: typeof body.roleTitle === "string" ? body.roleTitle : undefined,
					gitName: typeof body.gitName === "string" ? body.gitName : undefined,
					gitEmail: typeof body.gitEmail === "string" ? body.gitEmail : undefined,
					identitySummary: typeof body.identitySummary === "string" ? body.identitySummary : undefined,
				});
				broadcast("team_updated", { memberId: member.id });
				sendJson(res, 200, { member });
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
				if (!store.getMember(memberId)) {
					sendError(res, 404, `Member not found: ${memberId}`);
					return;
				}
				if (scope !== "role_general" && scope !== "company_private" && scope !== "project_private") {
					sendError(res, 400, `Unsupported memory scope: ${scope}`);
					return;
				}
				const category =
					body.category === undefined
						? "general"
						: typeof body.category === "string" && MEMORY_CATEGORIES.has(body.category as MemoryCategory)
							? normalizeMemoryCategory(body.category)
							: null;
				if (!category) {
					sendError(res, 400, `Unsupported memory category: ${String(body.category)}`);
					return;
				}
				const orgId =
					scope === "company_private" && typeof body.orgId === "string" && body.orgId.trim()
						? body.orgId.trim()
						: null;
				if (orgId && !store.getOrganization(orgId)) {
					sendError(res, 404, `Organization not found: ${orgId}`);
					return;
				}
				const workspaceId =
					scope === "role_general" || orgId
						? null
						: typeof body.workspaceId === "string" && body.workspaceId
							? body.workspaceId
							: null;
				if (workspaceId && !store.getWorkspace(workspaceId)) {
					sendError(res, 404, `Workspace not found: ${workspaceId}`);
					return;
				}
				const rawStatus = body.status;
				const status: MemoryStatus =
					rawStatus === "candidate" ||
					rawStatus === "verified" ||
					rawStatus === "rejected" ||
					rawStatus === "superseded"
						? rawStatus
						: body.verified === false
							? "candidate"
							: "verified";
				const memory = store.addMemory({
					memberId,
					scope,
					category,
					orgId,
					workspaceId,
					content,
					rationale: typeof body.rationale === "string" ? body.rationale.trim() : "",
					sourceMatterId:
						typeof body.sourceMatterId === "string" && body.sourceMatterId ? body.sourceMatterId : null,
					sourceDeliverableId:
						typeof body.sourceDeliverableId === "string" && body.sourceDeliverableId
							? body.sourceDeliverableId
							: null,
					status,
					verified: status === "verified",
					supersedesMemoryId:
						typeof body.supersedesMemoryId === "string" && body.supersedesMemoryId
							? body.supersedesMemoryId
							: null,
				});
				broadcast("memory_updated", { memberId, memory });
				sendJson(res, 201, { memory });
				return;
			}

			const memoryAppsMatch = pathname.match(/^\/api\/memories\/([^/]+)\/applications$/);
			if (method === "GET" && memoryAppsMatch) {
				const memoryId = decodeURIComponent(memoryAppsMatch[1]!);
				const memory = store.getMemory(memoryId);
				if (!memory) {
					sendError(res, 404, `Memory not found: ${memoryId}`);
					return;
				}
				sendJson(res, 200, { memory, applications: store.listMemoryApplications(memoryId) });
				return;
			}

			const memoryEvalMatch = pathname.match(/^\/api\/memories\/([^/]+)\/evaluate$/);
			if (method === "POST" && memoryEvalMatch) {
				const memoryId = decodeURIComponent(memoryEvalMatch[1]!);
				const existing = store.getMemory(memoryId);
				if (!existing) {
					sendError(res, 404, `Memory not found: ${memoryId}`);
					return;
				}
				const body = await readJsonBody(req);
				if (body.outcome !== "positive" && body.outcome !== "negative") {
					sendError(res, 400, "outcome must be positive or negative");
					return;
				}
				const memory = store.evaluateMemory({
					memoryId,
					outcome: body.outcome === "positive" ? "feedback_positive" : "feedback_negative",
					matterId: typeof body.matterId === "string" && body.matterId ? body.matterId : existing.sourceMatterId,
					memberId: existing.memberId,
					note: typeof body.note === "string" ? body.note.trim() : "",
				});
				broadcast("memory_updated", { memberId: memory.memberId, memory });
				sendJson(res, 200, { memory });
				return;
			}

			const memoryPatchMatch = pathname.match(/^\/api\/memories\/([^/]+)$/);
			if (method === "PATCH" && memoryPatchMatch) {
				const memoryId = decodeURIComponent(memoryPatchMatch[1]!);
				const existing = store.getMemory(memoryId);
				if (!existing) {
					sendError(res, 404, `Memory not found: ${memoryId}`);
					return;
				}
				const body = await readJsonBody(req);
				const memberId =
					typeof body.memberId === "string" && body.memberId.trim() ? body.memberId.trim() : undefined;
				if (memberId && !store.getMember(memberId)) {
					sendError(res, 404, `Member not found: ${memberId}`);
					return;
				}
				const scope = typeof body.scope === "string" ? (body.scope as MemoryScope) : undefined;
				if (scope && scope !== "role_general" && scope !== "company_private" && scope !== "project_private") {
					sendError(res, 400, `Unsupported memory scope: ${scope}`);
					return;
				}
				const category =
					body.category === undefined
						? undefined
						: typeof body.category === "string" && MEMORY_CATEGORIES.has(body.category as MemoryCategory)
							? (body.category as MemoryCategory)
							: null;
				if (category === null) {
					sendError(res, 400, `Unsupported memory category: ${String(body.category)}`);
					return;
				}
				const orgId =
					body.orgId === null
						? null
						: typeof body.orgId === "string" && body.orgId.trim()
							? body.orgId.trim()
							: undefined;
				if (orgId && !store.getOrganization(orgId)) {
					sendError(res, 404, `Organization not found: ${orgId}`);
					return;
				}
				const workspaceId =
					body.workspaceId === null
						? null
						: typeof body.workspaceId === "string" && body.workspaceId
							? body.workspaceId
							: undefined;
				if (workspaceId && !store.getWorkspace(workspaceId)) {
					sendError(res, 404, `Workspace not found: ${workspaceId}`);
					return;
				}
				const status = typeof body.status === "string" ? (body.status as MemoryStatus) : undefined;
				if (
					status &&
					status !== "candidate" &&
					status !== "verified" &&
					status !== "rejected" &&
					status !== "superseded"
				) {
					sendError(res, 400, `Unsupported memory status: ${status}`);
					return;
				}
				const memory = store.updateMemory(memoryId, {
					memberId,
					content: typeof body.content === "string" ? body.content : undefined,
					scope,
					category,
					orgId,
					workspaceId,
					status,
					rationale: typeof body.rationale === "string" ? body.rationale : undefined,
					supersedesMemoryId:
						body.supersedesMemoryId === null
							? null
							: typeof body.supersedesMemoryId === "string"
								? body.supersedesMemoryId
								: undefined,
				});
				if (existing.memberId !== memory.memberId) {
					broadcast("memory_updated", { memberId: existing.memberId, memory });
				}
				broadcast("memory_updated", { memberId: memory.memberId, memory });
				sendJson(res, 200, { memory });
				return;
			}

			if (method === "POST" && pathname === "/api/rsi/distill/abort") {
				const body = await readJsonBody(req);
				const matterId = typeof body.matterId === "string" ? body.matterId.trim() : "";
				if (!matterId) {
					sendError(res, 400, "matterId is required");
					return;
				}
				const aborted = orchestrator.abortDistillation(matterId);
				sendJson(res, 200, { ok: true, aborted });
				return;
			}

			if (method === "POST" && pathname === "/api/rsi/distill") {
				const body = await readJsonBody(req);
				const matterId = typeof body.matterId === "string" ? body.matterId.trim() : "";
				if (!matterId) {
					sendError(res, 400, "matterId is required");
					return;
				}
				const deliverableId =
					typeof body.deliverableId === "string" && body.deliverableId.trim()
						? body.deliverableId.trim()
						: undefined;
				const memberId =
					typeof body.memberId === "string" && body.memberId.trim() ? body.memberId.trim() : undefined;
				const feedback =
					typeof body.feedback === "string" && body.feedback.trim() ? body.feedback.trim() : undefined;
				const rating: FeedbackRating | undefined =
					body.rating === "positive" || body.rating === "negative" || body.rating === "neutral"
						? body.rating
						: undefined;
				const scopeMode = body.scopeMode === "single" || body.scopeMode === "team" ? body.scopeMode : undefined;
				const cancellation = responseCancellation(res);
				try {
					const result = await orchestrator.distillExperiences({
						matterId,
						deliverableId,
						memberId,
						feedback,
						rating,
						scopeMode,
						signal: cancellation.signal,
					});
					broadcastDistilledMemories(broadcast, result.member.id, result.createdMemories);
					sendJson(res, 200, { ok: true, ...result });
				} catch (err) {
					if (
						cancellation.signal.aborted ||
						(err instanceof Error && err.message === "Experience distillation was aborted")
					) {
						if (!res.writableEnded && !res.destroyed) {
							sendJson(res, 200, {
								ok: false,
								aborted: true,
								createdMemories: [],
								skippedDuplicates: 0,
								summary: "已取消 AI 经验复盘",
							});
						}
						return;
					}
					throw err;
				} finally {
					cancellation.dispose();
				}
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
			const statusCode =
				error instanceof HttpRequestError ? error.statusCode : error instanceof MemoryValidationError ? 400 : 500;
			sendError(res, statusCode, message);
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
