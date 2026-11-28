import { useCallback, useEffect, useRef, useState } from "react";
import { copyTextToClipboard } from "../../clipboard.ts";
import { Button, ModalDialog } from "../../primitives/index.ts";
import { formatByteSize } from "../../utils/formatters.ts";
import type { PreviewableTextAttachment } from "./ComposerDock.tsx";

export interface PreviewFileState {
	file: PreviewableTextAttachment;
	loading: boolean;
	error: string | null;
}

export interface LightboxImageState {
	src: string;
	alt: string;
}

/** Manages image lightbox and abortable text/pasted-text attachment previews for ChatStage. */
export function useAttachmentPreview() {
	const [lightboxImage, setLightboxImage] = useState<LightboxImageState | null>(null);
	const [previewFile, setPreviewFile] = useState<PreviewFileState | null>(null);
	const fetchAbortRef = useRef<AbortController | null>(null);

	const abortPendingFetch = useCallback(() => {
		fetchAbortRef.current?.abort();
		fetchAbortRef.current = null;
	}, []);

	const closeFilePreview = useCallback(() => {
		abortPendingFetch();
		setPreviewFile(null);
	}, [abortPendingFetch]);

	const openFilePreview = useCallback(
		(file: PreviewableTextAttachment) => {
			abortPendingFetch();
			if (typeof file.content === "string") {
				setPreviewFile({ file, loading: false, error: null });
				return;
			}
			if (!file.url) {
				setPreviewFile({ file, loading: false, error: "文件内容不可用。" });
				return;
			}
			const controller = new AbortController();
			fetchAbortRef.current = controller;
			setPreviewFile({ file, loading: true, error: null });
			void fetch(file.url, { signal: controller.signal })
				.then(async (res) => {
					if (!res.ok) throw new Error(`HTTP ${res.status}`);
					return await res.text();
				})
				.then((text) => {
					if (controller.signal.aborted) return;
					setPreviewFile((prev) =>
						prev && prev.file.url === file.url
							? { ...prev, file: { ...prev.file, content: text }, loading: false }
							: prev,
					);
				})
				.catch((err) => {
					if (controller.signal.aborted) return;
					setPreviewFile((prev) =>
						prev && prev.file.url === file.url
							? {
									...prev,
									loading: false,
									error: err instanceof Error ? err.message : "读取文件内容失败。",
								}
							: prev,
					);
				});
		},
		[abortPendingFetch],
	);

	useEffect(() => () => abortPendingFetch(), [abortPendingFetch]);

	useEffect(() => {
		if (!lightboxImage) return;
		const onKeyDown = (event: globalThis.KeyboardEvent) => {
			if (event.key === "Escape") {
				setLightboxImage(null);
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [lightboxImage]);

	return {
		lightboxImage,
		setLightboxImage,
		previewFile,
		openFilePreview,
		closeFilePreview,
	};
}

interface AttachmentPreviewModalsProps {
	lightboxImage: LightboxImageState | null;
	previewFile: PreviewFileState | null;
	onCloseLightbox: () => void;
	onCloseFilePreview: () => void;
	onExpandPastedFile: (fileId: string) => void;
	onNotice: (message: string) => void;
}

/** Renders the image lightbox and text/pasted-text preview modal dialogs for ChatStage. */
export function AttachmentPreviewModals({
	lightboxImage,
	previewFile,
	onCloseLightbox,
	onCloseFilePreview,
	onExpandPastedFile,
	onNotice,
}: AttachmentPreviewModalsProps) {
	return (
		<>
			{lightboxImage && (
				<div className="fixed inset-0 z-60 bg-black/75 flex items-center justify-center p-6">
					<button
						type="button"
						className="absolute inset-0 border-0 p-0 m-0 bg-transparent cursor-pointer"
						aria-label="关闭预览"
						onClick={onCloseLightbox}
					/>
					<div
						className="relative z-10 bg-card border border-line rounded-lg p-3 max-w-[min(92vw,960px)] max-h-[90vh] flex flex-col gap-2.5 shadow-lg"
						role="dialog"
						aria-modal="true"
						aria-label="图片预览"
					>
						<img
							src={lightboxImage.src}
							alt={lightboxImage.alt}
							className="max-w-full max-h-[calc(90vh-76px)] object-contain rounded-md bg-subtle"
						/>
						<div className="flex items-center justify-between gap-3 text-sm text-ink-secondary">
							<span className="truncate">{lightboxImage.alt}</span>
							<Button variant="inline" size="xs" onClick={onCloseLightbox}>
								关闭
							</Button>
						</div>
					</div>
				</div>
			)}

			<ModalDialog
				open={previewFile !== null}
				title={previewFile?.file.name ?? ""}
				subtitle={
					previewFile
						? [
								previewFile.file.kind === "pasted_text" ? "折叠粘贴文本" : "文本文件",
								previewFile.file.lineCount !== undefined ? `${previewFile.file.lineCount} 行` : null,
								previewFile.file.charCount !== undefined
									? `${previewFile.file.charCount.toLocaleString()} 字`
									: null,
								previewFile.file.sizeBytes !== undefined ? formatByteSize(previewFile.file.sizeBytes) : null,
							]
								.filter(Boolean)
								.join(" · ")
						: undefined
				}
				size="lg"
				onClose={onCloseFilePreview}
				footer={
					previewFile ? (
						<>
							{previewFile.file.pendingPastedId && (
								<Button
									variant="inline"
									size="xs"
									onClick={() => {
										const id = previewFile.file.pendingPastedId;
										onCloseFilePreview();
										if (id) onExpandPastedFile(id);
									}}
								>
									放回输入框
								</Button>
							)}
							{typeof previewFile.file.content === "string" && (
								<Button
									variant="inline"
									size="xs"
									onClick={() => {
										void copyTextToClipboard(previewFile.file.content ?? "", "附件文本", onNotice);
									}}
								>
									复制内容
								</Button>
							)}
							<Button variant="inline" size="xs" onClick={onCloseFilePreview}>
								关闭
							</Button>
						</>
					) : undefined
				}
			>
				{previewFile?.loading ? (
					<div className="text-xs text-ink-muted">正在读取文件内容…</div>
				) : previewFile?.error ? (
					<div className="text-xs text-danger-text">{previewFile.error}</div>
				) : (
					<pre className="m-0 px-3.5 py-3 border border-line rounded-md bg-subtle font-mono text-xs leading-relaxed text-ink max-h-[min(62vh,520px)] overflow-auto whitespace-pre-wrap break-words">
						{previewFile?.file.content ?? ""}
					</pre>
				)}
			</ModalDialog>
		</>
	);
}
