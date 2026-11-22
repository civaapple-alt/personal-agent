import { useCallback, useEffect, useState } from "react";
import {
	deleteSpaceDocumentFile,
	readSpaceDocumentFile,
	type SpaceDocumentFileDto,
	spaceDocumentPreviewUrl,
	writeSpaceDocumentFile,
} from "../api/space.ts";
import { MarkdownView } from "../MarkdownView.tsx";
import { formatByteSize } from "../utils.ts";

interface SpaceFolderFilesPanelProps {
	docId: string;
	readmeContent: string;
	files: SpaceDocumentFileDto[];
	previewEntryPath: string | null;
	canWrite: boolean;
	onChanged: () => Promise<void>;
}

/** Focused multi-file explorer & inline sub-file editor for folder-kind Space entries. */
export function SpaceFolderFilesPanel({
	docId,
	readmeContent,
	files,
	previewEntryPath,
	canWrite,
	onChanged,
}: SpaceFolderFilesPanelProps) {
	const [activePath, setActivePath] = useState<string>("README.md");
	const [subContent, setSubContent] = useState<string>("");
	const [loadingFile, setLoadingFile] = useState(false);
	const [editingSubFile, setEditingSubFile] = useState(false);
	const [draftContent, setDraftContent] = useState("");
	const [addingFile, setAddingFile] = useState(false);
	const [newFilePath, setNewFilePath] = useState("");
	const [newFileContent, setNewFileContent] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	useEffect(() => {
		void docId;
		setActivePath("README.md");
		setEditingSubFile(false);
		setAddingFile(false);
		setError("");
	}, [docId]);

	const loadSubFile = useCallback(
		async (path: string) => {
			setActivePath(path);
			setEditingSubFile(false);
			setAddingFile(false);
			setError("");
			if (path === "README.md") return;
			setLoadingFile(true);
			try {
				const res = await readSpaceDocumentFile(docId, path);
				setSubContent(res.content);
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setLoadingFile(false);
			}
		},
		[docId],
	);

	const handleSaveSubFile = async (event: React.FormEvent) => {
		event.preventDefault();
		if (busy) return;
		setBusy(true);
		setError("");
		try {
			await writeSpaceDocumentFile(docId, { path: activePath, content: draftContent });
			setSubContent(draftContent);
			setEditingSubFile(false);
			await onChanged();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const handleCreateSubFile = async (event: React.FormEvent) => {
		event.preventDefault();
		const targetPath = newFilePath.trim();
		if (!targetPath || busy) return;
		setBusy(true);
		setError("");
		try {
			await writeSpaceDocumentFile(docId, { path: targetPath, content: newFileContent });
			setAddingFile(false);
			setNewFilePath("");
			setNewFileContent("");
			await onChanged();
			await loadSubFile(targetPath);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const handleDeleteSubFile = async (path: string) => {
		if (path === "README.md" || busy) return;
		setBusy(true);
		setError("");
		try {
			await deleteSpaceDocumentFile(docId, path);
			if (activePath === path) {
				setActivePath("README.md");
			}
			await onChanged();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const isMarkdown = activePath.toLowerCase().endsWith(".md");
	const displayedContent = activePath === "README.md" ? readmeContent : subContent;

	return (
		<div className="space-folder-panel">
			<div className="space-folder-bar">
				<div className="space-folder-files-chips" role="tablist" aria-label="目录条目文件">
					{files.map((file) => (
						<button
							key={file.path}
							type="button"
							role="tab"
							aria-selected={activePath === file.path && !addingFile}
							className={`space-type-chip ${activePath === file.path && !addingFile ? "active" : ""}`}
							title={`${file.path} (${formatByteSize(file.sizeBytes)})`}
							onClick={() => void loadSubFile(file.path)}
						>
							{file.path}
						</button>
					))}
				</div>
				<div className="space-folder-bar-actions">
					{previewEntryPath && (
						<a
							className="btn-pill-dark btn-xs"
							href={spaceDocumentPreviewUrl(docId, previewEntryPath)}
							target="_blank"
							rel="noreferrer"
						>
							预览站点 ↗
						</a>
					)}
					{canWrite && (
						<button
							type="button"
							className="btn-pill-outline btn-xs"
							onClick={() => {
								setAddingFile((v) => !v);
								setEditingSubFile(false);
								setError("");
							}}
						>
							{addingFile ? "取消新建" : "+ 添加子文件"}
						</button>
					)}
				</div>
			</div>

			{error && (
				<p role="alert" className="space-error">
					{error}
				</p>
			)}

			{addingFile ? (
				<form className="space-editor-form space-subfile-form" onSubmit={(e) => void handleCreateSubFile(e)}>
					<div className="space-folder-presets">
						<span className="muted-tiny">快捷路径：</span>
						{["notes.md", "demo/index.html", ".gitignore"].map((preset) => (
							<button key={preset} type="button" className="btn-inline" onClick={() => setNewFilePath(preset)}>
								{preset}
							</button>
						))}
					</div>
					<label>
						子文件相对路径
						<input
							className="input-field"
							placeholder="如 option-a.md、demo/index.html 或 .gitignore"
							value={newFilePath}
							onChange={(e) => setNewFilePath(e.target.value)}
							required
						/>
					</label>
					<label>
						文件内容
						<textarea
							className="input-field space-page-editor"
							value={newFileContent}
							onChange={(e) => setNewFileContent(e.target.value)}
							placeholder="输入 Markdown、HTML、配置或参考文本"
						/>
					</label>
					<div className="space-page-actions">
						<button type="submit" className="btn-pill-dark btn-xs" disabled={busy}>
							{busy ? "提交中…" : "保存子文件并提交 Git"}
						</button>
						<button
							type="button"
							className="btn-secondary btn-xs"
							disabled={busy}
							onClick={() => setAddingFile(false)}
						>
							取消
						</button>
					</div>
				</form>
			) : editingSubFile ? (
				<form className="space-editor-form space-subfile-form" onSubmit={(e) => void handleSaveSubFile(e)}>
					<label>
						编辑子文件：<code>{activePath}</code>
						<textarea
							className="input-field space-page-editor"
							value={draftContent}
							onChange={(e) => setDraftContent(e.target.value)}
						/>
					</label>
					<div className="space-page-actions">
						<button type="submit" className="btn-pill-dark btn-xs" disabled={busy}>
							{busy ? "提交中…" : "保存并提交 Git"}
						</button>
						<button
							type="button"
							className="btn-secondary btn-xs"
							disabled={busy}
							onClick={() => setEditingSubFile(false)}
						>
							取消
						</button>
					</div>
				</form>
			) : (
				<div className="space-folder-viewer">
					{activePath !== "README.md" && (
						<div className="space-subfile-head">
							<code>{activePath}</code>
							{canWrite && (
								<div className="space-folder-bar-actions">
									<button
										type="button"
										className="btn-inline"
										onClick={() => {
											setDraftContent(subContent);
											setEditingSubFile(true);
										}}
									>
										编辑此文件
									</button>
									<button
										type="button"
										className="btn-inline btn-danger-inline"
										disabled={busy}
										onClick={() => void handleDeleteSubFile(activePath)}
									>
										删除
									</button>
								</div>
							)}
						</div>
					)}
					{loadingFile ? (
						<p className="muted-hint">正在读取文件…</p>
					) : isMarkdown ? (
						<div className="space-page-content">
							<MarkdownView content={displayedContent || "（空白）"} />
						</div>
					) : (
						<pre className="space-subfile-pre">{displayedContent || "（空文件）"}</pre>
					)}
				</div>
			)}
		</div>
	);
}
