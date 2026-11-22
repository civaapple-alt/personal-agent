import { useCallback, useEffect, useMemo, useState } from "react";
import {
	createCustomSpace,
	createSpaceDocument,
	getSpaceDocument,
	getSpaceDocumentCommitDetail,
	listRecentSpaceDocuments,
	listSpaceDocumentCommits,
	listSpaceDocuments,
	listSpaces,
	promoteSpaceDocumentToFolder,
	SPACE_DOC_TYPE_OPTIONS,
	type SpaceDocumentDto,
	type SpaceDocumentFileDto,
	type SpaceDocumentMetaDto,
	type SpaceDocumentType,
	type SpaceDto,
	type SpaceEntryKind,
	type SpaceGitCommitDetailDto,
	type SpaceGitCommitDto,
	type SpaceKind,
	type SpaceVisibility,
	spaceDocTypeLabel,
	updateSpaceDocument,
} from "../api/space.ts";
import type { BootstrapPayload } from "../api.ts";
import { MarkdownView } from "../MarkdownView.tsx";
import { SpaceFolderFilesPanel } from "./SpaceFolderFilesPanel.tsx";

const RECENT_SPACE_ID = "__recent__";

const SPACE_KIND_SECTIONS: Array<{ kind: SpaceKind; label: string }> = [
	{ kind: "org", label: "组织空间" },
	{ kind: "workspace", label: "仓库空间" },
	{ kind: "user", label: "个人空间" },
	{ kind: "member", label: "AI 角色空间" },
	{ kind: "custom", label: "自定义空间" },
];

export function SpacePages({
	bootstrap,
	pageId,
	memberName,
	onOpenMatter,
}: {
	bootstrap: BootstrapPayload | null;
	pageId?: string;
	memberName: (id: string) => string;
	onOpenMatter: (id: string) => void;
}) {
	const [spaces, setSpaces] = useState<SpaceDto[]>([]);
	const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(null);
	const [documents, setDocuments] = useState<SpaceDocumentMetaDto[]>([]);
	const [selectedDoc, setSelectedDoc] = useState<SpaceDocumentDto | null>(null);
	const [docFiles, setDocFiles] = useState<SpaceDocumentFileDto[]>([]);
	const [docPreviewPath, setDocPreviewPath] = useState<string | null>(null);
	const [docCanWrite, setDocCanWrite] = useState(false);
	const [commits, setCommits] = useState<SpaceGitCommitDto[]>([]);
	const [selectedCommitHash, setSelectedCommitHash] = useState<string | null>(null);
	const [commitDetail, setCommitDetail] = useState<SpaceGitCommitDetailDto | null>(null);

	const [editing, setEditing] = useState(false);
	const [navCollapsed, setNavCollapsed] = useState(false);
	const [creatingSpace, setCreatingSpace] = useState(false);
	const [expandedEmptyGroups, setExpandedEmptyGroups] = useState<Record<string, boolean>>({});
	const [newSpaceName, setNewSpaceName] = useState("");
	const [newSpaceDesc, setNewSpaceDesc] = useState("");
	const [newSpaceVisibility, setNewSpaceVisibility] = useState<SpaceVisibility>("org");
	const [newSpaceOrgId, setNewSpaceOrgId] = useState<string>("");

	const [title, setTitle] = useState("");
	const [docType, setDocType] = useState<SpaceDocumentType>("note");
	const [entryKind, setEntryKind] = useState<SpaceEntryKind>("file");
	const [extraFiles, setExtraFiles] = useState<Array<{ id: string; path: string; content: string }>>([]);
	const [docTypeFilter, setDocTypeFilter] = useState<"all" | SpaceDocumentType>("all");
	const [content, setContent] = useState("");
	const [linkedWorkspaceId, setLinkedWorkspaceId] = useState("");
	const [linkedFilePath, setLinkedFilePath] = useState("");
	const [commitMessage, setCommitMessage] = useState("");
	const [matterId, setMatterId] = useState("");
	const [search, setSearch] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	const isRecentView = selectedSpaceId === RECENT_SPACE_ID;
	const selectedSpace = useMemo(
		() => (isRecentView ? null : (spaces.find((s) => s.id === selectedSpaceId) ?? null)),
		[spaces, selectedSpaceId, isRecentView],
	);
	const spaceNameById = useMemo(() => new Map(spaces.map((s) => [s.id, s.name])), [spaces]);

	const resolveActorLabel = useCallback(
		(actorId: string) => {
			if (!actorId) return "系统";
			const fromMember = memberName(actorId);
			if (fromMember && fromMember !== actorId) return fromMember;
			const collab = bootstrap?.collaborators?.find((c) => c.id === actorId);
			if (collab) return collab.name;
			if (bootstrap?.accountUser?.id === actorId) return bootstrap.accountUser.displayName;
			return actorId;
		},
		[bootstrap, memberName],
	);

	const loadSpaceContents = useCallback(async (spaceId: string) => {
		if (spaceId === RECENT_SPACE_ID) {
			const res = await listRecentSpaceDocuments({ limit: 80 });
			setDocuments(res.documents);
			return res;
		}
		const res = await listSpaceDocuments(spaceId);
		setDocuments(res.documents);
		return res;
	}, []);

	const openDocument = useCallback(async (docId: string) => {
		setError("");
		setEditing(false);
		setSelectedCommitHash(null);
		setCommitDetail(null);
		const [docRes, commitsRes] = await Promise.all([getSpaceDocument(docId), listSpaceDocumentCommits(docId)]);
		setSelectedDoc(docRes.document);
		setDocFiles(docRes.files ?? []);
		setDocPreviewPath(docRes.previewEntryPath ?? null);
		setDocCanWrite(docRes.canWrite);
		setCommits(commitsRes.commits);
	}, []);

	const refreshSpaces = useCallback(async () => {
		const { spaces: loaded } = await listSpaces();
		setSpaces(loaded);
		return loaded;
	}, []);

	// Initial load & deep-link support (pageId can be a doc_... or spc_...)
	useEffect(() => {
		let cancelled = false;
		void (async () => {
			try {
				const loaded = await refreshSpaces();
				if (cancelled) return;
				if (pageId?.startsWith("spc_")) {
					const target = loaded.find((s) => s.id === pageId);
					if (target) {
						setSelectedSpaceId(target.id);
						setSelectedDoc(null);
						return;
					}
				}
				if (pageId) {
					try {
						const docRes = await getSpaceDocument(pageId);
						if (cancelled) return;
						setSelectedSpaceId(docRes.document.spaceId);
						setSelectedDoc(docRes.document);
						setDocFiles(docRes.files ?? []);
						setDocPreviewPath(docRes.previewEntryPath ?? null);
						setDocCanWrite(docRes.canWrite);
						const commitsRes = await listSpaceDocumentCommits(pageId);
						if (!cancelled) setCommits(commitsRes.commits);
						return;
					} catch {
						// Fallback to first available space
					}
				}
				// Default to cross-space "最近修改" when opening 资料空间 without a deep-link
				if (loaded.some((s) => s.documentCount > 0)) {
					setSelectedSpaceId(RECENT_SPACE_ID);
					return;
				}
				const preferred = loaded.find((s) => s.kind === "workspace") ?? loaded[0] ?? null;
				if (preferred) setSelectedSpaceId(preferred.id);
			} catch (err) {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [pageId, refreshSpaces]);

	// Load documents & refs when active space changes
	useEffect(() => {
		if (!selectedSpaceId) return;
		let cancelled = false;
		void loadSpaceContents(selectedSpaceId)
			.then((res) => {
				if (cancelled) return;
				let needsAutoOpen = false;
				setSelectedDoc((prev) => {
					if (prev && (selectedSpaceId === RECENT_SPACE_ID || prev.spaceId === selectedSpaceId)) return prev;
					needsAutoOpen = res.documents.length > 0;
					return null;
				});
				if (needsAutoOpen && res.documents[0]) {
					void openDocument(res.documents[0].id).catch(() => {});
				}
			})
			.catch((err: unknown) => {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			});
		return () => {
			cancelled = true;
		};
	}, [selectedSpaceId, loadSpaceContents, openDocument]);

	// Live SSE sync
	useEffect(() => {
		const events = new EventSource("/api/events");
		let cancelled = false;
		const sync = () => {
			void refreshSpaces().catch(() => {});
			if (selectedSpaceId) {
				void loadSpaceContents(selectedSpaceId).catch(() => {});
			}
			if (selectedDoc?.id && !editing) {
				void openDocument(selectedDoc.id).catch(() => {});
			}
		};
		events.addEventListener("space_updated", sync);
		events.addEventListener("space_page_updated", sync);
		events.addEventListener("matter_settled", sync);
		return () => {
			cancelled = true;
			void cancelled;
			events.close();
		};
	}, [selectedSpaceId, selectedDoc?.id, editing, refreshSpaces, loadSpaceContents, openDocument]);

	const handleToggleCommit = async (hash: string) => {
		if (!selectedDoc) return;
		if (selectedCommitHash === hash) {
			setSelectedCommitHash(null);
			setCommitDetail(null);
			return;
		}
		setSelectedCommitHash(hash);
		setCommitDetail(null);
		try {
			const res = await getSpaceDocumentCommitDetail(selectedDoc.id, hash);
			setCommitDetail(res.detail);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const handleCreateCustomSpace = async (event: React.FormEvent) => {
		event.preventDefault();
		if (!newSpaceName.trim()) return;
		setBusy(true);
		setError("");
		try {
			const orgId = newSpaceOrgId || bootstrap?.organizations[0]?.id || null;
			const { space } = await createCustomSpace({
				name: newSpaceName.trim(),
				description: newSpaceDesc.trim(),
				orgId: newSpaceVisibility === "org" ? orgId : null,
				visibility: newSpaceVisibility,
			});
			setCreatingSpace(false);
			setNewSpaceName("");
			setNewSpaceDesc("");
			await refreshSpaces();
			setSelectedSpaceId(space.id);
			setSelectedDoc(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const startNewDocument = () => {
		setSelectedDoc(null);
		setTitle("");
		setDocType(docTypeFilter === "all" ? "note" : docTypeFilter);
		setEntryKind("file");
		setExtraFiles([]);
		setContent("");
		setLinkedWorkspaceId(selectedSpace?.workspaceId ?? "");
		setLinkedFilePath("");
		setCommitMessage("");
		setMatterId("");
		setEditing(true);
		setError("");
	};

	const handlePromoteToFolder = async () => {
		if (!selectedDoc || !selectedSpaceId || busy) return;
		setBusy(true);
		setError("");
		try {
			await promoteSpaceDocumentToFolder(selectedDoc.id);
			await loadSpaceContents(selectedSpaceId);
			await openDocument(selectedDoc.id);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const handleSaveDocument = async (event: React.FormEvent) => {
		event.preventDefault();
		if (!selectedSpaceId) return;
		setBusy(true);
		setError("");
		const matchedWs = linkedWorkspaceId ? bootstrap?.workspaces.find((w) => w.id === linkedWorkspaceId) : null;
		const resolvedLinkedOrgId = matchedWs?.orgId ?? selectedSpace?.orgId ?? null;
		try {
			if (selectedDoc) {
				const { document } = await updateSpaceDocument(selectedDoc.id, {
					revision: selectedDoc.revision,
					title,
					docType,
					content,
					linkedOrgId: linkedFilePath.trim() ? resolvedLinkedOrgId : null,
					linkedWorkspaceId: linkedFilePath.trim() ? linkedWorkspaceId || null : null,
					linkedFilePath: linkedFilePath.trim() || null,
					commitMessage: commitMessage.trim() || undefined,
				});
				await loadSpaceContents(selectedSpaceId);
				await openDocument(document.id);
			} else {
				const validExtraFiles =
					entryKind === "folder"
						? extraFiles.map((f) => ({ path: f.path.trim(), content: f.content })).filter((f) => Boolean(f.path))
						: [];
				const { document } = await createSpaceDocument(selectedSpaceId, {
					title,
					docType,
					entryKind,
					content,
					...(validExtraFiles.length > 0 ? { extraFiles: validExtraFiles } : {}),
					matterId: matterId || null,
					linkedOrgId: linkedFilePath.trim() ? resolvedLinkedOrgId : null,
					linkedWorkspaceId: linkedFilePath.trim() ? linkedWorkspaceId || null : null,
					linkedFilePath: linkedFilePath.trim() || null,
					commitMessage: commitMessage.trim() || undefined,
				});
				await refreshSpaces();
				await loadSpaceContents(selectedSpaceId);
				await openDocument(document.id);
			}
			setEditing(false);
			setCommitMessage("");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const filteredDocs = useMemo(() => {
		const q = search.trim().toLowerCase();
		return documents.filter((doc) => {
			if (docTypeFilter !== "all" && doc.docType !== docTypeFilter) return false;
			if (!q) return true;
			return doc.title.toLowerCase().includes(q) || doc.filePath.toLowerCase().includes(q);
		});
	}, [documents, search, docTypeFilter]);

	const docTypeCounts = useMemo(() => {
		const counts: Record<SpaceDocumentType, number> = { plan: 0, spec: 0, decision: 0, rule: 0, note: 0 };
		for (const doc of documents) {
			counts[doc.docType] = (counts[doc.docType] ?? 0) + 1;
		}
		return counts;
	}, [documents]);

	const canWriteCurrentSpace = Boolean(selectedSpace?.canWrite);

	return (
		<section className="space-shell">
			{error && (
				<p role="alert" className="space-error">
					{error}
				</p>
			)}

			<div className={`space-three-col ${navCollapsed ? "is-nav-collapsed" : ""}`}>
				{/* Column 1: 5 Space Kinds */}
				{!navCollapsed && (
					<aside className="space-nav-col" aria-label="空间列表">
						<div className="space-nav-head">
							<strong>全部空间 ({spaces.length})</strong>
							<button
								type="button"
								className="btn-inline"
								onClick={() => {
									setCreatingSpace((v) => !v);
									setNewSpaceOrgId(bootstrap?.organizations[0]?.id ?? "");
								}}
							>
								{creatingSpace ? "取消" : "+ 新建空间"}
							</button>
						</div>

						{creatingSpace && (
							<form className="space-create-form" onSubmit={(e) => void handleCreateCustomSpace(e)}>
								<input
									className="input-field"
									placeholder="空间名称"
									value={newSpaceName}
									onChange={(e) => setNewSpaceName(e.target.value)}
									maxLength={100}
									required
								/>
								<input
									className="input-field"
									placeholder="简要说明（可选）"
									value={newSpaceDesc}
									onChange={(e) => setNewSpaceDesc(e.target.value)}
									maxLength={200}
								/>
								<div className="space-create-row">
									<select
										className="input-field"
										value={newSpaceVisibility}
										onChange={(e) => setNewSpaceVisibility(e.target.value as SpaceVisibility)}
									>
										<option value="org">组织共享</option>
										<option value="private">仅自己私密</option>
									</select>
									{newSpaceVisibility === "org" && (bootstrap?.organizations.length ?? 0) > 1 && (
										<select
											className="input-field"
											value={newSpaceOrgId}
											onChange={(e) => setNewSpaceOrgId(e.target.value)}
										>
											{bootstrap?.organizations.map((org) => (
												<option key={org.id} value={org.id}>
													{org.name}
												</option>
											))}
										</select>
									)}
								</div>
								<button type="submit" className="btn-pill-dark btn-xs" disabled={busy}>
									创建 Git 空间
								</button>
							</form>
						)}

						<div className="space-nav-groups">
							<div className="space-nav-group">
								<button
									type="button"
									className={`space-nav-item ${isRecentView ? "active" : ""}`}
									onClick={() => {
										setSelectedSpaceId(RECENT_SPACE_ID);
										setEditing(false);
										setSelectedCommitHash(null);
										setCommitDetail(null);
									}}
								>
									<span className="space-nav-item-name">最近修改</span>
									<span className="space-nav-item-count">跨空间</span>
								</button>
							</div>
							{SPACE_KIND_SECTIONS.map(({ kind, label }) => {
								const group = spaces
									.filter((s) => s.kind === kind)
									.sort((a, b) => b.documentCount - a.documentCount || b.updatedAt.localeCompare(a.updatedAt));
								if (group.length === 0) return null;
								const nonEmpty = group.filter((s) => s.documentCount > 0 || s.id === selectedSpaceId);
								const empty = group.filter((s) => s.documentCount === 0 && s.id !== selectedSpaceId);
								const shouldFoldEmpty = spaces.length > 8 && empty.length > 0 && !expandedEmptyGroups[kind];
								const minVisible = Math.min(2, group.length);
								const shown = shouldFoldEmpty
									? nonEmpty.length >= minVisible
										? nonEmpty
										: [...nonEmpty, ...empty.slice(0, minVisible - nonEmpty.length)]
									: group;
								const hiddenCount = group.length - shown.length;
								return (
									<div key={kind} className="space-nav-group">
										<div className="space-nav-group-label">{label}</div>
										{shown.map((space) => (
											<button
												type="button"
												key={space.id}
												className={`space-nav-item ${selectedSpaceId === space.id ? "active" : ""}`}
												onClick={() => {
													setSelectedSpaceId(space.id);
													setEditing(false);
													setSelectedCommitHash(null);
													setCommitDetail(null);
												}}
											>
												<span className="space-nav-item-name">{space.name}</span>
												<span className="space-nav-item-count">
													{space.documentCount > 0 ? space.documentCount : ""}
												</span>
											</button>
										))}
										{hiddenCount > 0 && (
											<button
												type="button"
												className="space-nav-more"
												onClick={() => setExpandedEmptyGroups((prev) => ({ ...prev, [kind]: true }))}
											>
												展开其余 {hiddenCount} 个空空间
											</button>
										)}
										{!shouldFoldEmpty &&
											spaces.length > 8 &&
											empty.length > 0 &&
											expandedEmptyGroups[kind] && (
												<button
													type="button"
													className="space-nav-more"
													onClick={() => setExpandedEmptyGroups((prev) => ({ ...prev, [kind]: false }))}
												>
													收起空空间
												</button>
											)}
									</div>
								);
							})}
						</div>
					</aside>
				)}

				{/* Column 2: Documents + Business Repo Refs */}
				{!navCollapsed && (
					<div className="space-docs-col">
						<div className="space-pages-toolbar">
							<input
								className="input-field"
								aria-label={isRecentView ? "搜索最近修改资料" : "搜索当前空间资料"}
								placeholder={isRecentView ? "搜索全部空间的最近资料…" : "搜索资料标题或路径…"}
								value={search}
								onChange={(e) => setSearch(e.target.value)}
							/>
							{canWriteCurrentSpace && (
								<button type="button" className="btn-pill-dark btn-xs" onClick={startNewDocument}>
									+ 新建资料
								</button>
							)}
						</div>

						<div className="space-type-filter-bar" role="tablist" aria-label="按内容类型筛选">
							<button
								type="button"
								role="tab"
								aria-selected={docTypeFilter === "all"}
								className={`space-type-chip ${docTypeFilter === "all" ? "active" : ""}`}
								onClick={() => setDocTypeFilter("all")}
							>
								全部{documents.length > 0 ? ` (${documents.length})` : ""}
							</button>
							{SPACE_DOC_TYPE_OPTIONS.map((opt) => (
								<button
									key={opt.value}
									type="button"
									role="tab"
									aria-selected={docTypeFilter === opt.value}
									className={`space-type-chip ${docTypeFilter === opt.value ? "active" : ""}`}
									title={opt.hint}
									onClick={() => setDocTypeFilter(opt.value)}
								>
									{opt.label}
									{docTypeCounts[opt.value] > 0 ? ` (${docTypeCounts[opt.value]})` : ""}
								</button>
							))}
						</div>

						<div className="space-pages-list">
							{filteredDocs.length === 0 ? (
								<p className="muted-hint">
									{documents.length
										? "没有匹配当前筛选条件的资料"
										: isRecentView
											? "暂无最近修改的资料。"
											: "当前空间还没有资料。可点击上方新建，或在对话中由 AI 保存。"}
								</p>
							) : (
								filteredDocs.map((doc) => (
									<button
										type="button"
										key={doc.id}
										className={`space-page-row ${selectedDoc?.id === doc.id && !editing ? "active" : ""}`}
										onClick={() => void openDocument(doc.id)}
									>
										<div className="space-page-row-head">
											<span className={`space-doc-type-pill is-${doc.docType}`}>
												{spaceDocTypeLabel(doc.docType)}
											</span>
											{doc.entryKind === "folder" && (
												<span className="space-folder-badge" title="目录条目（支持多文件与 .gitignore）">
													📁
												</span>
											)}
											<strong>{doc.title}</strong>
										</div>
										<span>
											{isRecentView ? `${spaceNameById.get(doc.spaceId) ?? doc.spaceId} · ` : ""}
											rev {doc.revision} · {doc.headCommit.slice(0, 7)} ·{" "}
											{new Date(doc.updatedAt).toLocaleDateString()}
										</span>
									</button>
								))
							)}
						</div>
					</div>
				)}

				{/* Column 3: Document Viewer / Editor + Git Commits & Diff */}
				<div className="space-page-detail">
					<div className="space-detail-topbar">
						<button
							type="button"
							className="btn-pill-outline btn-xs"
							aria-expanded={!navCollapsed}
							onClick={() => setNavCollapsed((v) => !v)}
						>
							{navCollapsed ? "展开导航目录" : "收起导航目录"}
						</button>
						{navCollapsed && selectedSpace && <span className="muted-tiny">当前空间：{selectedSpace.name}</span>}
					</div>
					{editing ? (
						<form className="space-editor-form" onSubmit={(e) => void handleSaveDocument(e)}>
							<div className="space-page-heading">
								<h2>
									{selectedDoc ? `编辑：${selectedDoc.title}` : `在「${selectedSpace?.name ?? ""}」新建资料`}
								</h2>
							</div>
							{!selectedDoc && (bootstrap?.matters.length ?? 0) > 0 && (
								<label>
									关联事项（可选）
									<select
										className="input-field"
										value={matterId}
										onChange={(e) => setMatterId(e.target.value)}
									>
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
										onChange={(e) => setTitle(e.target.value)}
										maxLength={200}
										required
									/>
								</label>
								<label style={{ flex: 1 }}>
									内容类型
									<select
										className="input-field"
										value={docType}
										onChange={(e) => setDocType(e.target.value as SpaceDocumentType)}
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
											onChange={(e) => setEntryKind(e.target.value as SpaceEntryKind)}
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
									onChange={(e) => setContent(e.target.value)}
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
														setExtraFiles((prev) => [
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
													setExtraFiles((prev) => [
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
														setExtraFiles((prev) =>
															prev.map((item) =>
																item.id === file.id ? { ...item, path: e.target.value } : item,
															),
														)
													}
													required
												/>
												<button
													type="button"
													className="btn-inline btn-danger-inline"
													onClick={() =>
														setExtraFiles((prev) => prev.filter((item) => item.id !== file.id))
													}
												>
													移除
												</button>
											</div>
											<textarea
												className="input-field space-extra-file-editor"
												placeholder="输入子文件内容（Markdown / HTML / 配置 / 文本）"
												value={file.content}
												onChange={(e) =>
													setExtraFiles((prev) =>
														prev.map((item) =>
															item.id === file.id ? { ...item, content: e.target.value } : item,
														),
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
										onChange={(e) => setLinkedWorkspaceId(e.target.value)}
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
										onChange={(e) => setLinkedFilePath(e.target.value)}
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
									onChange={(e) => setCommitMessage(e.target.value)}
									placeholder={selectedDoc ? `Update ${title || selectedDoc.title}` : "Create document"}
									maxLength={200}
								/>
							</label>
							<div className="space-page-actions">
								<button className="btn-pill-dark" type="submit" disabled={busy}>
									{busy ? "提交中…" : "保存并提交 Git"}
								</button>
								<button
									className="btn-secondary"
									type="button"
									onClick={() => setEditing(false)}
									disabled={busy}
								>
									取消
								</button>
							</div>
						</form>
					) : selectedDoc ? (
						<>
							<div className="space-page-heading">
								<div>
									<h2>{selectedDoc.title}</h2>
									<div className="space-doc-meta">
										<span className={`space-doc-type-pill is-${selectedDoc.docType}`}>
											{spaceDocTypeLabel(selectedDoc.docType)}
										</span>
										<span className="pill">
											{spaceNameById.get(selectedDoc.spaceId) ?? selectedDoc.spaceId}
										</span>
										<span className="pill">
											rev {selectedDoc.revision} · <code>{selectedDoc.headCommit.slice(0, 7)}</code>
										</span>
										{selectedDoc.linkedFilePath && (
											<span className="pill">
												关联：
												{selectedDoc.linkedWorkspaceId
													? `${bootstrap?.workspaces.find((w) => w.id === selectedDoc.linkedWorkspaceId)?.name ?? selectedDoc.linkedWorkspaceId} / `
													: ""}
												<code>{selectedDoc.linkedFilePath}</code>
											</span>
										)}
										<span className="muted-hint">
											最近更新：{resolveActorLabel(selectedDoc.updatedBy)} ·{" "}
											{new Date(selectedDoc.updatedAt).toLocaleString()}
										</span>
									</div>
								</div>
								{docCanWrite && (
									<div className="space-page-actions">
										{selectedDoc.entryKind === "file" && (
											<button
												type="button"
												className="btn-pill-outline btn-xs"
												disabled={busy}
												title="转为目录条目，便于追加参考文件、.gitignore 或演示站点"
												onClick={() => void handlePromoteToFolder()}
											>
												转为目录条目
											</button>
										)}
										<button
											type="button"
											className="btn-secondary"
											onClick={() => {
												setTitle(selectedDoc.title);
												setDocType(selectedDoc.docType);
												setContent(selectedDoc.content);
												setLinkedWorkspaceId(selectedDoc.linkedWorkspaceId ?? "");
												setLinkedFilePath(selectedDoc.linkedFilePath ?? "");
												setCommitMessage("");
												setEditing(true);
											}}
										>
											{selectedDoc.entryKind === "folder" ? "编辑主说明" : "编辑"}
										</button>
									</div>
								)}
							</div>

							{selectedDoc.matterId && (
								<div className="space-doc-links">
									<button
										type="button"
										className="btn-inline"
										onClick={() => onOpenMatter(selectedDoc.matterId!)}
									>
										查看来源事项 →
									</button>
								</div>
							)}

							{selectedDoc.entryKind === "folder" ? (
								<SpaceFolderFilesPanel
									docId={selectedDoc.id}
									readmeContent={selectedDoc.content}
									files={docFiles}
									previewEntryPath={docPreviewPath}
									canWrite={docCanWrite}
									onChanged={async () => {
										if (selectedSpaceId) await loadSpaceContents(selectedSpaceId);
										await openDocument(selectedDoc.id);
									}}
								/>
							) : (
								<div className="space-page-content">
									<MarkdownView content={selectedDoc.content || "（空白）"} />
								</div>
							)}

							<details className="space-commits-panel" open={commits.length > 1}>
								<summary>Git 提交历史（{commits.length}）</summary>
								<ul className="space-commit-list">
									{commits.map((commit) => (
										<li key={commit.hash} className="space-commit-item">
											<button
												type="button"
												className={`space-commit-btn ${selectedCommitHash === commit.hash ? "active" : ""}`}
												onClick={() => void handleToggleCommit(commit.hash)}
											>
												<code className="space-commit-hash">{commit.shortHash}</code>
												<span className="space-commit-subject">{commit.subject}</span>
												<span className="space-commit-meta">
													{resolveActorLabel(commit.authorName)} ·{" "}
													{new Date(commit.committedAt).toLocaleString()}
												</span>
											</button>
											{selectedCommitHash === commit.hash && commitDetail && (
												<div className="space-commit-diff-box">
													<pre className="space-diff-pre">
														{(commitDetail.diff || "（无文本差异）").split("\n").map((line, index) => (
															<span
																key={`${commit.hash}-${index}`}
																className={
																	line.startsWith("+") && !line.startsWith("+++")
																		? "diff-add"
																		: line.startsWith("-") && !line.startsWith("---")
																			? "diff-del"
																			: line.startsWith("@@")
																				? "diff-hunk"
																				: ""
																}
															>
																{line}
																{"\n"}
															</span>
														))}
													</pre>
												</div>
											)}
										</li>
									))}
								</ul>
							</details>
						</>
					) : (
						<div className="space-empty-detail">
							<h3>{selectedSpace?.name ?? "资料空间"}</h3>
							{selectedSpace?.description && <p className="muted-hint">{selectedSpace.description}</p>}
							<p className="muted-hint">
								{documents.length > 0
									? "从左侧选择一篇资料查看，或点击「新建资料」。"
									: "该空间目前还没有资料文档。所有新建和编辑都会自动记录为独立 Git 仓库中的标准提交。"}
							</p>
						</div>
					)}
				</div>
			</div>
		</section>
	);
}
