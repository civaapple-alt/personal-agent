import { useCallback, useEffect, useId, useState } from "react";
import {
	getSpaceDocument,
	getSpaceDocumentCommitDetail,
	listSpaceDocumentCommits,
	SPACE_DOC_TYPE_OPTIONS,
	type SpaceDocumentDto,
	type SpaceDocumentFileDto,
	type SpaceDocumentType,
	type SpaceGitCommitDetailDto,
	type SpaceGitCommitDto,
	spaceDocTypeLabel,
	updateSpaceDocument,
} from "../../api/space.ts";
import { resolveApiUrl, type WorkspaceDto } from "../../api.ts";
import { MarkdownView } from "../../MarkdownView.tsx";
import {
	Badge,
	type BadgeTone,
	Banner,
	Button,
	FieldGroup,
	IconButton,
	Input,
	Select,
	Tabs,
	Textarea,
} from "../../primitives/index.ts";
import { cn } from "../../utils/cn.ts";
import { SpaceDocumentFeedback } from "../SpaceDocumentFeedback.tsx";
import { SpaceFolderFilesPanel } from "../SpaceFolderFilesPanel.tsx";

interface MatterDocSidePaneProps {
	openDocIds: string[];
	activeDocId: string;
	autoExpandDiff?: boolean;
	openNonce?: number;
	docTitlesById: Map<string, string>;
	workspaces: WorkspaceDto[];
	memberName: (id: string) => string;
	onSelectDoc: (docId: string) => void;
	onCloseDoc: (docId: string) => void;
	onClosePane: () => void;
	onOpenFullSpace: (docId: string) => void;
}

const DOC_TYPE_TONE: Record<SpaceDocumentType, BadgeTone> = {
	plan: "accent",
	spec: "info",
	decision: "warn",
	rule: "observer",
	note: "neutral",
};

/** Right-hand split document pane inside a matter conversation: supports multi-tab docs, live SSE refresh, inline editing, and Git diff. */
export function MatterDocSidePane({
	openDocIds,
	activeDocId,
	autoExpandDiff = false,
	openNonce = 0,
	docTitlesById,
	workspaces,
	memberName,
	onSelectDoc,
	onCloseDoc,
	onClosePane,
	onOpenFullSpace,
}: MatterDocSidePaneProps) {
	const [doc, setDoc] = useState<SpaceDocumentDto | null>(null);
	const [docFiles, setDocFiles] = useState<SpaceDocumentFileDto[]>([]);
	const [previewEntryPath, setPreviewEntryPath] = useState<string | null>(null);
	const [canWrite, setCanWrite] = useState(false);
	const [commits, setCommits] = useState<SpaceGitCommitDto[]>([]);
	const [selectedCommitHash, setSelectedCommitHash] = useState<string | null>(null);
	const [commitDetail, setCommitDetail] = useState<SpaceGitCommitDetailDto | null>(null);
	const [viewMode, setViewMode] = useState<"content" | "diff">(autoExpandDiff ? "diff" : "content");
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");

	const [editing, setEditing] = useState(false);
	const [title, setTitle] = useState("");
	const [docType, setDocType] = useState<SpaceDocumentType>("note");
	const [content, setContent] = useState("");
	const [linkedWorkspaceId, setLinkedWorkspaceId] = useState("");
	const [linkedFilePath, setLinkedFilePath] = useState("");
	const [commitMessage, setCommitMessage] = useState("");
	const [saving, setSaving] = useState(false);

	const titleInputId = useId();
	const typeInputId = useId();
	const contentInputId = useId();
	const wsInputId = useId();
	const fileInputId = useId();
	const commitMsgId = useId();

	const loadDoc = useCallback(async (docId: string, expandLatestDiff: boolean) => {
		setLoading(true);
		setError("");
		try {
			const [docRes, commitsRes] = await Promise.all([getSpaceDocument(docId), listSpaceDocumentCommits(docId)]);
			setDoc(docRes.document);
			setDocFiles(docRes.files ?? []);
			setPreviewEntryPath(docRes.previewEntryPath ?? null);
			setCanWrite(docRes.canWrite);
			setCommits(commitsRes.commits);
			if (expandLatestDiff && commitsRes.commits[0]) {
				const latestHash = commitsRes.commits[0].hash;
				setSelectedCommitHash(latestHash);
				const detailRes = await getSpaceDocumentCommitDetail(docId, latestHash);
				setCommitDetail(detailRes.detail);
			} else {
				setSelectedCommitHash(null);
				setCommitDetail(null);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void openNonce;
		setEditing(false);
		setViewMode(autoExpandDiff ? "diff" : "content");
		void loadDoc(activeDocId, autoExpandDiff);
	}, [activeDocId, autoExpandDiff, openNonce, loadDoc]);

	const handleSwitchMode = async (mode: "content" | "diff") => {
		setViewMode(mode);
		if (mode === "diff" && doc && !selectedCommitHash && commits[0]) {
			const latestHash = commits[0].hash;
			setSelectedCommitHash(latestHash);
			setCommitDetail(null);
			try {
				const res = await getSpaceDocumentCommitDetail(doc.id, latestHash);
				setCommitDetail(res.detail);
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			}
		}
	};

	// Keep the side pane in sync when the AI or another collaborator updates the active document.
	useEffect(() => {
		const events = new EventSource(resolveApiUrl("/api/events"));
		const sync = () => {
			if (!editing) {
				void loadDoc(activeDocId, false);
			}
		};
		events.addEventListener("space_page_updated", sync);
		events.addEventListener("matter_settled", sync);
		return () => {
			events.close();
		};
	}, [activeDocId, editing, loadDoc]);

	const handleToggleCommit = async (hash: string) => {
		if (!doc) return;
		if (selectedCommitHash === hash) {
			setSelectedCommitHash(null);
			setCommitDetail(null);
			return;
		}
		setSelectedCommitHash(hash);
		setCommitDetail(null);
		try {
			const res = await getSpaceDocumentCommitDetail(doc.id, hash);
			setCommitDetail(res.detail);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const handleSave = async (event: React.FormEvent) => {
		event.preventDefault();
		if (!doc) return;
		setSaving(true);
		setError("");
		const matchedWs = linkedWorkspaceId ? workspaces.find((w) => w.id === linkedWorkspaceId) : null;
		try {
			await updateSpaceDocument(doc.id, {
				revision: doc.revision,
				title,
				docType,
				content,
				linkedOrgId: linkedFilePath.trim() ? (matchedWs?.orgId ?? doc.linkedOrgId) : null,
				linkedWorkspaceId: linkedFilePath.trim() ? linkedWorkspaceId || null : null,
				linkedFilePath: linkedFilePath.trim() || null,
				commitMessage: commitMessage.trim() || undefined,
			});
			setEditing(false);
			setCommitMessage("");
			await loadDoc(doc.id, false);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	};

	const resolveLabel = (actorId: string) => {
		const name = memberName(actorId);
		return name || actorId;
	};

	return (
		<aside
			className="flex flex-col min-w-0 min-h-0 h-full border-l border-line bg-surface overflow-hidden max-lg:absolute max-lg:inset-0 max-lg:z-20 max-lg:border-l-0 max-lg:shadow-lg"
			aria-label="空间文档侧栏"
		>
			<div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-line bg-stage shrink-0">
				<div className="flex items-center gap-1 min-w-0 overflow-x-auto" role="tablist" aria-label="已打开文档">
					{openDocIds.map((id) => {
						const tabTitle = (doc?.id === id ? doc.title : docTitlesById.get(id)) || `文档 ${id.slice(-6)}`;
						const isActive = id === activeDocId;
						return (
							<div
								key={id}
								className={cn(
									"inline-flex items-center max-w-[220px] rounded-md border text-xs transition-colors",
									isActive
										? "bg-surface border-line font-semibold text-ink"
										: "bg-transparent border-transparent text-ink-secondary hover:text-ink",
								)}
							>
								<button
									type="button"
									role="tab"
									aria-selected={isActive}
									className="inline-flex items-center gap-1.5 border-0 bg-transparent text-inherit py-1 pl-2 pr-1 cursor-pointer min-w-0"
									onClick={() => onSelectDoc(id)}
									title={tabTitle}
								>
									<span className="shrink-0 text-micro opacity-75" aria-hidden="true">
										📄
									</span>
									<span className="truncate">{tabTitle}</span>
								</button>
								<button
									type="button"
									className="border-0 bg-transparent text-ink-muted py-1 pr-1.5 pl-0.5 cursor-pointer text-sm leading-none hover:text-ink"
									aria-label={`关闭 ${tabTitle}`}
									onClick={() => onCloseDoc(id)}
								>
									×
								</button>
							</div>
						);
					})}
				</div>
				<div className="inline-flex items-center gap-0.5 shrink-0">
					<IconButton
						variant="ghost"
						size="sm"
						title="刷新最新内容"
						aria-label="刷新最新内容"
						onClick={() => void loadDoc(activeDocId, false)}
					>
						↻
					</IconButton>
					<IconButton
						variant="ghost"
						size="sm"
						title="在完整资料空间打开"
						aria-label="在完整资料空间打开"
						onClick={() => onOpenFullSpace(activeDocId)}
					>
						↗
					</IconButton>
					<IconButton
						variant="ghost"
						size="sm"
						title="收起右侧文档面板"
						aria-label="收起右侧文档面板"
						onClick={onClosePane}
					>
						×
					</IconButton>
				</div>
			</div>

			<div className="flex-1 overflow-y-auto px-6 pt-5 pb-8 overscroll-contain">
				{error && (
					<Banner tone="danger" className="mb-3">
						{error}
					</Banner>
				)}
				{loading && !doc ? (
					<p className="m-0 text-xs text-ink-muted">正在加载文档…</p>
				) : editing && doc ? (
					<form className="flex flex-col gap-4" onSubmit={(e) => void handleSave(e)}>
						<div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
							<FieldGroup label="标题" htmlFor={titleInputId} className="sm:col-span-2">
								<Input
									id={titleInputId}
									value={title}
									onChange={(e) => setTitle(e.target.value)}
									maxLength={200}
									required
								/>
							</FieldGroup>
							<FieldGroup label="内容类型" htmlFor={typeInputId}>
								<Select
									id={typeInputId}
									value={docType}
									onChange={(e) => setDocType(e.target.value as SpaceDocumentType)}
								>
									{SPACE_DOC_TYPE_OPTIONS.map((opt) => (
										<option key={opt.value} value={opt.value}>
											{opt.label}
										</option>
									))}
								</Select>
							</FieldGroup>
						</div>
						<FieldGroup label="正文（Markdown）" htmlFor={contentInputId}>
							<Textarea
								id={contentInputId}
								className="min-h-[360px]"
								value={content}
								onChange={(e) => setContent(e.target.value)}
								placeholder="支持 Markdown"
							/>
						</FieldGroup>
						<div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
							<FieldGroup label="关联仓库" htmlFor={wsInputId}>
								<Select
									id={wsInputId}
									value={linkedWorkspaceId}
									onChange={(e) => setLinkedWorkspaceId(e.target.value)}
								>
									<option value="">不关联</option>
									{workspaces.map((ws) => (
										<option key={ws.id} value={ws.id}>
											{ws.name}
										</option>
									))}
								</Select>
							</FieldGroup>
							<FieldGroup label="关联文件相对路径或链接" htmlFor={fileInputId} className="sm:col-span-2">
								<Input
									id={fileInputId}
									value={linkedFilePath}
									onChange={(e) => setLinkedFilePath(e.target.value)}
									placeholder="如 docs/plan.md"
									maxLength={300}
								/>
							</FieldGroup>
						</div>
						<FieldGroup label="提交说明（可选）" htmlFor={commitMsgId}>
							<Input
								id={commitMsgId}
								value={commitMessage}
								onChange={(e) => setCommitMessage(e.target.value)}
								placeholder={`Update ${title || doc.title}`}
								maxLength={200}
							/>
						</FieldGroup>
						<div className="flex items-center gap-2.5 pt-1">
							<Button type="submit" variant="primary" size="xs" disabled={saving}>
								{saving ? "提交中…" : "保存并提交 Git"}
							</Button>
							<Button variant="secondary" size="xs" onClick={() => setEditing(false)} disabled={saving}>
								取消
							</Button>
						</div>
					</form>
				) : doc ? (
					<>
						<div className="flex items-start justify-between gap-3 pb-3.5 border-b border-line">
							<div className="min-w-0 flex-1">
								<h2 className="m-0 text-lg font-semibold leading-snug text-ink">{doc.title}</h2>
								<div className="flex flex-wrap items-center gap-2 mt-1.5 text-xs">
									<Badge tone={DOC_TYPE_TONE[doc.docType]} size="xs">
										{spaceDocTypeLabel(doc.docType)}
									</Badge>
									<Badge tone="neutral" size="xs">
										rev {doc.revision} · <code className="font-mono">{doc.headCommit.slice(0, 7)}</code>
									</Badge>
									{doc.linkedFilePath && (
										<Badge tone="neutral" size="xs">
											关联：
											{doc.linkedWorkspaceId
												? `${workspaces.find((w) => w.id === doc.linkedWorkspaceId)?.name ?? doc.linkedWorkspaceId} / `
												: ""}
											<code className="font-mono">{doc.linkedFilePath}</code>
										</Badge>
									)}
									<span className="text-xs text-ink-muted">
										{resolveLabel(doc.updatedBy)} · {new Date(doc.updatedAt).toLocaleString()}
									</span>
								</div>
							</div>
							{canWrite && (
								<Button
									variant="secondary"
									size="xs"
									onClick={() => {
										setTitle(doc.title);
										setDocType(doc.docType);
										setContent(doc.content);
										setLinkedWorkspaceId(doc.linkedWorkspaceId ?? "");
										setLinkedFilePath(doc.linkedFilePath ?? "");
										setCommitMessage("");
										setEditing(true);
									}}
								>
									编辑
								</Button>
							)}
						</div>

						{commits.length > 0 && (
							<div className="mt-3.5">
								<Tabs
									variant="pill"
									size="sm"
									ariaLabel="文档视图"
									value={viewMode}
									onChange={(id) => {
										if (id === "content" || id === "diff") void handleSwitchMode(id);
									}}
									items={[
										{ id: "content", label: "正文" },
										{ id: "diff", label: "变更对比", count: commits.length },
									]}
								/>
							</div>
						)}

						<SpaceDocumentFeedback
							key={`${doc.id}:${viewMode === "diff" && selectedCommitHash ? selectedCommitHash : doc.headCommit}`}
							documentId={doc.id}
							commitHash={viewMode === "diff" && selectedCommitHash ? selectedCommitHash : doc.headCommit}
							canWrite={canWrite}
						/>
						{viewMode === "content" ? (
							doc.entryKind === "folder" ? (
								<SpaceFolderFilesPanel
									docId={doc.id}
									readmeContent={doc.content}
									files={docFiles}
									previewEntryPath={previewEntryPath}
									canWrite={canWrite}
									onChanged={() => loadDoc(activeDocId, false)}
								/>
							) : (
								<div className="mt-4">
									<MarkdownView content={doc.content || "（空白）"} />
								</div>
							)
						) : (
							<div className="mt-3.5">
								<ul className="list-none m-0 mt-2.5 p-0 flex flex-col gap-1.5">
									{commits.map((commit) => (
										<li key={commit.hash} className="flex flex-col gap-1">
											<button
												type="button"
												className={cn(
													"flex flex-wrap items-center gap-2 w-full px-2.5 py-2 border rounded-md text-left text-xs cursor-pointer transition-colors",
													selectedCommitHash === commit.hash
														? "bg-stage border-accent text-ink"
														: "bg-transparent border-line text-ink hover:bg-hover/40",
												)}
												onClick={() => void handleToggleCommit(commit.hash)}
											>
												<code className="font-mono font-semibold text-accent">{commit.shortHash}</code>
												<span className="flex-1 font-medium">{commit.subject}</span>
												<span className="text-ink-muted">
													{resolveLabel(commit.authorName)} ·{" "}
													{new Date(commit.committedAt).toLocaleString()}
												</span>
											</button>
											{selectedCommitHash === commit.hash && commitDetail && (
												<div className="mt-1.5 rounded-md overflow-hidden border border-line">
													<pre className="space-diff-pre m-0 px-3 py-2.5 bg-zinc-950 text-zinc-100 font-mono text-xs overflow-x-auto leading-relaxed">
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
							</div>
						)}
					</>
				) : null}
			</div>
		</aside>
	);
}
