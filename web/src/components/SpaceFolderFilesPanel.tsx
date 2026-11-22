import { useCallback, useEffect, useMemo, useState } from "react";
import {
	deleteSpaceDocumentFile,
	readSpaceDocumentFile,
	type SpaceDocumentFileDto,
	spaceDocumentPreviewUrl,
	writeSpaceDocumentFile,
	writeSpaceDocumentFiles,
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

interface DraftSubFile {
	id: string;
	path: string;
	content: string;
}

function createDraftRow(path = "", content = ""): DraftSubFile {
	return { id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, path, content };
}

/** Left-right collapsible directory tree + preview/editor + batch multi-file uploader for folder-kind Space entries. */
export function SpaceFolderFilesPanel({
	docId,
	readmeContent,
	files,
	previewEntryPath,
	canWrite,
	onChanged,
}: SpaceFolderFilesPanelProps) {
	const [treeOpen, setTreeOpen] = useState(true);
	const [activePath, setActivePath] = useState<string>("README.md");
	const [subContent, setSubContent] = useState<string>("");
	const [loadingFile, setLoadingFile] = useState(false);
	const [editingSubFile, setEditingSubFile] = useState(false);
	const [draftContent, setDraftContent] = useState("");
	const [addingFiles, setAddingFiles] = useState(false);
	const [draftRows, setDraftRows] = useState<DraftSubFile[]>([createDraftRow()]);
	const [batchCommitMsg, setBatchCommitMsg] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	useEffect(() => {
		void docId;
		setActivePath("README.md");
		setEditingSubFile(false);
		setAddingFiles(false);
		setDraftRows([createDraftRow()]);
		setBatchCommitMsg("");
		setError("");
	}, [docId]);

	// Group files by parent directory for a clean hierarchical left tree
	const groupedTree = useMemo(() => {
		const groups = new Map<string, Array<{ file: SpaceDocumentFileDto; name: string }>>();
		for (const file of files) {
			const slashIdx = file.path.lastIndexOf("/");
			const dir = slashIdx > 0 ? file.path.slice(0, slashIdx) : "";
			const name = slashIdx > 0 ? file.path.slice(slashIdx + 1) : file.path;
			const list = groups.get(dir) ?? [];
			list.push({ file, name });
			groups.set(dir, list);
		}
		return Array.from(groups.entries()).sort(([a], [b]) => {
			if (a === "") return -1;
			if (b === "") return 1;
			return a.localeCompare(b);
		});
	}, [files]);

	const loadSubFile = useCallback(
		async (path: string) => {
			setActivePath(path);
			setEditingSubFile(false);
			setAddingFiles(false);
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
			if (activePath !== "README.md") setSubContent(draftContent);
			setEditingSubFile(false);
			await onChanged();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const handleCreateBatchFiles = async (event: React.FormEvent) => {
		event.preventDefault();
		const valid = draftRows.map((r) => ({ path: r.path.trim(), content: r.content })).filter((r) => Boolean(r.path));
		if (valid.length === 0 || busy) return;
		setBusy(true);
		setError("");
		try {
			await writeSpaceDocumentFiles(docId, {
				files: valid,
				commitMessage: batchCommitMsg.trim() || undefined,
			});
			setAddingFiles(false);
			setDraftRows([createDraftRow()]);
			setBatchCommitMsg("");
			await onChanged();
			await loadSubFile(valid[0]!.path);
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
				<div className="space-folder-bar-left">
					<button
						type="button"
						className="btn-pill-outline btn-xs"
						aria-expanded={treeOpen}
						onClick={() => setTreeOpen((v) => !v)}
					>
						{treeOpen ? `收起目录 (${files.length})` : `展开目录 (${files.length})`}
					</button>
					<code className="space-folder-active-path">{addingFiles ? "批量添加子文件" : activePath}</code>
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
								setAddingFiles((v) => !v);
								setEditingSubFile(false);
								setError("");
							}}
						>
							{addingFiles ? "取消添加" : "+ 添加子文件"}
						</button>
					)}
				</div>
			</div>

			{error && (
				<p role="alert" className="space-error">
					{error}
				</p>
			)}

			<div className={`space-folder-split ${treeOpen ? "" : "is-collapsed"}`}>
				{treeOpen && (
					<aside className="space-folder-tree" aria-label="目录文件树">
						{groupedTree.map(([dir, items]) => (
							<div key={dir || "__root__"} className="space-folder-tree-group">
								{dir && <div className="space-folder-tree-dir">📁 {dir}/</div>}
								{items.map(({ file, name }) => {
									const isSelected = activePath === file.path && !addingFiles;
									return (
										<button
											key={file.path}
											type="button"
											className={`space-folder-tree-item ${dir ? "is-nested" : ""} ${isSelected ? "active" : ""}`}
											title={`${file.path} (${formatByteSize(file.sizeBytes)})`}
											onClick={() => void loadSubFile(file.path)}
										>
											<span className="space-folder-tree-name">{name}</span>
											<span className="space-folder-tree-size">{formatByteSize(file.sizeBytes)}</span>
										</button>
									);
								})}
							</div>
						))}
					</aside>
				)}

				<div className="space-folder-viewer">
					{addingFiles ? (
						<form
							className="space-editor-form space-subfile-form"
							onSubmit={(e) => void handleCreateBatchFiles(e)}
						>
							<div className="space-folder-presets">
								<span className="muted-tiny">快捷追加：</span>
								{["notes.md", "option-a.md", "demo/index.html", ".gitignore"].map((preset) => (
									<button
										key={preset}
										type="button"
										className="btn-inline"
										onClick={() =>
											setDraftRows((prev) => {
												if (prev.length === 1 && !prev[0]!.path.trim() && !prev[0]!.content) {
													return [{ ...prev[0]!, path: preset }];
												}
												return [...prev, createDraftRow(preset)];
											})
										}
									>
										+ {preset}
									</button>
								))}
							</div>

							{draftRows.map((row, index) => (
								<div key={row.id} className="space-extra-file-card">
									<div className="space-extra-file-head">
										<input
											className="input-field"
											placeholder={`文件 ${index + 1} 相对路径，如 option-a.md 或 demo/index.html`}
											value={row.path}
											onChange={(e) =>
												setDraftRows((prev) =>
													prev.map((item) =>
														item.id === row.id ? { ...item, path: e.target.value } : item,
													),
												)
											}
											required
										/>
										{draftRows.length > 1 && (
											<button
												type="button"
												className="btn-inline btn-danger-inline"
												onClick={() => setDraftRows((prev) => prev.filter((item) => item.id !== row.id))}
											>
												移除
											</button>
										)}
									</div>
									<textarea
										className="input-field space-extra-file-editor"
										placeholder="输入文件内容（Markdown / HTML / 配置 / 文本）"
										value={row.content}
										onChange={(e) =>
											setDraftRows((prev) =>
												prev.map((item) =>
													item.id === row.id ? { ...item, content: e.target.value } : item,
												),
											)
										}
									/>
								</div>
							))}

							<div className="space-page-actions">
								<button
									type="button"
									className="btn-pill-outline btn-xs"
									onClick={() => setDraftRows((prev) => [...prev, createDraftRow()])}
								>
									+ 再加一个文件
								</button>
							</div>

							<label>
								提交说明（可选）
								<input
									className="input-field"
									value={batchCommitMsg}
									onChange={(e) => setBatchCommitMsg(e.target.value)}
									placeholder={`一次提交 ${draftRows.length} 个子文件`}
									maxLength={200}
								/>
							</label>

							<div className="space-page-actions">
								<button type="submit" className="btn-pill-dark btn-xs" disabled={busy}>
									{busy ? "提交中…" : `保存 ${draftRows.length} 个文件并提交 Git`}
								</button>
								<button
									type="button"
									className="btn-secondary btn-xs"
									disabled={busy}
									onClick={() => setAddingFiles(false)}
								>
									取消
								</button>
							</div>
						</form>
					) : editingSubFile ? (
						<form className="space-editor-form space-subfile-form" onSubmit={(e) => void handleSaveSubFile(e)}>
							<label>
								编辑文件：<code>{activePath}</code>
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
						<>
							<div className="space-subfile-head">
								<code>{activePath}</code>
								{canWrite && (
									<div className="space-folder-bar-actions">
										<button
											type="button"
											className="btn-inline"
											onClick={() => {
												setDraftContent(displayedContent);
												setEditingSubFile(true);
											}}
										>
											编辑此文件
										</button>
										{activePath !== "README.md" && (
											<button
												type="button"
												className="btn-inline btn-danger-inline"
												disabled={busy}
												onClick={() => void handleDeleteSubFile(activePath)}
											>
												删除
											</button>
										)}
									</div>
								)}
							</div>
							{loadingFile ? (
								<p className="muted-hint">正在读取文件…</p>
							) : isMarkdown ? (
								<div className="space-page-content compact">
									<MarkdownView content={displayedContent || "（空白）"} />
								</div>
							) : (
								<pre className="space-subfile-pre">{displayedContent || "（空文件）"}</pre>
							)}
						</>
					)}
				</div>
			</div>
		</div>
	);
}
