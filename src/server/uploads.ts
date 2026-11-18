import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { basename, extname, join, resolve } from "node:path";
import type { PromptFileAttachment, PromptImageAttachment } from "../orchestrator/team-orchestrator.ts";
import type { PersonalAgentStore } from "../storage/repositories.ts";
import { HttpRequestError, MIME_TYPES, sendError } from "./http.ts";

const MAX_UPLOAD_IMAGES = 6;
const MAX_UPLOAD_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_UPLOAD_FILES = 6;
const MAX_UPLOAD_FILE_BYTES = 512 * 1024;
const MAX_FILE_PREVIEW_CHARS = 220;
const MAX_MEMORY_UPLOAD_CACHE = 128;

const IMAGE_EXTENSIONS: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/webp": ".webp",
	"image/gif": ".gif",
};

export interface ParsedUploadImage {
	data: string;
	mimeType: string;
	name: string;
	buffer: Buffer;
}

export interface ParsedUploadFile {
	kind: "file" | "pasted_text";
	name: string;
	mimeType: string;
	content: string;
	sizeBytes: number;
	lineCount: number;
	charCount: number;
	previewText: string;
	buffer: Buffer;
}

export function parseIncomingImages(raw: unknown): ParsedUploadImage[] {
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

function summarizeFilePreview(content: string): string {
	return content.replace(/\s+/g, " ").trim().slice(0, MAX_FILE_PREVIEW_CHARS);
}

function countLines(content: string): number {
	return content.split(/\r\n|\r|\n/).length;
}

export function parseIncomingFiles(raw: unknown): ParsedUploadFile[] {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) {
		throw new HttpRequestError(400, "files must be an array");
	}
	if (raw.length > MAX_UPLOAD_FILES) {
		throw new HttpRequestError(400, `At most ${MAX_UPLOAD_FILES} files per message are allowed`);
	}
	const parsed: ParsedUploadFile[] = [];
	for (let i = 0; i < raw.length; i += 1) {
		const item = raw[i];
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			throw new HttpRequestError(400, `Invalid file entry at index ${i}`);
		}
		const record = item as Record<string, unknown>;
		const content = typeof record.content === "string" ? record.content : "";
		if (!content.trim()) {
			throw new HttpRequestError(400, `Empty file content at index ${i}`);
		}
		if (content.includes("\0")) {
			throw new HttpRequestError(400, `Binary NUL bytes are not supported in file attachment at index ${i}`);
		}
		const buffer = Buffer.from(content, "utf8");
		if (buffer.byteLength > MAX_UPLOAD_FILE_BYTES) {
			throw new HttpRequestError(400, `File exceeds ${MAX_UPLOAD_FILE_BYTES / 1024}KB limit`);
		}
		const kind = record.kind === "pasted_text" ? "pasted_text" : "file";
		const rawMime = typeof record.mimeType === "string" ? record.mimeType.trim().toLowerCase() : "";
		const mimeType = rawMime || "text/plain";
		const rawName = typeof record.name === "string" ? basename(record.name.trim()).slice(0, 120) : "";
		const defaultName = kind === "pasted_text" ? `pasted-text-${i + 1}.txt` : `attachment-${i + 1}.txt`;
		parsed.push({
			kind,
			name: rawName || defaultName,
			mimeType,
			content,
			sizeBytes: buffer.byteLength,
			lineCount: countLines(content),
			charCount: content.length,
			previewText: summarizeFilePreview(content),
			buffer,
		});
	}
	return parsed;
}

async function persistUploadBytes(
	filename: string,
	buffer: Buffer,
	mimeType: string,
	uploadsDir: string | undefined,
	memoryUploads: Map<string, { buffer: Buffer; mimeType: string }>,
): Promise<void> {
	if (uploadsDir) {
		await mkdir(resolve(uploadsDir), { recursive: true });
		await writeFile(join(resolve(uploadsDir), filename), buffer);
		return;
	}
	memoryUploads.set(filename, { buffer, mimeType });
	while (memoryUploads.size > MAX_MEMORY_UPLOAD_CACHE) {
		const oldestKey = memoryUploads.keys().next().value;
		if (!oldestKey) break;
		memoryUploads.delete(oldestKey);
	}
}

export async function persistUploadedImages(
	items: ParsedUploadImage[],
	uploadsDir: string | undefined,
	memoryUploads: Map<string, { buffer: Buffer; mimeType: string }>,
): Promise<PromptImageAttachment[]> {
	if (items.length === 0) return [];
	const stored: PromptImageAttachment[] = [];
	for (const item of items) {
		const ext = IMAGE_EXTENSIONS[item.mimeType] ?? ".bin";
		const filename = `${Date.now()}-${randomUUID().slice(0, 8)}${ext}`;
		await persistUploadBytes(filename, item.buffer, item.mimeType, uploadsDir, memoryUploads);
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

export async function persistUploadedFiles(
	items: ParsedUploadFile[],
	uploadsDir: string | undefined,
	memoryUploads: Map<string, { buffer: Buffer; mimeType: string }>,
): Promise<PromptFileAttachment[]> {
	if (items.length === 0) return [];
	const stored: PromptFileAttachment[] = [];
	for (const item of items) {
		// Store uploaded text as .txt with nosniff delivery so raw HTML/JS/SVG attachments never execute in browser.
		const filename = `${Date.now()}-${randomUUID().slice(0, 8)}.txt`;
		await persistUploadBytes(filename, item.buffer, "text/plain; charset=utf-8", uploadsDir, memoryUploads);
		stored.push({
			type: "file",
			kind: item.kind,
			name: item.name,
			mimeType: item.mimeType,
			content: item.content,
			sizeBytes: item.sizeBytes,
			lineCount: item.lineCount,
			charCount: item.charCount,
			previewText: item.previewText,
			url: `/api/uploads/${filename}`,
		});
	}
	return stored;
}

export function recordStoredUploadsAcl(
	store: PersonalAgentStore,
	input: {
		orgId: string | null;
		matterId: string | null;
		uploaderUserId: string | null;
		images: PromptImageAttachment[];
		files: PromptFileAttachment[];
	},
): void {
	for (const img of input.images) {
		if (!img.url) continue;
		const filename = basename(img.url);
		store.recordUpload({
			filename,
			orgId: input.orgId,
			matterId: input.matterId,
			uploaderUserId: input.uploaderUserId,
			kind: "image",
			mimeType: img.mimeType,
		});
	}
	for (const file of input.files) {
		if (!file.url) continue;
		const filename = basename(file.url);
		store.recordUpload({
			filename,
			orgId: input.orgId,
			matterId: input.matterId,
			uploaderUserId: input.uploaderUserId,
			kind: file.kind,
			mimeType: file.mimeType,
		});
	}
}

async function readStoredUploadBuffer(
	url: string,
	uploadsDir: string | undefined,
	memoryUploads: Map<string, { buffer: Buffer; mimeType: string }>,
): Promise<Buffer | undefined> {
	if (!url.startsWith("/api/uploads/")) return undefined;
	const filename = url.slice("/api/uploads/".length);
	if (!/^[a-zA-Z0-9._-]+$/.test(filename)) return undefined;
	if (uploadsDir) {
		const filePath = join(resolve(uploadsDir), filename);
		if (existsSync(filePath)) {
			return await readFile(filePath);
		}
	}
	return memoryUploads.get(filename)?.buffer;
}

export async function loadStoredImagesFromRefs(
	rawRefs: unknown,
	uploadsDir: string | undefined,
	memoryUploads: Map<string, { buffer: Buffer; mimeType: string }>,
): Promise<PromptImageAttachment[]> {
	if (!Array.isArray(rawRefs)) return [];
	const loaded: PromptImageAttachment[] = [];
	for (const item of rawRefs) {
		if (!item || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		const url = typeof record.url === "string" ? record.url.trim() : "";
		const mimeType = typeof record.mimeType === "string" ? record.mimeType.trim() : "image/png";
		const name = typeof record.name === "string" ? record.name.trim() : undefined;
		const buffer = await readStoredUploadBuffer(url, uploadsDir, memoryUploads);
		if (!buffer) continue;
		loaded.push({
			type: "image",
			data: buffer.toString("base64"),
			mimeType,
			name,
			url,
		});
	}
	return loaded;
}

export async function loadStoredFilesFromRefs(
	rawRefs: unknown,
	uploadsDir: string | undefined,
	memoryUploads: Map<string, { buffer: Buffer; mimeType: string }>,
): Promise<PromptFileAttachment[]> {
	if (!Array.isArray(rawRefs)) return [];
	const loaded: PromptFileAttachment[] = [];
	for (const item of rawRefs) {
		if (!item || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		const url = typeof record.url === "string" ? record.url.trim() : "";
		const mimeType = typeof record.mimeType === "string" ? record.mimeType.trim() : "text/plain";
		const name = typeof record.name === "string" ? record.name.trim() : "attachment.txt";
		const kind = record.kind === "pasted_text" ? "pasted_text" : "file";
		const buffer = await readStoredUploadBuffer(url, uploadsDir, memoryUploads);
		if (!buffer) continue;
		const content = buffer.toString("utf8");
		loaded.push({
			type: "file",
			kind,
			name,
			mimeType,
			content,
			sizeBytes: buffer.byteLength,
			lineCount: typeof record.lineCount === "number" ? record.lineCount : countLines(content),
			charCount: typeof record.charCount === "number" ? record.charCount : content.length,
			previewText: typeof record.previewText === "string" ? record.previewText : summarizeFilePreview(content),
			url,
		});
	}
	return loaded;
}

export async function handleUploadGet(
	res: ServerResponse,
	filename: string,
	uploadsDir: string | undefined,
	memoryUploads: Map<string, { buffer: Buffer; mimeType: string }>,
): Promise<void> {
	const ext = extname(filename).toLowerCase();
	const mime = ext === ".txt" ? "text/plain; charset=utf-8" : MIME_TYPES[ext];
	if (!mime || (!mime.startsWith("image/") && ext !== ".txt")) {
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
				"X-Content-Type-Options": "nosniff",
			});
			res.end(content);
			return;
		}
	}
	const memEntry = memoryUploads.get(filename);
	if (memEntry) {
		res.writeHead(200, {
			"Content-Type": ext === ".txt" ? "text/plain; charset=utf-8" : memEntry.mimeType,
			"Content-Length": memEntry.buffer.byteLength,
			"Cache-Control": "public, max-age=31536000, immutable",
			"X-Content-Type-Options": "nosniff",
		});
		res.end(memEntry.buffer);
		return;
	}
	sendError(res, 404, "Upload not found");
}
