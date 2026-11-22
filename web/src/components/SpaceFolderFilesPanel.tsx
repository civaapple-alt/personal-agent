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

interface TreeDirNode {
	kind: "dir";
	name: string;
	fullPath: string;
	children: TreeNode[];
}

interface TreeFileNode {
	kind: "file";
	name: string;
	fullPath: string;
	sizeBytes: number;
}

type TreeNode = TreeDirNode | TreeFileNode;

function createDraftRow(path = "", content = ""): DraftSubFile {
	return { id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, path, content };
}

function buildFileTree(files: SpaceDocumentFileDto[]): TreeNode[] {
	const root: TreeDirNode = { kind: "dir", name: "", fullPath: "", children: [] };
	for (const file of files) {
		const parts = file.path.split("/").filter(Boolean);
		if (parts.length === 0) continue;
		let current = root;
		for (let i = 0; i < parts.length - 1; i++) {
			const seg = parts[i]!;
			const dirPath = parts.slice(0, i + 1).join("/");
			let nextDir = current.children.find((node): node is TreeDirNode => node.kind === "dir" && node.name === seg);
			if (!nextDir) {
				nextDir = { kind: "dir", name: seg, fullPath: dirPath, children: [] };
				current.children.push(nextDir);
			}
			current = nextDir;
		}
		const fileName = parts[parts.length - 1]!;
		// Keep .gitkeep only to materialize empty subdirectories; hide it as a clickable file node.
		if (fileName !== ".gitkeep") {
			current.children.push({
				kind: "file",
				name: fileName,
				fullPath: file.path,
				sizeBytes: file.sizeBytes,
			});
		}
	}

	const sortNodes = (nodes: TreeNode[]): TreeNode[] => {
		nodes.sort((a, b) => {
			if (a.kind === "file" && a.fullPath === "README.md") return -1;
			if (b.kind === "file" && b.fullPath === "README.md") return 1;
			if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
		for (const node of nodes) {
			if (node.kind === "dir") sortNodes(node.children);
		}
		return nodes;
	};

	return sortNodes(root.children);
}

/** Left-right collapsible recursive directory tree + preview/editor + batch multi-file & subdirectory creation. */
export function SpaceFolderFilesPanel({
	docId,
	readmeContent,
	files,
	previewEntryPath,
	canWrite,
	onChanged,
}: SpaceFolderFilesPanelProps) {
	const [treeOpen, setTreeOpen] = useState(true);
	const [collapsedDirs, setCollapsedDirs] = useState<Record<string, boolean>>({});
	const [activePath, setActivePath] = useState<string>("README.md");
	const [subContent, setSubContent] = useState<string>("");
	const [loadingFile, setLoadingFile] = useState(false);
	const [editingSubFile, setEditingSubFile] = useState(false);
	const [draftContent, setDraftContent] = useState("");
	const [addingFiles, setAddingFiles] = useState(false);
	const [addingDir, setAddingDir] = useState(false);
	const [newDirPath, setNewDirPath] = useState("");
	const [draftRows, setDraftRows] = useState<DraftSubFile[]>([createDraftRow()]);
	const [batchCommitMsg, setBatchCommitMsg] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	useEffect(() => {
		void docId;
		setActivePath("README.md");
		setCollapsedDirs({});
		setEditingSubFile(false);
		setAddingFiles(false);
		setAddingDir(false);
		setNewDirPath("");
		setDraftRows([createDraftRow()]);
		setBatchCommitMsg("");
		setError("");
	}, [docId]);

	const treeNodes = useMemo(() => buildFileTree(files), [files]);
	const visibleFileCount = useMemo(
		() => files.filter((f) => !f.path.endsWith("/.gitkeep") && f.path !== ".gitkeep").length,
		[files],
	);

	const loadSubFile = useCallback(
		async (path: string) => {
			setActivePath(path);
			setEditingSubFile(false);
			setAddingFiles(false);
			setAddingDir(false);
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

	const handleCreateSubDir = async (event: React.FormEvent) => {
		event.preventDefault();
		const cleaned = newDirPath
			.replace(/\\/g, "/")
			.trim()
			.replace(/^\/+|\/+$/g, "");
		if (!cleaned || busy) return;
		setBusy(true);
		setError("");
		try {
			await writeSpaceDocumentFile(docId, {
				path: `${cleaned}/.gitkeep`,
				content: "",
				commitMessage: `Create directory ${cleaned}/`,
			});
			setAddingDir(false);
			setNewDirPath("");
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

	const openAddFileInDir = (dirPath: string) => {
		setAddingDir(false);
		setEditingSubFile(false);
		setAddingFiles(true);
		setDraftRows([createDraftRow(`${dirPath}/`)]);
		setError("");
	};

	const renderTreeNodes = (nodes: TreeNode[], depth = 0) =>
		nodes.map((node) => {
			if (node.kind === "dir") {
				const isCollapsed = Boolean(collapsedDirs[node.fullPath]);
				return (
					<div key={`dir:${node.fullPath}`} className="space-folder-tree-branch">
						<div className="space-folder-tree-dir-row" style={{ paddingLeft: `${depth * 14 + 4}px` }}>
							<button
								type="button"
								className="space-folder-tree-dir-btn"
								aria-expanded={!isCollapsed}
								onClick={() =>
									setCollapsedDirs((prev) => ({
										...prev,
										[node.fullPath]: !prev[node.fullPath],
									}))
								}
							>
								<span className="space-folder-chevron" aria-hidden="true">
									{isCollapsed ? "▸" : "▾"}
								</span>
								<span className="space-folder-tree-name">📁 {node.name}/</span>
							</button>
							{canWrite && (
								<button
									type="button"
									className="space-folder-dir-add"
									title={`在 ${node.fullPath}/ 下新建文件`}
									aria-label={`在 ${node.fullPath}/ 下新建文件`}
									onClick={() => openAddFileInDir(node.fullPath)}
								>
									+
								</button>
							)}
						</div>
						{!isCollapsed &&
							(node.children.length > 0 ? (
								renderTreeNodes(node.children, depth + 1)
							) : (
								<div className="space-folder-tree-empty" style={{ paddingLeft: `${(depth + 1) * 14 + 12}px` }}>
									（空目录）
								</div>
							))}
					</div>
				);
			}
			const isSelected = activePath === node.fullPath && !addingFiles && !addingDir;
			return (
				<button
					key={`file:${node.fullPath}`}
					type="button"
					className={`space-folder-tree-item ${isSelected ? "active" : ""}`}
					style={{ paddingLeft: `${depth * 14 + 10}px` }}
					title={`${node.fullPath} (${formatByteSize(node.sizeBytes)})`}
					onClick={() => void loadSubFile(node.fullPath)}
				>
					<span className="space-folder-tree-name">{node.name}</span>
					<span className="space-folder-tree-size">{formatByteSize(node.sizeBytes)}</span>
				</button>
			);
		});

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
						{treeOpen ? `收起文件树 (${visibleFileCount})` : `展开文件树 (${visibleFileCount})`}
					</button>
					<code className="space-folder-active-path">
						{addingDir ? "新建子目录" : addingFiles ? "批量添加子文件" : activePath}
					</code>
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
						<>
							<button
								type="button"
								className="btn-pill-outline btn-xs"
								onClick={() => {
									setAddingDir((v) => !v);
									setAddingFiles(false);
									setEditingSubFile(false);
									setError("");
								}}
							>
								{addingDir ? "取消建目录" : "+ 新建子目录"}
							</button>
							<button
								type="button"
								className="btn-pill-outline btn-xs"
								onClick={() => {
									setAddingFiles((v) => !v);
									setAddingDir(false);
									setEditingSubFile(false);
									setError("");
								}}
							>
								{addingFiles ? "取消添加" : "+ 添加子文件"}
							</button>
						</>
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
						{renderTreeNodes(treeNodes)}
					</aside>
				)}

				<div className="space-folder-viewer">
					{addingDir ? (
						<form className="space-editor-form space-subfile-form" onSubmit={(e) => void handleCreateSubDir(e)}>
							<label>
								子目录相对路径（支持多级目录）
								<input
									className="input-field"
									placeholder="如 demo/assets 或 refs/benchmarks"
									value={newDirPath}
									onChange={(e) => setNewDirPath(e.target.value)}
									required
								/>
							</label>
							<div className="space-folder-presets">
								<span className="muted-tiny">常用目录：</span>
								{["refs", "demo", "demo/assets", "docs/api"].map((preset) => (
									<button
										key={preset}
										type="button"
										className="btn-inline"
										onClick={() => setNewDirPath(preset)}
									>
										{preset}/
									</button>
								))}
							</div>
							<div className="space-page-actions">
								<button type="submit" className="btn-pill-dark btn-xs" disabled={busy}>
									{busy ? "创建中…" : "创建子目录"}
								</button>
								<button
									type="button"
									className="btn-secondary btn-xs"
									disabled={busy}
									onClick={() => setAddingDir(false)}
								>
									取消
								</button>
							</div>
						</form>
					) : addingFiles ? (
						<form
							className="space-editor-form space-subfile-form"
							onSubmit={(e) => void handleCreateBatchFiles(e)}
						>
							<div className="space-folder-presets">
								<span className="muted-tiny">快捷追加（路径含 / 自动建多级子目录）：</span>
								{["notes.md", "refs/option-a.md", "demo/index.html", "demo/assets/app.js", ".gitignore"].map(
									(preset) => (
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
									),
								)}
							</div>

							{draftRows.map((row, index) => (
								<div key={row.id} className="space-extra-file-card">
									<div className="space-extra-file-head">
										<input
											className="input-field"
											placeholder={`文件 ${index + 1} 相对路径，如 refs/option-a.md 或 demo/assets/app.js`}
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
										placeholder="输入文件内容（Markdown / HTML / JS / CSS / 配置）"
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
