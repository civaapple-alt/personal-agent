import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { listSpaceDocuments } from "../api/space.ts";
import {
	addWorkspaceFolder,
	fetchWorkspaceCustomizations,
	removeWorkspaceFolder,
	updateWorkspaceFolder,
	updateWorkspacePiTrust,
	type WorkspaceFolderDto,
} from "../api/workspaceFolders.ts";
import type { MatterDto, OrganizationDto, WorkspaceDto } from "../api.ts";
import { copyTextToClipboard } from "../clipboard.ts";
import {
	Badge,
	type BadgeTone,
	Banner,
	Button,
	Card,
	EmptyState,
	IconButton,
	Input,
	Select,
	Tabs,
} from "../primitives/index.ts";
import { queryKeys } from "../queries/index.ts";
import { cn } from "../utils/cn.ts";
import { formatClockTime, stripMarkdownFormatting } from "../utils.ts";
import { ServerDirectoryPicker } from "./ServerDirectoryPicker.tsx";

const EMPTY_FOLDERS: WorkspaceFolderDto[] = [];

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
			className="text-ink-secondary shrink-0"
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

const MATTER_STATUS_TONE: Record<MatterDto["status"], BadgeTone> = {
	open: "accent",
	waiting_user: "warn",
	archived: "neutral",
};

const TOGGLE_PILL_BASE =
	"inline-flex items-center gap-1.5 px-2.5 py-1 rounded-pill border text-xs font-medium cursor-pointer transition-colors disabled:opacity-45";
const TOGGLE_PILL_ON = "bg-accent-soft border-accent-border text-accent font-semibold";
const TOGGLE_PILL_OFF = "bg-transparent border-line text-ink-muted hover:border-line-strong hover:text-ink";

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
	const queryClient = useQueryClient();
	const [subTab, setSubTab] = useState<"config" | "activity">("config");
	const [folderFilter, setFolderFilter] = useState<string>("");
	const [showRulesBreakdown, setShowRulesBreakdown] = useState(true);
	const [showSkillsBreakdown, setShowSkillsBreakdown] = useState(false);

	const [addingFolder, setAddingFolder] = useState(false);
	const [browsingDirectory, setBrowsingDirectory] = useState(false);
	const [newPath, setNewPath] = useState("");
	const [newLabel, setNewLabel] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	const workspaceSpaceId = `spc_ws_${workspace.id}`;
	const customizationsQuery = useQuery({
		queryKey: queryKeys.workspaces.customizations(workspace.id, folderFilter),
		queryFn: () => fetchWorkspaceCustomizations(workspace.id, folderFilter || undefined),
	});
	const spaceDocsQuery = useQuery({
		queryKey: queryKeys.spaces.documents(workspaceSpaceId),
		queryFn: async () => {
			try {
				const res = await listSpaceDocuments(workspaceSpaceId);
				return res.documents;
			} catch {
				return [];
			}
		},
	});

	const folders = customizationsQuery.data?.folders ?? EMPTY_FOLDERS;
	const piTrust = customizationsQuery.data?.piTrust ?? null;
	const report = customizationsQuery.data?.report ?? null;
	const spaceDocs = spaceDocsQuery.data ?? [];
	const loading = customizationsQuery.isFetching;
	const queryError = customizationsQuery.error;
	const displayError =
		error || (queryError instanceof Error ? queryError.message : queryError ? String(queryError) : "");

	useEffect(() => {
		setFolderFilter("");
		setAddingFolder(false);
		setBrowsingDirectory(false);
		setNewPath("");
		setNewLabel("");
		setError("");
	}, [workspace.id]);

	const workspaceMatters = matters
		.filter((m) => m.workspaceId === workspace.id && m.status !== "archived")
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

	const handleFilterChange = (nextFilter: string) => {
		setFolderFilter(nextFilter);
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
			await queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
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
			await queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
			await onChanged?.();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const handleTogglePiTrust = async () => {
		if (!piTrust?.eligible || !piTrust.canEdit) return;
		const nextTrusted = !piTrust.effectiveTrusted;
		setBusy(true);
		setError("");
		try {
			await updateWorkspacePiTrust(workspace.id, nextTrusted);
			await queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
			await onChanged?.();
			onNotice(
				nextTrusted
					? "已信任该工作区目录并同步至 ~/.pi/agent/trust.json"
					: "已取消信任该工作区目录并同步至 ~/.pi/agent/trust.json",
			);
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
			await queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
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
		<div className="flex flex-col gap-5 min-w-0">
			<div className="flex items-start justify-between gap-4 flex-wrap">
				<div className="flex flex-col gap-1 min-w-0 flex-1">
					<div className="flex items-center flex-wrap gap-2">
						<h2 className="m-0 text-lg font-semibold text-ink leading-snug">{workspace.name}</h2>
						<Badge tone="neutral" size="xs" className="font-mono">
							{workspace.defaultBranch}
						</Badge>
						{workspace.visibility === "restricted" && (
							<Badge tone="warn" dot size="xs">
								受限访问
							</Badge>
						)}
						{piTrust?.eligible && !piTrust.effectiveTrusted && (
							<Badge
								tone="warn"
								dot
								size="xs"
								title="~/.pi/agent/trust.json 中已拒绝该目录，可在下方点击切换为信任"
							>
								Pi 未信任
							</Badge>
						)}
					</div>
					<div className="mt-0.5 text-xs text-ink-muted leading-normal break-all">
						<code className="font-mono text-ink-secondary">{workspace.repoPath}</code>
						{workspace.repoGitUser && (
							<span>
								{" "}
								· Git Committer：{workspace.repoGitUser.name} &lt;{workspace.repoGitUser.email}&gt;
							</span>
						)}
					</div>
				</div>
				<div className="inline-flex items-center gap-2 shrink-0">
					{onOpenSpace && (
						<Button variant="secondary" size="xs" onClick={() => onOpenSpace(workspaceSpaceId)}>
							打开工作区空间 ↗
						</Button>
					)}
					<Button variant="primary" size="xs" onClick={() => onUseWorkspace(workspace.id)}>
						+ 在此新建事项
					</Button>
				</div>
			</div>

			<div className="flex items-center justify-between gap-4 flex-wrap pb-3.5 border-b border-line">
				<Tabs
					variant="pill"
					size="sm"
					ariaLabel="工作区视图"
					value={subTab}
					onChange={(id) => setSubTab(id as "config" | "activity")}
					items={[
						{ id: "config", label: "目录与规则", count: folders.length },
						{ id: "activity", label: "工作区动态", count: workspaceMatters.length + spaceDocs.length },
					]}
				/>

				<div className="inline-flex items-center gap-3 flex-wrap">
					<Button
						variant="inline"
						size="xs"
						onClick={() => void copyTextToClipboard(workspace.repoPath, "主目录路径", onNotice)}
					>
						复制路径
					</Button>
					{canEditAccess && (
						<Button variant="inline" size="xs" onClick={() => onOpenAccess(workspace)}>
							权限范围
						</Button>
					)}
					{organizations.length > 0 && canManage && (
						<Select
							size="sm"
							className="w-auto"
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
						</Select>
					)}
				</div>
			</div>

			{displayError && <Banner tone="danger">{displayError}</Banner>}

			{subTab === "config" ? (
				<div className="flex flex-col gap-6">
					<section className="flex flex-col gap-2.5">
						<div className="flex items-baseline justify-between gap-3 flex-wrap">
							<h3 className="m-0 text-sm font-semibold text-ink">挂载目录 ({folders.length})</h3>
							<span className="text-micro text-ink-muted">
								主目录作为 Pi 默认工作目录，附加目录共享 Rules 与 Skills
							</span>
						</div>
						<Card padding="none" className="overflow-hidden">
							{folders.map((folder) => (
								<div
									key={folder.id}
									className="flex items-center justify-between gap-4 px-4 py-3 border-b border-line last:border-b-0 flex-wrap sm:flex-nowrap"
								>
									<div className="min-w-0">
										<div className="flex items-center gap-2 text-sm text-ink">
											<FolderGlyph />
											<strong>{folder.label}/</strong>
											{folder.role === "primary" && (
												<Badge tone="neutral" size="xs">
													主目录
												</Badge>
											)}
										</div>
										<div className="mt-1 pl-[23px] font-mono text-micro text-ink-muted break-all">
											{folder.path}
										</div>
									</div>
									<div className="inline-flex items-center gap-2 shrink-0 flex-wrap">
										{canManage && (
											<>
												<button
													type="button"
													aria-pressed={folder.loadRules}
													className={cn(
														TOGGLE_PILL_BASE,
														folder.loadRules ? TOGGLE_PILL_ON : TOGGLE_PILL_OFF,
													)}
													disabled={busy}
													title="是否加载该目录的 AGENTS.md / CLAUDE.md"
													onClick={() => void handleToggleFlag(folder, "loadRules")}
												>
													<span className="text-micro leading-none" aria-hidden="true">
														{folder.loadRules ? "✓" : ""}
													</span>
													Rules
												</button>
												<button
													type="button"
													aria-pressed={folder.loadSkills}
													className={cn(
														TOGGLE_PILL_BASE,
														folder.loadSkills ? TOGGLE_PILL_ON : TOGGLE_PILL_OFF,
													)}
													disabled={busy}
													title="是否加载该目录的 .agents/skills 与 .pi/skills"
													onClick={() => void handleToggleFlag(folder, "loadSkills")}
												>
													<span className="text-micro leading-none" aria-hidden="true">
														{folder.loadSkills ? "✓" : ""}
													</span>
													Skills
												</button>
												{folder.role === "primary" && piTrust?.eligible && piTrust.canEdit && (
													<button
														type="button"
														aria-pressed={piTrust.effectiveTrusted}
														className={cn(
															TOGGLE_PILL_BASE,
															piTrust.effectiveTrusted ? TOGGLE_PILL_ON : TOGGLE_PILL_OFF,
														)}
														disabled={busy}
														title={
															piTrust.effectiveTrusted
																? "已允许 Pi 加载该目录的 .pi/ 与 .agents/（点击设为拒绝并写入 ~/.pi/agent/trust.json）"
																: "~/.pi/agent/trust.json 当前拒绝此目录（点击切换为信任并写入 trust.json）"
														}
														onClick={() => void handleTogglePiTrust()}
													>
														<span className="text-micro leading-none" aria-hidden="true">
															{piTrust.effectiveTrusted ? "✓" : ""}
														</span>
														Pi 信任
													</button>
												)}
												<span className="inline-flex items-center justify-center size-7 shrink-0">
													{folder.role === "attached" && (
														<IconButton
															variant="ghost"
															size="xs"
															aria-label={`移除目录 ${folder.label}`}
															title="移除附加目录"
															disabled={busy}
															onClick={() => void handleRemoveFolder(folder)}
														>
															×
														</IconButton>
													)}
												</span>
											</>
										)}
									</div>
								</div>
							))}

							{canManage &&
								(addingFolder ? (
									<form
										className="p-3.5 bg-surface flex flex-col gap-3"
										onSubmit={(e) => void handleAddFolder(e)}
									>
										<div className="flex items-center gap-2 flex-wrap sm:flex-nowrap">
											<Input
												mono
												className="flex-[2]"
												placeholder="输入本地目录绝对路径，例如 /Users/.../pi"
												value={newPath}
												onChange={(e) => setNewPath(e.target.value)}
												required
											/>
											<Button
												variant="secondary"
												size="md"
												onClick={() => setBrowsingDirectory(!browsingDirectory)}
											>
												选择目录
											</Button>
											<Input
												className="flex-1"
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
											<div className="flex flex-wrap items-center gap-1.5">
												<span className="text-xs text-ink-muted">快速选择已有工作区：</span>
												{quickAddCandidates.slice(0, 6).map((cand) => (
													<Button
														key={cand.id}
														variant="secondary"
														size="xs"
														className="rounded-pill"
														onClick={() => {
															setNewPath(cand.repoPath);
															setNewLabel(cand.name);
														}}
													>
														+ {cand.name}
													</Button>
												))}
											</div>
										)}
										<div className="flex items-center gap-2">
											<Button type="submit" variant="primary" size="xs" disabled={busy}>
												{busy ? "添加中…" : "确认添加"}
											</Button>
											<Button
												variant="secondary"
												size="xs"
												onClick={() => setAddingFolder(false)}
												disabled={busy}
											>
												取消
											</Button>
										</div>
									</form>
								) : (
									<button
										type="button"
										className="w-full border-0 bg-surface hover:bg-hover text-ink px-4 py-2.5 text-sm font-medium cursor-pointer transition-colors text-center disabled:opacity-45"
										onClick={() => setAddingFolder(true)}
										disabled={busy}
									>
										+ 添加目录
									</button>
								))}
						</Card>
					</section>

					<section className="flex flex-col gap-2.5">
						<div className="flex items-center justify-between gap-3">
							<h3 className="m-0 text-sm font-semibold text-ink">上下文规则与技能预算</h3>
							<Select
								size="sm"
								className="w-auto"
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
							</Select>
						</div>

						{loading && !report ? (
							<p className="m-0 text-xs text-ink-muted">正在扫描目录规则与 Skills…</p>
						) : report ? (
							<Card className="flex flex-col gap-4">
								<p className="m-0 text-xs text-ink-secondary leading-relaxed">
									统计已启用目录中 Rules（AGENTS.md / CLAUDE.md）与 Skills 的估算 Token
									占用；超出预算时，较大的附加目录规则将自动降级为路径指针。
								</p>

								<div className="flex flex-col gap-3.5">
									<div className="flex flex-col gap-1.5">
										<div className="flex items-center justify-between text-xs">
											<strong className="text-ink">Rules 规则</strong>
											<span className="text-ink-secondary tabular-nums font-mono">
												{report.rulesTokensUsed.toLocaleString()} /{" "}
												{report.rulesBudgetTokens.toLocaleString()} tokens (
												{formatPercent(report.rulesTokensUsed, report.rulesBudgetTokens)})
											</span>
										</div>
										<div className="h-2 rounded-pill bg-subtle overflow-hidden">
											<div
												className="h-full rounded-pill bg-info-text transition-[width] duration-200"
												style={{ width: `${rulesPct > 0 ? Math.max(2, rulesPct) : 0}%` }}
											/>
										</div>
									</div>

									<div className="flex flex-col gap-1.5">
										<div className="flex items-center justify-between text-xs">
											<strong className="text-ink">Skills 技能</strong>
											<span className="text-ink-secondary tabular-nums font-mono">
												{report.skillsTokensUsed.toLocaleString()} /{" "}
												{report.skillsBudgetTokens.toLocaleString()} tokens (
												{formatPercent(report.skillsTokensUsed, report.skillsBudgetTokens)})
											</span>
										</div>
										<div className="h-2 rounded-pill bg-subtle overflow-hidden">
											<div
												className="h-full rounded-pill bg-accent transition-[width] duration-200"
												style={{ width: `${skillsPct > 0 ? Math.max(2, skillsPct) : 0}%` }}
											/>
										</div>
									</div>
								</div>

								<div className="flex flex-col gap-2.5 pt-3.5 border-t border-dashed border-line">
									<div className="flex items-center justify-between gap-3 text-xs">
										<span className="inline-flex items-center gap-2 font-semibold text-ink">
											<span className="size-2 rounded-full bg-info-text shrink-0" aria-hidden="true" />
											Rules（{report.rules.length} 项 · {report.rulesTokensUsed.toLocaleString()} tokens）
										</span>
										<Button variant="inline" size="xs" onClick={() => setShowRulesBreakdown((v) => !v)}>
											{showRulesBreakdown ? "收起明细" : "展开明细"}
										</Button>
									</div>
									{showRulesBreakdown && (
										<div className="flex flex-col gap-2">
											{report.rules.length === 0 ? (
												<p className="m-0 text-xs text-ink-muted">
													未发现 AGENTS.md / CLAUDE.md 规则文件。
												</p>
											) : (
												report.rules.map((rule) => (
													<div
														key={rule.id}
														className="border border-line rounded-md p-3 bg-surface flex flex-col gap-1.5"
													>
														<div className="flex items-center justify-between gap-2.5">
															<div className="flex items-center flex-wrap gap-1.5 text-xs">
																<strong className="text-ink">{rule.fileName}</strong>
																<Badge tone="accent" size="xs">
																	{rule.folderLabel}
																</Badge>
																{rule.mode === "pointer" && (
																	<Badge tone="warn" dot size="xs">
																		已降级为路径指针
																	</Badge>
																)}
																{rule.mode === "disabled" && (
																	<Badge tone="neutral" size="xs">
																		已停用
																	</Badge>
																)}
															</div>
															<div className="inline-flex items-center gap-2 shrink-0">
																<span className="font-mono text-xs text-ink-muted tabular-nums">
																	{rule.tokens.toLocaleString()} tokens
																</span>
																<IconButton
																	variant="ghost"
																	size="xs"
																	aria-label={`复制规则文件路径 ${rule.fileName}`}
																	title="复制规则文件路径"
																	onClick={() =>
																		void copyTextToClipboard(rule.filePath, "规则路径", onNotice)
																	}
																>
																	⧉
																</IconButton>
															</div>
														</div>
														<div className="font-mono text-micro text-ink-muted break-all">
															{rule.filePath}
														</div>
														{rule.preview && (
															<p className="m-0 text-xs text-ink-secondary leading-relaxed line-clamp-2">
																{stripMarkdownFormatting(rule.preview)}
															</p>
														)}
													</div>
												))
											)}
										</div>
									)}
								</div>

								<div className="flex flex-col gap-2.5 pt-3.5 border-t border-dashed border-line">
									<div className="flex items-center justify-between gap-3 text-xs">
										<span className="inline-flex items-center gap-2 font-semibold text-ink">
											<span className="size-2 rounded-full bg-accent shrink-0" aria-hidden="true" />
											Skills（{report.skills.length} 项 · {report.skillsTokensUsed.toLocaleString()} tokens）
										</span>
										<Button variant="inline" size="xs" onClick={() => setShowSkillsBreakdown((v) => !v)}>
											{showSkillsBreakdown ? "收起明细" : "展开明细"}
										</Button>
									</div>
									{showSkillsBreakdown && (
										<div className="flex flex-col gap-2">
											{report.skills.length === 0 ? (
												<p className="m-0 text-xs text-ink-muted">
													未在 .agents/skills 或 .pi/skills 中发现目录级 Skill。
												</p>
											) : (
												report.skills.map((skill) => (
													<div
														key={skill.id}
														className="flex items-center justify-between gap-2.5 px-3 py-2 rounded-md bg-surface border border-line-subtle text-xs"
													>
														<div className="inline-flex items-center gap-2 min-w-0 flex-wrap">
															<span
																className="size-2 rounded-full bg-accent shrink-0"
																aria-hidden="true"
															/>
															<strong className="text-ink">{skill.name}</strong>
															<Badge tone="accent" size="xs">
																{skill.folderLabel}
															</Badge>
															{skill.excluded && (
																<Badge tone="neutral" size="xs">
																	已跳过
																</Badge>
															)}
														</div>
														<span className="font-mono text-xs text-ink-muted tabular-nums shrink-0">
															{skill.tokens.toLocaleString()} tokens
														</span>
													</div>
												))
											)}
										</div>
									)}
								</div>
							</Card>
						) : null}
					</section>
				</div>
			) : (
				<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
					<section className="flex flex-col gap-3">
						<div className="flex items-baseline justify-between gap-3">
							<h3 className="m-0 text-sm font-semibold text-ink">关联事项动态 ({workspaceMatters.length})</h3>
						</div>
						{workspaceMatters.length === 0 ? (
							<EmptyState compact title="该工作区暂无活跃事项。" />
						) : (
							<div className="flex flex-col gap-2">
								{workspaceMatters.slice(0, 15).map((matter) => (
									<button
										type="button"
										key={matter.id}
										className="flex flex-col gap-1.5 w-full p-3 border border-line rounded-lg bg-card text-left cursor-pointer transition-colors hover:border-line-strong hover:bg-hover/40"
										onClick={() => onOpenMatter?.(matter.id)}
									>
										<div className="flex items-center justify-between gap-2.5 text-sm text-ink">
											<strong className="min-w-0 truncate">{matter.title}</strong>
											<Badge tone={MATTER_STATUS_TONE[matter.status]} dot size="xs">
												{MATTER_STATUS_LABEL[matter.status]}
											</Badge>
										</div>
										{matter.summary && (
											<p className="m-0 text-xs text-ink-secondary leading-relaxed line-clamp-2">
												{stripMarkdownFormatting(matter.summary)}
											</p>
										)}
										<div className="flex items-center justify-between gap-2.5 text-micro text-ink-muted">
											<span>{matter.leadMemberId ? memberName(matter.leadMemberId) : "待分配"}</span>
											<span>更新于 {formatClockTime(matter.updatedAt)}</span>
										</div>
									</button>
								))}
							</div>
						)}
					</section>

					<section className="flex flex-col gap-3">
						<div className="flex items-baseline justify-between gap-3">
							<h3 className="m-0 text-sm font-semibold text-ink">工作区空间资料 ({spaceDocs.length})</h3>
							{onOpenSpace && (
								<Button variant="inline" size="xs" onClick={() => onOpenSpace(workspaceSpaceId)}>
									全部资料 →
								</Button>
							)}
						</div>
						{spaceDocs.length === 0 ? (
							<EmptyState compact title="工作区空间中还没有资料文档。" />
						) : (
							<div className="flex flex-col gap-2">
								{spaceDocs.slice(0, 12).map((doc) => (
									<button
										type="button"
										key={doc.id}
										className="flex flex-col gap-1.5 w-full p-3 border border-line rounded-lg bg-card text-left cursor-pointer transition-colors hover:border-line-strong hover:bg-hover/40"
										onClick={() => onOpenSpace?.(doc.id)}
									>
										<div className="flex items-center justify-between gap-2.5 text-sm text-ink">
											<strong className="min-w-0 truncate">{doc.title}</strong>
											<span className="font-mono text-xs text-ink-muted shrink-0">
												rev {doc.revision} · {doc.headCommit.slice(0, 7)}
											</span>
										</div>
										<div className="flex items-center justify-between gap-2.5 text-micro text-ink-muted">
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
