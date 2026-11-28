import { type FormEvent, useId } from "react";
import {
	SPACE_DOC_TYPE_OPTIONS,
	type SpaceDocumentDto,
	type SpaceDocumentType,
	type SpaceDto,
	type SpaceEntryKind,
} from "../../api/space.ts";
import type { BootstrapPayload } from "../../api.ts";
import { Button, Card, FieldGroup, Input, Select, Textarea } from "../../primitives/index.ts";

export interface SpaceDocumentEditorFormProps {
	bootstrap: BootstrapPayload | null;
	selectedSpace: SpaceDto | null;
	selectedDoc: SpaceDocumentDto | null;
	busy: boolean;
	matterId: string;
	onMatterIdChange: (value: string) => void;
	title: string;
	onTitleChange: (value: string) => void;
	docType: SpaceDocumentType;
	onDocTypeChange: (value: SpaceDocumentType) => void;
	entryKind: SpaceEntryKind;
	onEntryKindChange: (value: SpaceEntryKind) => void;
	content: string;
	onContentChange: (value: string) => void;
	extraFiles: Array<{ id: string; path: string; content: string }>;
	onExtraFilesChange: (
		updater: (prev: Array<{ id: string; path: string; content: string }>) => Array<{
			id: string;
			path: string;
			content: string;
		}>,
	) => void;
	linkedWorkspaceId: string;
	onLinkedWorkspaceIdChange: (value: string) => void;
	linkedFilePath: string;
	onLinkedFilePathChange: (value: string) => void;
	commitMessage: string;
	onCommitMessageChange: (value: string) => void;
	onSubmit: (event: FormEvent) => void;
	onCancel: () => void;
}

export function SpaceDocumentEditorForm({
	bootstrap,
	selectedSpace,
	selectedDoc,
	busy,
	matterId,
	onMatterIdChange,
	title,
	onTitleChange,
	docType,
	onDocTypeChange,
	entryKind,
	onEntryKindChange,
	content,
	onContentChange,
	extraFiles,
	onExtraFilesChange,
	linkedWorkspaceId,
	onLinkedWorkspaceIdChange,
	linkedFilePath,
	onLinkedFilePathChange,
	commitMessage,
	onCommitMessageChange,
	onSubmit,
	onCancel,
}: SpaceDocumentEditorFormProps) {
	const matterIdInput = useId();
	const titleId = useId();
	const docTypeId = useId();
	const entryKindId = useId();
	const contentId = useId();
	const linkedWorkspaceIdInput = useId();
	const linkedFilePathId = useId();
	const commitMessageId = useId();

	const isFolder = (!selectedDoc && entryKind === "folder") || selectedDoc?.entryKind === "folder";

	return (
		<form className="flex flex-col gap-4" onSubmit={onSubmit}>
			<div className="flex items-center justify-between gap-2.5 pb-2.5 border-b border-line">
				<h2 className="m-0 text-lg font-semibold text-ink">
					{selectedDoc ? `编辑：${selectedDoc.title}` : `在「${selectedSpace?.name ?? ""}」新建资料`}
				</h2>
			</div>

			{!selectedDoc && (bootstrap?.matters.length ?? 0) > 0 && (
				<FieldGroup label="关联事项（可选）" htmlFor={matterIdInput}>
					<Select id={matterIdInput} value={matterId} onChange={(e) => onMatterIdChange(e.target.value)}>
						<option value="">不绑定特定事项</option>
						{bootstrap?.matters.map((m) => (
							<option key={m.id} value={m.id}>
								{m.title}
							</option>
						))}
					</Select>
				</FieldGroup>
			)}

			<div className="flex flex-col sm:flex-row gap-2.5">
				<FieldGroup label="标题" htmlFor={titleId} className="flex-[2]">
					<Input
						id={titleId}
						value={title}
						onChange={(e) => onTitleChange(e.target.value)}
						maxLength={200}
						required
					/>
				</FieldGroup>
				<FieldGroup label="内容类型" htmlFor={docTypeId} className="flex-1">
					<Select
						id={docTypeId}
						value={docType}
						onChange={(e) => onDocTypeChange(e.target.value as SpaceDocumentType)}
					>
						{SPACE_DOC_TYPE_OPTIONS.map((opt) => (
							<option key={opt.value} value={opt.value}>
								{opt.label} — {opt.hint}
							</option>
						))}
					</Select>
				</FieldGroup>
				{!selectedDoc && (
					<FieldGroup label="条目形态" htmlFor={entryKindId} className="flex-1">
						<Select
							id={entryKindId}
							value={entryKind}
							onChange={(e) => onEntryKindChange(e.target.value as SpaceEntryKind)}
						>
							<option value="file">单文件 Markdown</option>
							<option value="folder">目录条目（多文件 / 演示站点 / .gitignore）</option>
						</Select>
					</FieldGroup>
				)}
			</div>

			<FieldGroup
				label={isFolder ? "入口文档（README.md）" : "正文（Markdown）"}
				htmlFor={contentId}
				hint={
					!selectedDoc && entryKind === "folder"
						? "目录条目会自动创建入口文件 README.md 与默认 .gitignore，下方可一次追加多个附加子文件。"
						: undefined
				}
			>
				<Textarea
					id={contentId}
					mono
					className="min-h-[300px]"
					value={content}
					onChange={(e) => onContentChange(e.target.value)}
					placeholder={
						!selectedDoc && entryKind === "folder"
							? "此内容将保存为目录内的 README.md（主说明/索引页）"
							: "支持 Markdown"
					}
				/>
			</FieldGroup>

			{!selectedDoc && entryKind === "folder" && (
				<div className="flex flex-col gap-2.5 p-3.5 border border-dashed border-line rounded-lg bg-surface">
					<div className="flex items-center justify-between gap-2.5 flex-wrap text-xs">
						<strong className="text-ink">附加子文件（可选，一次提交多个）</strong>
						<div className="flex items-center flex-wrap gap-2">
							{["notes.md", "option-a.md", "demo/index.html", ".gitignore"].map((preset) => (
								<Button
									key={preset}
									variant="inline"
									size="xs"
									onClick={() =>
										onExtraFilesChange((prev) => [
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
								</Button>
							))}
							<Button
								variant="secondary"
								size="xs"
								onClick={() =>
									onExtraFilesChange((prev) => [
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
							</Button>
						</div>
					</div>
					{extraFiles.map((file, idx) => (
						<Card key={file.id} padding="sm" className="flex flex-col gap-2">
							<div className="flex items-center gap-2.5">
								<Input
									size="sm"
									mono
									className="flex-1"
									placeholder={`子文件 ${idx + 1} 相对路径，如 option-a.md 或 demo/index.html`}
									value={file.path}
									onChange={(e) =>
										onExtraFilesChange((prev) =>
											prev.map((item) => (item.id === file.id ? { ...item, path: e.target.value } : item)),
										)
									}
									required
								/>
								<Button
									variant="inline"
									size="xs"
									className="text-danger-text"
									onClick={() => onExtraFilesChange((prev) => prev.filter((item) => item.id !== file.id))}
								>
									移除
								</Button>
							</div>
							<Textarea
								mono
								className="min-h-[110px]"
								placeholder="输入子文件内容（Markdown / HTML / 配置 / 文本）"
								value={file.content}
								onChange={(e) =>
									onExtraFilesChange((prev) =>
										prev.map((item) => (item.id === file.id ? { ...item, content: e.target.value } : item)),
									)
								}
							/>
						</Card>
					))}
				</div>
			)}

			<div className="flex flex-col sm:flex-row gap-2.5">
				<FieldGroup label="关联仓库（可选）" htmlFor={linkedWorkspaceIdInput} className="flex-1">
					<Select
						id={linkedWorkspaceIdInput}
						value={linkedWorkspaceId}
						onChange={(e) => onLinkedWorkspaceIdChange(e.target.value)}
					>
						<option value="">不关联仓库</option>
						{bootstrap?.workspaces.map((ws) => (
							<option key={ws.id} value={ws.id}>
								{ws.name}
							</option>
						))}
					</Select>
				</FieldGroup>
				<FieldGroup label="关联文件相对路径或链接（可选）" htmlFor={linkedFilePathId} className="flex-[2]">
					<Input
						id={linkedFilePathId}
						mono
						value={linkedFilePath}
						onChange={(e) => onLinkedFilePathChange(e.target.value)}
						placeholder="如 docs/plan.md 或 https://..."
						maxLength={300}
					/>
				</FieldGroup>
			</div>

			<FieldGroup label="提交说明（Git Commit Message，可选）" htmlFor={commitMessageId}>
				<Input
					id={commitMessageId}
					value={commitMessage}
					onChange={(e) => onCommitMessageChange(e.target.value)}
					placeholder={selectedDoc ? `Update ${title || selectedDoc.title}` : "Create document"}
					maxLength={200}
				/>
			</FieldGroup>

			<div className="flex items-center gap-2">
				<Button variant="primary" size="sm" type="submit" disabled={busy}>
					{busy ? "提交中…" : "保存并提交 Git"}
				</Button>
				<Button variant="secondary" size="sm" type="button" onClick={onCancel} disabled={busy}>
					取消
				</Button>
			</div>
		</form>
	);
}
