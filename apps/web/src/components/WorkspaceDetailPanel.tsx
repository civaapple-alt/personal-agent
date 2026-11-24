import { useCallback, useEffect, useState } from "react";
import { listSpaceDocuments, type SpaceDocumentMetaDto } from "../api/space.ts";
import {
	addWorkspaceFolder,
	fetchWorkspaceCustomizations,
	removeWorkspaceFolder,
	updateWorkspaceFolder,
	type WorkspaceCustomizationsReportDto,
	type WorkspaceFolderDto,
} from "../api/workspaceFolders.ts";
import type { MatterDto, OrganizationDto, WorkspaceDto } from "../api.ts";
import { copyTextToClipboard } from "../clipboard.ts";
import { formatClockTime, stripMarkdownFormatting } from "../utils.ts";
import { ServerDirectoryPicker } from "./ServerDirectoryPicker.tsx";

interface WorkspaceDetailPanelProps {
	workspace: WorkspaceDto;
	allWorkspaces: WorkspaceDto[];
	organizations: OrganizationDto[];
	matters: MatterDto[];
	canManage: boolean;
	canEditAccess: boolean;
	isAccountMode: boolean;
	memberName: (id: string) => string;
	onChangeOrg: (workspaceId: string, orgId: string) => Promise<void>;
	onOpenAccess: (workspace: WorkspaceDto) => void;
	onUseWorkspace: (workspaceId: string) => void;
	onOpenMatter?: (matterId: string) => void;
	onOpenSpace?: (targetId: string) => void;
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

const MATTER_STATUS_LABEL: Record<MatterDto["status"], string> = {
	open: "进行中",
	waiting_user: "待确认",
	archived: "已归档",
};

/** Right-hand detail pane for the unified Workspaces view: header config, inline Folders & Customizations, and live workspace activity. */
export function WorkspaceDetailPanel({
	workspace,
	allWorkspaces,
	organizations,
	matters,
	canManage,
	canEditAccess,
	isAccountMode,
	memberName,
	onChangeOrg,
	onOpenAccess,
	onUseWorkspace,
	onOpenMatter,
	onOpenSpace,
	onNotice,
	onChanged,
}: WorkspaceDetailPanelProps) {
	const [subTab, setSubTab] = useState<"config" | "activity">("config");
	const [folders, setFolders] = useState<WorkspaceFolderDto[]>([]);
	const [report, setReport] = useState<WorkspaceCustomizationsReportDto | null>(null);
	const [spaceDocs, setSpaceDocs] = useState<SpaceDocumentMetaDto[]>([]);
	const [folderFilter, setFolderFilter] = useState<string>("");
	const [showRulesBreakdown, setShowRulesBreakdown] = useState(true);
	const [showSkillsBreakdown, setShowSkillsBreakdown] = useState(false);

	const [addingFolder, setAddingFolder] = useState(false);
	const [browsingDirectory, setBrowsingDirectory] = useState(false);
	const [newPath, setNewPath] = useState("");
	const [newLabel, setNewLabel] = useState("");
	const [loading, setLoading] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	const workspaceSpaceId = `spc_ws_${workspace.id}`;

	const loadCustomizations = useCallback(async (wsId: string, filterId?: string) => {
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

	const loadSpaceDocs = useCallback(async (wsId: string) => {
		try {
			const res = await listSpaceDocuments(`spc_ws_${wsId}`);
			setSpaceDocs(res.documents);
		} catch {
			setSpaceDocs([]);
		}
	}, []);

	useEffect(() => {
		setFolderFilter("");
		setAddingFolder(false);
		setBrowsingDirectory(false);
		setNewPath("");
		setNewLabel("");
		void loadCustomizations(workspace.id);
		void loadSpaceDocs(workspace.id);
	}, [workspace.id, loadCustomizations, loadSpaceDocs]);

	const workspaceMatters = matters
		.filter((m) => m.workspaceId === workspace.id && m.status !== "archived")
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

	const handleFilterChange = (nextFilter: string) => {
		setFolderFilter(nextFilter);
		void loadCustomizations(workspace.id, nextFilter);
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
			await loadCustomizations(workspace.id, folderFilter);
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
			await loadCustomizations(workspace.id, folderFilter);
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
			await loadCustomizations(workspace.id, nextFilter);
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
		<div className="ws-detail-panel">
			<div className="ws-detail-header">
				<div className="ws-detail-title-col">
					<div className="ws-detail-title-row">
						<h2>{workspace.name}</h2>
						<span className="ws-role-pill">{workspace.defaultBranch}</span>
						{workspace.visibility === "restricted" && <span className="ws-warn-pill">受限访问</span>}
					</div>
					<div className="ws-detail-sub">
						<code>{workspace.repoPath}</code>
						{workspace.repoGitUser && (
							<span>
								{" "}
								· Git Committer：{workspace.repoGitUser.name} &lt;{workspace.repoGitUser.email}&gt;
							</span>
						)}
					</div>
				</div>
				<div className="ws-detail-actions">
					{onOpenSpace && (
						<button
							type="button"
							className="btn-pill-outline btn-xs"
							onClick={() => onOpenSpace(workspaceSpaceId)}
						>
							打开工作区空间 ↗
						</button>
					)}
					<button type="button" className="btn-pill-dark btn-xs" onClick={() => onUseWorkspace(workspace.id)}>
						+ 在此新建事项
					</button>
				</div>
			</div>

			<div className="ws-detail-toolbar">
				<div className="ws-subtabs" role="tablist" aria-label="工作区视图">
					<button
						type="button"
						role="tab"
						aria-selected={subTab === "config"}
						className={`choice-chip ${subTab === "config" ? "active" : ""}`}
						onClick={() => setSubTab("config")}
					>
						目录与规则 ({folders.length})
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={subTab === "activity"}
						className={`choice-chip ${subTab === "activity" ? "active" : ""}`}
						onClick={() => setSubTab("activity")}
					>
						工作区动态 ({workspaceMatters.length + spaceDocs.length})
					</button>
				</div>

				<div className="ws-detail-meta-controls">
					<button
						type="button"
						className="btn-inline"
						onClick={() => void copyTextToClipboard(workspace.repoPath, "主目录路径", onNotice)}
					>
						复制路径
					</button>
					{canEditAccess && (
						<button type="button" className="btn-inline" onClick={() => onOpenAccess(workspace)}>
							权限范围
						</button>
					)}
					{organizations.length > 0 && canManage && (
						<select
							className="select-sm select-control"
							aria-label={`设置 ${workspace.name} 的所属组织`}
							value={workspace.orgId ?? ""}
							onChange={(e) => void onChangeOrg(workspace.id, e.target.value)}
						>
							{!isAccountMode && <option value="">独立工作区</option>}
							{organizations.map((item) => (
								<option key={item.id} value={item.id}>
									组织：{item.name}
								</option>
							))}
						</select>
					)}
				</div>
			</div>

			{error && (
				<p role="alert" className="space-error">
					{error}
				</p>
			)}

			{subTab === "config" ? (
				<div className="ws-custom-modal">
					<section className="ws-folders-section">
						<div className="ws-section-head-row">
							<h3 className="ws-section-title">挂载目录 ({folders.length})</h3>
							<span className="ws-section-hint">主目录作为 Pi 默认工作目录，附加目录共享 Rules 与 Skills</span>
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
												<span className="ws-folder-remove-slot">
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
												</span>
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
											<button
												type="button"
												className="btn-secondary"
												onClick={() => setBrowsingDirectory(!browsingDirectory)}
											>
												选择目录
											</button>
											<input
												className="input-field"
												style={{ flex: 1 }}
												placeholder="短名称（可选）"
												value={newLabel}
												onChange={(e) => setNewLabel(e.target.value)}
												maxLength={60}
											/>
										</div>
										{browsingDirectory && (
											<ServerDirectoryPicker
												workspaceId={workspace.id}
												initialPath={newPath || workspace.repoPath}
												onClose={() => setBrowsingDirectory(false)}
												onSelect={(path) => {
													setNewPath(path);
													setBrowsingDirectory(false);
												}}
											/>
										)}
										{quickAddCandidates.length > 0 && (
											<div className="ws-quick-candidates">
												<span className="muted-hint">快速选择已有工作区：</span>
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
												{report.rulesTokensUsed.toLocaleString()} /{" "}
												{report.rulesBudgetTokens.toLocaleString()} tokens (
												{formatPercent(report.rulesTokensUsed, report.rulesBudgetTokens)})
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
																{rule.mode === "disabled" && (
																	<span className="ws-muted-pill">已停用</span>
																)}
															</div>
															<div className="ws-rule-card-right">
																<span className="ws-token-num">
																	{rule.tokens.toLocaleString()} tokens
																</span>
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
			) : (
				<div className="ws-activity-grid">
					<section className="ws-activity-block">
						<div className="ws-section-head-row">
							<h3 className="ws-section-title">关联事项动态 ({workspaceMatters.length})</h3>
						</div>
						{workspaceMatters.length === 0 ? (
							<p className="muted-hint">该工作区暂无活跃事项。</p>
						) : (
							<div className="ws-activity-list">
								{workspaceMatters.slice(0, 15).map((matter) => (
									<button
										type="button"
										key={matter.id}
										className="ws-activity-card"
										onClick={() => onOpenMatter?.(matter.id)}
									>
										<div className="ws-activity-card-head">
											<strong>{matter.title}</strong>
											<span className="ws-role-pill">{MATTER_STATUS_LABEL[matter.status]}</span>
										</div>
										{matter.summary && (
											<p className="ws-rule-preview">{stripMarkdownFormatting(matter.summary)}</p>
										)}
										<div className="ws-activity-card-meta">
											<span>{matter.leadMemberId ? memberName(matter.leadMemberId) : "待分配"}</span>
											<span>更新于 {formatClockTime(matter.updatedAt)}</span>
										</div>
									</button>
								))}
							</div>
						)}
					</section>

					<section className="ws-activity-block">
						<div className="ws-section-head-row">
							<h3 className="ws-section-title">工作区空间资料 ({spaceDocs.length})</h3>
							{onOpenSpace && (
								<button type="button" className="btn-inline" onClick={() => onOpenSpace(workspaceSpaceId)}>
									全部资料 →
								</button>
							)}
						</div>
						{spaceDocs.length === 0 ? (
							<p className="muted-hint">工作区空间中还没有资料文档。</p>
						) : (
							<div className="ws-activity-list">
								{spaceDocs.slice(0, 12).map((doc) => (
									<button
										type="button"
										key={doc.id}
										className="ws-activity-card"
										onClick={() => onOpenSpace?.(doc.id)}
									>
										<div className="ws-activity-card-head">
											<strong>{doc.title}</strong>
											<span className="ws-token-num">
												rev {doc.revision} · {doc.headCommit.slice(0, 7)}
											</span>
										</div>
										<div className="ws-activity-card-meta">
											<span>{memberName(doc.updatedBy)}</span>
											<span>{new Date(doc.updatedAt).toLocaleString()}</span>
										</div>
									</button>
								))}
							</div>
						)}
					</section>
				</div>
			)}
		</div>
	);
}
