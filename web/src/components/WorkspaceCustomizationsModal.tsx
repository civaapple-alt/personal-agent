import { useCallback, useEffect, useState } from "react";
import {
	addWorkspaceFolder,
	fetchWorkspaceCustomizations,
	removeWorkspaceFolder,
	updateWorkspaceFolder,
	type WorkspaceCustomizationsReportDto,
	type WorkspaceFolderDto,
} from "../api/workspaceFolders.ts";
import type { WorkspaceDto } from "../api.ts";
import { copyTextToClipboard } from "../clipboard.ts";
import { stripMarkdownFormatting } from "../utils.ts";
import { ModalDialog } from "./ModalDialog.tsx";

interface WorkspaceCustomizationsModalProps {
	workspace: WorkspaceDto | null;
	allWorkspaces: WorkspaceDto[];
	canManage: boolean;
	onClose: () => void;
	onNotice: (message: string) => void;
	onChanged?: () => Promise<void>;
}

function formatPercent(used: number, budget: number): string {
	if (budget <= 0) return "0.0%";
	return `${Math.min(100, (used / budget) * 100).toFixed(1)}%`;
}

function FolderGlyph() {
	return (
		<svg
			className="ws-folder-icon"
			width="15"
			height="15"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.9"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="M3 7a2 2 0 0 1 2-2h4.6a2 2 0 0 1 1.4.58l1.42 1.42a2 2 0 0 0 1.4.58H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
		</svg>
	);
}

/** Multi-folder workspace manager + cross-folder Rules/Skills token budget breakdown modal. */
export function WorkspaceCustomizationsModal({
	workspace,
	allWorkspaces,
	canManage,
	onClose,
	onNotice,
	onChanged,
}: WorkspaceCustomizationsModalProps) {
	const [folders, setFolders] = useState<WorkspaceFolderDto[]>([]);
	const [report, setReport] = useState<WorkspaceCustomizationsReportDto | null>(null);
	const [folderFilter, setFolderFilter] = useState<string>("");
	const [showRulesBreakdown, setShowRulesBreakdown] = useState(true);
	const [showSkillsBreakdown, setShowSkillsBreakdown] = useState(false);

	const [addingFolder, setAddingFolder] = useState(false);
	const [newPath, setNewPath] = useState("");
	const [newLabel, setNewLabel] = useState("");
	const [loading, setLoading] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	const load = useCallback(async (wsId: string, filterId?: string) => {
		setLoading(true);
		setError("");
		try {
			const res = await fetchWorkspaceCustomizations(wsId, filterId || undefined);
			setFolders(res.folders);
			setReport(res.report);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		if (!workspace) return;
		setFolderFilter("");
		setAddingFolder(false);
		setNewPath("");
		setNewLabel("");
		void load(workspace.id);
	}, [workspace, load]);

	if (!workspace) return null;

	const handleFilterChange = (nextFilter: string) => {
		setFolderFilter(nextFilter);
		void load(workspace.id, nextFilter);
	};

	const handleAddFolder = async (event: React.FormEvent) => {
		event.preventDefault();
		if (!newPath.trim()) return;
		setBusy(true);
		setError("");
		try {
			await addWorkspaceFolder(workspace.id, {
				path: newPath.trim(),
				label: newLabel.trim() || undefined,
			});
			setAddingFolder(false);
			setNewPath("");
			setNewLabel("");
			await load(workspace.id, folderFilter);
			await onChanged?.();
			onNotice("已向工作区添加目录");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const handleToggleFlag = async (folder: WorkspaceFolderDto, key: "loadRules" | "loadSkills") => {
		setBusy(true);
		setError("");
		try {
			await updateWorkspaceFolder(workspace.id, folder.id, { [key]: !folder[key] });
			await load(workspace.id, folderFilter);
			await onChanged?.();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const handleRemoveFolder = async (folder: WorkspaceFolderDto) => {
		setBusy(true);
		setError("");
		try {
			await removeWorkspaceFolder(workspace.id, folder.id);
			const nextFilter = folderFilter === folder.id ? "" : folderFilter;
			setFolderFilter(nextFilter);
			await load(workspace.id, nextFilter);
			await onChanged?.();
			onNotice(`已移除目录 ${folder.label}`);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const quickAddCandidates = allWorkspaces.filter(
		(other) => other.id !== workspace.id && !folders.some((f) => f.path === other.repoPath),
	);

	const rulesPct = report ? Math.min(100, (report.rulesTokensUsed / report.rulesBudgetTokens) * 100) : 0;
	const skillsPct = report ? Math.min(100, (report.skillsTokensUsed / report.skillsBudgetTokens) * 100) : 0;

	return (
		<ModalDialog
			open={Boolean(workspace)}
			title={`${workspace.name} · 目录与规则`}
			subtitle="管理工作区挂载目录与跨目录 Rules / Skills 上下文预算。"
			size="md"
			onClose={onClose}
		>
			<div className="ws-custom-modal">
				{error && (
					<p role="alert" className="space-error">
						{error}
					</p>
				)}

				<section className="ws-folders-section">
					<div className="ws-section-head-row">
						<h3 className="ws-section-title">挂载目录 ({folders.length})</h3>
						<span className="ws-section-hint">主目录作为 Pi 默认工作目录，附加目录共享上下文</span>
					</div>
					<div className="ws-folders-list">
						{folders.map((folder) => (
							<div key={folder.id} className="ws-folder-row">
								<div className="ws-folder-main">
									<div className="ws-folder-title">
										<FolderGlyph />
										<strong>{folder.label}/</strong>
										{folder.role === "primary" && <span className="ws-role-pill">主目录</span>}
									</div>
									<div className="ws-folder-path">{folder.path}</div>
								</div>
								<div className="ws-folder-controls">
									{canManage && (
										<>
											<button
												type="button"
												aria-pressed={folder.loadRules}
												className={`ws-toggle-pill ${folder.loadRules ? "is-on" : ""}`}
												disabled={busy}
												title="是否加载该目录的 AGENTS.md / CLAUDE.md"
												onClick={() => void handleToggleFlag(folder, "loadRules")}
											>
												<span className="ws-toggle-check" aria-hidden="true">
													{folder.loadRules ? "✓" : ""}
												</span>
												Rules
											</button>
											<button
												type="button"
												aria-pressed={folder.loadSkills}
												className={`ws-toggle-pill ${folder.loadSkills ? "is-on" : ""}`}
												disabled={busy}
												title="是否加载该目录的 .agents/skills 与 .pi/skills"
												onClick={() => void handleToggleFlag(folder, "loadSkills")}
											>
												<span className="ws-toggle-check" aria-hidden="true">
													{folder.loadSkills ? "✓" : ""}
												</span>
												Skills
											</button>
											{folder.role === "attached" && (
												<button
													type="button"
													className="btn-icon-ghost"
													aria-label={`移除目录 ${folder.label}`}
													title="移除附加目录"
													disabled={busy}
													onClick={() => void handleRemoveFolder(folder)}
												>
													×
												</button>
											)}
										</>
									)}
								</div>
							</div>
						))}

						{canManage &&
							(addingFolder ? (
								<form className="ws-add-folder-form" onSubmit={(e) => void handleAddFolder(e)}>
									<div className="space-create-row">
										<input
											className="input-field"
											style={{ flex: 2 }}
											placeholder="输入本地目录绝对路径，例如 /Users/.../pi"
											value={newPath}
											onChange={(e) => setNewPath(e.target.value)}
											required
										/>
										<input
											className="input-field"
											style={{ flex: 1 }}
											placeholder="短名称（可选）"
											value={newLabel}
											onChange={(e) => setNewLabel(e.target.value)}
											maxLength={60}
										/>
									</div>
									{quickAddCandidates.length > 0 && (
										<div className="ws-quick-candidates">
											<span className="muted-hint">快速选择已有仓库：</span>
											{quickAddCandidates.slice(0, 6).map((cand) => (
												<button
													key={cand.id}
													type="button"
													className="choice-chip"
													onClick={() => {
														setNewPath(cand.repoPath);
														setNewLabel(cand.name);
													}}
												>
													+ {cand.name}
												</button>
											))}
										</div>
									)}
									<div className="space-page-actions">
										<button type="submit" className="btn-pill-dark btn-xs" disabled={busy}>
											{busy ? "添加中…" : "确认添加"}
										</button>
										<button
											type="button"
											className="btn-secondary btn-xs"
											onClick={() => setAddingFolder(false)}
											disabled={busy}
										>
											取消
										</button>
									</div>
								</form>
							) : (
								<button
									type="button"
									className="ws-add-folder-btn"
									onClick={() => setAddingFolder(true)}
									disabled={busy}
								>
									+ 添加目录
								</button>
							))}
					</div>
				</section>

				<section className="ws-customizations-section">
					<div className="ws-customizations-head">
						<h3 className="ws-section-title">上下文规则与技能预算</h3>
						<select
							className="select-sm select-control"
							aria-label="按目录筛选上下文规则与技能"
							value={folderFilter}
							onChange={(e) => handleFilterChange(e.target.value)}
						>
							<option value="">全部目录</option>
							{folders.map((f) => (
								<option key={f.id} value={f.id}>
									{f.label}/
								</option>
							))}
						</select>
					</div>

					{loading && !report ? (
						<p className="muted-hint">正在扫描目录规则与 Skills…</p>
					) : report ? (
						<div className="ws-budget-card">
							<p className="ws-budget-desc">
								统计已启用目录中 Rules（AGENTS.md / CLAUDE.md）与 Skills 的估算 Token
								占用；超出预算时，较大的附加目录规则将自动降级为路径指针。
							</p>

							<div className="ws-budget-bars">
								<div className="ws-budget-bar-block">
									<div className="ws-budget-bar-label">
										<strong>Rules 规则</strong>
										<span className="ws-budget-metric">
											{report.rulesTokensUsed.toLocaleString()} / {report.rulesBudgetTokens.toLocaleString()}{" "}
											tokens ({formatPercent(report.rulesTokensUsed, report.rulesBudgetTokens)})
										</span>
									</div>
									<div className="ws-budget-track">
										<div
											className="ws-budget-fill is-rules"
											style={{ width: `${rulesPct > 0 ? Math.max(2, rulesPct) : 0}%` }}
										/>
									</div>
								</div>

								<div className="ws-budget-bar-block">
									<div className="ws-budget-bar-label">
										<strong>Skills 技能</strong>
										<span className="ws-budget-metric">
											{report.skillsTokensUsed.toLocaleString()} /{" "}
											{report.skillsBudgetTokens.toLocaleString()} tokens (
											{formatPercent(report.skillsTokensUsed, report.skillsBudgetTokens)})
										</span>
									</div>
									<div className="ws-budget-track">
										<div
											className="ws-budget-fill is-skills"
											style={{ width: `${skillsPct > 0 ? Math.max(2, skillsPct) : 0}%` }}
										/>
									</div>
								</div>
							</div>

							<div className="ws-breakdown-group">
								<div className="ws-breakdown-row">
									<span className="ws-breakdown-title">
										<span className="ws-dot is-rules" />
										Rules（{report.rules.length} 项 · {report.rulesTokensUsed.toLocaleString()} tokens）
									</span>
									<button
										type="button"
										className="btn-inline"
										onClick={() => setShowRulesBreakdown((v) => !v)}
									>
										{showRulesBreakdown ? "收起明细" : "展开明细"}
									</button>
								</div>
								{showRulesBreakdown && (
									<div className="ws-breakdown-items">
										{report.rules.length === 0 ? (
											<p className="muted-hint">未发现 AGENTS.md / CLAUDE.md 规则文件。</p>
										) : (
											report.rules.map((rule) => (
												<div key={rule.id} className="ws-rule-card">
													<div className="ws-rule-card-head">
														<div className="ws-rule-card-title">
															<strong>{rule.fileName}</strong>
															<span className="ws-source-pill">{rule.folderLabel}</span>
															{rule.mode === "pointer" && (
																<span className="ws-warn-pill">已降级为路径指针</span>
															)}
															{rule.mode === "disabled" && <span className="ws-muted-pill">已停用</span>}
														</div>
														<div className="ws-rule-card-right">
															<span className="ws-token-num">{rule.tokens.toLocaleString()} tokens</span>
															<button
																type="button"
																className="btn-icon-ghost"
																title="复制规则文件路径"
																onClick={() =>
																	void copyTextToClipboard(rule.filePath, "规则路径", onNotice)
																}
															>
																⧉
															</button>
														</div>
													</div>
													<div className="ws-rule-path">{rule.filePath}</div>
													{rule.preview && (
														<p className="ws-rule-preview">{stripMarkdownFormatting(rule.preview)}</p>
													)}
												</div>
											))
										)}
									</div>
								)}
							</div>

							<div className="ws-breakdown-group">
								<div className="ws-breakdown-row">
									<span className="ws-breakdown-title">
										<span className="ws-dot is-skills" />
										Skills（{report.skills.length} 项 · {report.skillsTokensUsed.toLocaleString()} tokens）
									</span>
									<button
										type="button"
										className="btn-inline"
										onClick={() => setShowSkillsBreakdown((v) => !v)}
									>
										{showSkillsBreakdown ? "收起明细" : "展开明细"}
									</button>
								</div>
								{showSkillsBreakdown && (
									<div className="ws-breakdown-items">
										{report.skills.length === 0 ? (
											<p className="muted-hint">未在 .agents/skills 或 .pi/skills 中发现目录级 Skill。</p>
										) : (
											report.skills.map((skill) => (
												<div key={skill.id} className="ws-skill-row">
													<div className="ws-skill-main">
														<span className="ws-dot is-skills" />
														<strong>{skill.name}</strong>
														<span className="ws-source-pill">{skill.folderLabel}</span>
														{skill.excluded && <span className="ws-muted-pill">已跳过</span>}
													</div>
													<span className="ws-token-num">{skill.tokens.toLocaleString()} tokens</span>
												</div>
											))
										)}
									</div>
								)}
							</div>
						</div>
					) : null}
				</section>
			</div>
		</ModalDialog>
	);
}
