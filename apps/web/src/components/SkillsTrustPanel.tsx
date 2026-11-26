import {
	type ManagedSkillEntryDto,
	type ManagedSkillScriptDetailDto,
	type PiNativeSkillDto,
	SKILL_TRUST_LEVEL_LABELS,
	type SkillTrustLevel,
	type SkillTrustScope,
} from "@pa/contracts/skill-trust";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	fetchManagedSkillDetail,
	fetchManagedSkills,
	fetchPiNativeSkillDetail,
	type OrganizationDto,
	updateSkillTrustPolicy,
	type WorkspaceDto,
} from "../api.ts";
import { MarkdownView } from "../MarkdownView.tsx";
import { ModalDialog } from "../primitives/ModalDialog.tsx";

interface SkillsTrustPanelProps {
	organizations?: OrganizationDto[];
	workspaces?: WorkspaceDto[];
	onNotice?: (message: string) => void;
	onError?: (message: string) => void;
}

type SkillsNavSelection =
	| { kind: "managed_all" }
	| { kind: "managed_scope"; scope: SkillTrustScope; scopeId?: string }
	| { kind: "builtin_all" }
	| { kind: "builtin_source"; source: string }
	| { kind: "pi_all" }
	| { kind: "pi_source"; source: string };

const TRUST_BADGE_CLASS: Record<SkillTrustLevel, string> = {
	confirm: "rsi-status-candidate",
	autonomous: "rsi-status-verified",
	disabled: "rsi-status-rejected",
};

function formatPiSourceLabel(source: string): string {
	if (source === "pa-builtin:role-skills") return "岗位方法 (role-skills)";
	if (source === "pa-builtin:workflow") return "协作工作流";
	if (source === "pa-builtin:self-inspect") return "宿主自检";
	if (source === "local" || source === "auto") return "本机用户";
	if (source.startsWith("git:")) return source.slice("git:".length);
	if (source.startsWith("npm:")) return source.slice("npm:".length);
	return source;
}

function stripScopePrefix(label: string): string {
	return label.replace(/^(工作区|仓库|组织)\s*·\s*/, "");
}

type PreviewTarget =
	| { kind: "managed"; key: string; skill: ManagedSkillEntryDto }
	| { kind: "native"; key: string; skill: PiNativeSkillDto };

interface UnifiedSkillPreviewDetail {
	filePath: string | null;
	content: string;
	truncated?: boolean;
	files: ManagedSkillScriptDetailDto[];
}

function groupSkillPreviewFiles(files: ManagedSkillScriptDetailDto[]) {
	const groups = new Map<string, ManagedSkillScriptDetailDto[]>();
	for (const file of files) {
		const slashIdx = file.path.indexOf("/");
		const group = slashIdx > 0 ? `${file.path.slice(0, slashIdx)}/` : "根目录";
		const list = groups.get(group) ?? [];
		list.push(file);
		groups.set(group, list);
	}
	return [...groups.entries()].map(([group, items]) => ({ group, items }));
}

function splitFrontmatterForMarkdown(raw: string): { frontmatter: string | null; body: string } {
	const match = raw.match(/^(---\r?\n[\s\S]*?\r?\n---)\r?\n?([\s\S]*)$/u);
	if (!match) return { frontmatter: null, body: raw };
	return { frontmatter: match[1]!, body: match[2]!.trimStart() };
}

function skillKey(skill: Pick<ManagedSkillEntryDto, "scope" | "scopeId" | "name">): string {
	return `${skill.scope}:${skill.scopeId}:${skill.name}`;
}

/** Settings → 技能与信任 split-pane panel for PA-managed Skills (Four-Step Trust) and Pi natively discovered Skills. */
export function SkillsTrustPanel({ organizations = [], workspaces = [], onNotice, onError }: SkillsTrustPanelProps) {
	const [skills, setSkills] = useState<ManagedSkillEntryDto[]>([]);
	const [piNativeSkills, setPiNativeSkills] = useState<PiNativeSkillDto[]>([]);
	const [piNativeSkillsError, setPiNativeSkillsError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [selection, setSelection] = useState<SkillsNavSelection>({ kind: "managed_all" });
	const [trustFilter, setTrustFilter] = useState<"all" | SkillTrustLevel>("all");
	const [searchQuery, setSearchQuery] = useState("");
	const [updatingKey, setUpdatingKey] = useState<string | null>(null);

	// Floating preview modal state
	const [previewTarget, setPreviewTarget] = useState<PreviewTarget | null>(null);
	const [previewFileTab, setPreviewFileTab] = useState<string>("SKILL.md");
	const [previewMdMode, setPreviewMdMode] = useState<"rendered" | "raw">("rendered");
	const [detailsByKey, setDetailsByKey] = useState<Record<string, UnifiedSkillPreviewDetail>>({});
	const [loadingDetailKey, setLoadingDetailKey] = useState<string | null>(null);
	const [detailError, setDetailError] = useState<string | null>(null);

	const load = useCallback(async (refresh = false) => {
		setLoading(true);
		setError(null);
		try {
			const res = await fetchManagedSkills({ refresh });
			setSkills(res.skills);
			setPiNativeSkills(res.piNativeSkills ?? []);
			setPiNativeSkillsError(res.piNativeSkillsError ?? null);
		} catch (err: unknown) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load(false);
	}, [load]);

	const groupedManaged = useMemo(() => {
		const wsMap = new Map<string, { scopeId: string; label: string; count: number }>();
		const orgMap = new Map<string, { scopeId: string; label: string; count: number }>();
		for (const ws of workspaces) {
			wsMap.set(ws.id, { scopeId: ws.id, label: ws.name, count: 0 });
		}
		for (const org of organizations) {
			orgMap.set(org.id, { scopeId: org.id, label: org.name, count: 0 });
		}
		let personalCount = 0;
		let globalCount = 0;
		for (const item of skills) {
			if (item.scope === "workspace") {
				const existing = wsMap.get(item.scopeId);
				if (existing) existing.count += 1;
				else
					wsMap.set(item.scopeId, {
						scopeId: item.scopeId,
						label: stripScopePrefix(item.scopeLabel),
						count: 1,
					});
			} else if (item.scope === "org") {
				const existing = orgMap.get(item.scopeId);
				if (existing) existing.count += 1;
				else
					orgMap.set(item.scopeId, { scopeId: item.scopeId, label: stripScopePrefix(item.scopeLabel), count: 1 });
			} else if (item.scope === "personal") {
				personalCount += 1;
			} else if (item.scope === "global") {
				globalCount += 1;
			}
		}
		return {
			workspaces: Array.from(wsMap.values()).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
			orgs: Array.from(orgMap.values()).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
			personalCount,
			globalCount,
		};
	}, [skills, organizations, workspaces]);

	const { builtinSkills, hostPiSkills } = useMemo(() => {
		const builtin: PiNativeSkillDto[] = [];
		const host: PiNativeSkillDto[] = [];
		for (const item of piNativeSkills) {
			if (item.source.startsWith("pa-builtin:")) builtin.push(item);
			else host.push(item);
		}
		return { builtinSkills: builtin, hostPiSkills: host };
	}, [piNativeSkills]);

	const builtinSources = useMemo(() => {
		const counts = new Map<string, number>();
		for (const item of builtinSkills) {
			counts.set(item.source, (counts.get(item.source) ?? 0) + 1);
		}
		return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
	}, [builtinSkills]);

	const piSources = useMemo(() => {
		const counts = new Map<string, number>();
		for (const item of hostPiSkills) {
			counts.set(item.source, (counts.get(item.source) ?? 0) + 1);
		}
		return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
	}, [hostPiSkills]);

	const isReadOnlyPiView =
		selection.kind === "builtin_all" ||
		selection.kind === "builtin_source" ||
		selection.kind === "pi_all" ||
		selection.kind === "pi_source";

	const visibleManagedSkills = useMemo(() => {
		if (isReadOnlyPiView) return [];
		const q = searchQuery.trim().toLowerCase();
		return skills.filter((item) => {
			if (selection.kind === "managed_scope") {
				if (item.scope !== selection.scope) return false;
				if (selection.scopeId !== undefined && item.scopeId !== selection.scopeId) return false;
			}
			if (trustFilter !== "all" && item.trustLevel !== trustFilter) return false;
			if (!q) return true;
			return (
				item.name.toLowerCase().includes(q) ||
				item.description.toLowerCase().includes(q) ||
				item.scopeLabel.toLowerCase().includes(q) ||
				item.scripts.some((s) => s.toLowerCase().includes(q))
			);
		});
	}, [skills, selection, isReadOnlyPiView, trustFilter, searchQuery]);

	const visiblePiSkills = useMemo(() => {
		if (!isReadOnlyPiView) return [];
		const pool =
			selection.kind === "builtin_all" || selection.kind === "builtin_source" ? builtinSkills : hostPiSkills;
		const q = searchQuery.trim().toLowerCase();
		return pool.filter((item) => {
			if (selection.kind === "builtin_source" && item.source !== selection.source) return false;
			if (selection.kind === "pi_source" && item.source !== selection.source) return false;
			if (!q) return true;
			return (
				item.name.toLowerCase().includes(q) ||
				item.description.toLowerCase().includes(q) ||
				item.source.toLowerCase().includes(q)
			);
		});
	}, [builtinSkills, hostPiSkills, selection, isReadOnlyPiView, searchQuery]);

	const activeHeading = useMemo(() => {
		if (selection.kind === "managed_all") {
			return {
				title: "全部 PA 托管技能",
				subtitle: "通过 propose_skill 沉淀在工作区、组织、个人或全局作用域的标准 Skill 与脚本信任策略",
			};
		}
		if (selection.kind === "managed_scope") {
			if (selection.scope === "workspace") {
				const target = groupedManaged.workspaces.find((w) => w.scopeId === selection.scopeId);
				return {
					title: target ? `工作区 · ${target.label}` : "工作区技能",
					subtitle:
						"来自 PA 工作区专属目录（.data/skills/workspaces/<id>/）以及工作区主目录/关联目录的 .agents/skills、.pi/skills，脚本默认步骤 3 执行前确认",
				};
			}
			if (selection.scope === "org") {
				const target = groupedManaged.orgs.find((o) => o.scopeId === selection.scopeId);
				return {
					title: target ? `组织 · ${target.label}` : "组织共享技能",
					subtitle: "组织内共享的受管 Skill，仅组织管理员可调整脚本信任策略",
				};
			}
			if (selection.scope === "personal") {
				return {
					title: "个人技能",
					subtitle: "仅当前账号可见与使用的私有 Skill",
				};
			}
			return {
				title: "平台全局技能",
				subtitle: "平台级共享 Skill，由超级管理员维护信任策略",
			};
		}
		if (selection.kind === "builtin_all") {
			return {
				title: "PA 内置技能（只读）",
				subtitle: "随 PA 启动自动挂载到 Pi 的岗位方法（pi-extensions/role-skills）、协作工作流与宿主自检技能",
			};
		}
		if (selection.kind === "builtin_source") {
			return {
				title: `PA 内置 · ${formatPiSourceLabel(selection.source)}`,
				subtitle: "由 Pi RPC get_commands 直接回报的 PA 内置技能，随角色按需读取",
			};
		}
		if (selection.kind === "pi_source") {
			return {
				title: `Pi 原生发现 · ${formatPiSourceLabel(selection.source)}`,
				subtitle: "由本机 Pi RPC get_commands 直接回报，PA 不重复扫描，仅只读展示",
			};
		}
		return {
			title: "全部 Pi 原生发现技能（只读）",
			subtitle: "由本机 Pi RPC get_commands 直接回报（含 ~/.agents/skills、~/.pi/agent/skills 及已启用 Pi 包）",
		};
	}, [selection, groupedManaged]);

	const handleOpenPreview = async (skill: ManagedSkillEntryDto) => {
		const key = `managed:${skillKey(skill)}`;
		setPreviewTarget({ kind: "managed", key, skill });
		setPreviewFileTab("SKILL.md");
		setPreviewMdMode("rendered");
		setDetailError(null);
		if (detailsByKey[key]) return;
		setLoadingDetailKey(key);
		try {
			const { detail } = await fetchManagedSkillDetail({
				scope: skill.scope,
				scopeId: skill.scopeId,
				skillName: skill.name,
			});
			setDetailsByKey((prev) => ({
				...prev,
				[key]: {
					filePath: detail.filePath,
					content: detail.content,
					truncated: detail.truncated,
					files: detail.files ?? detail.scripts,
				},
			}));
		} catch (err: unknown) {
			setDetailError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoadingDetailKey(null);
		}
	};

	const handleOpenNativePreview = async (skill: PiNativeSkillDto) => {
		const key = `native:${skill.source}:${skill.name}`;
		setPreviewTarget({ kind: "native", key, skill });
		setPreviewFileTab("SKILL.md");
		setPreviewMdMode("rendered");
		setDetailError(null);
		if (detailsByKey[key]) return;
		setLoadingDetailKey(key);
		try {
			const { detail } = await fetchPiNativeSkillDetail({
				name: skill.name,
				source: skill.source,
			});
			setDetailsByKey((prev) => ({
				...prev,
				[key]: {
					filePath: detail.filePath,
					content: detail.content,
					truncated: detail.truncated,
					files: detail.files,
				},
			}));
		} catch (err: unknown) {
			setDetailError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoadingDetailKey(null);
		}
	};

	const handleSetTrust = async (skill: ManagedSkillEntryDto, trustLevel: SkillTrustLevel) => {
		const key = skillKey(skill);
		if (updatingKey) return;
		setUpdatingKey(key);
		try {
			await updateSkillTrustPolicy({
				scope: skill.scope,
				scopeId: skill.scopeId,
				skillName: skill.name,
				trustLevel,
			});
			onNotice?.(`已将 Skill「${skill.name}」设为「${SKILL_TRUST_LEVEL_LABELS[trustLevel]}」`);
			if (previewTarget?.kind === "managed" && skillKey(previewTarget.skill) === key) {
				setPreviewTarget({ ...previewTarget, skill: { ...previewTarget.skill, trustLevel } });
			}
			await load(false);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			onError?.(msg);
		} finally {
			setUpdatingKey(null);
		}
	};

	const activePreviewKey = previewTarget?.key ?? null;
	const activePreviewDetail = activePreviewKey ? detailsByKey[activePreviewKey] : null;
	const activePreviewManaged = previewTarget?.kind === "managed" ? previewTarget.skill : null;
	const activePreviewBusy = activePreviewManaged ? updatingKey === skillKey(activePreviewManaged) : false;
	const activePreviewFileGroups = useMemo(
		() => (activePreviewDetail ? groupSkillPreviewFiles(activePreviewDetail.files) : []),
		[activePreviewDetail],
	);
	const activeFileEntry = useMemo(() => {
		if (!activePreviewDetail) return null;
		if (previewFileTab === "SKILL.md") {
			return {
				path: "SKILL.md",
				content: activePreviewDetail.content,
				truncated: activePreviewDetail.truncated,
			};
		}
		return activePreviewDetail.files.find((file) => file.path === previewFileTab) ?? null;
	}, [activePreviewDetail, previewFileTab]);
	const activeFileIsMarkdown = Boolean(activeFileEntry && /\.md$/i.test(activeFileEntry.path));

	const isSelected = (candidate: SkillsNavSelection): boolean => {
		if (selection.kind !== candidate.kind) return false;
		if (selection.kind === "managed_scope" && candidate.kind === "managed_scope") {
			return selection.scope === candidate.scope && selection.scopeId === candidate.scopeId;
		}
		if (selection.kind === "builtin_source" && candidate.kind === "builtin_source") {
			return selection.source === candidate.source;
		}
		if (selection.kind === "pi_source" && candidate.kind === "pi_source") {
			return selection.source === candidate.source;
		}
		return true;
	};

	return (
		<section className="ui-section">
			<div className="ui-section-head">
				<div>
					<h2 className="ui-section-title">技能与信任（信任四步）</h2>
					<p className="ui-section-desc">
						左栏按 PA 作用域与 Pi 原生来源分栏浏览；所有 Skill 本体保存在磁盘，点击任意 PA 托管技能可浮窗预览{" "}
						<code>SKILL.md</code> 与脚本并管理信任策略。
					</p>
				</div>
				<button
					type="button"
					className="btn-pill-outline btn-xs"
					onClick={() => void load(true)}
					disabled={loading}
				>
					{loading ? "扫描中…" : "重新扫描"}
				</button>
			</div>

			{error && (
				<div className="approval-card" role="alert">
					读取 Skill 列表失败：{error}
				</div>
			)}

			<div className="skills-split-layout">
				<aside className="skills-split-nav" aria-label="技能范围与来源导航">
					<div className="skills-nav-group">
						<div className="skills-nav-group-label">PA 托管 · 信任四步</div>
						<button
							type="button"
							className={`skills-nav-item ${isSelected({ kind: "managed_all" }) ? "active" : ""}`}
							onClick={() => setSelection({ kind: "managed_all" })}
						>
							<span className="skills-nav-item-name">全部托管技能</span>
							<span className="skills-nav-count">{skills.length}</span>
						</button>
					</div>

					<div className="skills-nav-group">
						<div className="skills-nav-group-label">工作区技能</div>
						{groupedManaged.workspaces.length === 0 ? (
							<div className="skills-nav-empty">暂无可见工作区</div>
						) : (
							groupedManaged.workspaces.map((ws) => (
								<button
									key={ws.scopeId}
									type="button"
									className={`skills-nav-item ${isSelected({ kind: "managed_scope", scope: "workspace", scopeId: ws.scopeId }) ? "active" : ""}`}
									onClick={() =>
										setSelection({ kind: "managed_scope", scope: "workspace", scopeId: ws.scopeId })
									}
									title={ws.label}
								>
									<span className="skills-nav-item-name">{ws.label}</span>
									<span className="skills-nav-count">{ws.count}</span>
								</button>
							))
						)}
					</div>

					<div className="skills-nav-group">
						<div className="skills-nav-group-label">组织技能</div>
						{groupedManaged.orgs.length === 0 ? (
							<div className="skills-nav-empty">暂无可见组织</div>
						) : (
							groupedManaged.orgs.map((org) => (
								<button
									key={org.scopeId}
									type="button"
									className={`skills-nav-item ${isSelected({ kind: "managed_scope", scope: "org", scopeId: org.scopeId }) ? "active" : ""}`}
									onClick={() => setSelection({ kind: "managed_scope", scope: "org", scopeId: org.scopeId })}
									title={org.label}
								>
									<span className="skills-nav-item-name">{org.label}</span>
									<span className="skills-nav-count">{org.count}</span>
								</button>
							))
						)}
					</div>

					<div className="skills-nav-group">
						<div className="skills-nav-group-label">个人 / 全局</div>
						<button
							type="button"
							className={`skills-nav-item ${isSelected({ kind: "managed_scope", scope: "personal" }) ? "active" : ""}`}
							onClick={() => setSelection({ kind: "managed_scope", scope: "personal" })}
						>
							<span className="skills-nav-item-name">个人技能</span>
							<span className="skills-nav-count">{groupedManaged.personalCount}</span>
						</button>
						<button
							type="button"
							className={`skills-nav-item ${isSelected({ kind: "managed_scope", scope: "global" }) ? "active" : ""}`}
							onClick={() => setSelection({ kind: "managed_scope", scope: "global" })}
						>
							<span className="skills-nav-item-name">平台全局</span>
							<span className="skills-nav-count">{groupedManaged.globalCount}</span>
						</button>
					</div>

					<div className="skills-nav-divider" />

					<div className="skills-nav-group">
						<div className="skills-nav-group-label">PA 内置技能（只读）</div>
						<button
							type="button"
							className={`skills-nav-item ${isSelected({ kind: "builtin_all" }) ? "active" : ""}`}
							onClick={() => setSelection({ kind: "builtin_all" })}
						>
							<span className="skills-nav-item-name">全部内置技能</span>
							<span className="skills-nav-count">{builtinSkills.length}</span>
						</button>
						{builtinSources.map(([src, count]) => (
							<button
								key={src}
								type="button"
								className={`skills-nav-item ${isSelected({ kind: "builtin_source", source: src }) ? "active" : ""}`}
								onClick={() => setSelection({ kind: "builtin_source", source: src })}
								title={src}
							>
								<span className="skills-nav-item-name">{formatPiSourceLabel(src)}</span>
								<span className="skills-nav-count">{count}</span>
							</button>
						))}
					</div>

					<div className="skills-nav-divider" />

					<div className="skills-nav-group">
						<div className="skills-nav-group-label">Pi 原生发现（只读）</div>
						<button
							type="button"
							className={`skills-nav-item ${isSelected({ kind: "pi_all" }) ? "active" : ""}`}
							onClick={() => setSelection({ kind: "pi_all" })}
						>
							<span className="skills-nav-item-name">全部 Pi 原生</span>
							<span className="skills-nav-count">{hostPiSkills.length}</span>
						</button>
						{piSources.map(([src, count]) => (
							<button
								key={src}
								type="button"
								className={`skills-nav-item ${isSelected({ kind: "pi_source", source: src }) ? "active" : ""}`}
								onClick={() => setSelection({ kind: "pi_source", source: src })}
								title={src}
							>
								<span className="skills-nav-item-name">{formatPiSourceLabel(src)}</span>
								<span className="skills-nav-count">{count}</span>
							</button>
						))}
					</div>
				</aside>

				<div className="skills-split-main">
					<div className="skills-main-toolbar">
						<div>
							<h3 className="skills-main-title">{activeHeading.title}</h3>
							<p className="muted-tiny" style={{ margin: "2px 0 0" }}>
								{activeHeading.subtitle}
							</p>
						</div>
						<div className="skills-main-filters">
							<input
								type="search"
								className="input-field skills-search-input"
								placeholder="搜索技能名称或描述…"
								value={searchQuery}
								onChange={(e) => setSearchQuery(e.target.value)}
							/>
							{!isReadOnlyPiView && (
								<div className="actions-row compact">
									{(
										[
											["all", "全部"],
											["confirm", "步骤 3 · 确认"],
											["autonomous", "步骤 4 · 自主"],
											["disabled", "已停用"],
										] as const
									).map(([id, label]) => (
										<button
											key={id}
											type="button"
											className={`choice-chip ${trustFilter === id ? "active" : ""}`}
											onClick={() => setTrustFilter(id)}
										>
											{label}
										</button>
									))}
								</div>
							)}
						</div>
					</div>

					{isReadOnlyPiView ? (
						<>
							{piNativeSkillsError && (
								<div className="approval-card" role="alert">
									查询 Pi 原生技能失败：{piNativeSkillsError}
								</div>
							)}
							{!loading && !piNativeSkillsError && visiblePiSkills.length === 0 ? (
								<div className="ui-card">
									<p className="muted-tiny">
										{piNativeSkills.length === 0
											? "当前 Pi 运行环境未回报原生 Skill（团队模式需设置 PA_LOCAL_PI_RESOURCES=1 才会加载宿主机 Pi 安装包）。"
											: "没有匹配搜索条件的 Pi 原生技能。"}
									</p>
								</div>
							) : (
								<div className="skills-card-list">
									{visiblePiSkills.map((item) => (
										<div key={`${item.source}:${item.name}`} className="ui-card compact skills-item-card">
											<div className="banner-row">
												<div className="row-wrap-gap">
													<strong>{item.name}</strong>
													<span className="pill">{formatPiSourceLabel(item.source)}</span>
												</div>
												<span className="muted-tiny">
													{item.source.startsWith("pa-builtin:")
														? "PA 内置"
														: item.origin === "package"
															? "Pi 包"
															: "用户级"}
												</span>
											</div>
											{item.description && <p className="muted-tiny skills-item-desc">{item.description}</p>}
											<div className="skills-item-footer">
												<span className="skills-item-path mono-wrap" title={item.filePath ?? ""}>
													{item.filePath ?? ""}
												</span>
												{item.filePath && (
													<div className="skills-item-actions">
														<button
															type="button"
															className="btn-pill-outline btn-xs"
															onClick={() => void handleOpenNativePreview(item)}
														>
															查看内容
														</button>
													</div>
												)}
											</div>
										</div>
									))}
								</div>
							)}
						</>
					) : !loading && visibleManagedSkills.length === 0 ? (
						<div className="ui-card">
							<p className="muted-tiny">
								当前筛选条件下暂无已沉淀的 PA 托管 Skill。在事项对话中完成可复用流程后，可让角色调用{" "}
								<code>propose_skill</code> 生成确认卡并落盘；也可以点击左栏「Pi 原生发现（只读）」查看宿主机 Pi
								已发现的 {piNativeSkills.length} 个技能。
							</p>
						</div>
					) : (
						<div className="skills-card-list">
							{visibleManagedSkills.map((skill) => {
								const key = skillKey(skill);
								const busy = updatingKey === key;
								return (
									<div key={key} className="ui-card compact skills-item-card">
										<div className="banner-row">
											<div className="row-wrap-gap">
												<strong>{skill.name}</strong>
												<span className="pill">{skill.scopeLabel}</span>
												<span className={`pill ${TRUST_BADGE_CLASS[skill.trustLevel]}`}>
													{SKILL_TRUST_LEVEL_LABELS[skill.trustLevel]}
												</span>
											</div>
											<span className="muted-tiny">
												{skill.runCount > 0 ? `已执行 ${skill.runCount} 次` : "尚未触发脚本"}
											</span>
										</div>
										<p className="muted-tiny skills-item-desc">{skill.description}</p>
										{skill.scripts.length > 0 && (
											<div className="tag-list">
												{skill.scripts.map((script) => (
													<span key={script} className="tag-chip skill">
														{script}
													</span>
												))}
											</div>
										)}
										<div className="skills-item-footer">
											<span className="skills-item-path mono-wrap" title={skill.filePath}>
												{skill.filePath}
											</span>
											<div className="skills-item-actions">
												<button
													type="button"
													className="btn-pill-outline btn-xs"
													onClick={() => void handleOpenPreview(skill)}
												>
													{skill.scripts.length > 0
														? `查看内容 (${skill.scripts.length + 1})`
														: "查看 SKILL.md"}
												</button>
												{skill.canManage && skill.trustLevel !== "autonomous" && (
													<button
														type="button"
														className="btn-pill-dark btn-xs"
														disabled={busy}
														onClick={() => void handleSetTrust(skill, "autonomous")}
													>
														升级为自主执行
													</button>
												)}
												{skill.canManage && skill.trustLevel !== "confirm" && (
													<button
														type="button"
														className="btn-pill-outline btn-xs"
														disabled={busy}
														onClick={() => void handleSetTrust(skill, "confirm")}
													>
														设为执行前确认
													</button>
												)}
												{skill.canManage && skill.trustLevel !== "disabled" && (
													<button
														type="button"
														className="btn-inline"
														disabled={busy}
														onClick={() => void handleSetTrust(skill, "disabled")}
													>
														停用脚本
													</button>
												)}
											</div>
										</div>
									</div>
								);
							})}
						</div>
					)}
				</div>
			</div>

			<ModalDialog
				open={Boolean(previewTarget)}
				title={previewTarget ? previewTarget.skill.name : ""}
				subtitle={
					previewTarget
						? previewTarget.kind === "managed"
							? `${previewTarget.skill.scopeLabel} · ${previewTarget.skill.filePath}`
							: `${formatPiSourceLabel(previewTarget.skill.source)}${previewTarget.skill.filePath ? ` · ${previewTarget.skill.filePath}` : ""}`
						: undefined
				}
				size="lg"
				headerExtra={
					activePreviewManaged ? (
						<span className={`pill ${TRUST_BADGE_CLASS[activePreviewManaged.trustLevel]}`}>
							{SKILL_TRUST_LEVEL_LABELS[activePreviewManaged.trustLevel]}
						</span>
					) : previewTarget?.kind === "native" ? (
						<span className="pill">只读预览</span>
					) : null
				}
				onClose={() => setPreviewTarget(null)}
				footer={
					previewTarget ? (
						<>
							{activePreviewManaged?.canManage && activePreviewManaged.trustLevel !== "autonomous" && (
								<button
									type="button"
									className="btn-pill-dark btn-xs"
									disabled={activePreviewBusy}
									onClick={() => void handleSetTrust(activePreviewManaged, "autonomous")}
								>
									升级为自主执行
								</button>
							)}
							{activePreviewManaged?.canManage && activePreviewManaged.trustLevel !== "confirm" && (
								<button
									type="button"
									className="btn-pill-outline btn-xs"
									disabled={activePreviewBusy}
									onClick={() => void handleSetTrust(activePreviewManaged, "confirm")}
								>
									设为执行前确认
								</button>
							)}
							{activePreviewManaged?.canManage && activePreviewManaged.trustLevel !== "disabled" && (
								<button
									type="button"
									className="btn-inline"
									disabled={activePreviewBusy}
									onClick={() => void handleSetTrust(activePreviewManaged, "disabled")}
								>
									停用脚本
								</button>
							)}
							<button type="button" className="btn-pill-outline btn-xs" onClick={() => setPreviewTarget(null)}>
								关闭
							</button>
						</>
					) : undefined
				}
			>
				{loadingDetailKey === activePreviewKey ? (
					<p className="muted-sm">正在读取 Skill 目录与文件内容…</p>
				) : detailError ? (
					<div className="approval-card" role="alert">
						读取失败：{detailError}
					</div>
				) : activePreviewDetail ? (
					<div className="skills-preview-split">
						<aside className="skills-preview-nav" aria-label="Skill 目录文件">
							<div className="skills-preview-group">
								<span className="skills-preview-group-label">入口定义</span>
								<button
									type="button"
									className={`skills-preview-file-btn ${previewFileTab === "SKILL.md" ? "active" : ""}`}
									onClick={() => setPreviewFileTab("SKILL.md")}
									title="SKILL.md"
								>
									<span>SKILL.md</span>
								</button>
							</div>
							{activePreviewFileGroups.map(({ group, items }) => (
								<div key={group} className="skills-preview-group">
									<span className="skills-preview-group-label">
										{group} ({items.length})
									</span>
									{items.map((file) => {
										const displayName = file.path.includes("/")
											? file.path.slice(file.path.indexOf("/") + 1)
											: file.path;
										return (
											<button
												key={file.path}
												type="button"
												className={`skills-preview-file-btn ${previewFileTab === file.path ? "active" : ""}`}
												onClick={() => setPreviewFileTab(file.path)}
												title={file.path}
											>
												<span>{displayName}</span>
											</button>
										);
									})}
								</div>
							))}
						</aside>
						<div className="skills-preview-content">
							<div className="skills-preview-filebar">
								<div className="row-wrap-gap">
									<code className="skills-preview-filepath">{activeFileEntry?.path ?? previewFileTab}</code>
									{activeFileEntry?.truncated && <span className="pill">已截断至 64KB</span>}
								</div>
								{activeFileIsMarkdown && (
									<div className="skills-preview-mode-toggle" role="tablist" aria-label="查看模式">
										<button
											type="button"
											role="tab"
											aria-selected={previewMdMode === "rendered"}
											className={`choice-chip ${previewMdMode === "rendered" ? "active" : ""}`}
											onClick={() => setPreviewMdMode("rendered")}
										>
											渲染
										</button>
										<button
											type="button"
											role="tab"
											aria-selected={previewMdMode === "raw"}
											className={`choice-chip ${previewMdMode === "raw" ? "active" : ""}`}
											onClick={() => setPreviewMdMode("raw")}
										>
											源码
										</button>
									</div>
								)}
							</div>
							<div className="skills-preview-viewer">
								{activeFileIsMarkdown && previewMdMode === "rendered" ? (
									(() => {
										const split = splitFrontmatterForMarkdown(activeFileEntry?.content ?? "");
										return (
											<div className="skills-preview-markdown">
												{split.frontmatter && (
													<pre className="pa-viz-code skills-modal-code" style={{ marginBottom: 14 }}>
														<code>{split.frontmatter}</code>
													</pre>
												)}
												<MarkdownView content={split.body} />
											</div>
										);
									})()
								) : (
									<pre className="pa-viz-code skills-modal-code">
										<code>{activeFileEntry?.content ?? ""}</code>
									</pre>
								)}
							</div>
						</div>
					</div>
				) : null}
			</ModalDialog>
		</section>
	);
}
