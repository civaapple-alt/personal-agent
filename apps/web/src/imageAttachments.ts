import type { ComposerFileAttachment, ComposerImageAttachment } from "./api.ts";
import {
	COMPOSER_FILE_ACCEPT,
	createPastedTextAttachment,
	isSupportedImageDescriptor,
	LARGE_PASTE_CHAR_THRESHOLD,
	LARGE_PASTE_LINE_THRESHOLD,
	MAX_COMPOSER_FILE_BYTES,
	MAX_COMPOSER_FILES,
	prepareComposerTextFiles,
	resolveSupportedImageMimeType,
	shouldFoldPastedText,
} from "./textAttachments.ts";

export {
	COMPOSER_FILE_ACCEPT,
	createPastedTextAttachment,
	LARGE_PASTE_CHAR_THRESHOLD,
	LARGE_PASTE_LINE_THRESHOLD,
	MAX_COMPOSER_FILE_BYTES,
	MAX_COMPOSER_FILES,
	shouldFoldPastedText,
};

export const MAX_COMPOSER_IMAGES = 6;

const MAX_RAW_FILE_BYTES = 20 * 1024 * 1024;
const MAX_ENCODED_IMAGE_BYTES = 4.5 * 1024 * 1024;
const PASS_THROUGH_BYTES = 1.2 * 1024 * 1024;
const MAX_EDGE_PX = 2048;

export function isSupportedImageFile(file: File): boolean {
	return isSupportedImageDescriptor(file);
}

export async function prepareComposerFiles(
	files: FileList | File[],
	existingCount: number,
): Promise<{ attachments: ComposerFileAttachment[]; warnings: string[] }> {
	return prepareComposerTextFiles(Array.from(files), existingCount);
}

function readFileAsDataUrl(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			if (typeof reader.result === "string") resolve(reader.result);
			else reject(new Error("无法读取图片内容"));
		};
		reader.onerror = () => reject(new Error(`读取图片「${file.name}」失败`));
		reader.readAsDataURL(file);
	});
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error("图片解码失败，请确认文件未损坏"));
		img.src = src;
	});
}

function estimateBase64Bytes(base64: string): number {
	const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
	return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

function splitDataUrl(dataUrl: string, fallbackMime: string): { mimeType: string; data: string; previewUrl: string } {
	const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
	if (!match) {
		throw new Error("无效的图片编码格式");
	}
	return {
		mimeType: match[1] || fallbackMime,
		data: match[2]!,
		previewUrl: dataUrl,
	};
}

async function downsizeImageDataUrl(
	sourceDataUrl: string,
	originalMime: string,
): Promise<{ mimeType: string; data: string; previewUrl: string }> {
	const img = await loadImageElement(sourceDataUrl);
	const naturalWidth = img.naturalWidth || img.width;
	const naturalHeight = img.naturalHeight || img.height;
	if (!naturalWidth || !naturalHeight) {
		return splitDataUrl(sourceDataUrl, originalMime);
	}

	const preferredOutMime = originalMime === "image/png" ? "image/webp" : "image/jpeg";
	const attempts: Array<{ maxEdge: number; quality: number }> = [
		{ maxEdge: MAX_EDGE_PX, quality: 0.88 },
		{ maxEdge: 1600, quality: 0.82 },
		{ maxEdge: 1280, quality: 0.76 },
	];

	for (const attempt of attempts) {
		const scale = Math.min(1, attempt.maxEdge / Math.max(naturalWidth, naturalHeight));
		const width = Math.max(1, Math.round(naturalWidth * scale));
		const height = Math.max(1, Math.round(naturalHeight * scale));
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext("2d");
		if (!ctx) break;
		ctx.drawImage(img, 0, 0, width, height);

		const encoded = canvas.toDataURL(preferredOutMime, attempt.quality);
		const parsed = splitDataUrl(encoded, preferredOutMime);
		if (estimateBase64Bytes(parsed.data) <= MAX_ENCODED_IMAGE_BYTES) {
			return parsed;
		}
	}

	return splitDataUrl(sourceDataUrl, originalMime);
}

/**
 * Validates, resizes when oversized, and encodes browser-selected/dropped/pasted
 * images into attachments ready for preview and JSON upload.
 */
export async function prepareComposerImages(
	files: FileList | File[],
	existingCount: number,
): Promise<{ attachments: ComposerImageAttachment[]; warnings: string[] }> {
	const list = Array.from(files);
	const warnings: string[] = [];
	const attachments: ComposerImageAttachment[] = [];
	const availableSlots = Math.max(0, MAX_COMPOSER_IMAGES - existingCount);

	if (availableSlots === 0 && list.length > 0) {
		return { attachments: [], warnings: [`每条消息最多附带 ${MAX_COMPOSER_IMAGES} 张图片`] };
	}

	for (const file of list) {
		if (attachments.length >= availableSlots) {
			warnings.push(`最多附带 ${MAX_COMPOSER_IMAGES} 张图片，已忽略多余文件`);
			break;
		}
		const mimeType = resolveSupportedImageMimeType(file);
		if (!mimeType) {
			warnings.push(`不支持「${file.name || "未命名文件"}」（仅支持 PNG / JPG / WebP / GIF）`);
			continue;
		}
		if (file.size === 0) {
			warnings.push(`「${file.name || "图片"}」为空文件，已跳过`);
			continue;
		}
		if (file.size > MAX_RAW_FILE_BYTES) {
			warnings.push(`「${file.name || "图片"}」超过 20MB，请压缩后再上传`);
			continue;
		}

		try {
			const rawDataUrl = await readFileAsDataUrl(file);
			const shouldKeepOriginal = mimeType === "image/gif" || file.size <= PASS_THROUGH_BYTES;
			const encoded = shouldKeepOriginal
				? splitDataUrl(rawDataUrl, mimeType)
				: await downsizeImageDataUrl(rawDataUrl, mimeType);
			const sizeBytes = estimateBase64Bytes(encoded.data);
			if (sizeBytes > MAX_ENCODED_IMAGE_BYTES) {
				warnings.push(`「${file.name || "图片"}」压缩后仍超过 4.5MB 限制，已跳过`);
				continue;
			}
			attachments.push({
				id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				mimeType: encoded.mimeType,
				data: encoded.data,
				previewUrl: encoded.previewUrl,
				name: file.name || `image-${attachments.length + 1}`,
				sizeBytes,
			});
		} catch (error: unknown) {
			warnings.push(error instanceof Error ? error.message : `处理「${file.name}」失败`);
		}
	}

	return { attachments, warnings };
}
