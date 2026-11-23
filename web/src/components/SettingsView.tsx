import { useMemo, useState } from "react";
import type {
	CollaboratorDto,
	RuntimeConfigSectionDto,
	RuntimeExtensionDto,
	RuntimeExtensionSourceKind,
	RuntimeExtensionStatus,
	RuntimeOverviewDto,
} from "../api.ts";
import type { SettingsSection } from "../hashRouter.ts";
import { PstackSettings } from "./PstackSettings.tsx";
import { SystemOneSettings } from "./SystemOneSettings.tsx";
import { WebAccessSettings } from "./WebAccessSettings.tsx";

interface SettingsViewProps {
	currentUser?: CollaboratorDto | null;
	isSuperAdmin?: boolean;
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

const STATUS_BADGE_CLASSES: Record<RuntimeExtensionStatus, string> = {
	active: "rsi-status-verified",
	conditional: "rsi-status-candidate",
	inactive: "rsi-status-superseded",
	error: "rsi-status-rejected",
};

export function SettingsView({
	isSuperAdmin = false,
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

	return (
		<div className="subpage-scroll">
			<div className="subpage-inner wide">
				<div className="pane-header-row">
					<div className="pane-header">
						<h1>设置</h1>
						<p>工作台运行底座、扩展插件与当前生效配置</p>
					</div>
					<div className="actions-row compact">
						<button
							type="button"
							className="btn-pill-outline"
							onClick={() => void onRefresh()}
							disabled={loading}
						>
							{loading ? "检测中…" : "刷新"}
						</button>
					</div>
				</div>

				<div className="settings-category-tabs" role="tablist" aria-label="设置类目">
					{CATEGORY_TABS.map((tab) => (
						<button
							key={tab.id}
							type="button"
							role="tab"
							aria-selected={activeSection === tab.id}
							className={`choice-chip ${activeSection === tab.id ? "active" : ""}`}
							onClick={() => onSelectSection(tab.id)}
						>
							{tab.label}
						</button>
					))}
				</div>

				{error && (
					<div className="approval-card settings-alert-gap" role="alert">
						<div className="banner-row">
							<span>
								<strong>读取运行状态失败：</strong> {error}
							</span>
							<button type="button" className="btn-inline" onClick={() => void onRefresh()} disabled={loading}>
								重试
							</button>
						</div>
					</div>
				)}

				{!overview && loading ? (
					<div className="ui-sections-stack">
						<div className="ui-card">
							<p className="ui-empty-note compact">正在读取底座与配置状态...</p>
						</div>
					</div>
				) : base ? (
					<div className="ui-sections-stack">
						{base.pathsRedacted && (
							<div className="notice-card" aria-live="polite">
								协同成员视角已隐藏本机绝对路径。
							</div>
						)}

						{showBase && (
							<section className="ui-section" aria-label="Agent 底座">
								<div className="ui-section-head">
									<div className="ui-inline-head">
										<h2 className="ui-section-title">Agent 底座</h2>
										<span
											className={`rsi-badge ${base.available ? "rsi-status-verified" : "rsi-status-rejected"}`}
										>
											{base.available ? `Pi v${base.version}` : "Pi 未就绪"}
										</span>
									</div>
								</div>

								<div className="ui-card compact settings-base-card">
									{!base.available && (
										<div className="approval-card">
											{base.probeError ?? "未检测到 Pi CLI"} · 安装指引：
											<a href="https://pi.dev/" target="_blank" rel="noreferrer noopener">
												pi.dev
											</a>
										</div>
									)}

									<div className="settings-kv-grid">
										<div className="settings-kv-item">
											<span className="settings-kv-label">执行底座</span>
											<strong className="settings-kv-value">{base.transport}</strong>
										</div>
										<div className="settings-kv-item">
											<span className="settings-kv-label">CLI / 宿主</span>
											<strong className="settings-kv-value">
												{base.available ? `Pi ${base.version}` : "未就绪"} · Node {base.nodeVersion} (
												{base.platform})
											</strong>
										</div>
										<div className="settings-kv-item">
											<span className="settings-kv-label">会话模式</span>
											<strong className="settings-kv-value">
												{base.sessionMode === "persisted" ? "v2 作用域（可续接）" : "--no-session"}
											</strong>
										</div>
										<div className="settings-kv-item">
											<span className="settings-kv-label">默认 cwd</span>
											<strong className="settings-kv-value mono-wrap">{base.defaultCwd ?? "-"}</strong>
										</div>
										<div className="settings-kv-item">
											<span className="settings-kv-label">pstack 方法包</span>
											<strong className="settings-kv-value">
												{!base.pstack.configured
													? "未配置"
													: base.pstack.available
														? `v${base.pstack.version}（${base.pstack.skillCount} 项）`
														: `异常：${base.pstack.error ?? "不可用"}`}
											</strong>
										</div>
										<div className="settings-kv-item">
											<span className="settings-kv-label">空闲看门狗</span>
											<strong className="settings-kv-value">
												{base.envFlags.idleTimeoutMs === 0
													? "已关闭 (0)"
													: `${Math.round(base.envFlags.idleTimeoutMs / 1000)}s`}
											</strong>
										</div>
									</div>

									<details className="settings-details">
										<summary>调用隔离策略</summary>
										<p className="muted-hint">
											岗位执行共享已配置的运行工具；团队业务操作仍遵循事项协作规则。Pi
											以服务账号权限运行，不是操作系统沙箱。
										</p>
										<div className="settings-isolation-list">
											{base.isolationModes.map((mode) => (
												<div key={mode.id} className="settings-isolation-row">
													<div className="settings-isolation-title">
														<strong>{mode.label}</strong>
														<span className="muted-hint">{mode.usage}</span>
													</div>
													<div className="settings-isolation-tags">
														<span className="tag-chip">{mode.extensionsPolicy}</span>
														<span className="tag-chip">{mode.sessionStrategy}</span>
														<span className="tag-chip">{mode.toolsPolicy}</span>
													</div>
												</div>
											))}
										</div>
									</details>
								</div>
							</section>
						)}

						{showExtensions && (
							<section className="ui-section" aria-label="扩展插件">
								<div className="ui-section-head">
									<div className="ui-inline-head">
										<h2 className="ui-section-title">扩展插件（Pi Extensions）</h2>
										{summary && (
											<span className="ui-inline-sub">
												已启用 {summary.activeCount} · 按条件 {summary.conditionalCount} · 外部{" "}
												{summary.operatorCount}
											</span>
										)}
									</div>
									<div className="settings-filter-row" role="tablist" aria-label="扩展筛选">
										<button
											type="button"
											className={`choice-chip ${extFilter === "all" ? "active" : ""}`}
											onClick={() => setExtFilter("all")}
										>
											全部 ({overview?.extensions.length ?? 0})
										</button>
										<button
											type="button"
											className={`choice-chip ${extFilter === "active" ? "active" : ""}`}
											onClick={() => setExtFilter("active")}
										>
											已启用 ({(summary?.activeCount ?? 0) + (summary?.conditionalCount ?? 0)})
										</button>
										<button
											type="button"
											className={`choice-chip ${extFilter === "operator" ? "active" : ""}`}
											onClick={() => setExtFilter("operator")}
										>
											外部 ({overview?.extensions.filter(isExternalExtension).length ?? 0})
										</button>
									</div>
								</div>

								<div className="settings-ext-list">
									{filteredExtensions.length === 0 ? (
										<div className="ui-card compact">
											<p className="ui-empty-note compact">
												{extFilter === "operator" ? "没有可显示的外部扩展。" : "当前筛选条件下无扩展项。"}
											</p>
										</div>
									) : (
										filteredExtensions.map((ext) => (
											<article key={ext.id} className="ui-card compact settings-ext-card">
												<div className="settings-ext-head">
													<div className="settings-ext-name-row">
														<strong className="settings-ext-name">{ext.name}</strong>
														<span className={`rsi-badge ${STATUS_BADGE_CLASSES[ext.status]}`}>
															{STATUS_LABELS[ext.status]}
														</span>
														<span className="tag-chip">{SOURCE_LABELS[ext.sourceKind]}</span>
														{ext.fileStatus === "missing" && (
															<span className="rsi-badge rsi-status-rejected">文件缺失</span>
														)}
													</div>
													{ext.entryPath && (
														<code className="settings-ext-path mono-wrap">{ext.entryPath}</code>
													)}
												</div>

												<div className="settings-ext-summary">
													<span>{ext.description}</span>
													<span className="muted-hint"> · {ext.scopeSummary}</span>
												</div>

												{ext.error && <div className="settings-ext-error">{ext.error}</div>}

												{(ext.registeredTools.length > 0 ||
													(ext.id === "pi-builtin-mcp" && ext.declaredByRoles.length > 0)) && (
													<div className="settings-ext-footer">
														{ext.registeredTools.length > 0 && (
															<div className="tag-list">
																{ext.registeredTools.map((tool) => (
																	<span key={tool} className="tag-chip skill">
																		{tool}
																	</span>
																))}
															</div>
														)}
														{ext.id === "pi-builtin-mcp" && ext.declaredByRoles.length > 0 && (
															<span className="muted-hint">
																声明角色：{ext.declaredByRoles.join("、")}（仅声明，需运行期核查 ·{" "}
																<button type="button" className="btn-inline" onClick={onOpenTeam}>
																	查看团队
																</button>
																）
															</span>
														)}
													</div>
												)}
												{ext.id === "builtin-pstack-extension" && (
													<PstackSettings
														base={base}
														canManage={isSuperAdmin}
														onRefresh={onRefresh}
														onOverviewChange={onOverviewChange}
														onNotice={onNotice}
														onError={onError}
													/>
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
											</article>
										))
									)}
									{isSuperAdmin && base && (
										<SystemOneSettings
											base={base}
											envItems={(overview?.envCredentials ?? []).filter(
												(item) => item.scope === "classifier",
											)}
											onRefresh={onRefresh}
											onOverviewChange={onOverviewChange}
											onNotice={onNotice}
											onError={onError}
										/>
									)}
								</div>

								<p className="muted-hint">
									扩展以服务账户的权限运行。可在上方管理 pstack 和 pi-web-access，其他扩展可通过启动参数{" "}
									<code>PA_PI_EXTENSIONS</code> 接入。
								</p>
							</section>
						)}

						{showConfig && (
							<section className="ui-section" aria-label="运行配置">
								<div className="ui-section-head">
									<div className="ui-inline-head">
										<h2 className="ui-section-title">运行配置</h2>
										<span className="ui-inline-sub">查看当前运行实例的配置值</span>
									</div>
									{activeSection === "config" && (
										<div className="settings-filter-row" role="tablist" aria-label="配置分组筛选">
											<button
												type="button"
												className={`choice-chip ${configFilter === "all" ? "active" : ""}`}
												onClick={() => setConfigFilter("all")}
											>
												全部节
											</button>
											{(overview?.configSections ?? []).map((sec) => (
												<button
													key={sec.id}
													type="button"
													className={`choice-chip ${configFilter === sec.id ? "active" : ""}`}
													onClick={() => setConfigFilter(sec.id)}
												>
													{sec.title}
												</button>
											))}
										</div>
									)}
								</div>

								<div className="settings-config-sections">
									{filteredConfigSections.map((sec) => {
										const defaultExpanded =
											activeSection === "config" || sec.id === "env" || sec.id === "paths";
										return (
											<details
												key={`${sec.id}-${activeSection}`}
												className="ui-card compact settings-config-card"
												open={defaultExpanded}
											>
												<summary className="settings-config-summary">
													<span className="settings-config-title">{sec.title}</span>
													<span className="pill">{sec.items.length} 项</span>
												</summary>
												<div className="settings-config-grid">
													{sec.items.map((item) => (
														<div key={item.key} className="settings-config-row">
															<div className="settings-config-keycol">
																<code>{item.key}</code>
																<span>{item.label}</span>
															</div>
															<div className="settings-config-valcol">
																<strong className="mono-wrap">{item.value}</strong>
																{item.overridden && <span className="tag-chip skill">已覆写</span>}
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
					</div>
				) : null}
			</div>
		</div>
	);
}
