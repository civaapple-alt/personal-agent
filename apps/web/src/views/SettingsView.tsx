import { useMemo, useState } from "react";
import type {
	CollaboratorDto,
	OrganizationDto,
	RuntimeConfigSectionDto,
	RuntimeExtensionDto,
	RuntimeExtensionSourceKind,
	RuntimeExtensionStatus,
	RuntimeOverviewDto,
	WorkspaceDto,
} from "../api.ts";
import { SessionInsightsPanel } from "../components/SessionInsightsPanel.tsx";
import { SkillsTrustPanel } from "../components/SkillsTrustPanel.tsx";
import { SystemOneSettings } from "../components/SystemOneSettings.tsx";
import { WebAccessSettings } from "../components/WebAccessSettings.tsx";
import type { SettingsSection } from "../hashRouter.ts";
import {
	Badge,
	type BadgeTone,
	Banner,
	Button,
	Card,
	EmptyState,
	PageShell,
	PaneHeader,
	SettingsDisclosure,
	Tabs,
} from "../primitives/index.ts";

interface SettingsViewProps {
	currentUser?: CollaboratorDto | null;
	isSuperAdmin?: boolean;
	organizations?: OrganizationDto[];
	workspaces?: WorkspaceDto[];
	activeSection: SettingsSection;
	overview: RuntimeOverviewDto | null;
	loading: boolean;
	error: string | null;
	onSelectSection: (section: SettingsSection) => void;
	onRefresh: () => Promise<void>;
	onOverviewChange?: (overview: RuntimeOverviewDto) => void;
	onNotice?: (message: string) => void;
	onError?: (message: string) => void;
	onOpenTeam: () => void;
	onOpenMatter?: (matterId: string) => void;
	onStartMatterWithPrompt?: (prompt: string) => void;
}

type ExtensionFilter = "all" | "active" | "operator";
type ConfigSectionFilter = "all" | RuntimeConfigSectionDto["id"];

function isExternalExtension(item: RuntimeExtensionDto): boolean {
	return item.sourceKind === "operator_env" || item.sourceKind === "pi_package";
}

const CATEGORY_TABS: Array<{ id: SettingsSection; label: string }> = [
	{ id: "all", label: "全部" },
	{ id: "base", label: "Agent 底座" },
	{ id: "extensions", label: "扩展插件" },
	{ id: "config", label: "运行配置" },
	{ id: "skills", label: "技能与信任" },
	{ id: "insights", label: "运行洞察" },
];

const SOURCE_LABELS: Record<RuntimeExtensionSourceKind, string> = {
	builtin: "内置",
	builtin_conditional: "内置按需",
	pi_builtin: "Pi 内置",
	operator_env: "PA_PI_EXTENSIONS",
	pi_package: "Pi 安装包",
};

const STATUS_LABELS: Record<RuntimeExtensionStatus, string> = {
	active: "已启用",
	conditional: "按条件",
	inactive: "未启用",
	error: "异常",
};

const STATUS_BADGE_TONES: Record<RuntimeExtensionStatus, BadgeTone> = {
	active: "success",
	conditional: "warn",
	inactive: "neutral",
	error: "danger",
};

export function SettingsView({
	isSuperAdmin = false,
	organizations = [],
	workspaces = [],
	activeSection,
	overview,
	loading,
	error,
	onSelectSection,
	onRefresh,
	onOverviewChange,
	onNotice,
	onError,
	onOpenTeam,
	onOpenMatter,
	onStartMatterWithPrompt,
}: SettingsViewProps) {
	const [extFilter, setExtFilter] = useState<ExtensionFilter>("all");
	const [configFilter, setConfigFilter] = useState<ConfigSectionFilter>("all");

	const filteredExtensions: RuntimeExtensionDto[] = useMemo(() => {
		const list = overview?.extensions ?? [];
		if (extFilter === "active") {
			return list.filter((item) => item.status === "active" || item.status === "conditional");
		}
		if (extFilter === "operator") {
			return list.filter(isExternalExtension);
		}
		return list;
	}, [overview, extFilter]);

	const filteredConfigSections: RuntimeConfigSectionDto[] = useMemo(() => {
		const list = overview?.configSections ?? [];
		if (activeSection === "config" && configFilter !== "all") {
			return list.filter((sec) => sec.id === configFilter);
		}
		return list;
	}, [overview, activeSection, configFilter]);

	const base = overview?.base ?? null;
	const summary = overview?.summary ?? null;
	const showBase = activeSection === "all" || activeSection === "base";
	const showExtensions = activeSection === "all" || activeSection === "extensions";
	const showConfig = activeSection === "all" || activeSection === "config";
	const showSkills = activeSection === "skills";
	const showInsights = activeSection === "insights";

	return (
		<PageShell maxWidth="wide">
			<PaneHeader
				title="设置"
				subtitle="工作台运行底座、扩展插件与当前生效配置"
				actions={
					<Button variant="secondary" size="sm" onClick={() => void onRefresh()} disabled={loading}>
						{loading ? "检测中…" : "刷新"}
					</Button>
				}
			/>

			<Tabs
				variant="underline"
				className="mt-3"
				ariaLabel="设置类目"
				value={activeSection}
				onChange={(id) => onSelectSection(id as SettingsSection)}
				items={CATEGORY_TABS}
			/>

			{error && (
				<Banner
					tone="danger"
					className="mt-3"
					actions={
						<Button variant="inline" size="xs" onClick={() => void onRefresh()} disabled={loading}>
							重试
						</Button>
					}
				>
					<strong>读取运行状态失败：</strong> {error}
				</Banner>
			)}

			{!overview && loading ? (
				<Card padding="md" className="mt-4">
					<p className="m-0 text-xs text-ink-muted">正在读取底座与配置状态...</p>
				</Card>
			) : base ? (
				<div className="mt-4 flex flex-col gap-5">
					{base.pathsRedacted && (
						<Banner tone="info">
							<span aria-live="polite">协同成员视角已隐藏本机绝对路径。</span>
						</Banner>
					)}

					{showBase && (
						<section className="flex flex-col gap-2.5" aria-label="Agent 底座">
							<div className="flex items-center gap-2 flex-wrap">
								<h2 className="m-0 text-md font-semibold text-ink">Agent 底座</h2>
								<Badge tone={base.available ? "success" : "danger"} dot>
									{base.available ? `Pi v${base.version}` : "Pi 未就绪"}
								</Badge>
							</div>

							<Card padding="sm" className="flex flex-col gap-2.5">
								{!base.available && (
									<Banner tone="warn">
										{base.probeError ?? "未检测到 Pi CLI"} · 安装指引：
										<a
											href="https://pi.dev/"
											target="_blank"
											rel="noreferrer noopener"
											className="text-accent hover:underline ml-1"
										>
											pi.dev
										</a>
									</Banner>
								)}

								<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
									<div className="bg-sidebar border border-line rounded-md px-3 py-2 flex flex-col gap-0.5 min-w-0">
										<span className="text-micro font-semibold text-ink-muted">执行底座</span>
										<strong className="text-xs text-ink leading-snug break-words">{base.transport}</strong>
									</div>
									<div className="bg-sidebar border border-line rounded-md px-3 py-2 flex flex-col gap-0.5 min-w-0">
										<span className="text-micro font-semibold text-ink-muted">CLI / 宿主</span>
										<strong className="text-xs text-ink leading-snug break-words">
											{base.available ? `Pi ${base.version}` : "未就绪"} · Node {base.nodeVersion} (
											{base.platform})
										</strong>
									</div>
									<div className="bg-sidebar border border-line rounded-md px-3 py-2 flex flex-col gap-0.5 min-w-0">
										<span className="text-micro font-semibold text-ink-muted">会话模式</span>
										<strong className="text-xs text-ink leading-snug break-words">
											{base.sessionMode === "persisted" ? "v2 作用域（可续接）" : "--no-session"}
										</strong>
									</div>
									<div className="bg-sidebar border border-line rounded-md px-3 py-2 flex flex-col gap-0.5 min-w-0">
										<span className="text-micro font-semibold text-ink-muted">默认 cwd</span>
										<strong className="text-xs text-ink font-mono leading-snug break-all">
											{base.defaultCwd ?? "-"}
										</strong>
									</div>
									<div className="bg-sidebar border border-line rounded-md px-3 py-2 flex flex-col gap-0.5 min-w-0">
										<span className="text-micro font-semibold text-ink-muted">空闲看门狗</span>
										<strong className="text-xs text-ink leading-snug break-words">
											{base.envFlags.idleTimeoutMs === 0
												? "已关闭 (0)"
												: `${Math.round(base.envFlags.idleTimeoutMs / 1000)}s`}
										</strong>
									</div>
								</div>

								<SettingsDisclosure summary="调用隔离策略">
									<p className="mt-0 mb-2 text-xs text-ink-muted leading-normal">
										岗位执行共享已配置的运行工具；团队业务操作仍遵循事项协作规则。Pi
										以服务账号权限运行，不是操作系统沙箱。
									</p>
									<div className="flex flex-col gap-1.5">
										{base.isolationModes.map((mode) => (
											<div
												key={mode.id}
												className="flex items-center justify-between gap-2 flex-wrap px-2.5 py-1.5 rounded-sm bg-sidebar border border-line"
											>
												<div className="flex items-center gap-2 flex-wrap text-xs">
													<strong className="text-ink">{mode.label}</strong>
													<span className="text-ink-muted">{mode.usage}</span>
												</div>
												<div className="flex items-center gap-1.5 flex-wrap">
													<Badge tone="neutral">{mode.extensionsPolicy}</Badge>
													<Badge tone="neutral">{mode.sessionStrategy}</Badge>
													<Badge tone="neutral">{mode.toolsPolicy}</Badge>
												</div>
											</div>
										))}
									</div>
								</SettingsDisclosure>
							</Card>
						</section>
					)}

					{showExtensions && (
						<section className="flex flex-col gap-2.5" aria-label="扩展插件">
							<div className="flex items-center justify-between gap-3 flex-wrap">
								<div className="flex items-center gap-2 flex-wrap">
									<h2 className="m-0 text-md font-semibold text-ink">扩展插件（Pi Extensions）</h2>
									{summary && (
										<span className="text-xs text-ink-muted">
											已启用 {summary.activeCount} · 按条件 {summary.conditionalCount} · 外部{" "}
											{summary.operatorCount}
										</span>
									)}
								</div>
								<Tabs
									variant="pill"
									size="sm"
									ariaLabel="扩展筛选"
									value={extFilter}
									onChange={(id) => setExtFilter(id as ExtensionFilter)}
									items={[
										{ id: "all", label: `全部 (${overview?.extensions.length ?? 0})` },
										{
											id: "active",
											label: `已启用 (${(summary?.activeCount ?? 0) + (summary?.conditionalCount ?? 0)})`,
										},
										{
											id: "operator",
											label: `外部 (${overview?.extensions.filter(isExternalExtension).length ?? 0})`,
										},
									]}
								/>
							</div>

							<div className="flex flex-col gap-2">
								{filteredExtensions.length === 0 ? (
									<EmptyState
										compact
										title={extFilter === "operator" ? "没有可显示的外部扩展。" : "当前筛选条件下无扩展项。"}
									/>
								) : (
									filteredExtensions.map((ext) => (
										<Card key={ext.id} padding="sm" className="flex flex-col gap-1.5">
											<div className="flex items-center justify-between gap-2 flex-wrap">
												<div className="flex items-center gap-1.5 flex-wrap min-w-0">
													<strong className="text-sm font-semibold text-ink">{ext.name}</strong>
													<Badge tone={STATUS_BADGE_TONES[ext.status]} dot>
														{STATUS_LABELS[ext.status]}
													</Badge>
													<Badge tone="neutral">{SOURCE_LABELS[ext.sourceKind]}</Badge>
													{ext.fileStatus === "missing" && <Badge tone="danger">文件缺失</Badge>}
												</div>
												{ext.entryPath && (
													<code className="font-mono text-micro text-ink-muted bg-subtle px-1.5 py-0.5 rounded-xs break-all">
														{ext.entryPath}
													</code>
												)}
											</div>

											<div className="text-xs text-ink-secondary leading-normal">
												<span>{ext.description}</span>
												<span className="text-ink-muted"> · {ext.scopeSummary}</span>
											</div>

											{ext.error && <div className="text-xs text-danger-text">{ext.error}</div>}

											{(ext.registeredTools.length > 0 ||
												(ext.id === "pi-builtin-mcp" && ext.declaredByRoles.length > 0)) && (
												<div className="flex items-center justify-between gap-2 flex-wrap pt-0.5">
													{ext.registeredTools.length > 0 && (
														<div className="flex items-center gap-1 flex-wrap">
															{ext.registeredTools.map((tool) => (
																<Badge key={tool} tone="accent">
																	{tool}
																</Badge>
															))}
														</div>
													)}
													{ext.id === "pi-builtin-mcp" && ext.declaredByRoles.length > 0 && (
														<span className="text-xs text-ink-muted">
															声明角色：{ext.declaredByRoles.join("、")}（仅声明，需运行期核查 ·{" "}
															<Button variant="inline" size="xs" onClick={onOpenTeam}>
																查看团队
															</Button>
															）
														</span>
													)}
												</div>
											)}
											{ext.id === "pi-web-access" && isSuperAdmin && (
												<WebAccessSettings
													base={base}
													envItems={(overview?.envCredentials ?? []).filter(
														(item) => item.scope === "web_access",
													)}
													onRefresh={onRefresh}
													onOverviewChange={onOverviewChange}
													onNotice={onNotice}
													onError={onError}
												/>
											)}
										</Card>
									))
								)}
								{isSuperAdmin && base && (
									<SystemOneSettings
										base={base}
										envItems={(overview?.envCredentials ?? []).filter((item) => item.scope === "classifier")}
										onRefresh={onRefresh}
										onOverviewChange={onOverviewChange}
										onNotice={onNotice}
										onError={onError}
									/>
								)}
							</div>

							<p className="m-0 text-xs text-ink-muted leading-normal">
								扩展以服务账户的权限运行。可在上方管理 pi-web-access；其他扩展可通过启动参数{" "}
								<code className="font-mono text-xs bg-subtle px-1 py-0.5 rounded-xs">PA_PI_EXTENSIONS</code>{" "}
								接入。
							</p>
						</section>
					)}

					{showConfig && (
						<section className="flex flex-col gap-2.5" aria-label="运行配置">
							<div className="flex items-center justify-between gap-3 flex-wrap">
								<div className="flex items-center gap-2 flex-wrap">
									<h2 className="m-0 text-md font-semibold text-ink">运行配置</h2>
									<span className="text-xs text-ink-muted">查看当前运行实例的配置值</span>
								</div>
								{activeSection === "config" && (
									<Tabs
										variant="pill"
										size="sm"
										ariaLabel="配置分组筛选"
										value={configFilter}
										onChange={(id) => setConfigFilter(id as ConfigSectionFilter)}
										items={[
											{ id: "all", label: "全部节" },
											...(overview?.configSections ?? []).map((sec) => ({
												id: sec.id,
												label: sec.title,
											})),
										]}
									/>
								)}
							</div>

							<div className="flex flex-col gap-2.5">
								{filteredConfigSections.map((sec) => {
									const defaultExpanded = activeSection === "config" || sec.id === "env" || sec.id === "paths";
									return (
										<details
											key={`${sec.id}-${activeSection}`}
											className="bg-card border border-line rounded-lg px-3.5 py-2.5 min-w-0"
											open={defaultExpanded}
										>
											<summary className="list-none flex items-center justify-between gap-2 cursor-pointer select-none">
												<span className="text-sm font-semibold text-ink">{sec.title}</span>
												<Badge tone="neutral">{sec.items.length} 项</Badge>
											</summary>
											<div className="mt-2.5 pt-2 border-t border-line grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-2">
												{sec.items.map((item) => (
													<div
														key={item.key}
														className="flex items-start justify-between gap-3 py-1.5 border-b border-dashed border-line min-w-0"
													>
														<div className="flex items-center gap-1.5 flex-wrap text-xs text-ink-secondary shrink-0 max-w-[48%]">
															<code className="font-mono text-xs bg-subtle px-1.5 py-0.5 rounded-xs whitespace-nowrap">
																{item.key}
															</code>
															<span>{item.label}</span>
														</div>
														<div className="flex items-center justify-end gap-1.5 flex-wrap text-right text-xs text-ink flex-1 min-w-0">
															<strong className="min-w-0 max-w-full font-mono break-all">
																{item.value}
															</strong>
															{item.overridden && <Badge tone="accent">已覆写</Badge>}
														</div>
													</div>
												))}
											</div>
										</details>
									);
								})}
							</div>
						</section>
					)}
					{showSkills && (
						<SkillsTrustPanel
							organizations={organizations}
							workspaces={workspaces}
							onNotice={onNotice}
							onError={onError}
						/>
					)}
					{showInsights && (
						<SessionInsightsPanel onOpenMatter={onOpenMatter} onStartMatterWithPrompt={onStartMatterWithPrompt} />
					)}
				</div>
			) : showSkills ? (
				<div className="mt-4">
					<SkillsTrustPanel
						organizations={organizations}
						workspaces={workspaces}
						onNotice={onNotice}
						onError={onError}
					/>
				</div>
			) : showInsights ? (
				<div className="mt-4">
					<SessionInsightsPanel onOpenMatter={onOpenMatter} onStartMatterWithPrompt={onStartMatterWithPrompt} />
				</div>
			) : null}
		</PageShell>
	);
}
