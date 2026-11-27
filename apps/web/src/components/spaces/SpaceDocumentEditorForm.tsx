import type { FormEvent } from "react";
import {
	SPACE_DOC_TYPE_OPTIONS,
	type SpaceDocumentDto,
	type SpaceDocumentType,
	type SpaceDto,
	type SpaceEntryKind,
} from "../../api/space.ts";
import type { BootstrapPayload } from "../../api.ts";

export interface SpaceDocumentEditorFormProps {
	bootstrap: BootstrapPayload | null;
	selectedSpace: SpaceDto | null;
	selectedDoc: SpaceDocumentDto | null;
	busy: boolean;
	matterId: string;
	onMatterIdChange: (value: string) => void;
	title: string;
	onTitleChange: (value: string) => void;
	docType: SpaceDocumentType;
	onDocTypeChange: (value: SpaceDocumentType) => void;
	entryKind: SpaceEntryKind;
	onEntryKindChange: (value: SpaceEntryKind) => void;
	content: string;
	onContentChange: (value: string) => void;
	extraFiles: Array<{ id: string; path: string; content: string }>;
	onExtraFilesChange: (
		updater: (prev: Array<{ id: string; path: string; content: string }>) => Array<{
			id: string;
			path: string;
			content: string;
		}>,
	) => void;
	linkedWorkspaceId: string;
	onLinkedWorkspaceIdChange: (value: string) => void;
	linkedFilePath: string;
	onLinkedFilePathChange: (value: string) => void;
	commitMessage: string;
	onCommitMessageChange: (value: string) => void;
	onSubmit: (event: FormEvent) => void;
	onCancel: () => void;
}

export function SpaceDocumentEditorForm({
	bootstrap,
	selectedSpace,
	selectedDoc,
	busy,
	matterId,
	onMatterIdChange,
	title,
	onTitleChange,
	docType,
	onDocTypeChange,
	entryKind,
	onEntryKindChange,
	content,
	onContentChange,
	extraFiles,
	onExtraFilesChange,
	linkedWorkspaceId,
	onLinkedWorkspaceIdChange,
	linkedFilePath,
	onLinkedFilePathChange,
	commitMessage,
	onCommitMessageChange,
	onSubmit,
	onCancel,
}: SpaceDocumentEditorFormProps) {
	return (
		<form className="space-editor-form" onSubmit={onSubmit}>
			<div className="space-page-heading">
				<h2>{selectedDoc ? `编辑：${selectedDoc.title}` : `在「${selectedSpace?.name ?? ""}」新建资料`}</h2>
			</div>
			{!selectedDoc && (bootstrap?.matters.length ?? 0) > 0 && (
				<label>
					关联事项（可选）
					<select className="input-field" value={matterId} onChange={(e) => onMatterIdChange(e.target.value)}>
						<option value="">不绑定特定事项</option>
						{bootstrap?.matters.map((m) => (
							<option key={m.id} value={m.id}>
								{m.title}
							</option>
						))}
					</select>
				</label>
			)}
			<div className="space-create-row">
				<label style={{ flex: 2 }}>
					标题
					<input
						className="input-field"
						value={title}
						onChange={(e) => onTitleChange(e.target.value)}
						maxLength={200}
						required
					/>
				</label>
				<label style={{ flex: 1 }}>
					内容类型
					<select
						className="input-field"
						value={docType}
						onChange={(e) => onDocTypeChange(e.target.value as SpaceDocumentType)}
					>
						{SPACE_DOC_TYPE_OPTIONS.map((opt) => (
							<option key={opt.value} value={opt.value}>
								{opt.label} — {opt.hint}
							</option>
						))}
					</select>
				</label>
				{!selectedDoc && (
					<label style={{ flex: 1 }}>
						条目形态
						<select
							className="input-field"
							value={entryKind}
							onChange={(e) => onEntryKindChange(e.target.value as SpaceEntryKind)}
						>
							<option value="file">单文件 Markdown</option>
							<option value="folder">目录条目（多文件 / 演示站点 / .gitignore）</option>
						</select>
					</label>
				)}
			</div>
			<label>
				{(!selectedDoc && entryKind === "folder") || selectedDoc?.entryKind === "folder"
					? "入口文档（README.md）"
					: "正文（Markdown）"}
				{!selectedDoc && entryKind === "folder" && (
					<span className="muted-tiny">
						目录条目会自动创建入口文件 README.md 与默认 .gitignore，下方可一次追加多个附加子文件。
					</span>
				)}
				<textarea
					className="input-field space-page-editor"
					value={content}
					onChange={(e) => onContentChange(e.target.value)}
					placeholder={
						!selectedDoc && entryKind === "folder"
							? "此内容将保存为目录内的 README.md（主说明/索引页）"
							: "支持 Markdown"
					}
				/>
			</label>
			{!selectedDoc && entryKind === "folder" && (
				<div className="space-extra-files-section">
					<div className="space-extra-files-header">
						<strong>附加子文件（可选，一次提交多个）</strong>
						<div className="space-folder-presets">
							{["notes.md", "option-a.md", "demo/index.html", ".gitignore"].map((preset) => (
								<button
									key={preset}
									type="button"
									className="btn-inline"
									onClick={() =>
										onExtraFilesChange((prev) => [
											...prev,
											{
												id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
												path: preset,
												content: "",
											},
										])
									}
								>
									+ {preset}
								</button>
							))}
							<button
								type="button"
								className="btn-pill-outline btn-xs"
								onClick={() =>
									onExtraFilesChange((prev) => [
										...prev,
										{
											id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
											path: "",
											content: "",
										},
									])
								}
							>
								+ 自定义文件
							</button>
						</div>
					</div>
					{extraFiles.map((file, idx) => (
						<div key={file.id} className="space-extra-file-card">
							<div className="space-extra-file-head">
								<input
									className="input-field"
									placeholder={`子文件 ${idx + 1} 相对路径，如 option-a.md 或 demo/index.html`}
									value={file.path}
									onChange={(e) =>
										onExtraFilesChange((prev) =>
											prev.map((item) => (item.id === file.id ? { ...item, path: e.target.value } : item)),
										)
									}
									required
								/>
								<button
									type="button"
									className="btn-inline btn-danger-inline"
									onClick={() => onExtraFilesChange((prev) => prev.filter((item) => item.id !== file.id))}
								>
									移除
								</button>
							</div>
							<textarea
								className="input-field space-extra-file-editor"
								placeholder="输入子文件内容（Markdown / HTML / 配置 / 文本）"
								value={file.content}
								onChange={(e) =>
									onExtraFilesChange((prev) =>
										prev.map((item) => (item.id === file.id ? { ...item, content: e.target.value } : item)),
									)
								}
							/>
						</div>
					))}
				</div>
			)}
			<div className="space-create-row">
				<label style={{ flex: 1 }}>
					关联仓库（可选）
					<select
						className="input-field"
						value={linkedWorkspaceId}
						onChange={(e) => onLinkedWorkspaceIdChange(e.target.value)}
					>
						<option value="">不关联仓库</option>
						{bootstrap?.workspaces.map((ws) => (
							<option key={ws.id} value={ws.id}>
								{ws.name}
							</option>
						))}
					</select>
				</label>
				<label style={{ flex: 2 }}>
					关联文件相对路径或链接（可选）
					<input
						className="input-field"
						value={linkedFilePath}
						onChange={(e) => onLinkedFilePathChange(e.target.value)}
						placeholder="如 docs/plan.md 或 https://..."
						maxLength={300}
					/>
				</label>
			</div>
			<label>
				提交说明（Git Commit Message，可选）
				<input
					className="input-field"
					value={commitMessage}
					onChange={(e) => onCommitMessageChange(e.target.value)}
					placeholder={selectedDoc ? `Update ${title || selectedDoc.title}` : "Create document"}
					maxLength={200}
				/>
			</label>
			<div className="space-page-actions">
				<button className="btn-pill-dark" type="submit" disabled={busy}>
					{busy ? "提交中…" : "保存并提交 Git"}
				</button>
				<button className="btn-secondary" type="button" onClick={onCancel} disabled={busy}>
					取消
				</button>
			</div>
		</form>
	);
}
