import { useCallback, useEffect, useId, useMemo, useState } from "react";
import {
	deleteSpaceDocumentFile,
	readSpaceDocumentFile,
	type SpaceDocumentFileDto,
	spaceDocumentPreviewUrl,
	writeSpaceDocumentFile,
	writeSpaceDocumentFiles,
} from "../api/space.ts";
import { MarkdownView } from "../MarkdownView.tsx";
import { Banner, Button, Card, FieldGroup, Input, Textarea } from "../primitives/index.ts";
import { cn } from "../utils/cn.ts";
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

	const newDirInputId = useId();
	const batchCommitInputId = useId();
	const editSubFileId = useId();

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
					<div key={`dir:${node.fullPath}`} className="flex flex-col gap-0.5">
						<div
							className="flex items-center justify-between gap-1"
							style={{ paddingLeft: `${depth * 14 + 4}px` }}
						>
							<button
								type="button"
								className="flex-1 min-w-0 inline-flex items-center gap-1 px-1 py-1 border-0 rounded-sm bg-transparent text-ink-secondary text-xs font-semibold text-left cursor-pointer hover:bg-hover/60 hover:text-ink transition-colors"
								aria-expanded={!isCollapsed}
								onClick={() =>
									setCollapsedDirs((prev) => ({
										...prev,
										[node.fullPath]: !prev[node.fullPath],
									}))
								}
							>
								<span className="w-2.5 text-[10px] text-ink-muted shrink-0" aria-hidden="true">
									{isCollapsed ? "▸" : "▾"}
								</span>
								<span className="min-w-0 truncate">📁 {node.name}/</span>
							</button>
							{canWrite && (
								<button
									type="button"
									className="size-5.5 inline-grid place-items-center border-0 rounded-sm bg-transparent text-ink-muted text-sm leading-none cursor-pointer shrink-0 hover:bg-hover hover:text-accent transition-colors"
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
								<div
									className="text-micro text-ink-muted py-0.5"
									style={{ paddingLeft: `${(depth + 1) * 14 + 12}px` }}
								>
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
					className={cn(
						"flex items-center justify-between gap-2 w-full py-1.5 pr-2 border-0 rounded-sm text-left text-xs cursor-pointer transition-colors",
						isSelected ? "bg-subtle text-accent font-semibold" : "bg-transparent text-ink hover:bg-hover/60",
					)}
					style={{ paddingLeft: `${depth * 14 + 10}px` }}
					title={`${node.fullPath} (${formatByteSize(node.sizeBytes)})`}
					onClick={() => void loadSubFile(node.fullPath)}
				>
					<span className="min-w-0 truncate">{node.name}</span>
					<span className="text-[10px] font-mono text-ink-muted shrink-0">{formatByteSize(node.sizeBytes)}</span>
				</button>
			);
		});

	const isMarkdown = activePath.toLowerCase().endsWith(".md");
	const displayedContent = activePath === "README.md" ? readmeContent : subContent;

	return (
		<div className="mt-4 flex flex-col gap-3.5">
			<div className="flex items-center justify-between gap-2.5 flex-wrap px-3 py-2 border border-line rounded-lg bg-sidebar">
				<div className="flex items-center gap-2.5 min-w-0">
					<Button variant="secondary" size="xs" aria-expanded={treeOpen} onClick={() => setTreeOpen((v) => !v)}>
						{treeOpen ? `收起文件树 (${visibleFileCount})` : `展开文件树 (${visibleFileCount})`}
					</Button>
					<code className="font-mono text-xs text-ink-secondary truncate">
						{addingDir ? "新建子目录" : addingFiles ? "批量添加子文件" : activePath}
					</code>
				</div>
				<div className="flex items-center flex-wrap gap-2">
					{previewEntryPath && (
						<a
							className="inline-flex items-center justify-center h-6 px-2 text-xs font-medium whitespace-nowrap rounded-xs bg-cta text-stage hover:opacity-90 no-underline shrink-0"
							href={spaceDocumentPreviewUrl(docId, previewEntryPath)}
							target="_blank"
							rel="noreferrer"
						>
							预览站点 ↗
						</a>
					)}
					{canWrite && (
						<>
							<Button
								variant="secondary"
								size="xs"
								onClick={() => {
									setAddingDir((v) => !v);
									setAddingFiles(false);
									setEditingSubFile(false);
									setError("");
								}}
							>
								{addingDir ? "取消建目录" : "+ 新建子目录"}
							</Button>
							<Button
								variant="secondary"
								size="xs"
								onClick={() => {
									setAddingFiles((v) => !v);
									setAddingDir(false);
									setEditingSubFile(false);
									setError("");
								}}
							>
								{addingFiles ? "取消添加" : "+ 添加子文件"}
							</Button>
						</>
					)}
				</div>
			</div>

			{error && <Banner tone="danger">{error}</Banner>}

			<div
				className={cn(
					"grid grid-cols-1 gap-4 items-start",
					treeOpen && "md:grid-cols-[minmax(175px,215px)_minmax(0,1fr)]",
				)}
			>
				{treeOpen && (
					<aside
						className="flex flex-col gap-1.5 min-h-0 md:min-h-[220px] border-b border-line pb-3 md:border-b-0 md:border-r md:pb-0 md:pr-3"
						aria-label="目录文件树"
					>
						{renderTreeNodes(treeNodes)}
					</aside>
				)}

				<div className="min-w-0">
					{addingDir ? (
						<form
							className="flex flex-col gap-3 p-3.5 border border-line rounded-lg bg-surface"
							onSubmit={(e) => void handleCreateSubDir(e)}
						>
							<FieldGroup label="子目录相对路径（支持多级目录）" htmlFor={newDirInputId}>
								<Input
									id={newDirInputId}
									mono
									placeholder="如 demo/assets 或 refs/benchmarks"
									value={newDirPath}
									onChange={(e) => setNewDirPath(e.target.value)}
									required
								/>
							</FieldGroup>
							<div className="flex items-center flex-wrap gap-2">
								<span className="text-micro text-ink-muted">常用目录：</span>
								{["refs", "demo", "demo/assets", "docs/api"].map((preset) => (
									<Button key={preset} variant="inline" size="xs" onClick={() => setNewDirPath(preset)}>
										{preset}/
									</Button>
								))}
							</div>
							<div className="flex items-center gap-2">
								<Button variant="primary" size="xs" type="submit" disabled={busy}>
									{busy ? "创建中…" : "创建子目录"}
								</Button>
								<Button variant="secondary" size="xs" disabled={busy} onClick={() => setAddingDir(false)}>
									取消
								</Button>
							</div>
						</form>
					) : addingFiles ? (
						<form
							className="flex flex-col gap-3 p-3.5 border border-line rounded-lg bg-surface"
							onSubmit={(e) => void handleCreateBatchFiles(e)}
						>
							<div className="flex items-center flex-wrap gap-2">
								<span className="text-micro text-ink-muted">快捷追加（路径含 / 自动建多级子目录）：</span>
								{["notes.md", "refs/option-a.md", "demo/index.html", "demo/assets/app.js", ".gitignore"].map(
									(preset) => (
										<Button
											key={preset}
											variant="inline"
											size="xs"
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
										</Button>
									),
								)}
							</div>

							{draftRows.map((row, index) => (
								<Card key={row.id} padding="sm" className="flex flex-col gap-2">
									<div className="flex items-center gap-2.5">
										<Input
											size="sm"
											mono
											className="flex-1"
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
											<Button
												variant="inline"
												size="xs"
												className="text-danger-text"
												onClick={() => setDraftRows((prev) => prev.filter((item) => item.id !== row.id))}
											>
												移除
											</Button>
										)}
									</div>
									<Textarea
										mono
										className="min-h-[110px]"
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
								</Card>
							))}

							<div className="flex items-center gap-2">
								<Button
									variant="secondary"
									size="xs"
									onClick={() => setDraftRows((prev) => [...prev, createDraftRow()])}
								>
									+ 再加一个文件
								</Button>
							</div>

							<FieldGroup label="提交说明（可选）" htmlFor={batchCommitInputId}>
								<Input
									id={batchCommitInputId}
									value={batchCommitMsg}
									onChange={(e) => setBatchCommitMsg(e.target.value)}
									placeholder={`一次提交 ${draftRows.length} 个子文件`}
									maxLength={200}
								/>
							</FieldGroup>

							<div className="flex items-center gap-2">
								<Button variant="primary" size="xs" type="submit" disabled={busy}>
									{busy ? "提交中…" : `保存 ${draftRows.length} 个文件并提交 Git`}
								</Button>
								<Button variant="secondary" size="xs" disabled={busy} onClick={() => setAddingFiles(false)}>
									取消
								</Button>
							</div>
						</form>
					) : editingSubFile ? (
						<form
							className="flex flex-col gap-3 p-3.5 border border-line rounded-lg bg-surface"
							onSubmit={(e) => void handleSaveSubFile(e)}
						>
							<FieldGroup
								label={
									<>
										编辑文件：<code className="font-mono">{activePath}</code>
									</>
								}
								htmlFor={editSubFileId}
							>
								<Textarea
									id={editSubFileId}
									mono
									className="min-h-[300px]"
									value={draftContent}
									onChange={(e) => setDraftContent(e.target.value)}
								/>
							</FieldGroup>
							<div className="flex items-center gap-2">
								<Button variant="primary" size="xs" type="submit" disabled={busy}>
									{busy ? "提交中…" : "保存并提交 Git"}
								</Button>
								<Button variant="secondary" size="xs" disabled={busy} onClick={() => setEditingSubFile(false)}>
									取消
								</Button>
							</div>
						</form>
					) : (
						<>
							<div className="flex items-center justify-between gap-2.5 pb-2.5 border-b border-dashed border-line text-xs">
								<code className="font-mono text-ink">{activePath}</code>
								{canWrite && (
									<div className="flex items-center gap-2">
										<Button
											variant="inline"
											size="xs"
											onClick={() => {
												setDraftContent(displayedContent);
												setEditingSubFile(true);
											}}
										>
											编辑此文件
										</Button>
										{activePath !== "README.md" && (
											<Button
												variant="inline"
												size="xs"
												className="text-danger-text"
												disabled={busy}
												onClick={() => void handleDeleteSubFile(activePath)}
											>
												删除
											</Button>
										)}
									</div>
								)}
							</div>
							{loadingFile ? (
								<p className="m-0 py-3 text-xs text-ink-muted">正在读取文件…</p>
							) : isMarkdown ? (
								<div className="mt-3">
									<MarkdownView content={displayedContent || "（空白）"} />
								</div>
							) : (
								<pre className="mt-3 p-3.5 border border-line rounded-lg bg-sidebar font-mono text-xs leading-relaxed text-ink overflow-x-auto whitespace-pre-wrap break-words">
									{displayedContent || "（空文件）"}
								</pre>
							)}
						</>
					)}
				</div>
			</div>
		</div>
	);
}
