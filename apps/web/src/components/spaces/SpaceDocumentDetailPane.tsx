import {
	type SpaceDocumentDto,
	type SpaceDocumentFileDto,
	type SpaceDocumentType,
	type SpaceGitCommitDetailDto,
	type SpaceGitCommitDto,
	spaceDocTypeLabel,
} from "../../api/space.ts";
import type { BootstrapPayload } from "../../api.ts";
import { MarkdownView } from "../../MarkdownView.tsx";
import { Badge, type BadgeTone, Button, SettingsDisclosure } from "../../primitives/index.ts";
import { cn } from "../../utils/cn.ts";
import { SpaceDocumentFeedback } from "../SpaceDocumentFeedback.tsx";
import { SpaceFolderFilesPanel } from "../SpaceFolderFilesPanel.tsx";

const DOC_TYPE_TONE: Record<SpaceDocumentType, BadgeTone> = {
	plan: "accent",
	spec: "info",
	decision: "warn",
	rule: "observer",
	note: "neutral",
};

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
			<div className="flex items-start justify-between gap-3 flex-wrap pb-3 border-b border-line">
				<div className="min-w-0 flex-1">
					<h2 className="m-0 text-lg font-semibold text-ink leading-snug">{selectedDoc.title}</h2>
					<div className="flex flex-wrap items-center gap-1.5 mt-2 text-xs">
						<Badge tone={DOC_TYPE_TONE[selectedDoc.docType]} dot size="xs">
							{spaceDocTypeLabel(selectedDoc.docType)}
						</Badge>
						<Badge tone="neutral" size="xs">
							{spaceNameById.get(selectedDoc.spaceId) ?? selectedDoc.spaceId}
						</Badge>
						<Badge tone="neutral" size="xs" className="font-mono">
							rev {selectedDoc.revision} · <code>{selectedDoc.headCommit.slice(0, 7)}</code>
						</Badge>
						{selectedDoc.linkedFilePath && (
							<Badge tone="info" size="xs">
								关联：
								{selectedDoc.linkedWorkspaceId
									? `${bootstrap?.workspaces.find((w) => w.id === selectedDoc.linkedWorkspaceId)?.name ?? selectedDoc.linkedWorkspaceId} / `
									: ""}
								<code className="font-mono">{selectedDoc.linkedFilePath}</code>
							</Badge>
						)}
						<span className="text-xs text-ink-muted">
							最近更新：{resolveActorLabel(selectedDoc.updatedBy)} ·{" "}
							{new Date(selectedDoc.updatedAt).toLocaleString()}
						</span>
					</div>
				</div>
				{docCanWrite && (
					<div className="flex items-center gap-2 shrink-0">
						{selectedDoc.entryKind === "file" && (
							<Button
								variant="secondary"
								size="xs"
								disabled={busy}
								title="转为目录条目，便于追加参考文件、.gitignore 或演示站点"
								onClick={onPromoteToFolder}
							>
								转为目录条目
							</Button>
						)}
						<Button variant="secondary" size="sm" onClick={onStartEdit}>
							{selectedDoc.entryKind === "folder" ? "编辑主说明" : "编辑"}
						</Button>
					</div>
				)}
			</div>

			{selectedDoc.matterId && (
				<div className="mt-2.5">
					<Button variant="inline" size="xs" onClick={() => onOpenMatter(selectedDoc.matterId!)}>
						查看来源事项 →
					</Button>
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
				<div className="my-5">
					<MarkdownView content={selectedDoc.content || "（空白）"} />
				</div>
			)}

			<SpaceDocumentFeedback
				key={`${selectedDoc.id}:${selectedCommitHash ?? selectedDoc.headCommit}`}
				documentId={selectedDoc.id}
				commitHash={selectedCommitHash ?? selectedDoc.headCommit}
				canWrite={docCanWrite}
			/>

			<SettingsDisclosure
				summary={`Git 提交历史（${commits.length}）`}
				defaultOpen={commits.length > 1}
				className="mt-6 pt-3.5"
			>
				<ul className="list-none m-0 mt-2.5 p-0 flex flex-col gap-1.5">
					{commits.map((commit) => (
						<li key={commit.hash} className="flex flex-col gap-1">
							<button
								type="button"
								className={cn(
									"flex flex-wrap items-center gap-2 w-full px-2.5 py-2 border rounded-md text-left text-xs cursor-pointer transition-colors",
									selectedCommitHash === commit.hash
										? "bg-subtle border-accent"
										: "bg-transparent border-line hover:bg-hover/60",
								)}
								onClick={() => onToggleCommit(commit.hash)}
							>
								<code className="font-mono font-semibold text-accent">{commit.shortHash}</code>
								<span className="flex-1 min-w-0 font-medium text-ink truncate">{commit.subject}</span>
								<span className="text-ink-muted shrink-0">
									{resolveActorLabel(commit.authorName)} · {new Date(commit.committedAt).toLocaleString()}
								</span>
							</button>
							{selectedCommitHash === commit.hash && commitDetail && (
								<div className="mt-1 rounded-md overflow-hidden border border-line bg-sidebar">
									<pre className="m-0 p-3 font-mono text-xs leading-relaxed text-ink overflow-x-auto">
										{(commitDetail.diff || "（无文本差异）").split("\n").map((line, index) => (
											<span
												key={`${commit.hash}-${index}`}
												className={cn(
													line.startsWith("+") && !line.startsWith("+++")
														? "text-success-text"
														: line.startsWith("-") && !line.startsWith("---")
															? "text-danger-text"
															: line.startsWith("@@")
																? "text-info-text"
																: "",
												)}
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
			</SettingsDisclosure>
		</>
	);
}
