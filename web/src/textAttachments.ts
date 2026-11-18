import type { ComposerFileAttachment } from "./api.ts";

export const MAX_COMPOSER_FILES = 6;
export const MAX_COMPOSER_FILE_BYTES = 512 * 1024;
export const LARGE_PASTE_CHAR_THRESHOLD = 600;
export const LARGE_PASTE_LINE_THRESHOLD = 10;
export const COMPOSER_FILE_ACCEPT =
	"image/png,image/jpeg,image/webp,image/gif,.txt,.md,.markdown,.json,.csv,.tsv,.log,.yaml,.yml,.toml,.ini,.xml,.html,.css,.js,.jsx,.mjs,.cjs,.ts,.tsx,.py,.go,.rs,.java,.kt,.swift,.c,.cpp,.h,.sh,.sql";

export interface TextFileLike {
	name: string;
	size: number;
	type: string;
	arrayBuffer(): Promise<ArrayBuffer>;
}

const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

const IMAGE_EXT_TO_MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
};

const TEXT_MIME_BY_EXT: Record<string, string> = {
	txt: "text/plain",
	log: "text/plain",
	md: "text/markdown",
	markdown: "text/markdown",
	json: "application/json",
	csv: "text/csv",
	tsv: "text/tab-separated-values",
	yaml: "text/yaml",
	yml: "text/yaml",
	toml: "text/plain",
	ini: "text/plain",
	xml: "application/xml",
	html: "text/html",
	css: "text/css",
	js: "text/javascript",
	jsx: "text/javascript",
	mjs: "text/javascript",
	cjs: "text/javascript",
	ts: "text/typescript",
	tsx: "text/typescript",
	py: "text/x-python",
	go: "text/plain",
	rs: "text/plain",
	java: "text/plain",
	kt: "text/plain",
	swift: "text/plain",
	c: "text/plain",
	cpp: "text/plain",
	h: "text/plain",
	sh: "text/x-shellscript",
	sql: "application/sql",
};

const BINARY_EXTS = new Set([
	"pdf",
	"zip",
	"gz",
	"tar",
	"7z",
	"rar",
	"exe",
	"dmg",
	"pkg",
	"doc",
	"docx",
	"xls",
	"xlsx",
	"ppt",
	"pptx",
	"mp3",
	"mp4",
	"mov",
	"avi",
	"wav",
	"woff",
	"woff2",
	"ttf",
]);

/** Resolves a supported raster image MIME type from file descriptor metadata or filename extension. */
export function resolveSupportedImageMimeType(file: { name: string; type: string }): string | null {
	const raw = file.type.trim().toLowerCase();
	const normalized = raw === "image/jpg" ? "image/jpeg" : raw;
	if (SUPPORTED_IMAGE_MIME_TYPES.has(normalized)) return normalized;
	const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
	return IMAGE_EXT_TO_MIME[ext] ?? null;
}

/** Returns true when a file descriptor represents a supported composer image. */
export function isSupportedImageDescriptor(file: { name: string; type: string }): boolean {
	return resolveSupportedImageMimeType(file) !== null;
}

/** Returns true when pasted text is long enough to fold into a previewable composer chip. */
export function shouldFoldPastedText(text: string): boolean {
	if (text.length >= LARGE_PASTE_CHAR_THRESHOLD) return true;
	const lineCount = text.split(/\r\n|\r|\n/).length;
	return lineCount >= LARGE_PASTE_LINE_THRESHOLD;
}

/** Builds a client-side attachment item representing a folded multi-line or large clipboard paste. */
export function createPastedTextAttachment(text: string, index = 1): ComposerFileAttachment {
	const normalized = text.replace(/\r\n/g, "\n");
	const bytes = new TextEncoder().encode(normalized).byteLength;
	const lineCount = normalized.split("\n").length;
	const previewText = normalized.replace(/\s+/g, " ").trim().slice(0, 140);
	return {
		id: `paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		kind: "pasted_text",
		name: `pasted-text-${index}.txt`,
		mimeType: "text/plain",
		content: normalized,
		sizeBytes: bytes,
		lineCount,
		charCount: normalized.length,
		previewText,
	};
}

/** Validates and decodes UTF-8 text or code files for composer upload, rejecting binaries and oversized payloads. */
export async function prepareComposerTextFiles(
	files: readonly TextFileLike[],
	existingCount: number,
): Promise<{ attachments: ComposerFileAttachment[]; warnings: string[] }> {
	const warnings: string[] = [];
	const attachments: ComposerFileAttachment[] = [];
	const availableSlots = Math.max(0, MAX_COMPOSER_FILES - existingCount);

	if (availableSlots === 0 && files.length > 0) {
		return { attachments: [], warnings: [`每条消息最多附带 ${MAX_COMPOSER_FILES} 个文件或长文本片段`] };
	}

	const decoder = new TextDecoder("utf-8", { fatal: true });
	for (const file of files) {
		if (attachments.length >= availableSlots) {
			warnings.push(`最多附带 ${MAX_COMPOSER_FILES} 个文件，已忽略多余文件`);
			break;
		}
		const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
		if (BINARY_EXTS.has(ext)) {
			warnings.push(`暂不支持二进制文件「${file.name}」，请上传文本、代码、Markdown、JSON、CSV 或图片`);
			continue;
		}
		if (file.size === 0) {
			warnings.push(`「${file.name || "文件"}」为空文件，已跳过`);
			continue;
		}
		if (file.size > MAX_COMPOSER_FILE_BYTES) {
			warnings.push(`「${file.name}」超过 512KB 上限，请拆分后再上传`);
			continue;
		}
		try {
			const buffer = await file.arrayBuffer();
			const content = decoder.decode(new Uint8Array(buffer));
			if (content.includes("\0")) {
				warnings.push(`「${file.name}」包含二进制内容，暂不支持作为文本附件`);
				continue;
			}
			if (!content.trim()) {
				warnings.push(`「${file.name}」仅包含空白字符，已跳过`);
				continue;
			}
			const mimeType = file.type.trim() || TEXT_MIME_BY_EXT[ext] || "text/plain";
			const lineCount = content.split(/\r\n|\r|\n/).length;
			attachments.push({
				id: `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				kind: "file",
				name: file.name || `attachment-${attachments.length + 1}.txt`,
				mimeType,
				content,
				sizeBytes: buffer.byteLength,
				lineCount,
				charCount: content.length,
				previewText: content.replace(/\s+/g, " ").trim().slice(0, 140),
			});
		} catch {
			warnings.push(`无法以 UTF-8 文本读取「${file.name}」，暂不支持该文件格式`);
		}
	}

	return { attachments, warnings };
}
