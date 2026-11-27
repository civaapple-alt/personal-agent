import {
	type SpaceDocumentDto,
	type SpaceDocumentFileDto,
	type SpaceGitCommitDetailDto,
	type SpaceGitCommitDto,
	spaceDocTypeLabel,
} from "../../api/space.ts";
import type { BootstrapPayload } from "../../api.ts";
import { MarkdownView } from "../../MarkdownView.tsx";
import { SpaceDocumentFeedback } from "../SpaceDocumentFeedback.tsx";
import { SpaceFolderFilesPanel } from "../SpaceFolderFilesPanel.tsx";

export interface SpaceDocumentDetailPaneProps {
	bootstrap: BootstrapPayload | null;
	selectedDoc: SpaceDocumentDto;
	spaceNameById: Map<string, string>;
	docFiles: SpaceDocumentFileDto[];
	docPreviewPath: string | null;
	docCanWrite: boolean;
	busy: boolean;
	commits: SpaceGitCommitDto[];
	selectedCommitHash: string | null;
	commitDetail: SpaceGitCommitDetailDto | null;
	resolveActorLabel: (actorId: string) => string | undefined;
	onPromoteToFolder: () => void;
	onStartEdit: () => void;
	onOpenMatter: (matterId: string) => void;
	onReloadFolderFiles: () => Promise<void>;
	onToggleCommit: (hash: string) => void;
}

export function SpaceDocumentDetailPane({
	bootstrap,
	selectedDoc,
	spaceNameById,
	docFiles,
	docPreviewPath,
	docCanWrite,
	busy,
	commits,
	selectedCommitHash,
	commitDetail,
	resolveActorLabel,
	onPromoteToFolder,
	onStartEdit,
	onOpenMatter,
	onReloadFolderFiles,
	onToggleCommit,
}: SpaceDocumentDetailPaneProps) {
	return (
		<>
			<div className="space-page-heading">
				<div>
					<h2>{selectedDoc.title}</h2>
					<div className="space-doc-meta">
						<span className={`space-doc-type-pill is-${selectedDoc.docType}`}>
							{spaceDocTypeLabel(selectedDoc.docType)}
						</span>
						<span className="pill">{spaceNameById.get(selectedDoc.spaceId) ?? selectedDoc.spaceId}</span>
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
								onClick={onPromoteToFolder}
							>
								转为目录条目
							</button>
						)}
						<button type="button" className="btn-secondary" onClick={onStartEdit}>
							{selectedDoc.entryKind === "folder" ? "编辑主说明" : "编辑"}
						</button>
					</div>
				)}
			</div>

			{selectedDoc.matterId && (
				<div className="space-doc-links">
					<button type="button" className="btn-inline" onClick={() => onOpenMatter(selectedDoc.matterId!)}>
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
					onChanged={onReloadFolderFiles}
				/>
			) : (
				<div className="space-page-content">
					<MarkdownView content={selectedDoc.content || "（空白）"} />
				</div>
			)}

			<SpaceDocumentFeedback
				key={`${selectedDoc.id}:${selectedCommitHash ?? selectedDoc.headCommit}`}
				documentId={selectedDoc.id}
				commitHash={selectedCommitHash ?? selectedDoc.headCommit}
				canWrite={docCanWrite}
			/>
			<details className="space-commits-panel" open={commits.length > 1}>
				<summary>Git 提交历史（{commits.length}）</summary>
				<ul className="space-commit-list">
					{commits.map((commit) => (
						<li key={commit.hash} className="space-commit-item">
							<button
								type="button"
								className={`space-commit-btn ${selectedCommitHash === commit.hash ? "active" : ""}`}
								onClick={() => onToggleCommit(commit.hash)}
							>
								<code className="space-commit-hash">{commit.shortHash}</code>
								<span className="space-commit-subject">{commit.subject}</span>
								<span className="space-commit-meta">
									{resolveActorLabel(commit.authorName)} · {new Date(commit.committedAt).toLocaleString()}
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
	);
}
