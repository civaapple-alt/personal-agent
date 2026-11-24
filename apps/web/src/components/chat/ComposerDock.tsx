import {
	type ClipboardEvent,
	type DragEvent,
	type KeyboardEvent,
	type ReactNode,
	type RefObject,
	useEffect,
	useId,
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
import { ElapsedTimer } from "../../primitives/ElapsedTimer.tsx";
import { formatByteSize, STAGE_LABELS } from "../../utils.ts";

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

interface MentionMember {
	id: string;
	displayName: string;
	roleTitle?: string;
	kind: "ai" | "human";
}

interface ComposerDockProps {
	initiationPanel?: ReactNode;
	modelControl?: ReactNode;
	composerDockRef: RefObject<HTMLDivElement | null>;
	composerRef: RefObject<HTMLTextAreaElement | null>;
	isOwner: boolean;
	mentionMembers?: MentionMember[];
	leadMemberId?: string | null;
	observerMemberIds?: string[];
	allowUnboundOrg?: boolean;
	isArchitectMode?: boolean;
	isTurnRunning: boolean;
	submitting: boolean;
	composerText: string;
	pendingImages: ComposerImageAttachment[];
	pendingFiles: ComposerFileAttachment[];
	effectiveOrgId: string | null;
	selectedWorkspaceId: string;
	selectedMatterId: string | null;
	activeMatterProgress: MatterProgressDto | null;
	progressStartedAt: number | null;
	organizations: OrganizationDto[];
	orgFilteredWorkspaces: WorkspaceDto[];
	onCloseRoster: () => void;
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
	modelControl,
	composerDockRef,
	composerRef,
	isOwner,
	mentionMembers = [],
	leadMemberId = null,
	observerMemberIds = [],
	allowUnboundOrg = true,
	isArchitectMode = false,
	isTurnRunning,
	submitting,
	composerText,
	pendingImages,
	pendingFiles,
	effectiveOrgId,
	selectedWorkspaceId,
	selectedMatterId,
	activeMatterProgress,
	progressStartedAt,
	organizations,
	orgFilteredWorkspaces,
	onCloseRoster,
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
	const [mentionState, setMentionState] = useState<{
		start: number;
		end: number;
		query: string;
		prefix?: string;
	} | null>(null);
	const [mentionIdx, setMentionIdx] = useState(0);
	const mentionListId = useId();
	const mentionMenuRef = useRef<HTMLDivElement | null>(null);
	const mentionTriggerRef = useRef<HTMLButtonElement | null>(null);
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const dragDepthRef = useRef(0);

	const composerScope = selectedMatterId ?? (isArchitectMode ? "new:architect" : "new:matter");
	const [mentionScope, setMentionScope] = useState(composerScope);
	if (mentionScope !== composerScope) {
		setMentionScope(composerScope);
		setMentionState(null);
	}

	const canMention = !isArchitectMode;
	const showMentionPicker = Boolean(mentionState && canMention && mentionMembers.length > 0);
	const filteredMentionMembers = showMentionPicker
		? mentionMembers.filter((member) => {
				const q = (mentionState?.query ?? "").trim().toLowerCase();
				if (!q) return true;
				return (
					member.displayName.toLowerCase().includes(q) ||
					member.roleTitle?.toLowerCase().includes(q) ||
					member.id.toLowerCase().includes(q)
				);
			})
		: [];

	useEffect(() => {
		if (!showMentionPicker) return;
		const dismissOutside = (event: PointerEvent) => {
			const target = event.target;
			if (
				target instanceof Node &&
				target !== composerRef.current &&
				!mentionMenuRef.current?.contains(target) &&
				!mentionTriggerRef.current?.contains(target)
			) {
				setMentionState(null);
			}
		};
		document.addEventListener("pointerdown", dismissOutside, true);
		return () => document.removeEventListener("pointerdown", dismissOutside, true);
	}, [composerRef, showMentionPicker]);

	const findTypedMention = (text: string, caret: number) => {
		const beforeCaret = text.slice(0, caret);
		const atIdx = beforeCaret.lastIndexOf("@");
		if (atIdx < 0 || (atIdx > 0 && !/[\s,.:;!?，。：；！？、([【（]/.test(beforeCaret[atIdx - 1]!))) return null;
		const query = beforeCaret.slice(atIdx + 1);
		const normalizedQuery = query.toLowerCase();
		const completedMention = mentionMembers.some((member) =>
			[member.displayName, member.roleTitle, member.id].some((alias) => {
				const prefix = alias?.trim().toLowerCase() ?? "";
				return prefix.length > 0 && normalizedQuery.startsWith(prefix) && /\s/.test(query[prefix.length] ?? "");
			}),
		);
		return /^\s|\n/.test(query) || query.length > 128 || completedMention
			? null
			: { start: atIdx, end: caret, query };
	};

	const syncMentionFromCursor = (text: string, caret: number) => {
		setMentionState(canMention ? findTypedMention(text, caret) : null);
		setMentionIdx(0);
	};

	const handleMentionInput = (text: string, caret: number) => {
		const typed = canMention ? findTypedMention(text, caret) : null;
		if (typed || !showMentionPicker || mentionState?.prefix === undefined) {
			setMentionState(typed);
		} else {
			// Toolbar search starts at the selection without inserting a placeholder into the draft.
			const query = text.slice(mentionState.start, caret);
			const isQueryEdit =
				caret >= mentionState.start &&
				text.slice(0, mentionState.start) === composerText.slice(0, mentionState.start) &&
				text.slice(caret) === composerText.slice(mentionState.end) &&
				!/^\s|\n/.test(query) &&
				query.length <= 128;
			setMentionState(isQueryEdit ? { ...mentionState, end: caret, query } : null);
		}
		setMentionIdx(0);
	};

	const toggleMentionPicker = () => {
		if (showMentionPicker) {
			setMentionState(null);
			return;
		}
		const el = composerRef.current;
		const start = el?.selectionStart ?? composerText.length;
		const end = el?.selectionEnd ?? start;
		const typed = start === end ? findTypedMention(composerText, start) : null;
		const prefix = start > 0 && !/[\s(（[【]/.test(composerText[start - 1]!) ? " " : "";
		setMentionState(typed ?? { start, end, query: "", prefix });
		setMentionIdx(0);
		el?.focus();
	};

	const insertMentionMember = (member: MentionMember) => {
		if (!mentionState) return;
		const el = composerRef.current;
		const displayName = member.displayName.trim();
		const duplicateName = mentionMembers.some(
			(other) =>
				other.id !== member.id &&
				[other.displayName, other.roleTitle, other.id].some(
					(alias) => alias?.trim().toLowerCase() === displayName.toLowerCase(),
				),
		);
		const inserted = `${mentionState.prefix ?? ""}@${duplicateName ? member.id : displayName} `;
		const next = composerText.slice(0, mentionState.start) + inserted + composerText.slice(mentionState.end);
		const nextCaret = mentionState.start + inserted.length;
		onComposerTextChange(next);
		setMentionState(null);
		requestAnimationFrame(() => {
			el?.focus();
			el?.setSelectionRange(nextCaret, nextCaret);
		});
	};

	const isNewMatter = !selectedMatterId;
	const hasAttachments = pendingImages.length > 0 || pendingFiles.length > 0;
	const canSend =
		!(isArchitectMode && isTurnRunning) && !submitting && (composerText.trim().length > 0 || hasAttachments);

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
		if (e.nativeEvent.isComposing) return;
		if (showMentionPicker && e.key === "Escape") {
			e.preventDefault();
			setMentionState(null);
			return;
		}
		if (showMentionPicker && filteredMentionMembers.length > 0) {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setMentionIdx((idx) => (idx + 1) % filteredMentionMembers.length);
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				setMentionIdx((idx) => (idx - 1 + filteredMentionMembers.length) % filteredMentionMembers.length);
				return;
			}
			if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
				e.preventDefault();
				const picked = filteredMentionMembers[mentionIdx] ?? filteredMentionMembers[0];
				if (picked) insertMentionMember(picked);
				return;
			}
		}
		if (e.key === "Enter" && !e.shiftKey) {
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

	const placeholder = isArchitectMode ? "描述你们的工作流程或角色缺口…" : "说说想法、安排工作，或 @ 成员…";

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
								<ElapsedTimer className="composer-run-elapsed" startedAt={progressStartedAt} />
							</div>
							<div className="composer-run-actions">
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
						{isArchitectMode && (
							<div className="composer-top-left">
								<span className="composer-architect-badge">角色架构师 · 只读建队规划</span>
							</div>
						)}

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
												<img src={img.previewUrl} alt={img.name} width={58} height={58} />
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
						{showMentionPicker && (
							<div
								ref={mentionMenuRef}
								id={mentionListId}
								className="composer-mention-menu"
								role="listbox"
								aria-label="选择要 @ 的成员"
							>
								{filteredMentionMembers.length === 0 ? (
									<div className="composer-mention-empty">没有匹配的成员</div>
								) : (
									filteredMentionMembers.map((member, idx) => {
										const roleTag =
											member.kind === "human"
												? "同事"
												: member.id === leadMemberId
													? "主责"
													: observerMemberIds.includes(member.id)
														? "旁听"
														: "协作";
										return (
											<button
												key={member.id}
												type="button"
												role="option"
												aria-selected={idx === mentionIdx}
												className={`composer-mention-item ${idx === mentionIdx ? "active" : ""}`}
												onMouseDown={(e) => e.preventDefault()}
												onClick={() => insertMentionMember(member)}
											>
												<strong>@{member.displayName}</strong>
												<span className="composer-mention-tag">{roleTag}</span>
											</button>
										);
									})
								)}
							</div>
						)}
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
							onChange={(e) => {
								onComposerTextChange(e.target.value);
								handleMentionInput(e.target.value, e.target.selectionStart);
							}}
							onClick={(e) => {
								if (showMentionPicker) setMentionState(null);
								else syncMentionFromCursor(e.currentTarget.value, e.currentTarget.selectionStart);
							}}
							onKeyUp={(e) => {
								if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") {
									syncMentionFromCursor(e.currentTarget.value, e.currentTarget.selectionStart);
								}
							}}
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
								{canMention && mentionMembers.length > 0 && (
									<button
										type="button"
										ref={mentionTriggerRef}
										className="composer-at-btn"
										aria-label="@ 成员"
										aria-expanded={showMentionPicker}
										aria-controls={showMentionPicker ? mentionListId : undefined}
										title="点名 AI 角色"
										onClick={toggleMentionPicker}
									>
										@成员
									</button>
								)}
								<span className="composer-toolbar-hint">
									{isMultiline ? "Shift+Enter 换行" : "支持文件和图片"}
								</span>
							</div>
							<div className="composer-toolbar-actions">
								{modelControl}
								<button
									type="button"
									className="pill-send-btn pill-send-labeled dispatch"
									aria-label={isArchitectMode ? "发送给架构师" : "发送"}
									disabled={!canSend}
									onClick={onSendPrompt}
								>
									{submitting ? "发送中…" : "发送"}
								</button>
							</div>
						</div>
					</div>

					{initiationPanel}
				</div>
			</section>
		</div>
	);
}
