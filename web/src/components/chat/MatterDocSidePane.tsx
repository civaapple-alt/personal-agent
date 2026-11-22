import { useCallback, useEffect, useState } from "react";
import {
	getSpaceDocument,
	getSpaceDocumentCommitDetail,
	listSpaceDocumentCommits,
	SPACE_DOC_TYPE_OPTIONS,
	type SpaceDocumentDto,
	type SpaceDocumentType,
	type SpaceGitCommitDetailDto,
	type SpaceGitCommitDto,
	spaceDocTypeLabel,
	updateSpaceDocument,
} from "../../api/space.ts";
import type { WorkspaceDto } from "../../api.ts";
import { MarkdownView } from "../../MarkdownView.tsx";

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

	const loadDoc = useCallback(async (docId: string, expandLatestDiff: boolean) => {
		setLoading(true);
		setError("");
		try {
			const [docRes, commitsRes] = await Promise.all([getSpaceDocument(docId), listSpaceDocumentCommits(docId)]);
			setDoc(docRes.document);
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
		const events = new EventSource("/api/events");
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
		<aside className="matter-doc-side-pane" aria-label="空间文档侧栏">
			<div className="matter-doc-pane-tabs">
				<div className="matter-doc-tab-strip" role="tablist" aria-label="已打开文档">
					{openDocIds.map((id) => {
						const tabTitle = (doc?.id === id ? doc.title : docTitlesById.get(id)) || `文档 ${id.slice(-6)}`;
						const isActive = id === activeDocId;
						return (
							<div key={id} className={`matter-doc-tab ${isActive ? "active" : ""}`}>
								<button
									type="button"
									role="tab"
									aria-selected={isActive}
									className="matter-doc-tab-btn"
									onClick={() => onSelectDoc(id)}
									title={tabTitle}
								>
									<span className="matter-doc-tab-icon" aria-hidden="true">
										📄
									</span>
									<span className="matter-doc-tab-label">{tabTitle}</span>
								</button>
								<button
									type="button"
									className="matter-doc-tab-close"
									aria-label={`关闭 ${tabTitle}`}
									onClick={() => onCloseDoc(id)}
								>
									×
								</button>
							</div>
						);
					})}
				</div>
				<div className="matter-doc-pane-controls">
					<button
						type="button"
						className="btn-icon-ghost"
						title="刷新最新内容"
						aria-label="刷新最新内容"
						onClick={() => void loadDoc(activeDocId, false)}
					>
						↻
					</button>
					<button
						type="button"
						className="btn-icon-ghost"
						title="在完整资料空间打开"
						aria-label="在完整资料空间打开"
						onClick={() => onOpenFullSpace(activeDocId)}
					>
						↗
					</button>
					<button
						type="button"
						className="btn-icon-ghost"
						title="收起右侧文档面板"
						aria-label="收起右侧文档面板"
						onClick={onClosePane}
					>
						×
					</button>
				</div>
			</div>

			<div className="matter-doc-pane-body">
				{error && (
					<p role="alert" className="space-error">
						{error}
					</p>
				)}
				{loading && !doc ? (
					<p className="muted-hint">正在加载文档…</p>
				) : editing && doc ? (
					<form className="space-editor-form" onSubmit={(e) => void handleSave(e)}>
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
											{opt.label}
										</option>
									))}
								</select>
							</label>
						</div>
						<label>
							正文（Markdown）
							<textarea
								className="input-field space-page-editor"
								value={content}
								onChange={(e) => setContent(e.target.value)}
								placeholder="支持 Markdown"
							/>
						</label>
						<div className="space-create-row">
							<label style={{ flex: 1 }}>
								关联仓库
								<select
									className="input-field"
									value={linkedWorkspaceId}
									onChange={(e) => setLinkedWorkspaceId(e.target.value)}
								>
									<option value="">不关联</option>
									{workspaces.map((ws) => (
										<option key={ws.id} value={ws.id}>
											{ws.name}
										</option>
									))}
								</select>
							</label>
							<label style={{ flex: 2 }}>
								关联文件相对路径或链接
								<input
									className="input-field"
									value={linkedFilePath}
									onChange={(e) => setLinkedFilePath(e.target.value)}
									placeholder="如 docs/plan.md"
									maxLength={300}
								/>
							</label>
						</div>
						<label>
							提交说明（可选）
							<input
								className="input-field"
								value={commitMessage}
								onChange={(e) => setCommitMessage(e.target.value)}
								placeholder={`Update ${title || doc.title}`}
								maxLength={200}
							/>
						</label>
						<div className="space-page-actions">
							<button type="submit" className="btn-pill-dark btn-xs" disabled={saving}>
								{saving ? "提交中…" : "保存并提交 Git"}
							</button>
							<button
								type="button"
								className="btn-secondary btn-xs"
								onClick={() => setEditing(false)}
								disabled={saving}
							>
								取消
							</button>
						</div>
					</form>
				) : doc ? (
					<>
						<div className="matter-doc-pane-header">
							<div className="matter-doc-pane-title-wrap">
								<h2>{doc.title}</h2>
								<div className="space-doc-meta">
									<span className={`space-doc-type-pill is-${doc.docType}`}>
										{spaceDocTypeLabel(doc.docType)}
									</span>
									<span className="pill">
										rev {doc.revision} · <code>{doc.headCommit.slice(0, 7)}</code>
									</span>
									{doc.linkedFilePath && (
										<span className="pill">
											关联：
											{doc.linkedWorkspaceId
												? `${workspaces.find((w) => w.id === doc.linkedWorkspaceId)?.name ?? doc.linkedWorkspaceId} / `
												: ""}
											<code>{doc.linkedFilePath}</code>
										</span>
									)}
									<span className="muted-hint">
										{resolveLabel(doc.updatedBy)} · {new Date(doc.updatedAt).toLocaleString()}
									</span>
								</div>
							</div>
							{canWrite && (
								<button
									type="button"
									className="btn-secondary btn-xs"
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
								</button>
							)}
						</div>

						{commits.length > 0 && (
							<div className="matter-doc-pane-modebar" role="tablist" aria-label="文档视图">
								<button
									type="button"
									role="tab"
									aria-selected={viewMode === "content"}
									className={viewMode === "content" ? "btn-pill-dark btn-xs" : "btn-pill-outline btn-xs"}
									onClick={() => void handleSwitchMode("content")}
								>
									正文
								</button>
								<button
									type="button"
									role="tab"
									aria-selected={viewMode === "diff"}
									className={viewMode === "diff" ? "btn-pill-dark btn-xs" : "btn-pill-outline btn-xs"}
									onClick={() => void handleSwitchMode("diff")}
								>
									变更对比（{commits.length}）
								</button>
							</div>
						)}

						{viewMode === "content" ? (
							<div className="matter-doc-pane-markdown">
								<MarkdownView content={doc.content || "（空白）"} />
							</div>
						) : (
							<div className="matter-doc-pane-diff-view">
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
													{resolveLabel(commit.authorName)} ·{" "}
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
							</div>
						)}
					</>
				) : null}
			</div>
		</aside>
	);
}
