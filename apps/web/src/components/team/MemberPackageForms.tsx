import { type ChangeEvent, useEffect, useId, useMemo, useState } from "react";
import { type AccountUserDto, type CollaboratorDto, importMemberPackage, type OrganizationDto } from "../../api.ts";
import { buildRoleScopeChoices } from "../../architectApi.ts";
import { Button, FieldGroup, ModalDialog, Select, Textarea } from "../../primitives/index.ts";

interface MemberPackageFormsProps {
	showImportMember: boolean;
	exportedPackage: { id: string; filename: string; markdown: string } | null;
	isSuperAdmin?: boolean;
	accountUser?: AccountUserDto | null;
	currentUser?: CollaboratorDto | null;
	organizations?: OrganizationDto[];
	onCloseImportMember: () => void;
	onCloseExportedPackage: () => void;
	onRefresh: () => Promise<void>;
	onNotice: (message: string) => void;
	onError: (message: string) => void;
}

/** Handles importing and exporting sanitized AI role capability Markdown packages in focused modals. */
export function MemberPackageForms({
	showImportMember,
	exportedPackage,
	isSuperAdmin = false,
	accountUser = null,
	currentUser = null,
	organizations = [],
	onCloseImportMember,
	onCloseExportedPackage,
	onRefresh,
	onNotice,
	onError,
}: MemberPackageFormsProps) {
	const scopeSelectId = useId();
	const [importMarkdown, setImportMarkdown] = useState("");
	const [importing, setImporting] = useState(false);
	const scopeChoices = useMemo(
		() => buildRoleScopeChoices({ isSuperAdmin, accountUser, currentUser, organizations }),
		[isSuperAdmin, accountUser, currentUser, organizations],
	);
	const [selectedScopeKey, setSelectedScopeKey] = useState<string>(() => scopeChoices[0]?.key ?? "personal");

	useEffect(() => {
		if (!showImportMember) return;
		if (!scopeChoices.some((c) => c.key === selectedScopeKey)) {
			setSelectedScopeKey(scopeChoices[0]?.key ?? "personal");
		}
	}, [showImportMember, scopeChoices, selectedScopeKey]);

	const closeImportModal = () => {
		if (importing) return;
		setImportMarkdown("");
		onCloseImportMember();
	};

	const handleImportMember = async () => {
		if (!importMarkdown.trim() || importing) return;
		const chosen = scopeChoices.find((c) => c.key === selectedScopeKey) ?? scopeChoices[0];
		setImporting(true);
		try {
			const res = await importMemberPackage(
				importMarkdown,
				chosen ? { roleScope: chosen.roleScope, ownerOrgId: chosen.ownerOrgId } : undefined,
			);
			setImportMarkdown("");
			onCloseImportMember();
			onNotice(`已导入角色「${res.member.displayName}」`);
			await onRefresh();
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
		} finally {
			setImporting(false);
		}
	};

	const handleImportFileChange = (e: ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (!file) return;
		const reader = new FileReader();
		reader.onload = () => {
			if (typeof reader.result === "string") {
				setImportMarkdown(reader.result);
			}
		};
		reader.readAsText(file);
	};

	const handleDownloadExportedPackage = () => {
		if (!exportedPackage) return;
		const blob = new Blob([exportedPackage.markdown], { type: "text/markdown;charset=utf-8" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = exportedPackage.filename;
		a.click();
		URL.revokeObjectURL(url);
	};

	return (
		<>
			<ModalDialog
				open={showImportMember}
				title="导入团队成员能力包（.md）"
				subtitle="支持选择本地文件或粘贴导出的角色 Markdown 模板，导入后立即注册到当前团队，不包含他人私有项目记忆。"
				size="md"
				closeDisabled={importing}
				onClose={closeImportModal}
				footer={
					<>
						<Button variant="secondary" size="sm" disabled={importing} onClick={closeImportModal}>
							取消
						</Button>
						<Button
							variant="primary"
							size="sm"
							disabled={importing || !importMarkdown.trim()}
							onClick={() => void handleImportMember()}
						>
							{importing ? "导入中…" : "确认导入"}
						</Button>
					</>
				}
			>
				<FieldGroup label="导入后的角色使用范围" htmlFor={scopeSelectId}>
					<Select
						id={scopeSelectId}
						value={selectedScopeKey}
						onChange={(e) => setSelectedScopeKey(e.target.value)}
					>
						{scopeChoices.map((choice) => (
							<option key={choice.key} value={choice.key}>
								{choice.label}
							</option>
						))}
					</Select>
				</FieldGroup>
				<label className="flex items-center gap-2 flex-wrap text-xs text-ink-secondary cursor-pointer">
					<span>选择本地 .md 文件：</span>
					<input
						type="file"
						accept=".md,text/markdown"
						onChange={handleImportFileChange}
						className="text-xs text-ink file:mr-2 file:px-2.5 file:py-1 file:rounded-xs file:border file:border-line file:bg-stage file:text-xs file:font-medium file:text-ink hover:file:bg-hover file:cursor-pointer"
					/>
				</label>
				<Textarea
					rows={8}
					mono
					placeholder="粘贴角色模板 Markdown（含 --- frontmatter ---）…"
					value={importMarkdown}
					onChange={(e) => setImportMarkdown(e.target.value)}
				/>
			</ModalDialog>

			<ModalDialog
				open={Boolean(exportedPackage)}
				title={exportedPackage ? `已导出脱敏能力包：${exportedPackage.filename}` : "已导出脱敏能力包"}
				subtitle="已自动剥离公司私有规范与项目私有记忆，仅保留角色职责、技能与工作原则。"
				size="md"
				onClose={onCloseExportedPackage}
				footer={
					<>
						<Button variant="secondary" size="sm" onClick={onCloseExportedPackage}>
							关闭
						</Button>
						<Button
							variant="secondary"
							size="sm"
							onClick={() => {
								if (!exportedPackage) return;
								void navigator.clipboard.writeText(exportedPackage.markdown);
								onNotice("能力包 Markdown 已复制到剪贴板");
							}}
						>
							复制内容
						</Button>
						<Button variant="primary" size="sm" onClick={handleDownloadExportedPackage}>
							下载 .md 文件
						</Button>
					</>
				}
			>
				<Textarea rows={9} readOnly mono value={exportedPackage?.markdown ?? ""} />
			</ModalDialog>
		</>
	);
}
