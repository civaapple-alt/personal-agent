import {
	type ClipboardEvent,
	type DragEvent,
	type KeyboardEvent,
	type ReactNode,
	type RefObject,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import type {
	ComposerFileAttachment,
	ComposerImageAttachment,
	MatterProgressDto,
	OrganizationDto,
	WorkspaceDto,
} from "../../api.ts";
import {
	COMPOSER_FILE_ACCEPT,
	MAX_COMPOSER_FILES,
	MAX_COMPOSER_IMAGES,
	shouldFoldPastedText,
} from "../../imageAttachments.ts";
import { formatByteSize, formatElapsedDuration, STAGE_LABELS } from "../../utils.ts";

export interface PreviewableTextAttachment {
	id?: string;
	kind: "file" | "pasted_text";
	name: string;
	content?: string;
	url?: string;
	lineCount?: number;
	charCount?: number;
	sizeBytes?: number;
	pendingPastedId?: string;
}

interface ComposerDockProps {
	initiationPanel?: ReactNode;
	composerDockRef: RefObject<HTMLDivElement | null>;
	composerRef: RefObject<HTMLTextAreaElement | null>;
	composerMode: "discussion" | "dispatch";
	isOwner: boolean;
	allowUnboundOrg?: boolean;
	isArchitectMode?: boolean;
	isTurnRunning: boolean;
	sendBlockedByTurn: boolean;
	submitting: boolean;
	composerText: string;
	pendingImages: ComposerImageAttachment[];
	pendingFiles: ComposerFileAttachment[];
	effectiveOrgId: string | null;
	selectedWorkspaceId: string;
	selectedMatterId: string | null;
	activeMatterProgress: MatterProgressDto | null;
	elapsedSeconds: number;
	organizations: OrganizationDto[];
	orgFilteredWorkspaces: WorkspaceDto[];
	onCloseRoster: () => void;
	onComposerModeChange: (mode: "discussion" | "dispatch") => void;
	onSelectOrganization: (orgId: string) => void;
	onSelectWorkspace: (workspaceId: string) => void;
	onNewMatter: () => void;
	onComposerTextChange: (value: string) => void;
	onAddAttachments: (files: FileList | File[]) => void;
	onAddPastedText: (text: string) => void;
	onRemoveImage: (imageId: string) => void;
	onRemoveFile: (fileId: string) => void;
	onSendPrompt: () => void;
	onAbortMatter: (matterId: string) => void;
	onOpenLightbox: (img: { src: string; alt: string }) => void;
	onPreviewFile: (file: PreviewableTextAttachment) => void;
}

/** Unified composer card with consistent config bar, running status strip, file/image/pasted-text chips, and multi-line auto-sizing. */
export function ComposerDock({
	initiationPanel,
	composerDockRef,
	composerRef,
	composerMode,
	isOwner,
	allowUnboundOrg = true,
	isArchitectMode = false,
	isTurnRunning,
	sendBlockedByTurn,
	submitting,
	composerText,
	pendingImages,
	pendingFiles,
	effectiveOrgId,
	selectedWorkspaceId,
	selectedMatterId,
	activeMatterProgress,
	elapsedSeconds,
	organizations,
	orgFilteredWorkspaces,
	onCloseRoster,
	onComposerModeChange,
	onSelectOrganization,
	onSelectWorkspace,
	onNewMatter,
	onComposerTextChange,
	onAddAttachments,
	onAddPastedText,
	onRemoveImage,
	onRemoveFile,
	onSendPrompt,
	onAbortMatter,
	onOpenLightbox,
	onPreviewFile,
}: ComposerDockProps) {
	const [dragOverComposer, setDragOverComposer] = useState(false);
	const [isMultiline, setIsMultiline] = useState(false);
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const dragDepthRef = useRef(0);

	const isNewMatter = !selectedMatterId;
	const hasAttachments = pendingImages.length > 0 || pendingFiles.length > 0;
	const canSend = !sendBlockedByTurn && !submitting && (composerText.trim().length > 0 || hasAttachments);
	const lineCount = composerText ? composerText.split(/\r\n|\r|\n/).length : 0;

	// Auto-size textarea cleanly across default compact state and multi-line editing without shifting toolbar controls.
	useLayoutEffect(() => {
		const el = composerRef.current;
		if (!el) return;
		el.style.height = "auto";
		const maxHeight = selectedMatterId ? 200 : 240;
		const nextHeight = Math.min(el.scrollHeight, maxHeight);
		el.style.height = `${nextHeight}px`;
		el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
		setIsMultiline(composerText.includes("\n") || el.scrollHeight > (selectedMatterId ? 52 : 92));
	}, [composerRef, composerText, selectedMatterId]);

	const hasDraggedFiles = (dataTransfer: DataTransfer | null): boolean => {
		if (!dataTransfer) return false;
		if (dataTransfer.files && dataTransfer.files.length > 0) return true;
		return Array.from(dataTransfer.types ?? []).includes("Files");
	};

	const handleComposerKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
			e.preventDefault();
			if (canSend) {
				onSendPrompt();
			}
		}
	};

	const handleComposerDragEnter = (e: DragEvent<HTMLDivElement>) => {
		if (!hasDraggedFiles(e.dataTransfer)) return;
		e.preventDefault();
		e.stopPropagation();
		dragDepthRef.current += 1;
		setDragOverComposer(true);
	};

	const handleComposerDragOver = (e: DragEvent<HTMLDivElement>) => {
		if (!hasDraggedFiles(e.dataTransfer)) return;
		e.preventDefault();
		e.stopPropagation();
		e.dataTransfer.dropEffect = "copy";
		if (!dragOverComposer) setDragOverComposer(true);
	};

	const handleComposerDragLeave = (e: DragEvent<HTMLDivElement>) => {
		if (!hasDraggedFiles(e.dataTransfer)) return;
		e.preventDefault();
		e.stopPropagation();
		dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
		if (dragDepthRef.current === 0) {
			setDragOverComposer(false);
		}
	};

	const handleComposerDrop = (e: DragEvent<HTMLDivElement>) => {
		e.preventDefault();
		e.stopPropagation();
		dragDepthRef.current = 0;
		setDragOverComposer(false);
		if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
			onAddAttachments(e.dataTransfer.files);
			composerRef.current?.focus();
		}
	};

	const handleComposerPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
		const clipboard = e.clipboardData;
		if (!clipboard) return;
		const droppedFiles: File[] = [];
		for (const item of Array.from(clipboard.items ?? [])) {
			if (item.kind === "file") {
				const file = item.getAsFile();
				if (file) droppedFiles.push(file);
			}
		}
		if (droppedFiles.length === 0 && clipboard.files?.length) {
			droppedFiles.push(...Array.from(clipboard.files));
		}
		if (droppedFiles.length > 0) {
			if (!clipboard.getData("text/plain")) {
				e.preventDefault();
			}
			onAddAttachments(droppedFiles);
			return;
		}
		const pastedText = clipboard.getData("text/plain");
		if (pastedText && shouldFoldPastedText(pastedText)) {
			e.preventDefault();
			onAddPastedText(pastedText);
		}
	};

	const uploadLimitReached = pendingImages.length >= MAX_COMPOSER_IMAGES && pendingFiles.length >= MAX_COMPOSER_FILES;

	const placeholder = isArchitectMode
		? "描述你们的工作流程或角色缺口（Enter 发送，Shift+Enter 换行）..."
		: composerMode === "discussion"
			? "和团队成员同步想法，支持附带文件或截图（不触发 AI 执行）..."
			: !isOwner
				? "写下希望 AI 协助处理的内容，提交后由团队所有者确认派发..."
				: isTurnRunning
					? "当前 AI 正在执行；可先停止，或切到「团队聊天讨论」继续沟通..."
					: isNewMatter
						? "向你的 AI 团队布置任务，支持上传/拖拽文件与图片、自动折叠大段粘贴文本..."
						: "继续安排工作、提出修改，或拖入文件与截图...";

	const sendLabel = submitting
		? "发送中..."
		: isArchitectMode
			? "发送"
			: composerMode === "discussion"
				? "发讨论"
				: isOwner
					? "派发 AI"
					: "提请 AI";

	return (
		<div className="composer-dock">
			<section
				ref={composerDockRef}
				aria-label="统一输入与配置区"
				className={`composer-dock-inner${dragOverComposer ? " drag-over" : ""}`}
				onDragEnter={handleComposerDragEnter}
				onDragOver={handleComposerDragOver}
				onDragLeave={handleComposerDragLeave}
				onDrop={handleComposerDrop}
			>
				{dragOverComposer && (
					<div className="composer-drop-overlay" aria-hidden="true">
						<strong>松开即可添加文件或图片</strong>
						<span>
							支持文本/代码/Markdown/JSON/CSV（最多 {MAX_COMPOSER_FILES} 个）与 PNG/JPG/WebP/GIF（最多{" "}
							{MAX_COMPOSER_IMAGES} 张）
						</span>
					</div>
				)}

				<div
					className={`composer-card${isNewMatter ? " is-new" : ""}${isTurnRunning ? " is-running" : ""}${isMultiline ? " is-multiline" : ""}`}
				>
					{selectedMatterId && activeMatterProgress && (
						<output className="composer-run-banner" aria-live="polite">
							<div className="composer-run-info">
								<span className="composer-run-dot" aria-hidden="true" />
								<span className={`exploring-stage stage-${activeMatterProgress.stage}`}>
									{STAGE_LABELS[activeMatterProgress.stage]}
								</span>
								<span className="composer-run-label">{activeMatterProgress.label}</span>
								<span className="composer-run-elapsed">{formatElapsedDuration(elapsedSeconds)}</span>
							</div>
							<div className="composer-run-actions">
								{isOwner && sendBlockedByTurn && (
									<button
										type="button"
										className="btn-inline"
										onClick={() => onComposerModeChange("discussion")}
									>
										切到讨论
									</button>
								)}
								{isOwner && (
									<button
										type="button"
										className="btn-stop-pill"
										onClick={() => onAbortMatter(selectedMatterId)}
									>
										停止执行
									</button>
								)}
							</div>
						</output>
					)}

					<div className="composer-top-bar">
						<div className="composer-top-left">
							{isArchitectMode ? (
								<span className="composer-architect-badge">角色架构师 · 只读建队规划</span>
							) : (
								<div className="composer-mode-tabs" role="tablist" aria-label="发言模式切换">
									<button
										type="button"
										role="tab"
										aria-selected={composerMode === "discussion"}
										className={`composer-mode-tab discussion ${composerMode === "discussion" ? "active" : ""}`}
										onClick={() => onComposerModeChange("discussion")}
									>
										团队聊天讨论
									</button>
									<button
										type="button"
										role="tab"
										aria-selected={composerMode === "dispatch"}
										className={`composer-mode-tab dispatch ${composerMode === "dispatch" ? "active" : ""}`}
										onClick={() => onComposerModeChange("dispatch")}
									>
										{isOwner ? "给 AI 安排事项" : "提请 AI 处理"}
									</button>
								</div>
							)}
						</div>

						<div className="composer-top-right">
							{!isArchitectMode && (
								<>
									<select
										className="composer-ctx-select"
										aria-label="所属组织"
										value={effectiveOrgId ?? ""}
										disabled={isTurnRunning || !isOwner}
										title={
											!isOwner
												? "仅团队所有者可切换组织"
												: isTurnRunning
													? "AI 执行中，停止后可切换组织"
													: "选择所属组织"
										}
										onChange={(e) => onSelectOrganization(e.target.value)}
									>
										{organizations.map((org) => (
											<option key={org.id} value={org.id}>
												组织：{org.name}
												{org.isDefault ? "（默认）" : ""}
											</option>
										))}
										{allowUnboundOrg && (
											<option value="">
												{organizations.length === 0 ? "暂无组织（请先在「我的团队」新建）" : "不归属组织"}
											</option>
										)}
									</select>
									<select
										className="composer-ctx-select"
										aria-label="项目仓库"
										value={selectedWorkspaceId}
										disabled={isTurnRunning || !isOwner}
										title={
											!isOwner
												? "仅团队所有者可切换项目仓库"
												: isTurnRunning
													? "AI 执行中，停止后可切换项目仓库"
													: "选择关联仓库"
										}
										onChange={(e) => onSelectWorkspace(e.target.value)}
									>
										<option value="">
											{effectiveOrgId && orgFilteredWorkspaces.length === 0
												? "不绑定仓库（该组织暂无仓库）"
												: "不绑定仓库"}
										</option>
										{orgFilteredWorkspaces.map((ws) => (
											<option key={ws.id} value={ws.id}>
												仓库：{ws.name}
											</option>
										))}
									</select>
								</>
							)}
							{selectedMatterId && (
								<button type="button" className="composer-ctx-btn" onClick={onNewMatter}>
									+ 新事项
								</button>
							)}
						</div>
					</div>

					{hasAttachments && (
						<div className="composer-attachments-strip">
							{pendingImages.length > 0 && (
								<ul className="composer-image-strip" aria-label="待发送图片">
									{pendingImages.map((img) => (
										<li key={img.id} className="composer-image-chip" title={img.name}>
											<button
												type="button"
												className="composer-image-preview"
												onClick={() => onOpenLightbox({ src: img.previewUrl, alt: img.name })}
												aria-label={`预览图片 ${img.name}`}
											>
												<img src={img.previewUrl} alt={img.name} />
											</button>
											<button
												type="button"
												className="composer-image-remove"
												onClick={() => onRemoveImage(img.id)}
												aria-label={`移除图片 ${img.name}`}
												title="移除图片"
											>
												×
											</button>
										</li>
									))}
								</ul>
							)}

							{pendingFiles.length > 0 && (
								<ul className="composer-file-strip" aria-label="待发送文件与粘贴文本">
									{pendingFiles.map((file) => {
										const isPasted = file.kind === "pasted_text";
										return (
											<li key={file.id} className={`composer-file-chip${isPasted ? " is-pasted" : ""}`}>
												<button
													type="button"
													className="composer-file-open"
													onClick={() =>
														onPreviewFile({
															id: file.id,
															kind: file.kind,
															name: file.name,
															content: file.content,
															lineCount: file.lineCount,
															charCount: file.charCount,
															sizeBytes: file.sizeBytes,
															pendingPastedId: isPasted ? file.id : undefined,
														})
													}
													title="点击查看完整内容"
												>
													<span className="composer-file-icon" aria-hidden="true">
														{isPasted ? "¶" : "📄"}
													</span>
													<span className="composer-file-copy">
														<strong>{isPasted ? `粘贴文本 · ${file.lineCount} 行` : file.name}</strong>
														<small>
															{isPasted
																? `${file.charCount} 字 · ${file.previewText}`
																: `${formatByteSize(file.sizeBytes)} · ${file.lineCount} 行`}
														</small>
													</span>
												</button>
												<button
													type="button"
													className="composer-file-remove"
													onClick={() => onRemoveFile(file.id)}
													aria-label={`移除附件 ${file.name}`}
													title="移除附件"
												>
													×
												</button>
											</li>
										);
									})}
								</ul>
							)}
						</div>
					)}

					<div className="composer-input-shell">
						<input
							ref={fileInputRef}
							type="file"
							accept={COMPOSER_FILE_ACCEPT}
							multiple
							hidden
							onChange={(e) => {
								if (e.target.files?.length) {
									onAddAttachments(e.target.files);
									composerRef.current?.focus();
								}
								e.target.value = "";
							}}
						/>
						<textarea
							ref={composerRef}
							rows={isNewMatter ? 3 : 1}
							className="composer-textarea"
							value={composerText}
							onChange={(e) => onComposerTextChange(e.target.value)}
							onKeyDown={handleComposerKeyDown}
							onPaste={handleComposerPaste}
							placeholder={placeholder}
						/>
						<div className="composer-toolbar">
							<div className="composer-toolbar-left">
								<button
									type="button"
									className="composer-plus-btn"
									aria-label="上传文件或图片"
									title="上传文件或图片（支持拖拽、截图粘贴与大段文本自动折叠）"
									disabled={submitting || uploadLimitReached}
									onClick={() => {
										onCloseRoster();
										fileInputRef.current?.click();
									}}
								>
									+
								</button>
								<span className="composer-toolbar-hint">
									{isTurnRunning && sendBlockedByTurn
										? "当前正在执行，可停止或切到「团队聊天讨论」"
										: isMultiline
											? `${lineCount} 行 · ${composerText.length} 字 · Shift+Enter 换行`
											: composerMode === "discussion"
												? "自由讨论，不触发 AI · 支持文件与图片"
												: "支持上传文件/图片，粘贴大段文本自动折叠"}
								</span>
							</div>
							<button
								type="button"
								className={`pill-send-btn pill-send-labeled ${isArchitectMode ? "dispatch" : composerMode === "discussion" ? "discussion" : isOwner ? "dispatch" : "ai-request"}`}
								aria-label={
									isArchitectMode
										? "发送给架构师"
										: composerMode === "discussion"
											? "发送讨论"
											: isOwner
												? "派发 AI"
												: "提请 AI"
								}
								disabled={!canSend}
								onClick={onSendPrompt}
							>
								{sendLabel}
							</button>
						</div>
					</div>

					{initiationPanel}
				</div>
			</section>
		</div>
	);
}
