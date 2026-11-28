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
import { Badge, type BadgeTone, Button, ElapsedTimer, IconButton, Select } from "../../primitives/index.ts";
import { cn } from "../../utils/cn.ts";
import { formatByteSize, STAGE_LABELS } from "../../utils.ts";

function stageBadgeTone(stage: MatterProgressDto["stage"]): BadgeTone {
	if (stage === "waiting_user") return "warn";
	if (stage === "finalizing") return "success";
	return "accent";
}

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
		<div
			className={cn(
				"shrink-0 px-[var(--page-pad-x)]",
				isNewMatter ? "flex-none pt-1.5 pb-4" : "pt-2.5 pb-[18px] bg-gradient-to-b from-transparent to-stage",
			)}
		>
			<section
				ref={composerDockRef}
				aria-label="统一输入与配置区"
				className={cn(
					"mx-auto relative flex flex-col gap-2",
					isNewMatter ? "max-w-[760px]" : "max-w-[var(--content-max-w)]",
				)}
				onDragEnter={handleComposerDragEnter}
				onDragOver={handleComposerDragOver}
				onDragLeave={handleComposerDragLeave}
				onDrop={handleComposerDrop}
			>
				{dragOverComposer && (
					<div
						className="absolute -inset-1.5 z-20 rounded-xl border-2 border-dashed border-accent bg-accent-soft/95 backdrop-blur-xs flex flex-col items-center justify-center gap-1 text-accent pointer-events-none"
						aria-hidden="true"
					>
						<strong className="text-base">松开即可添加文件或图片</strong>
						<span className="text-xs text-ink-secondary">
							支持文本/代码/Markdown/JSON/CSV（最多 {MAX_COMPOSER_FILES} 个）与 PNG/JPG/WebP/GIF（最多{" "}
							{MAX_COMPOSER_IMAGES} 张）
						</span>
					</div>
				)}

				<div
					className={cn(
						"relative flex flex-col bg-stage border rounded-xl shadow-sm transition-colors focus-within:border-line-strong",
						isNewMatter ? "gap-3 p-3.5 sm:p-4" : "gap-2.5 px-3.5 py-3",
						dragOverComposer
							? "border-accent ring-2 ring-accent/20"
							: isTurnRunning
								? "border-accent-border"
								: "border-line",
					)}
				>
					{selectedMatterId && activeMatterProgress && (
						<output
							className="flex items-center justify-between gap-3 px-3 py-2 border border-accent-border rounded-md bg-surface-accent text-xs"
							aria-live="polite"
						>
							<div className="inline-flex items-center gap-2 min-w-0 flex-wrap">
								<span
									className="size-2 rounded-full bg-accent shrink-0 animate-pulse motion-reduce:animate-none"
									aria-hidden="true"
								/>
								<Badge tone={stageBadgeTone(activeMatterProgress.stage)} size="xs">
									{STAGE_LABELS[activeMatterProgress.stage]}
								</Badge>
								<span className="text-ink font-medium truncate">{activeMatterProgress.label}</span>
								<ElapsedTimer className="text-ink-muted tabular-nums shrink-0" startedAt={progressStartedAt} />
							</div>
							<div className="inline-flex items-center gap-2 shrink-0">
								{isOwner && (
									<Button
										variant="danger"
										size="xs"
										className="rounded-pill"
										onClick={() => onAbortMatter(selectedMatterId)}
									>
										停止执行
									</Button>
								)}
							</div>
						</output>
					)}

					<div className="flex items-center justify-between gap-x-3.5 gap-y-2 flex-wrap min-w-0">
						<div className="flex items-center gap-2 flex-wrap min-w-0 ml-auto">
							<Select
								size="sm"
								className="w-auto max-w-[210px] rounded-pill bg-transparent border-transparent text-ink-secondary hover:bg-subtle hover:border-line hover:text-ink"
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
							</Select>
							<Select
								size="sm"
								className="w-auto max-w-[210px] rounded-pill bg-transparent border-transparent text-ink-secondary hover:bg-subtle hover:border-line hover:text-ink"
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
							</Select>
							{selectedMatterId && (
								<Button variant="secondary" size="xs" className="rounded-pill" onClick={onNewMatter}>
									+ 新事项
								</Button>
							)}
						</div>
					</div>

					{hasAttachments && (
						<div className="flex flex-col gap-2">
							{pendingImages.length > 0 && (
								<ul
									className="flex items-center flex-wrap gap-2 px-1 pt-1 m-0 list-none"
									aria-label="待发送图片"
								>
									{pendingImages.map((img) => (
										<li key={img.id} className="relative size-[58px] shrink-0" title={img.name}>
											<button
												type="button"
												className="w-full h-full p-0 border border-line rounded-lg overflow-hidden bg-subtle cursor-zoom-in block"
												onClick={() => onOpenLightbox({ src: img.previewUrl, alt: img.name })}
												aria-label={`预览图片 ${img.name}`}
											>
												<img
													src={img.previewUrl}
													alt={img.name}
													width={58}
													height={58}
													className="w-full h-full object-cover block"
												/>
											</button>
											<button
												type="button"
												className="absolute -top-1.5 -right-1.5 size-5 rounded-full border border-stage bg-cta text-stage text-sm leading-none grid place-items-center cursor-pointer shadow-sm hover:bg-danger-text hover:text-white"
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
								<ul className="flex flex-wrap gap-2 list-none m-0 p-0" aria-label="待发送文件与粘贴文本">
									{pendingFiles.map((file) => {
										const isPasted = file.kind === "pasted_text";
										return (
											<li
												key={file.id}
												className={cn(
													"inline-flex items-center gap-1 max-w-[min(320px,100%)] border rounded-md py-0.5 pr-1 pl-2 min-w-0 transition-colors",
													isPasted
														? "border-dashed bg-accent-soft/60 border-accent-border"
														: "border-line bg-subtle hover:border-line-strong",
												)}
											>
												<button
													type="button"
													className="inline-flex items-center gap-1.5 min-w-0 border-0 bg-transparent py-0.5 pr-1 pl-0 text-ink text-left cursor-pointer"
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
													<span className="text-sm leading-none shrink-0" aria-hidden="true">
														{isPasted ? "¶" : "📄"}
													</span>
													<span className="flex flex-col min-w-0 gap-px">
														<strong className="text-xs font-semibold truncate">
															{isPasted ? `粘贴文本 · ${file.lineCount} 行` : file.name}
														</strong>
														<small className="text-micro text-ink-secondary tabular-nums truncate">
															{isPasted
																? `${file.charCount} 字 · ${file.previewText}`
																: `${formatByteSize(file.sizeBytes)} · ${file.lineCount} 行`}
														</small>
													</span>
												</button>
												<IconButton
													variant="ghost"
													size="xs"
													className="size-[22px] rounded-full text-ink-muted"
													onClick={() => onRemoveFile(file.id)}
													aria-label={`移除附件 ${file.name}`}
													title="移除附件"
												>
													×
												</IconButton>
											</li>
										);
									})}
								</ul>
							)}
						</div>
					)}

					<div className="relative flex flex-col gap-1.5 border border-line-strong rounded-lg bg-stage px-3 pt-2.5 pb-2 transition-colors focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/15">
						{showMentionPicker && (
							<div
								ref={mentionMenuRef}
								id={mentionListId}
								className="absolute left-2.5 right-2.5 bottom-[calc(100%+6px)] max-w-[360px] max-h-[220px] overflow-y-auto overscroll-contain bg-card border border-line-strong rounded-md shadow-lg p-1 z-30 flex flex-col gap-0.5"
								role="listbox"
								aria-label="选择要 @ 的成员"
							>
								{filteredMentionMembers.length === 0 ? (
									<div className="px-2.5 py-2 text-xs text-ink-muted">没有匹配的成员</div>
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
												className={cn(
													"flex items-center justify-between gap-2.5 w-full border-0 rounded-sm px-2.5 py-1.5 text-xs text-left cursor-pointer transition-colors",
													idx === mentionIdx
														? "bg-info-bg text-info-text"
														: "bg-transparent text-ink hover:bg-hover",
												)}
												onMouseDown={(e) => e.preventDefault()}
												onClick={() => insertMentionMember(member)}
											>
												<strong>@{member.displayName}</strong>
												<span className="text-micro text-ink-muted shrink-0">{roleTag}</span>
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
							className={cn(
								"w-full resize-none border-0 outline-none focus-visible:outline-none bg-transparent font-sans text-base leading-relaxed text-ink p-0 placeholder:text-ink-muted",
								isNewMatter ? "min-h-[76px] max-sm:min-h-[68px] max-h-[240px]" : "min-h-[26px] max-h-[220px]",
							)}
							value={composerText}
							onChange={(e) => {
								onComposerTextChange(e.target.value);
								handleMentionInput(e.target.value, e.currentTarget.selectionStart);
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
						<div className="flex items-center justify-between gap-2.5 min-w-0">
							<div className="inline-flex items-center gap-2 min-w-0">
								<IconButton
									size="sm"
									className="rounded-full"
									aria-label="上传文件或图片"
									title="上传文件或图片（支持拖拽、截图粘贴与大段文本自动折叠）"
									disabled={submitting || uploadLimitReached}
									onClick={() => {
										onCloseRoster();
										fileInputRef.current?.click();
									}}
								>
									+
								</IconButton>
								{canMention && mentionMembers.length > 0 && (
									<Button
										ref={mentionTriggerRef}
										variant="secondary"
										size="xs"
										className="rounded-pill bg-info-bg/70 border-info-border text-info-text hover:bg-info-bg"
										aria-label="@ 成员"
										aria-expanded={showMentionPicker}
										aria-controls={showMentionPicker ? mentionListId : undefined}
										title="点名 AI 角色"
										onClick={toggleMentionPicker}
									>
										@成员
									</Button>
								)}
								<span className="text-xs text-ink-muted truncate">
									{isMultiline ? "Shift+Enter 换行" : "支持文件和图片"}
								</span>
							</div>
							<div className="flex items-center gap-2 min-w-0 ml-auto">
								{modelControl}
								<Button
									variant="primary"
									size="md"
									className="h-8 min-w-[68px] px-3.5 rounded-pill text-xs font-semibold"
									aria-label={isArchitectMode ? "发送给架构师" : "发送"}
									disabled={!canSend}
									onClick={onSendPrompt}
								>
									{submitting ? "发送中…" : "发送"}
								</Button>
							</div>
						</div>
					</div>

					{initiationPanel}
				</div>
			</section>
		</div>
	);
}
