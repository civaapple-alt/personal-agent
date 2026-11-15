import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve } from "node:path";

const MAX_JSON_BODY_BYTES = 36 * 1024 * 1024;

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

	constructor(statusCode: number, message: string) {
		super(message);
		this.statusCode = statusCode;
	}
}

export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
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

export function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
	const body = JSON.stringify(data);
	res.writeHead(statusCode, {
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

export async function serveStaticAsset(
	res: ServerResponse,
	pathname: string,
	webDistDir: string | undefined,
): Promise<boolean> {
	if (!webDistDir || !existsSync(webDistDir)) return false;
	const safeRel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
	const targetPath = resolve(webDistDir, safeRel);
	if (targetPath.startsWith(resolve(webDistDir)) && existsSync(targetPath)) {
		const content = await readFile(targetPath);
		const mime = MIME_TYPES[extname(targetPath)] ?? "application/octet-stream";
		res.writeHead(200, { "Content-Type": mime, "Content-Length": content.byteLength });
		res.end(content);
		return true;
	}
	const indexHtml = join(webDistDir, "index.html");
	if (existsSync(indexHtml) && !pathname.startsWith("/api/")) {
		const content = await readFile(indexHtml);
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": content.byteLength });
		res.end(content);
		return true;
	}
	return false;
}
