import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { basename, extname, join, resolve } from "node:path";
import type { PromptImageAttachment } from "../orchestrator/team-orchestrator.ts";
import { HttpRequestError, MIME_TYPES, sendError } from "./http.ts";

const MAX_UPLOAD_IMAGES = 6;
const MAX_UPLOAD_IMAGE_BYTES = 5 * 1024 * 1024;
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

export async function persistUploadedImages(
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
		if (!url.startsWith("/api/uploads/")) continue;
		const filename = url.slice("/api/uploads/".length);
		if (!/^[a-zA-Z0-9._-]+$/.test(filename)) continue;
		let buffer: Buffer | undefined;
		if (uploadsDir) {
			const filePath = join(resolve(uploadsDir), filename);
			if (existsSync(filePath)) {
				buffer = await readFile(filePath);
			}
		}
		if (!buffer) {
			buffer = memoryUploads.get(filename)?.buffer;
		}
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

export async function handleUploadGet(
	res: ServerResponse,
	filename: string,
	uploadsDir: string | undefined,
	memoryUploads: Map<string, { buffer: Buffer; mimeType: string }>,
): Promise<void> {
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
}
