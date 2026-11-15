import { type ChangeEvent, useState } from "react";
import { createMember, importMemberPackage } from "../../api.ts";
import { splitTagsInput } from "../../utils.ts";

interface MemberPackageFormsProps {
	showAddMember: boolean;
	showImportMember: boolean;
	exportedPackage: { id: string; filename: string; markdown: string } | null;
	onCloseAddMember: () => void;
	onCloseImportMember: () => void;
	onCloseExportedPackage: () => void;
	onRefresh: () => Promise<void>;
	onNotice: (message: string) => void;
	onError: (message: string) => void;
}

/** Handles creating custom AI team members and importing/exporting sanitized role capability Markdown packages. */
export function MemberPackageForms({
	showAddMember,
	showImportMember,
	exportedPackage,
	onCloseAddMember,
	onCloseImportMember,
	onCloseExportedPackage,
	onRefresh,
	onNotice,
	onError,
}: MemberPackageFormsProps) {
	const [newMemberName, setNewMemberName] = useState("");
	const [newMemberTitle, setNewMemberTitle] = useState("");
	const [newMemberResp, setNewMemberResp] = useState("");
	const [newMemberKeywords, setNewMemberKeywords] = useState("");
	const [newMemberSkills, setNewMemberSkills] = useState("");
	const [newMemberGitName, setNewMemberGitName] = useState("");
	const [newMemberGitEmail, setNewMemberGitEmail] = useState("");
	const [newMemberIdentitySummary, setNewMemberIdentitySummary] = useState("");
	const [newMemberPrimary, setNewMemberPrimary] = useState(false);
	const [importMarkdown, setImportMarkdown] = useState("");

	const handleCreateMember = async () => {
		if (!newMemberName.trim() || !newMemberTitle.trim()) return;
		try {
			const res = await createMember({
				name: newMemberName.trim(),
				title: newMemberTitle.trim(),
				responsibilities: newMemberResp.trim() || undefined,
				keywords: splitTagsInput(newMemberKeywords),
				skills: splitTagsInput(newMemberSkills),
				gitName: newMemberGitName.trim() || undefined,
				gitEmail: newMemberGitEmail.trim() || undefined,
				identitySummary: newMemberIdentitySummary.trim() || undefined,
				isPrimaryContact: newMemberPrimary,
			});
			setNewMemberName("");
			setNewMemberTitle("");
			setNewMemberResp("");
			setNewMemberKeywords("");
			setNewMemberSkills("");
			setNewMemberGitName("");
			setNewMemberGitEmail("");
			setNewMemberIdentitySummary("");
			setNewMemberPrimary(false);
			onCloseAddMember();
			onNotice(`新同事「${res.member.displayName}」已加入团队`);
			await onRefresh();
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
		}
	};

	const handleImportMember = async () => {
		if (!importMarkdown.trim()) return;
		try {
			const res = await importMemberPackage(importMarkdown);
			setImportMarkdown("");
			onCloseImportMember();
			onNotice(`已导入角色「${res.member.displayName}」`);
			await onRefresh();
		} catch (err: unknown) {
			onError(err instanceof Error ? err.message : String(err));
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
			{showAddMember && (
				<section className="ui-card form-card">
					<h2 className="ui-card-title">组建新角色</h2>
					<div className="form-grid">
						<input
							className="input-field"
							placeholder="角色名称（如：架构师）"
							value={newMemberName}
							onChange={(e) => setNewMemberName(e.target.value)}
						/>
						<input
							className="input-field"
							placeholder="职位头衔（如：System Architect）"
							value={newMemberTitle}
							onChange={(e) => setNewMemberTitle(e.target.value)}
						/>
					</div>
					<textarea
						rows={2}
						className="composer-input"
						placeholder="核心职责描述（例如：负责系统架构选型、模块解耦和性能瓶颈排查）"
						value={newMemberResp}
						onChange={(e) => setNewMemberResp(e.target.value)}
					/>
					<div className="form-grid">
						<input
							className="input-field"
							placeholder="路由关键词（逗号分隔，如：架构,性能,重构）"
							value={newMemberKeywords}
							onChange={(e) => setNewMemberKeywords(e.target.value)}
						/>
						<input
							className="input-field"
							placeholder="能力技能（逗号分隔，如：architecture-review,rfc）"
							value={newMemberSkills}
							onChange={(e) => setNewMemberSkills(e.target.value)}
						/>
					</div>
					<div className="form-grid">
						<input
							className="input-field"
							placeholder="Git Author 名称（可选，默认用英文头衔或 ID）"
							value={newMemberGitName}
							onChange={(e) => setNewMemberGitName(e.target.value)}
						/>
						<input
							className="input-field"
							placeholder="Git 提交邮箱 Email（可选，默认按组织域名或 @team.local）"
							value={newMemberGitEmail}
							onChange={(e) => setNewMemberGitEmail(e.target.value)}
						/>
					</div>
					<input
						className="input-field"
						placeholder="角色背景与身份定位说明（可选，仅私有保存，导出能力包时自动脱敏）"
						value={newMemberIdentitySummary}
						onChange={(e) => setNewMemberIdentitySummary(e.target.value)}
					/>
					<div className="form-footer">
						<label className="checkbox-label">
							<input
								type="checkbox"
								checked={newMemberPrimary}
								onChange={(e) => setNewMemberPrimary(e.target.checked)}
							/>
							<span>设为默认主联系人</span>
						</label>
						<div className="ui-row-actions">
							<button type="button" className="btn-pill-outline" onClick={onCloseAddMember}>
								取消
							</button>
							<button type="button" className="btn-pill-dark" onClick={() => void handleCreateMember()}>
								加入团队
							</button>
						</div>
					</div>
				</section>
			)}

			{showImportMember && (
				<section className="ui-card form-card">
					<h2 className="ui-card-title">导入团队成员能力包（.md）</h2>
					<p className="muted-hint">
						支持粘贴或选择导出的角色 Markdown 模板。导入后立即注册到当前团队，不包含他人私有项目记忆。
					</p>
					<label className="file-upload-label">
						<span>选择本地 .md 文件：</span>
						<input type="file" accept=".md,text/markdown" onChange={handleImportFileChange} />
					</label>
					<textarea
						rows={6}
						className="composer-input mono-input"
						placeholder="粘贴角色模板 Markdown（含 --- frontmatter ---）..."
						value={importMarkdown}
						onChange={(e) => setImportMarkdown(e.target.value)}
					/>
					<div className="actions-row">
						<button type="button" className="btn-pill-dark" onClick={() => void handleImportMember()}>
							确认导入
						</button>
						<button type="button" className="btn-pill-outline" onClick={onCloseImportMember}>
							取消
						</button>
					</div>
				</section>
			)}

			{exportedPackage && (
				<section className="ui-card form-card">
					<div className="banner-row">
						<h2 className="ui-card-title">已导出脱敏能力包：{exportedPackage.filename}</h2>
						<button type="button" className="btn-inline" onClick={onCloseExportedPackage}>
							关闭
						</button>
					</div>
					<p className="muted-hint">已自动剥离公司私有规范与项目私有记忆，仅保留角色职责、技能与工作原则。</p>
					<textarea rows={7} readOnly className="composer-input mono-input" value={exportedPackage.markdown} />
					<div className="actions-row">
						<button type="button" className="btn-pill-dark" onClick={handleDownloadExportedPackage}>
							下载 .md 文件
						</button>
						<button
							type="button"
							className="btn-pill-outline"
							onClick={() => {
								void navigator.clipboard.writeText(exportedPackage.markdown);
								onNotice("能力包 Markdown 已复制到剪贴板");
							}}
						>
							复制内容
						</button>
					</div>
				</section>
			)}
		</>
	);
}
