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

interface ComposerDraft {
	text: string;
	images: ComposerImageAttachment[];
	files: ComposerFileAttachment[];
}

const EMPTY_DRAFT: ComposerDraft = { text: "", images: [], files: [] };

/** Owns draft text, attachments, and conversion between pasted text and files. */
export function useComposerDraft(
	draftKey: string,
	composerRef: RefObject<HTMLTextAreaElement | null>,
	setErrorBanner: (message: string | null) => void,
) {
	const sessionRef = useRef(0);
	const [{ session, drafts }, setDraftState] = useState(() => ({
		session: 0,
		drafts: new Map<string, ComposerDraft>(),
	}));
	const { text: composerText, images: composerImages, files: composerFiles } = drafts.get(draftKey) ?? EMPTY_DRAFT;

	const updateDraft = useCallback(
		(update: (draft: ComposerDraft) => ComposerDraft, targetKey = draftKey) => {
			setDraftState((current) => {
				if (current.session !== session) return current;
				const previous = current.drafts.get(targetKey) ?? EMPTY_DRAFT;
				const next = update(previous);
				if (next === previous) return current;
				const drafts = new Map(current.drafts);
				if (next.text || next.images.length || next.files.length) drafts.set(targetKey, next);
				else drafts.delete(targetKey);
				return { session, drafts };
			});
		},
		[draftKey, session],
	);
	const resetComposerDrafts = useCallback(() => {
		sessionRef.current += 1;
		setDraftState({ session: sessionRef.current, drafts: new Map() });
	}, []);

	const setComposerText = useCallback((text: string) => updateDraft((draft) => ({ ...draft, text })), [updateDraft]);
	const appendComposerText = useCallback(
		(text: string, targetKey = draftKey) => {
			updateDraft((draft) => ({ ...draft, text: draft.text.trim() ? `${draft.text}\n\n${text}` : text }), targetKey);
		},
		[draftKey, updateDraft],
	);

	const clearSentComposer = useCallback(() => {
		const sentImageIds = new Set(composerImages.map(({ id }) => id));
		const sentFileIds = new Set(composerFiles.map(({ id }) => id));
		updateDraft((draft) => ({
			text: draft.text === composerText ? "" : draft.text,
			images: draft.images.filter(({ id }) => !sentImageIds.has(id)),
			files: draft.files.filter(({ id }) => !sentFileIds.has(id)),
		}));
	}, [composerText, composerImages, composerFiles, updateDraft]);

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
				const res = await prepareComposerImages(imageFiles, composerImages.length);
				if (res.attachments.length > 0) {
					updateDraft((draft) => ({
						...draft,
						images: [...draft.images, ...res.attachments].slice(0, MAX_COMPOSER_IMAGES),
					}));
				}
				warnings.push(...res.warnings);
			}
			if (docFiles.length > 0) {
				const res = await prepareComposerFiles(docFiles, composerFiles.length);
				if (res.attachments.length > 0) {
					updateDraft((draft) => ({
						...draft,
						files: [...draft.files, ...res.attachments].slice(0, MAX_COMPOSER_FILES),
					}));
				}
				warnings.push(...res.warnings);
			}
			if (sessionRef.current === session && warnings[0]) setErrorBanner(warnings[0]);
		},
		[composerImages.length, composerFiles.length, session, setErrorBanner, updateDraft],
	);

	const handleAddPastedText = useCallback(
		(text: string) => {
			if (composerFiles.length >= MAX_COMPOSER_FILES) {
				setErrorBanner(`每次最多附带 ${MAX_COMPOSER_FILES} 个文本文件或长文本片段`);
				return;
			}
			const pastedIndex = composerFiles.filter((item) => item.kind === "pasted_text").length + 1;
			const attachment = createPastedTextAttachment(text, pastedIndex);
			if (attachment.sizeBytes > MAX_COMPOSER_FILE_BYTES) {
				setErrorBanner(`粘贴文本超过 512KB 上限，请分段后再发送`);
				return;
			}
			updateDraft((draft) => ({ ...draft, files: [...draft.files, attachment].slice(0, MAX_COMPOSER_FILES) }));
		},
		[composerFiles, setErrorBanner, updateDraft],
	);

	const handleRemoveComposerImage = useCallback(
		(imageId: string) =>
			updateDraft((draft) => ({ ...draft, images: draft.images.filter(({ id }) => id !== imageId) })),
		[updateDraft],
	);
	const handleRemoveComposerFile = useCallback(
		(fileId: string) => updateDraft((draft) => ({ ...draft, files: draft.files.filter(({ id }) => id !== fileId) })),
		[updateDraft],
	);

	const handleExpandPastedFile = useCallback(
		(fileId: string) => {
			updateDraft((draft) => {
				const target = draft.files.find((item) => item.id === fileId);
				if (!target) return draft;
				return {
					...draft,
					files: draft.files.filter((item) => item.id !== fileId),
					text: draft.text.trim() ? `${draft.text}\n${target.content}` : target.content,
				};
			});
			composerRef.current?.focus();
		},
		[composerRef, updateDraft],
	);

	return {
		composerText,
		setComposerText,
		appendComposerText,
		composerImages,
		composerFiles,
		clearSentComposer,
		resetComposerDrafts,
		composerAttachmentText,
		handleAddComposerAttachments,
		handleAddPastedText,
		handleRemoveComposerImage,
		handleRemoveComposerFile,
		handleExpandPastedFile,
	};
}
