import { type RefObject, useCallback, useMemo, useRef, useState } from "react";
import type { ComposerFileAttachment, ComposerImageAttachment } from "../api/matters.ts";
import {
	createPastedTextAttachment,
	isSupportedImageFile,
	MAX_COMPOSER_FILE_BYTES,
	MAX_COMPOSER_FILES,
	MAX_COMPOSER_IMAGES,
	prepareComposerFiles,
	prepareComposerImages,
} from "../imageAttachments.ts";

/** Owns draft text, attachments, and conversion between pasted text and files. */
export function useComposerDraft(
	composerRef: RefObject<HTMLTextAreaElement | null>,
	setErrorBanner: (message: string | null) => void,
) {
	const [composerText, setComposerText] = useState("");
	const [composerImages, setComposerImages] = useState<ComposerImageAttachment[]>([]);
	const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
	composerImagesRef.current = composerImages;
	const [composerFiles, setComposerFiles] = useState<ComposerFileAttachment[]>([]);
	const composerFilesRef = useRef<ComposerFileAttachment[]>([]);
	composerFilesRef.current = composerFiles;

	const composerAttachmentText = useMemo(
		() =>
			composerFiles
				.map((item) => item.content)
				.join("\n")
				.slice(0, 1200),
		[composerFiles],
	);

	const handleAddComposerAttachments = useCallback(
		async (files: FileList | File[]) => {
			const incoming = Array.from(files ?? []);
			if (incoming.length === 0) return;
			const imageFiles: File[] = [];
			const docFiles: File[] = [];
			for (const file of incoming) {
				if (isSupportedImageFile(file)) {
					imageFiles.push(file);
				} else {
					docFiles.push(file);
				}
			}
			const warnings: string[] = [];
			if (imageFiles.length > 0) {
				const res = await prepareComposerImages(imageFiles, composerImagesRef.current.length);
				if (res.attachments.length > 0) {
					setComposerImages((prev) => [...prev, ...res.attachments].slice(0, MAX_COMPOSER_IMAGES));
				}
				warnings.push(...res.warnings);
			}
			if (docFiles.length > 0) {
				const res = await prepareComposerFiles(docFiles, composerFilesRef.current.length);
				if (res.attachments.length > 0) {
					setComposerFiles((prev) => [...prev, ...res.attachments].slice(0, MAX_COMPOSER_FILES));
				}
				warnings.push(...res.warnings);
			}
			if (warnings.length > 0) {
				setErrorBanner(warnings[0]!);
			}
		},
		[setErrorBanner],
	);

	const handleAddPastedText = useCallback(
		(text: string) => {
			if (composerFilesRef.current.length >= MAX_COMPOSER_FILES) {
				setErrorBanner(`每次最多附带 ${MAX_COMPOSER_FILES} 个文本文件或长文本片段`);
				return;
			}
			const pastedIndex = composerFilesRef.current.filter((item) => item.kind === "pasted_text").length + 1;
			const attachment = createPastedTextAttachment(text, pastedIndex);
			if (attachment.sizeBytes > MAX_COMPOSER_FILE_BYTES) {
				setErrorBanner(`粘贴文本超过 512KB 上限，请分段后再发送`);
				return;
			}
			setComposerFiles((prev) => [...prev, attachment].slice(0, MAX_COMPOSER_FILES));
		},
		[setErrorBanner],
	);

	const handleRemoveComposerImage = useCallback((imageId: string) => {
		setComposerImages((prev) => prev.filter((item) => item.id !== imageId));
	}, []);

	const handleRemoveComposerFile = useCallback((fileId: string) => {
		setComposerFiles((prev) => prev.filter((item) => item.id !== fileId));
	}, []);

	const handleExpandPastedFile = useCallback(
		(fileId: string) => {
			const target = composerFilesRef.current.find((item) => item.id === fileId);
			if (!target) return;
			setComposerFiles((prev) => prev.filter((item) => item.id !== fileId));
			setComposerText((prev) => (prev.trim() ? `${prev}\n${target.content}` : target.content));
			composerRef.current?.focus();
		},
		[composerRef],
	);

	return {
		composerText,
		setComposerText,
		composerImages,
		setComposerImages,
		composerFiles,
		setComposerFiles,
		composerAttachmentText,
		handleAddComposerAttachments,
		handleAddPastedText,
		handleRemoveComposerImage,
		handleRemoveComposerFile,
		handleExpandPastedFile,
	};
}
