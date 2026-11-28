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
import {
	Badge,
	type BadgeTone,
	Banner,
	Button,
	Card,
	EmptyState,
	Input,
	ModalDialog,
	SplitPane,
	Tabs,
} from "../primitives/index.ts";
import { cn } from "../utils/cn.ts";

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

const TRUST_BADGE_TONES: Record<SkillTrustLevel, BadgeTone> = {
	confirm: "warn",
	autonomous: "success",
	disabled: "danger",
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

const NAV_ITEM_BASE =
	"flex items-center justify-between gap-2 w-full px-2.5 py-1.5 rounded-sm text-xs text-left cursor-pointer transition-colors border-l-2 focus-visible:outline-2 focus-visible:outline-accent";
const NAV_ITEM_ACTIVE = "bg-subtle text-ink font-semibold border-accent";
const NAV_ITEM_IDLE = "bg-transparent text-ink-secondary border-transparent hover:bg-subtle hover:text-ink";

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

	const navSidebar = (
		<nav
			aria-label="技能范围与来源导航"
			className="lg:sticky lg:top-3 flex flex-col gap-3 pb-3 lg:pb-0 lg:pr-3 border-b lg:border-b-0 lg:border-r border-line lg:max-h-[calc(100vh-180px)] overflow-y-auto"
		>
			<div className="flex flex-col gap-0.5">
				<div className="text-micro font-semibold text-ink-muted px-2 pt-0.5 pb-1">PA 托管 · 信任四步</div>
				<button
					type="button"
					className={cn(NAV_ITEM_BASE, isSelected({ kind: "managed_all" }) ? NAV_ITEM_ACTIVE : NAV_ITEM_IDLE)}
					onClick={() => setSelection({ kind: "managed_all" })}
				>
					<span className="min-w-0 truncate">全部托管技能</span>
					<span className="shrink-0 text-micro text-ink-muted tabular-nums">{skills.length}</span>
				</button>
			</div>

			<div className="flex flex-col gap-0.5">
				<div className="text-micro font-semibold text-ink-muted px-2 pt-0.5 pb-1">工作区技能</div>
				{groupedManaged.workspaces.length === 0 ? (
					<div className="px-2.5 py-1 text-micro text-ink-muted">暂无可见工作区</div>
				) : (
					groupedManaged.workspaces.map((ws) => (
						<button
							key={ws.scopeId}
							type="button"
							className={cn(
								NAV_ITEM_BASE,
								isSelected({ kind: "managed_scope", scope: "workspace", scopeId: ws.scopeId })
									? NAV_ITEM_ACTIVE
									: NAV_ITEM_IDLE,
							)}
							onClick={() => setSelection({ kind: "managed_scope", scope: "workspace", scopeId: ws.scopeId })}
							title={ws.label}
						>
							<span className="min-w-0 truncate">{ws.label}</span>
							<span className="shrink-0 text-micro text-ink-muted tabular-nums">{ws.count}</span>
						</button>
					))
				)}
			</div>

			<div className="flex flex-col gap-0.5">
				<div className="text-micro font-semibold text-ink-muted px-2 pt-0.5 pb-1">组织技能</div>
				{groupedManaged.orgs.length === 0 ? (
					<div className="px-2.5 py-1 text-micro text-ink-muted">暂无可见组织</div>
				) : (
					groupedManaged.orgs.map((org) => (
						<button
							key={org.scopeId}
							type="button"
							className={cn(
								NAV_ITEM_BASE,
								isSelected({ kind: "managed_scope", scope: "org", scopeId: org.scopeId })
									? NAV_ITEM_ACTIVE
									: NAV_ITEM_IDLE,
							)}
							onClick={() => setSelection({ kind: "managed_scope", scope: "org", scopeId: org.scopeId })}
							title={org.label}
						>
							<span className="min-w-0 truncate">{org.label}</span>
							<span className="shrink-0 text-micro text-ink-muted tabular-nums">{org.count}</span>
						</button>
					))
				)}
			</div>

			<div className="flex flex-col gap-0.5">
				<div className="text-micro font-semibold text-ink-muted px-2 pt-0.5 pb-1">个人 / 全局</div>
				<button
					type="button"
					className={cn(
						NAV_ITEM_BASE,
						isSelected({ kind: "managed_scope", scope: "personal" }) ? NAV_ITEM_ACTIVE : NAV_ITEM_IDLE,
					)}
					onClick={() => setSelection({ kind: "managed_scope", scope: "personal" })}
				>
					<span className="min-w-0 truncate">个人技能</span>
					<span className="shrink-0 text-micro text-ink-muted tabular-nums">{groupedManaged.personalCount}</span>
				</button>
				<button
					type="button"
					className={cn(
						NAV_ITEM_BASE,
						isSelected({ kind: "managed_scope", scope: "global" }) ? NAV_ITEM_ACTIVE : NAV_ITEM_IDLE,
					)}
					onClick={() => setSelection({ kind: "managed_scope", scope: "global" })}
				>
					<span className="min-w-0 truncate">平台全局</span>
					<span className="shrink-0 text-micro text-ink-muted tabular-nums">{groupedManaged.globalCount}</span>
				</button>
			</div>

			<div className="h-px bg-line mx-1" />

			<div className="flex flex-col gap-0.5">
				<div className="text-micro font-semibold text-ink-muted px-2 pt-0.5 pb-1">PA 内置技能（只读）</div>
				<button
					type="button"
					className={cn(NAV_ITEM_BASE, isSelected({ kind: "builtin_all" }) ? NAV_ITEM_ACTIVE : NAV_ITEM_IDLE)}
					onClick={() => setSelection({ kind: "builtin_all" })}
				>
					<span className="min-w-0 truncate">全部内置技能</span>
					<span className="shrink-0 text-micro text-ink-muted tabular-nums">{builtinSkills.length}</span>
				</button>
				{builtinSources.map(([src, count]) => (
					<button
						key={src}
						type="button"
						className={cn(
							NAV_ITEM_BASE,
							isSelected({ kind: "builtin_source", source: src }) ? NAV_ITEM_ACTIVE : NAV_ITEM_IDLE,
						)}
						onClick={() => setSelection({ kind: "builtin_source", source: src })}
						title={src}
					>
						<span className="min-w-0 truncate">{formatPiSourceLabel(src)}</span>
						<span className="shrink-0 text-micro text-ink-muted tabular-nums">{count}</span>
					</button>
				))}
			</div>

			<div className="h-px bg-line mx-1" />

			<div className="flex flex-col gap-0.5">
				<div className="text-micro font-semibold text-ink-muted px-2 pt-0.5 pb-1">Pi 原生发现（只读）</div>
				<button
					type="button"
					className={cn(NAV_ITEM_BASE, isSelected({ kind: "pi_all" }) ? NAV_ITEM_ACTIVE : NAV_ITEM_IDLE)}
					onClick={() => setSelection({ kind: "pi_all" })}
				>
					<span className="min-w-0 truncate">全部 Pi 原生</span>
					<span className="shrink-0 text-micro text-ink-muted tabular-nums">{hostPiSkills.length}</span>
				</button>
				{piSources.map(([src, count]) => (
					<button
						key={src}
						type="button"
						className={cn(
							NAV_ITEM_BASE,
							isSelected({ kind: "pi_source", source: src }) ? NAV_ITEM_ACTIVE : NAV_ITEM_IDLE,
						)}
						onClick={() => setSelection({ kind: "pi_source", source: src })}
						title={src}
					>
						<span className="min-w-0 truncate">{formatPiSourceLabel(src)}</span>
						<span className="shrink-0 text-micro text-ink-muted tabular-nums">{count}</span>
					</button>
				))}
			</div>
		</nav>
	);

	return (
		<section className="flex flex-col gap-3">
			<div className="flex items-start justify-between gap-3 flex-wrap">
				<div className="min-w-0 flex-1">
					<h2 className="m-0 text-md font-semibold text-ink">技能与信任（信任四步）</h2>
					<p className="mt-1 mb-0 text-xs text-ink-muted leading-normal">
						左栏按 PA 作用域与 Pi 原生来源分栏浏览；所有 Skill 本体保存在磁盘，点击任意 PA 托管技能可浮窗预览{" "}
						<code className="font-mono text-xs bg-subtle px-1 py-0.5 rounded-xs">SKILL.md</code>{" "}
						与脚本并管理信任策略。
					</p>
				</div>
				<Button variant="secondary" size="xs" onClick={() => void load(true)} disabled={loading}>
					{loading ? "扫描中…" : "重新扫描"}
				</Button>
			</div>

			{error && <Banner tone="danger">读取 Skill 列表失败：{error}</Banner>}

			<SplitPane sidebar={navSidebar} sidebarWidth="240px">
				<div className="flex flex-col gap-3 min-w-0">
					<div className="flex flex-col gap-2.5 pb-2.5 border-b border-line">
						<div>
							<h3 className="m-0 text-md font-semibold text-ink">{activeHeading.title}</h3>
							<p className="mt-0.5 mb-0 text-micro text-ink-muted leading-normal">{activeHeading.subtitle}</p>
						</div>
						<div className="flex items-center gap-2.5 flex-wrap">
							<Input
								type="search"
								size="sm"
								className="flex-1 min-w-[200px] max-w-[280px]"
								placeholder="搜索技能名称或描述…"
								value={searchQuery}
								onChange={(e) => setSearchQuery(e.target.value)}
							/>
							{!isReadOnlyPiView && (
								<Tabs
									variant="pill"
									size="sm"
									ariaLabel="信任级别筛选"
									value={trustFilter}
									onChange={(id) => setTrustFilter(id as "all" | SkillTrustLevel)}
									items={[
										{ id: "all", label: "全部" },
										{ id: "confirm", label: "步骤 3 · 确认" },
										{ id: "autonomous", label: "步骤 4 · 自主" },
										{ id: "disabled", label: "已停用" },
									]}
								/>
							)}
						</div>
					</div>

					{isReadOnlyPiView ? (
						<>
							{piNativeSkillsError && <Banner tone="danger">查询 Pi 原生技能失败：{piNativeSkillsError}</Banner>}
							{!loading && !piNativeSkillsError && visiblePiSkills.length === 0 ? (
								<EmptyState
									compact
									title={
										piNativeSkills.length === 0
											? "当前 Pi 运行环境未回报原生 Skill"
											: "没有匹配搜索条件的 Pi 原生技能"
									}
									description={
										piNativeSkills.length === 0
											? "团队模式需设置 PA_LOCAL_PI_RESOURCES=1 才会加载宿主机 Pi 安装包。"
											: undefined
									}
								/>
							) : (
								<div className="flex flex-col gap-2">
									{visiblePiSkills.map((item) => (
										<Card key={`${item.source}:${item.name}`} padding="sm" className="flex flex-col gap-1.5">
											<div className="flex items-center justify-between gap-2 flex-wrap">
												<div className="flex items-center gap-2 flex-wrap min-w-0">
													<strong className="text-sm font-semibold text-ink">{item.name}</strong>
													<Badge tone="neutral">{formatPiSourceLabel(item.source)}</Badge>
												</div>
												<span className="text-micro text-ink-muted">
													{item.source.startsWith("pa-builtin:")
														? "PA 内置"
														: item.origin === "package"
															? "Pi 包"
															: "用户级"}
												</span>
											</div>
											{item.description && (
												<p className="m-0 text-xs text-ink-secondary line-clamp-2 leading-normal">
													{item.description}
												</p>
											)}
											<div className="flex items-center justify-between gap-3 mt-0.5">
												<span
													className="flex-1 min-w-0 font-mono text-micro text-ink-muted truncate"
													title={item.filePath ?? ""}
												>
													{item.filePath ?? ""}
												</span>
												{item.filePath && (
													<Button
														variant="secondary"
														size="xs"
														onClick={() => void handleOpenNativePreview(item)}
													>
														查看内容
													</Button>
												)}
											</div>
										</Card>
									))}
								</div>
							)}
						</>
					) : !loading && visibleManagedSkills.length === 0 ? (
						<EmptyState
							compact
							title="当前筛选条件下暂无已沉淀的 PA 托管 Skill"
							description={`在事项对话中完成可复用流程后，可让角色调用 propose_skill 生成确认卡并落盘；也可以点击左栏「Pi 原生发现（只读）」查看宿主机 Pi 已发现的 ${piNativeSkills.length} 个技能。`}
						/>
					) : (
						<div className="flex flex-col gap-2">
							{visibleManagedSkills.map((skill) => {
								const key = skillKey(skill);
								const busy = updatingKey === key;
								return (
									<Card key={key} padding="sm" className="flex flex-col gap-1.5">
										<div className="flex items-center justify-between gap-2 flex-wrap">
											<div className="flex items-center gap-2 flex-wrap min-w-0">
												<strong className="text-sm font-semibold text-ink">{skill.name}</strong>
												<Badge tone="neutral">{skill.scopeLabel}</Badge>
												<Badge tone={TRUST_BADGE_TONES[skill.trustLevel]} dot>
													{SKILL_TRUST_LEVEL_LABELS[skill.trustLevel]}
												</Badge>
											</div>
											<span className="text-micro text-ink-muted">
												{skill.runCount > 0 ? `已执行 ${skill.runCount} 次` : "尚未触发脚本"}
											</span>
										</div>
										<p className="m-0 text-xs text-ink-secondary line-clamp-2 leading-normal">
											{skill.description}
										</p>
										{skill.scripts.length > 0 && (
											<div className="flex items-center gap-1.5 flex-wrap">
												{skill.scripts.map((script) => (
													<Badge key={script} tone="accent">
														{script}
													</Badge>
												))}
											</div>
										)}
										<div className="flex items-center justify-between gap-3 mt-0.5 flex-wrap">
											<span
												className="flex-1 min-w-0 font-mono text-micro text-ink-muted truncate"
												title={skill.filePath}
											>
												{skill.filePath}
											</span>
											<div className="flex items-center gap-1.5 shrink-0 flex-wrap">
												<Button variant="secondary" size="xs" onClick={() => void handleOpenPreview(skill)}>
													{skill.scripts.length > 0
														? `查看内容 (${skill.scripts.length + 1})`
														: "查看 SKILL.md"}
												</Button>
												{skill.canManage && skill.trustLevel !== "autonomous" && (
													<Button
														variant="primary"
														size="xs"
														disabled={busy}
														onClick={() => void handleSetTrust(skill, "autonomous")}
													>
														升级为自主执行
													</Button>
												)}
												{skill.canManage && skill.trustLevel !== "confirm" && (
													<Button
														variant="secondary"
														size="xs"
														disabled={busy}
														onClick={() => void handleSetTrust(skill, "confirm")}
													>
														设为执行前确认
													</Button>
												)}
												{skill.canManage && skill.trustLevel !== "disabled" && (
													<Button
														variant="inline"
														size="xs"
														disabled={busy}
														onClick={() => void handleSetTrust(skill, "disabled")}
													>
														停用脚本
													</Button>
												)}
											</div>
										</div>
									</Card>
								);
							})}
						</div>
					)}
				</div>
			</SplitPane>

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
						<Badge tone={TRUST_BADGE_TONES[activePreviewManaged.trustLevel]} dot>
							{SKILL_TRUST_LEVEL_LABELS[activePreviewManaged.trustLevel]}
						</Badge>
					) : previewTarget?.kind === "native" ? (
						<Badge tone="neutral">只读预览</Badge>
					) : null
				}
				onClose={() => setPreviewTarget(null)}
				footer={
					previewTarget ? (
						<>
							{activePreviewManaged?.canManage && activePreviewManaged.trustLevel !== "autonomous" && (
								<Button
									variant="primary"
									size="xs"
									disabled={activePreviewBusy}
									onClick={() => void handleSetTrust(activePreviewManaged, "autonomous")}
								>
									升级为自主执行
								</Button>
							)}
							{activePreviewManaged?.canManage && activePreviewManaged.trustLevel !== "confirm" && (
								<Button
									variant="secondary"
									size="xs"
									disabled={activePreviewBusy}
									onClick={() => void handleSetTrust(activePreviewManaged, "confirm")}
								>
									设为执行前确认
								</Button>
							)}
							{activePreviewManaged?.canManage && activePreviewManaged.trustLevel !== "disabled" && (
								<Button
									variant="inline"
									size="xs"
									disabled={activePreviewBusy}
									onClick={() => void handleSetTrust(activePreviewManaged, "disabled")}
								>
									停用脚本
								</Button>
							)}
							<Button variant="secondary" size="xs" onClick={() => setPreviewTarget(null)}>
								关闭
							</Button>
						</>
					) : undefined
				}
			>
				{loadingDetailKey === activePreviewKey ? (
					<p className="m-0 text-xs text-ink-muted">正在读取 Skill 目录与文件内容…</p>
				) : detailError ? (
					<Banner tone="danger">读取失败：{detailError}</Banner>
				) : activePreviewDetail ? (
					<div className="grid grid-cols-1 md:grid-cols-[204px_minmax(0,1fr)] gap-3.5 items-start min-h-[360px]">
						<aside
							aria-label="Skill 目录文件"
							className="flex flex-col gap-2.5 pb-2.5 md:pb-0 md:pr-3 border-b md:border-b-0 md:border-r border-line max-h-[180px] md:max-h-[62vh] overflow-y-auto"
						>
							<div className="flex flex-col gap-0.5">
								<span className="text-micro font-semibold text-ink-muted px-1.5 py-0.5">入口定义</span>
								<button
									type="button"
									className={cn(
										"border-0 text-left px-2 py-1.5 rounded-sm text-xs cursor-pointer flex items-center min-w-0 transition-colors",
										previewFileTab === "SKILL.md"
											? "bg-accent-soft text-accent font-semibold"
											: "bg-transparent text-ink-secondary hover:bg-subtle hover:text-ink",
									)}
									onClick={() => setPreviewFileTab("SKILL.md")}
									title="SKILL.md"
								>
									<span className="truncate">SKILL.md</span>
								</button>
							</div>
							{activePreviewFileGroups.map(({ group, items }) => (
								<div key={group} className="flex flex-col gap-0.5">
									<span className="text-micro font-semibold text-ink-muted px-1.5 py-0.5">
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
												className={cn(
													"border-0 text-left px-2 py-1.5 rounded-sm text-xs cursor-pointer flex items-center min-w-0 transition-colors",
													previewFileTab === file.path
														? "bg-accent-soft text-accent font-semibold"
														: "bg-transparent text-ink-secondary hover:bg-subtle hover:text-ink",
												)}
												onClick={() => setPreviewFileTab(file.path)}
												title={file.path}
											>
												<span className="truncate">{displayName}</span>
											</button>
										);
									})}
								</div>
							))}
						</aside>
						<div className="flex flex-col gap-2 min-w-0">
							<div className="flex items-center justify-between gap-2 flex-wrap pb-2 border-b border-line">
								<div className="flex items-center gap-2 flex-wrap">
									<code className="font-mono text-xs text-ink bg-subtle px-2 py-0.5 rounded-sm">
										{activeFileEntry?.path ?? previewFileTab}
									</code>
									{activeFileEntry?.truncated && <Badge tone="warn">已截断至 64KB</Badge>}
								</div>
								{activeFileIsMarkdown && (
									<Tabs
										variant="pill"
										size="sm"
										ariaLabel="查看模式"
										value={previewMdMode}
										onChange={(id) => setPreviewMdMode(id as "rendered" | "raw")}
										items={[
											{ id: "rendered", label: "渲染" },
											{ id: "raw", label: "源码" },
										]}
									/>
								)}
							</div>
							<div className="max-h-[58vh] overflow-y-auto min-w-0">
								{activeFileIsMarkdown && previewMdMode === "rendered" ? (
									(() => {
										const split = splitFrontmatterForMarkdown(activeFileEntry?.content ?? "");
										return (
											<div className="px-1.5 pb-3 text-sm leading-relaxed text-ink">
												{split.frontmatter && (
													<pre className="bg-sidebar border border-line rounded-md p-3 font-mono text-xs text-ink leading-relaxed max-h-[58vh] overflow-auto m-0 mb-3.5 whitespace-pre-wrap break-words">
														<code>{split.frontmatter}</code>
													</pre>
												)}
												<MarkdownView content={split.body} />
											</div>
										);
									})()
								) : (
									<pre className="bg-sidebar border border-line rounded-md p-3 font-mono text-xs text-ink leading-relaxed max-h-[58vh] overflow-auto m-0 whitespace-pre-wrap break-words">
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
