import { type ClipboardEvent, type DragEvent, type KeyboardEvent, type RefObject, useRef, useState } from "react";
import type {
	CollaborationPresetMode,
	ComposerImageAttachment,
	MatterProgressDto,
	OrganizationDto,
	WorkspaceDto,
} from "../../api.ts";
import { MAX_COMPOSER_IMAGES } from "../../imageAttachments.ts";
import type { StarterTask } from "../../utils.ts";

interface ComposerDockProps {
	composerDockRef: RefObject<HTMLDivElement | null>;
	composerRef: RefObject<HTMLTextAreaElement | null>;
	composerMode: "discussion" | "dispatch";
	isOwner: boolean;
	isArchitectMode?: boolean;
	isTurnRunning: boolean;
	sendBlockedByTurn: boolean;
	submitting: boolean;
	composerText: string;
	pendingImages: ComposerImageAttachment[];
	effectiveOrgId: string | null;
	selectedWorkspaceId: string;
	selectedMatterId: string | null;
	activeMatterProgress: MatterProgressDto | null;
	organizations: OrganizationDto[];
	orgFilteredWorkspaces: WorkspaceDto[];
	starterTasks: StarterTask[];
	starterMenuOpen: boolean;
	onToggleStarterMenu: () => void;
	onCloseStarterMenu: () => void;
	onCloseRoster: () => void;
	onComposerModeChange: (mode: "discussion" | "dispatch") => void;
	onSelectOrganization: (orgId: string) => void;
	onSelectWorkspace: (workspaceId: string) => void;
	onNewMatter: () => void;
	onChangeLeadMember: (memberId: string) => void;
	onApplyPresetMode?: (mode: CollaborationPresetMode, leadId?: string | null) => void;
	onComposerTextChange: (value: string) => void;
	onAddImages: (files: FileList | File[]) => void;
	onRemoveImage: (imageId: string) => void;
	onSendPrompt: () => void;
	onAbortMatter: (matterId: string) => void;
	onOpenLightbox: (img: { src: string; alt: string }) => void;
}

/** Bottom message input bar with mode switcher, org/workspace context selectors, starter tasks, and image attachment support. */
export function ComposerDock({
	composerDockRef,
	composerRef,
	composerMode,
	isOwner,
	isArchitectMode = false,
	isTurnRunning,
	sendBlockedByTurn,
	submitting,
	composerText,
	pendingImages,
	effectiveOrgId,
	selectedWorkspaceId,
	selectedMatterId,
	activeMatterProgress,
	organizations,
	orgFilteredWorkspaces,
	starterTasks,
	starterMenuOpen,
	onToggleStarterMenu,
	onCloseStarterMenu,
	onCloseRoster,
	onComposerModeChange,
	onSelectOrganization,
	onSelectWorkspace,
	onNewMatter,
	onChangeLeadMember,
	onApplyPresetMode,
	onComposerTextChange,
	onAddImages,
	onRemoveImage,
	onSendPrompt,
	onAbortMatter,
	onOpenLightbox,
}: ComposerDockProps) {
	const [dragOverComposer, setDragOverComposer] = useState(false);
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const dragDepthRef = useRef(0);

	const hasDraggedFiles = (dataTransfer: DataTransfer | null): boolean => {
		if (!dataTransfer) return false;
		if (dataTransfer.files && dataTransfer.files.length > 0) return true;
		return Array.from(dataTransfer.types ?? []).includes("Files");
	};

	const handleComposerKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
			e.preventDefault();
			if (!sendBlockedByTurn && !submitting && (composerText.trim() || pendingImages.length > 0)) {
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
			onAddImages(e.dataTransfer.files);
			composerRef.current?.focus();
		}
	};

	const handleComposerPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
		const clipboard = e.clipboardData;
		if (!clipboard) return;
		const imageFiles: File[] = [];
		for (const item of Array.from(clipboard.items ?? [])) {
			if (item.kind === "file" && item.type.startsWith("image/")) {
				const file = item.getAsFile();
				if (file) imageFiles.push(file);
			}
		}
		if (imageFiles.length === 0) {
			for (const file of Array.from(clipboard.files ?? [])) {
				if (file.type.startsWith("image/")) imageFiles.push(file);
			}
		}
		if (imageFiles.length > 0) {
			if (!clipboard.getData("text/plain")) {
				e.preventDefault();
			}
			onAddImages(imageFiles);
		}
	};

	return (
		<div className="composer-dock">
			<section
				ref={composerDockRef}
				aria-label="消息与图片输入区"
				className={`composer-dock-inner${dragOverComposer ? " drag-over" : ""}`}
				onDragEnter={handleComposerDragEnter}
				onDragOver={handleComposerDragOver}
				onDragLeave={handleComposerDragLeave}
				onDrop={handleComposerDrop}
			>
				{dragOverComposer && (
					<div className="composer-drop-overlay" aria-hidden="true">
						<strong>松开即可添加图片附件</strong>
						<span>支持 PNG / JPG / WebP / GIF（最多 {MAX_COMPOSER_IMAGES} 张）</span>
					</div>
				)}
				{starterMenuOpen && (
					<div className="quick-prompts-popover">
						<div className="banner-row">
							<strong>快速插入示范需求</strong>
							<button type="button" className="btn-inline" onClick={onCloseStarterMenu}>
								关闭
							</button>
						</div>
						<div className="quick-prompts-list">
							{starterTasks.map((task) => (
								<button
									key={task.id}
									type="button"
									className="quick-prompt-item"
									onClick={() => {
										if (task.collaborationPreset && onApplyPresetMode) {
											onApplyPresetMode(task.collaborationPreset, task.memberId ?? null);
										} else {
											if (task.memberId) onChangeLeadMember(task.memberId);
											if (task.suggestedMode) onComposerModeChange(task.suggestedMode);
										}
										onComposerTextChange(task.prompt);
										onCloseStarterMenu();
										composerRef.current?.focus();
									}}
								>
									<span className="starter-role">{task.roleLabel}</span>
									<span>{task.title}</span>
								</button>
							))}
						</div>
					</div>
				)}

				{isArchitectMode ? (
					<div className="composer-mode-bar">
						<span className="composer-mode-hint">
							<strong>角色架构师只读规划</strong> · 所有新建或权限调整仅生成提案确认卡，经你勾选后才生效
						</span>
					</div>
				) : (
					<div className="composer-mode-bar">
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
						<span className="composer-mode-hint">
							{composerMode === "discussion"
								? "成员间自由同步想法，不触发 AI 执行（下次派发 AI 时会自动参考这段讨论）"
								: isOwner
									? "正式指派 AI 团队分析、修改并生成交付成果"
									: "发送 AI 提请卡片，待团队所有者一键确认后派发执行"}
						</span>
					</div>
				)}

				<div className="composer-meta-bar">
					<select
						className="select-pill"
						aria-label="所属组织"
						value={effectiveOrgId ?? ""}
						disabled={isTurnRunning || !isOwner}
						title={
							!isOwner
								? "仅团队所有者可切换组织"
								: isTurnRunning
									? "当前回合正在执行，请先停止后再切换组织"
									: "选择本次事项所属组织"
						}
						onChange={(e) => onSelectOrganization(e.target.value)}
					>
						{organizations.map((org) => (
							<option key={org.id} value={org.id}>
								组织：{org.name}
								{org.isDefault ? "（默认）" : ""}
							</option>
						))}
						<option value="">不归属组织</option>
					</select>
					<select
						className="select-pill"
						aria-label="项目仓库"
						value={selectedWorkspaceId}
						disabled={isTurnRunning || !isOwner}
						title={
							!isOwner
								? "仅团队所有者可切换项目仓库"
								: isTurnRunning
									? "当前回合正在执行，请先停止后再切换仓库"
									: undefined
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
					{selectedMatterId && (
						<button type="button" className="select-pill action" onClick={onNewMatter}>
							+ 切到新事项
						</button>
					)}
				</div>

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
						<li className="composer-image-hint">
							已选 {pendingImages.length}/{MAX_COMPOSER_IMAGES} 张 · 可继续拖拽或粘贴图片
						</li>
					</ul>
				)}

				<div className="pill-composer">
					<input
						ref={fileInputRef}
						type="file"
						accept="image/png,image/jpeg,image/webp,image/gif"
						multiple
						hidden
						onChange={(e) => {
							if (e.target.files?.length) {
								onAddImages(e.target.files);
								composerRef.current?.focus();
							}
							e.target.value = "";
						}}
					/>
					<button
						type="button"
						aria-expanded={starterMenuOpen}
						className="pill-plus-btn"
						aria-label="插入示范任务"
						title="插入示范任务"
						onClick={() => {
							onCloseRoster();
							onToggleStarterMenu();
						}}
					>
						+
					</button>
					<button
						type="button"
						className="pill-upload-btn"
						aria-label="上传图片"
						title="上传图片（也可直接拖拽或 Ctrl/Cmd+V 粘贴图片）"
						disabled={submitting || pendingImages.length >= MAX_COMPOSER_IMAGES}
						onClick={() => fileInputRef.current?.click()}
					>
						<svg
							width="16"
							height="16"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.9"
							strokeLinecap="round"
							strokeLinejoin="round"
							aria-hidden="true"
						>
							<rect x="3" y="4" width="18" height="16" rx="2.5" />
							<circle cx="8.5" cy="9.5" r="1.5" />
							<path d="m21 15-4.5-4.5a1.5 1.5 0 0 0-2.1 0L6 19" />
						</svg>
					</button>
					<textarea
						ref={composerRef}
						rows={1}
						className="pill-textarea"
						value={composerText}
						onChange={(e) => onComposerTextChange(e.target.value)}
						onKeyDown={handleComposerKeyDown}
						onPaste={handleComposerPaste}
						placeholder={
							isArchitectMode
								? "描述你们的工作流程、职责卡点，或直接下达团队体检指令（Enter 发送）..."
								: composerMode === "discussion"
									? "和团队成员同步想法、附带截图讨论（不触发 AI 执行，Enter 发送）..."
									: !isOwner
										? "写下希望 AI 协助处理的内容，提交后由团队所有者一键确认并派发..."
										: isTurnRunning
											? "当前 AI 回合仍在推进，可切到「团队聊天讨论」或等待完成后继续..."
											: selectedMatterId
												? "继续给 AI 团队安排工作、拖拽或粘贴图片，或提出修改（Enter 发送）..."
												: "向你的 AI 团队布置任务，支持上传/拖拽/粘贴图片（Enter 发送）..."
						}
					/>
					{activeMatterProgress && selectedMatterId && isOwner && (
						<button
							type="button"
							className="pill-stop-btn"
							aria-label="停止执行"
							title="停止当前执行"
							onClick={() => onAbortMatter(selectedMatterId)}
						>
							■
						</button>
					)}
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
						disabled={sendBlockedByTurn || submitting || (!composerText.trim() && pendingImages.length === 0)}
						onClick={onSendPrompt}
					>
						{submitting
							? "发送中..."
							: isArchitectMode
								? "发送"
								: composerMode === "discussion"
									? "发讨论"
									: isOwner
										? "派发 AI"
										: "提请 AI"}
					</button>
				</div>
			</section>
		</div>
	);
}
