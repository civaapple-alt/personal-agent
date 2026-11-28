import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve } from "node:path";

const MAX_JSON_BODY_BYTES = 36 * 1024 * 1024;
const rawBodyCache = new WeakMap<IncomingMessage, Buffer>();

export const MIME_TYPES: Record<string, string> = {
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

/** HTTP error with explicit status code propagated to JSON error responses. */
export class HttpRequestError extends Error {
	statusCode: number;
	code?: string;

	constructor(statusCode: number, message: string, code?: string) {
		super(message);
		this.statusCode = statusCode;
		if (code) this.code = code;
	}
}

/** Read and memoize the raw request body (capped at 36MB) so multiple adapters can inspect it safely. */
export async function readRawBody(req: IncomingMessage): Promise<Buffer> {
	const cached = rawBodyCache.get(req);
	if (cached) return cached;
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
	const combined = Buffer.concat(chunks);
	rawBodyCache.set(req, combined);
	return combined;
}

export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	const rawBuffer = await readRawBody(req);
	const raw = rawBuffer.toString("utf8").trim();
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

export const BASE_SECURITY_HEADERS: Record<string, string> = {
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options": "DENY",
	"Referrer-Policy": "no-referrer",
};

export function isAllowedMutatingOrigin(req: IncomingMessage): boolean {
	const method = (req.method ?? "GET").toUpperCase();
	if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;
	const origin = req.headers.origin;
	if (!origin || typeof origin !== "string") return true;
	const host = req.headers.host;
	if (!host || typeof host !== "string") return false;
	try {
		const originUrl = new URL(origin);
		return originUrl.host.toLowerCase() === host.trim().toLowerCase();
	} catch {
		return false;
	}
}

export function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
	const body = JSON.stringify(data);
	res.writeHead(statusCode, {
		...BASE_SECURITY_HEADERS,
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(body),
	});
	res.end(body);
}

export function sendError(res: ServerResponse, statusCode: number, message: string): void {
	sendJson(res, statusCode, { error: message });
}

export function responseCancellation(res: ServerResponse): { signal: AbortSignal; dispose: () => void } {
	const controller = new AbortController();
	const onClose = () => {
		if (!res.writableEnded) controller.abort();
	};
	res.on("close", onClose);
	return { signal: controller.signal, dispose: () => res.off("close", onClose) };
}

function escapeHtmlText(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function sendAssetBuffer(res: ServerResponse, content: Buffer, mime: string, documentTitle?: string): void {
	let payload = content;
	if (documentTitle && mime.startsWith("text/html")) {
		const html = content.toString("utf8");
		const nextHtml = /<title>[\s\S]*?<\/title>/i.test(html)
			? html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtmlText(documentTitle)}</title>`)
			: html;
		payload = Buffer.from(nextHtml, "utf8");
	}
	res.writeHead(200, {
		...BASE_SECURITY_HEADERS,
		"Cache-Control": "no-store",
		"Content-Type": mime,
		"Content-Length": payload.byteLength,
	});
	res.end(payload);
}

export async function serveStaticAsset(
	res: ServerResponse,
	pathname: string,
	webDistDir: string | undefined,
	options?: { documentTitle?: string },
): Promise<boolean> {
	if (!webDistDir || !existsSync(webDistDir)) return false;
	const safeRel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
	const targetPath = resolve(webDistDir, safeRel);
	if (targetPath.startsWith(resolve(webDistDir)) && existsSync(targetPath)) {
		const content = await readFile(targetPath);
		const mime = MIME_TYPES[extname(targetPath)] ?? "application/octet-stream";
		sendAssetBuffer(res, content, mime, options?.documentTitle);
		return true;
	}
	const indexHtml = join(webDistDir, "index.html");
	if (existsSync(indexHtml) && !pathname.startsWith("/api/")) {
		const content = await readFile(indexHtml);
		sendAssetBuffer(res, content, "text/html; charset=utf-8", options?.documentTitle);
		return true;
	}
	return false;
}
