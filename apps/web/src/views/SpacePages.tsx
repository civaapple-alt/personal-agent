import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
	type SpaceDocumentFileDto,
	type SpaceDocumentMetaDto,
	type SpaceDocumentType,
	type SpaceDto,
	type SpaceEntryKind,
	type SpaceGitCommitDto,
	type SpaceKind,
	type SpaceVisibility,
	spaceDocTypeLabel,
	updateSpaceDocument,
} from "../api/space.ts";
import type { BootstrapPayload } from "../api.ts";
import { SpaceDocumentDetailPane } from "../components/spaces/SpaceDocumentDetailPane.tsx";
import { SpaceDocumentEditorForm } from "../components/spaces/SpaceDocumentEditorForm.tsx";
import {
	Badge,
	type BadgeTone,
	Banner,
	Button,
	EmptyState,
	Input,
	Select,
	type TabItem,
	Tabs,
} from "../primitives/index.ts";
import { queryKeys } from "../queries/index.ts";
import { cn } from "../utils/cn.ts";

const RECENT_SPACE_ID = "__recent__";
const EMPTY_SPACES: SpaceDto[] = [];
const EMPTY_DOCS: SpaceDocumentMetaDto[] = [];
const EMPTY_DOC_FILES: SpaceDocumentFileDto[] = [];
const EMPTY_COMMITS: SpaceGitCommitDto[] = [];

const SPACE_KIND_SECTIONS: Array<{ kind: SpaceKind; label: string }> = [
	{ kind: "org", label: "组织空间" },
	{ kind: "workspace", label: "仓库空间" },
	{ kind: "user", label: "个人空间" },
	{ kind: "member", label: "AI 角色空间" },
	{ kind: "custom", label: "自定义空间" },
];

const DOC_TYPE_TONE: Record<SpaceDocumentType, BadgeTone> = {
	plan: "accent",
	spec: "info",
	decision: "warn",
	rule: "observer",
	note: "neutral",
};

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
	const queryClient = useQueryClient();
	const appliedPageIdRef = useRef<string | null>(null);
	const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(null);
	const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
	const [selectedCommitHash, setSelectedCommitHash] = useState<string | null>(null);

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

	const spacesQuery = useQuery({
		queryKey: queryKeys.spaces.list(),
		queryFn: async () => (await listSpaces()).spaces,
	});
	const documentsQuery = useQuery({
		queryKey: queryKeys.spaces.documents(selectedSpaceId ?? ""),
		queryFn: async () =>
			selectedSpaceId === RECENT_SPACE_ID
				? (await listRecentSpaceDocuments({ limit: 80 })).documents
				: (await listSpaceDocuments(selectedSpaceId ?? "")).documents,
		enabled: Boolean(selectedSpaceId),
	});
	const docDetailQuery = useQuery({
		queryKey: queryKeys.spaces.document(selectedDocId ?? ""),
		queryFn: () => getSpaceDocument(selectedDocId ?? ""),
		enabled: Boolean(selectedDocId),
	});
	const commitsQuery = useQuery({
		queryKey: queryKeys.spaces.documentCommits(selectedDocId ?? ""),
		queryFn: async () => (await listSpaceDocumentCommits(selectedDocId ?? "")).commits,
		enabled: Boolean(selectedDocId),
	});
	const commitDetailQuery = useQuery({
		queryKey: queryKeys.spaces.commitDetail(selectedDocId ?? "", selectedCommitHash ?? ""),
		queryFn: async () => (await getSpaceDocumentCommitDetail(selectedDocId ?? "", selectedCommitHash ?? "")).detail,
		enabled: Boolean(selectedDocId && selectedCommitHash),
	});

	const spaces = spacesQuery.data ?? EMPTY_SPACES;
	const documents = documentsQuery.data ?? EMPTY_DOCS;
	const selectedDoc = selectedDocId ? (docDetailQuery.data?.document ?? null) : null;
	const docFiles = selectedDocId ? (docDetailQuery.data?.files ?? EMPTY_DOC_FILES) : EMPTY_DOC_FILES;
	const docPreviewPath = selectedDocId ? (docDetailQuery.data?.previewEntryPath ?? null) : null;
	const docCanWrite = selectedDocId ? Boolean(docDetailQuery.data?.canWrite) : false;
	const commits = selectedDocId ? (commitsQuery.data ?? EMPTY_COMMITS) : EMPTY_COMMITS;
	const commitDetail = selectedCommitHash ? (commitDetailQuery.data ?? null) : null;
	const queryError =
		spacesQuery.error ??
		documentsQuery.error ??
		docDetailQuery.error ??
		commitsQuery.error ??
		commitDetailQuery.error;
	const displayError =
		error || (queryError instanceof Error ? queryError.message : queryError ? String(queryError) : "");

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
			const member = Object.values(bootstrap?.orgMembersByOrgId ?? {})
				.flat()
				.find((item) => item.userId === actorId);
			if (member) return member.displayName;
			if (bootstrap?.accountUser?.id === actorId) return bootstrap.accountUser.displayName;
			return actorId;
		},
		[bootstrap, memberName],
	);

	const openDocument = useCallback((docId: string) => {
		setError("");
		setEditing(false);
		setSelectedCommitHash(null);
		setSelectedDocId(docId);
	}, []);

	// Initial load & deep-link support (pageId can be a doc_... or spc_...)
	useEffect(() => {
		if (!spacesQuery.isSuccess) return;
		const selectDefaultSpace = () => {
			if (spaces.some((s) => s.documentCount > 0)) {
				setSelectedSpaceId(RECENT_SPACE_ID);
				return;
			}
			const preferred = spaces.find((s) => s.kind === "workspace") ?? spaces[0] ?? null;
			if (preferred) setSelectedSpaceId(preferred.id);
		};
		if (!pageId) {
			appliedPageIdRef.current = null;
			if (!selectedSpaceId) selectDefaultSpace();
			return;
		}
		if (appliedPageIdRef.current === pageId) return;
		if (pageId.startsWith("spc_")) {
			const target = spaces.find((s) => s.id === pageId);
			if (target) {
				appliedPageIdRef.current = pageId;
				setSelectedSpaceId(target.id);
				setSelectedDocId(null);
				setSelectedCommitHash(null);
				return;
			}
		}
		let cancelled = false;
		void queryClient
			.fetchQuery({
				queryKey: queryKeys.spaces.document(pageId),
				queryFn: () => getSpaceDocument(pageId),
			})
			.then((docRes) => {
				if (cancelled) return;
				appliedPageIdRef.current = pageId;
				setSelectedSpaceId(docRes.document.spaceId);
				setSelectedDocId(docRes.document.id);
				setSelectedCommitHash(null);
			})
			.catch(() => {
				if (cancelled || selectedSpaceId) return;
				appliedPageIdRef.current = pageId;
				selectDefaultSpace();
			});
		return () => {
			cancelled = true;
		};
	}, [pageId, spacesQuery.isSuccess, spaces, selectedSpaceId, queryClient]);

	// Auto-open the first document when active space documents load or change
	useEffect(() => {
		if (!selectedSpaceId || !documentsQuery.data || editing) return;
		const loadedDocs = documentsQuery.data;
		if (selectedDocId) {
			const belongsToActiveSpace =
				selectedSpaceId === RECENT_SPACE_ID || loadedDocs.some((doc) => doc.id === selectedDocId);
			if (belongsToActiveSpace) return;
		}
		const firstDoc = loadedDocs[0];
		if (firstDoc) {
			setSelectedDocId(firstDoc.id);
			setSelectedCommitHash(null);
		} else if (selectedDocId) {
			setSelectedDocId(null);
			setSelectedCommitHash(null);
		}
	}, [selectedSpaceId, documentsQuery.data, selectedDocId, editing]);

	const handleToggleCommit = (hash: string) => {
		if (!selectedDoc) return;
		setSelectedCommitHash((prev) => (prev === hash ? null : hash));
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
			await queryClient.invalidateQueries({ queryKey: queryKeys.spaces.all });
			setSelectedSpaceId(space.id);
			setSelectedDocId(null);
			setSelectedCommitHash(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const startNewDocument = () => {
		setSelectedDocId(null);
		setSelectedCommitHash(null);
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
			await queryClient.invalidateQueries({ queryKey: queryKeys.spaces.all });
			openDocument(selectedDoc.id);
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
				await queryClient.invalidateQueries({ queryKey: queryKeys.spaces.all });
				openDocument(document.id);
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
				await queryClient.invalidateQueries({ queryKey: queryKeys.spaces.all });
				openDocument(document.id);
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

	const docTypeTabs = useMemo<TabItem[]>(
		() => [
			{ id: "all", label: "全部", count: documents.length },
			...SPACE_DOC_TYPE_OPTIONS.map((opt) => ({
				id: opt.value,
				label: opt.label,
				count: docTypeCounts[opt.value] > 0 ? docTypeCounts[opt.value] : undefined,
			})),
		],
		[documents.length, docTypeCounts],
	);

	const canWriteCurrentSpace = Boolean(selectedSpace?.canWrite);

	return (
		<section className="mt-4">
			{displayError && (
				<Banner tone="danger" className="mb-3">
					{displayError}
				</Banner>
			)}

			<div
				className={cn(
					"grid grid-cols-1 gap-4 items-start min-w-0",
					navCollapsed ? "lg:grid-cols-1" : "lg:grid-cols-[minmax(190px,228px)_minmax(220px,276px)_minmax(0,1fr)]",
				)}
			>
				{/* Column 1: 5 Space Kinds */}
				{!navCollapsed && (
					<aside
						className="min-w-0 flex flex-col gap-3 border-b border-line pb-4 lg:border-b-0 lg:border-r lg:pb-0 lg:pr-3.5"
						aria-label="空间列表"
					>
						<div className="flex items-center justify-between gap-2 text-sm">
							<strong className="text-xs font-semibold text-ink">全部空间 ({spaces.length})</strong>
							<Button
								variant="inline"
								size="xs"
								onClick={() => {
									setCreatingSpace((v) => !v);
									setNewSpaceOrgId(bootstrap?.organizations[0]?.id ?? "");
								}}
							>
								{creatingSpace ? "取消" : "+ 新建空间"}
							</Button>
						</div>

						{creatingSpace && (
							<form
								className="flex flex-col gap-2 p-2.5 border border-line rounded-lg bg-card shadow-sm"
								onSubmit={(e) => void handleCreateCustomSpace(e)}
							>
								<Input
									size="sm"
									placeholder="空间名称"
									value={newSpaceName}
									onChange={(e) => setNewSpaceName(e.target.value)}
									maxLength={100}
									required
								/>
								<Input
									size="sm"
									placeholder="简要说明（可选）"
									value={newSpaceDesc}
									onChange={(e) => setNewSpaceDesc(e.target.value)}
									maxLength={200}
								/>
								<div className="flex items-center gap-1.5">
									<Select
										size="sm"
										value={newSpaceVisibility}
										onChange={(e) => setNewSpaceVisibility(e.target.value as SpaceVisibility)}
									>
										<option value="org">组织共享</option>
										<option value="private">仅自己私密</option>
									</Select>
									{newSpaceVisibility === "org" && (bootstrap?.organizations.length ?? 0) > 1 && (
										<Select
											size="sm"
											value={newSpaceOrgId}
											onChange={(e) => setNewSpaceOrgId(e.target.value)}
										>
											{bootstrap?.organizations.map((org) => (
												<option key={org.id} value={org.id}>
													{org.name}
												</option>
											))}
										</Select>
									)}
								</div>
								<Button type="submit" variant="primary" size="xs" disabled={busy}>
									创建 Git 空间
								</Button>
							</form>
						)}

						<div className="flex flex-col gap-3.5">
							<div className="flex flex-col gap-0.5">
								<button
									type="button"
									className={cn(
										"flex items-center justify-between gap-2 w-full px-2.5 py-1.5 border-0 rounded-md text-left text-sm cursor-pointer transition-colors",
										isRecentView
											? "bg-subtle text-ink font-semibold"
											: "bg-transparent text-ink-secondary hover:bg-hover/60 hover:text-ink",
									)}
									onClick={() => {
										setSelectedSpaceId(RECENT_SPACE_ID);
										setEditing(false);
										setSelectedCommitHash(null);
									}}
								>
									<span className="min-w-0 truncate">最近修改</span>
									<span className="text-micro text-ink-muted shrink-0">跨空间</span>
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
									<div key={kind} className="flex flex-col gap-0.5">
										<div className="px-2.5 py-1 text-micro font-semibold text-ink-muted uppercase tracking-wider">
											{label}
										</div>
										{shown.map((space) => (
											<button
												type="button"
												key={space.id}
												className={cn(
													"flex items-center justify-between gap-2 w-full px-2.5 py-1.5 border-0 rounded-md text-left text-sm cursor-pointer transition-colors",
													selectedSpaceId === space.id
														? "bg-subtle text-ink font-semibold"
														: "bg-transparent text-ink-secondary hover:bg-hover/60 hover:text-ink",
												)}
												onClick={() => {
													setSelectedSpaceId(space.id);
													setEditing(false);
													setSelectedCommitHash(null);
												}}
											>
												<span className="min-w-0 truncate">{space.name}</span>
												{space.documentCount > 0 && (
													<span className="text-micro text-ink-muted tabular-nums shrink-0">
														{space.documentCount}
													</span>
												)}
											</button>
										))}
										{hiddenCount > 0 && (
											<button
												type="button"
												className="border-0 bg-transparent text-ink-muted text-micro text-left px-2.5 py-1 cursor-pointer hover:text-ink transition-colors"
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
													className="border-0 bg-transparent text-ink-muted text-micro text-left px-2.5 py-1 cursor-pointer hover:text-ink transition-colors"
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
					<div className="min-w-0 flex flex-col gap-3 border-b border-line pb-4 lg:border-b-0 lg:border-r lg:pb-0 lg:pr-4">
						<div className="flex items-center justify-between gap-2">
							<Input
								size="sm"
								className="flex-1 min-w-0"
								aria-label={isRecentView ? "搜索最近修改资料" : "搜索当前空间资料"}
								placeholder={isRecentView ? "搜索全部空间的最近资料…" : "搜索资料标题或路径…"}
								value={search}
								onChange={(e) => setSearch(e.target.value)}
							/>
							{canWriteCurrentSpace && (
								<Button variant="primary" size="xs" onClick={startNewDocument}>
									+ 新建资料
								</Button>
							)}
						</div>

						<Tabs
							variant="pill"
							size="sm"
							ariaLabel="按内容类型筛选"
							value={docTypeFilter}
							onChange={(id) => setDocTypeFilter(id as "all" | SpaceDocumentType)}
							items={docTypeTabs}
							className="w-full flex-wrap"
						/>

						<div className="flex flex-col gap-1">
							{filteredDocs.length === 0 ? (
								<EmptyState
									compact
									title={
										documents.length
											? "没有匹配当前筛选条件的资料"
											: isRecentView
												? "暂无最近修改的资料。"
												: "当前空间还没有资料。"
									}
									description={
										!documents.length && !isRecentView ? "可点击上方新建，或在对话中由 AI 保存。" : undefined
									}
								/>
							) : (
								filteredDocs.map((doc) => (
									<button
										type="button"
										key={doc.id}
										className={cn(
											"flex flex-col items-start gap-1 w-full px-2.5 py-2 text-left border rounded-md cursor-pointer transition-colors",
											selectedDoc?.id === doc.id && !editing
												? "bg-subtle border-line-strong text-ink"
												: "bg-transparent border-transparent text-ink hover:bg-hover/60",
										)}
										onClick={() => openDocument(doc.id)}
									>
										<div className="flex items-center gap-1.5 w-full min-w-0">
											<Badge tone={DOC_TYPE_TONE[doc.docType]} dot size="xs">
												{spaceDocTypeLabel(doc.docType)}
											</Badge>
											{doc.entryKind === "folder" && (
												<span className="text-xs shrink-0" title="目录条目（支持多文件与 .gitignore）">
													📁
												</span>
											)}
											<strong className="min-w-0 truncate text-xs font-semibold text-ink">
												{doc.title}
											</strong>
										</div>
										<span className="text-micro text-ink-muted truncate w-full font-mono">
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
				<div className="min-w-0 flex flex-col">
					<div className="flex items-center gap-2.5 mb-3.5">
						<Button
							variant="secondary"
							size="xs"
							aria-expanded={!navCollapsed}
							onClick={() => setNavCollapsed((v) => !v)}
						>
							{navCollapsed ? "展开导航目录" : "收起导航目录"}
						</Button>
						{navCollapsed && selectedSpace && (
							<div className="flex items-center gap-2 min-w-0">
								<span className="text-xs text-ink-muted truncate">当前空间：{selectedSpace.name}</span>
								<Badge tone={selectedSpace.visibility === "private" ? "warn" : "accent"} dot size="xs">
									{selectedSpace.visibility === "private" ? "私密" : "共享"}
								</Badge>
							</div>
						)}
					</div>
					{editing ? (
						<SpaceDocumentEditorForm
							bootstrap={bootstrap}
							selectedSpace={selectedSpace}
							selectedDoc={selectedDoc}
							busy={busy}
							matterId={matterId}
							onMatterIdChange={setMatterId}
							title={title}
							onTitleChange={setTitle}
							docType={docType}
							onDocTypeChange={setDocType}
							entryKind={entryKind}
							onEntryKindChange={setEntryKind}
							content={content}
							onContentChange={setContent}
							extraFiles={extraFiles}
							onExtraFilesChange={setExtraFiles}
							linkedWorkspaceId={linkedWorkspaceId}
							onLinkedWorkspaceIdChange={setLinkedWorkspaceId}
							linkedFilePath={linkedFilePath}
							onLinkedFilePathChange={setLinkedFilePath}
							commitMessage={commitMessage}
							onCommitMessageChange={setCommitMessage}
							onSubmit={(e) => void handleSaveDocument(e)}
							onCancel={() => setEditing(false)}
						/>
					) : selectedDoc ? (
						<SpaceDocumentDetailPane
							bootstrap={bootstrap}
							selectedDoc={selectedDoc}
							spaceNameById={spaceNameById}
							docFiles={docFiles}
							docPreviewPath={docPreviewPath}
							docCanWrite={docCanWrite}
							busy={busy}
							commits={commits}
							selectedCommitHash={selectedCommitHash}
							commitDetail={commitDetail}
							resolveActorLabel={resolveActorLabel}
							onPromoteToFolder={() => void handlePromoteToFolder()}
							onStartEdit={() => {
								setTitle(selectedDoc.title);
								setDocType(selectedDoc.docType);
								setContent(selectedDoc.content);
								setLinkedWorkspaceId(selectedDoc.linkedWorkspaceId ?? "");
								setLinkedFilePath(selectedDoc.linkedFilePath ?? "");
								setCommitMessage("");
								setEditing(true);
							}}
							onOpenMatter={onOpenMatter}
							onReloadFolderFiles={async () => {
								await queryClient.invalidateQueries({ queryKey: queryKeys.spaces.all });
								openDocument(selectedDoc.id);
							}}
							onToggleCommit={handleToggleCommit}
						/>
					) : (
						<EmptyState
							className="items-start text-left"
							title={
								<div className="flex items-center gap-2 flex-wrap">
									<h3 className="m-0 text-base font-semibold text-ink">{selectedSpace?.name ?? "资料空间"}</h3>
									{selectedSpace && (
										<Badge tone={selectedSpace.visibility === "private" ? "warn" : "accent"} dot size="xs">
											{selectedSpace.visibility === "private" ? "私密" : "共享"}
										</Badge>
									)}
								</div>
							}
							description={
								<>
									{selectedSpace?.description && (
										<span className="block mb-1 text-ink-secondary">{selectedSpace.description}</span>
									)}
									{documents.length > 0
										? "从左侧选择一篇资料查看，或点击「新建资料」。"
										: "该空间目前还没有资料文档。所有新建和编辑都会自动记录为独立 Git 仓库中的标准提交。"}
								</>
							}
							action={
								canWriteCurrentSpace ? (
									<Button variant="primary" size="xs" onClick={startNewDocument}>
										+ 新建资料
									</Button>
								) : undefined
							}
						/>
					)}
				</div>
			</div>
		</section>
	);
}
