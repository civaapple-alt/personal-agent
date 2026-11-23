import { useEffect, useState } from "react";
import type { ModelSelection } from "../api/models.ts";
import type { AdminOverviewPayload, AdminUserRowDto, PlatformRole, RegistrationMode, UserStatus } from "../api.ts";
import { ModelPicker, useModelCatalog } from "./ModelPicker.tsx";

interface AdminViewProps {
	overview: AdminOverviewPayload | null;
	loading: boolean;
	error: string | null;
	currentUserId: string | null;
	onRefresh: () => Promise<void>;
	onSaveSettings: (input: {
		registrationMode: RegistrationMode;
		workspacesRoot: string;
		allowLocalWorkspacePath: boolean;
		localWorkspaceAllowlist: string[];
		allowCommandPreviews: boolean;
		systemOneEnabled: boolean;
		defaultMaxOrgs: number;
		defaultMaxActiveDispatches: number;
		defaultMaxPersonalRoles: number;
		defaultModelSelection?: ModelSelection | null;
	}) => Promise<void>;
	onUpdateUser: (
		userId: string,
		input: {
			status?: UserStatus;
			platformRole?: PlatformRole;
			maxOrgs?: number;
			maxActiveDispatches?: number;
			maxPersonalRoles?: number;
			canDispatchAi?: boolean;
		},
	) => Promise<void>;
	onAbortMatter: (matterId: string) => Promise<void>;
	onNotice: (message: string) => void;
	onError: (message: string) => void;
}

type AdminSectionTab = "settings" | "users" | "orgs" | "audit";
type UserStatusFilter = "all" | UserStatus;

const USER_STATUS_LABEL: Record<UserStatus, string> = {
	active: "已启用",
	pending_review: "待审核",
	disabled: "已禁用",
};

const USER_STATUS_BADGE: Record<UserStatus, string> = {
	active: "rsi-status-verified",
	pending_review: "rsi-status-candidate",
	disabled: "rsi-status-rejected",
};

const REGISTRATION_LABELS: Array<{ value: RegistrationMode; label: string; desc: string }> = [
	{
		value: "open_review",
		label: "开放注册（管理员审核）",
		desc: "默认策略：允许自主注册账号，但需超级管理员审核通过后才能访问工作台。",
	},
	{
		value: "open_auto",
		label: "开放注册（自动开通）",
		desc: "任意成员邮箱密码注册后立即进入工作台，随后可由管理员调整配额或禁用。",
	},
	{ value: "invite_only", label: "仅组织邀请注册", desc: "必须持有效组织邀请码才允许注册账号。" },
];

export function AdminView({
	overview,
	loading,
	error,
	currentUserId,
	onRefresh,
	onSaveSettings,
	onUpdateUser,
	onAbortMatter,
	onNotice,
	onError,
}: AdminViewProps) {
	const [activeTab, setActiveTab] = useState<AdminSectionTab>("users");
	const [userFilter, setUserFilter] = useState<UserStatusFilter>("all");
	const [savingSettings, setSavingSettings] = useState(false);
	const [busyUserId, setBusyUserId] = useState<string | null>(null);

	const { catalog, reload: reloadModels } = useModelCatalog();
	const [modelEdit, setModelEdit] = useState<ModelSelection | null | undefined>(undefined);

	// Platform settings draft state
	const [registrationMode, setRegistrationMode] = useState<RegistrationMode>("open_review");
	const [workspacesRoot, setWorkspacesRoot] = useState("");
	const [allowLocalWorkspacePath, setAllowLocalWorkspacePath] = useState(true);
	const [allowlistText, setAllowlistText] = useState("");
	const [allowCommandPreviews, setAllowCommandPreviews] = useState(false);
	const [systemOneEnabled, setSystemOneEnabled] = useState(false);
	const [defaultMaxOrgs, setDefaultMaxOrgs] = useState(3);
	const [defaultMaxActiveDispatches, setDefaultMaxActiveDispatches] = useState(3);
	const [defaultMaxPersonalRoles, setDefaultMaxPersonalRoles] = useState(5);

	// Per-user quota drafts
	const [userDrafts, setUserDrafts] = useState<
		Record<string, { maxOrgs: number; maxActiveDispatches: number; maxPersonalRoles: number; canDispatchAi: boolean }>
	>({});

	useEffect(() => {
		if (!overview) return;
		const s = overview.settings;
		setModelEdit(undefined);
		setRegistrationMode(s.registrationMode);
		setWorkspacesRoot(s.workspacesRoot);
		setAllowLocalWorkspacePath(s.allowLocalWorkspacePath);
		setAllowlistText(s.localWorkspaceAllowlist.join("\n"));
		setAllowCommandPreviews(s.allowCommandPreviews);
		setSystemOneEnabled(Boolean(s.systemOneEnabled));
		setDefaultMaxOrgs(s.defaultMaxOrgs);
		setDefaultMaxActiveDispatches(s.defaultMaxActiveDispatches);
		setDefaultMaxPersonalRoles(s.defaultMaxPersonalRoles ?? 5);

		const nextDrafts: Record<
			string,
			{ maxOrgs: number; maxActiveDispatches: number; maxPersonalRoles: number; canDispatchAi: boolean }
		> = {};
		for (const u of overview.users) {
			nextDrafts[u.id] = {
				maxOrgs: u.maxOrgs,
				maxActiveDispatches: u.maxActiveDispatches,
				maxPersonalRoles: u.maxPersonalRoles ?? 5,
				canDispatchAi: u.canDispatchAi,
			};
		}
		setUserDrafts(nextDrafts);
	}, [overview]);

	const users = overview?.users ?? [];
	const pendingCount = users.filter((u) => u.status === "pending_review").length;
	const visibleUsers = userFilter === "all" ? users : users.filter((u) => u.status === userFilter);

	const handleSaveSettings = async (e: React.FormEvent) => {
		e.preventDefault();
		setSavingSettings(true);
		try {
			await onSaveSettings({
				registrationMode,
				defaultModelSelection: modelEdit,
				workspacesRoot: workspacesRoot.trim(),
				allowLocalWorkspacePath,
				localWorkspaceAllowlist: allowlistText
					.split(/\r?\n/)
					.map((l) => l.trim())
					.filter(Boolean),
				allowCommandPreviews,
				systemOneEnabled,
				defaultMaxOrgs: Number(defaultMaxOrgs) || 1,
				defaultMaxActiveDispatches: Number(defaultMaxActiveDispatches) || 1,
				defaultMaxPersonalRoles: Math.max(0, Number(defaultMaxPersonalRoles) || 0),
			});
			if (modelEdit !== undefined) reloadModels();
			onNotice("平台配置已保存");
		} catch (error) {
			onError(error instanceof Error ? error.message : String(error));
		} finally {
			setSavingSettings(false);
		}
	};

	const handleUserAction = async (
		user: AdminUserRowDto,
		patch: {
			status?: UserStatus;
			platformRole?: PlatformRole;
			maxOrgs?: number;
			maxActiveDispatches?: number;
			maxPersonalRoles?: number;
			canDispatchAi?: boolean;
		},
		message: string,
	) => {
		setBusyUserId(user.id);
		try {
			await onUpdateUser(user.id, patch);
			onNotice(message);
		} catch (error) {
			onError(error instanceof Error ? error.message : String(error));
		} finally {
			setBusyUserId(null);
		}
	};

	return (
		<div className="subpage-scroll">
			<div className="subpage-inner wide">
				<div className="pane-header-row">
					<div className="pane-header">
						<h1>超级管理员控制台</h1>
						<p>统一管理用户审核与配额、代码库克隆主目录、注册策略、运行中 AI 任务与安全审计日志</p>
					</div>
					<div className="actions-row compact">
						<button
							type="button"
							className="btn-pill-outline"
							onClick={() => void onRefresh()}
							disabled={loading}
						>
							{loading ? "刷新中…" : "刷新总览"}
						</button>
					</div>
				</div>

				<div className="settings-category-tabs" role="tablist" aria-label="管理员控制台模块">
					<button
						type="button"
						role="tab"
						aria-selected={activeTab === "users"}
						className={`choice-chip ${activeTab === "users" ? "active" : ""}`}
						onClick={() => setActiveTab("users")}
					>
						用户审核与配额（{users.length}
						{pendingCount > 0 ? ` · ${pendingCount} 待审` : ""}）
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={activeTab === "settings"}
						className={`choice-chip ${activeTab === "settings" ? "active" : ""}`}
						onClick={() => setActiveTab("settings")}
					>
						平台安全边界
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={activeTab === "orgs"}
						className={`choice-chip ${activeTab === "orgs" ? "active" : ""}`}
						onClick={() => setActiveTab("orgs")}
					>
						组织与运行任务（{overview?.activeRuns.length ?? 0}）
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={activeTab === "audit"}
						className={`choice-chip ${activeTab === "audit" ? "active" : ""}`}
						onClick={() => setActiveTab("audit")}
					>
						安全审计日志
					</button>
				</div>

				{error && (
					<div className="approval-card" role="alert">
						{error}
					</div>
				)}

				{!overview && loading ? (
					<div className="ui-card">
						<p className="ui-empty-note compact">正在加载管理员总览...</p>
					</div>
				) : overview ? (
					<div className="ui-sections-stack">
						{activeTab === "users" && (
							<section className="ui-section" aria-label="用户审核与配额">
								<div className="ui-section-head">
									<h2 className="ui-section-title">平台账号与配额</h2>
									<div className="actions-row compact">
										{(["all", "pending_review", "active", "disabled"] as UserStatusFilter[]).map((f) => (
											<button
												key={f}
												type="button"
												className={`choice-chip ${userFilter === f ? "active" : ""}`}
												onClick={() => setUserFilter(f)}
											>
												{f === "all" ? "全部" : USER_STATUS_LABEL[f]}
											</button>
										))}
									</div>
								</div>

								<div className="admin-user-list">
									{visibleUsers.length === 0 ? (
										<div className="ui-card">
											<p className="ui-empty-note compact">当前筛选条件下暂无账号</p>
										</div>
									) : (
										visibleUsers.map((user) => {
											const draft = userDrafts[user.id] ?? {
												maxOrgs: user.maxOrgs,
												maxActiveDispatches: user.maxActiveDispatches,
												maxPersonalRoles: user.maxPersonalRoles ?? 5,
												canDispatchAi: user.canDispatchAi,
											};
											const isSelf = user.id === currentUserId;
											const isBusy = busyUserId === user.id;
											return (
												<div key={user.id} className="ui-card admin-user-card">
													<div className="admin-user-top">
														<div>
															<div className="ui-inline-head">
																<strong>{user.displayName}</strong>
																<span className="muted-hint">{user.email}</span>
																<span className={`rsi-badge ${USER_STATUS_BADGE[user.status]}`}>
																	{USER_STATUS_LABEL[user.status]}
																</span>
																{user.platformRole === "super_admin" && (
																	<span className="rsi-badge rsi-status-verified">超级管理员</span>
																)}
																{isSelf && <span className="roster-me">当前我</span>}
															</div>
															<div className="muted-hint admin-user-meta">
																已创建组织 {user.ownedOrgCount} 个 · 所属组织{" "}
																{user.orgMemberships.length} 个
																{user.lastLoginAt
																	? ` · 最近登录 ${new Date(user.lastLoginAt).toLocaleString()}`
																	: ""}
															</div>
														</div>
														<div className="actions-row compact">
															{user.status === "pending_review" && (
																<button
																	type="button"
																	className="btn-pill-dark"
																	disabled={isBusy}
																	onClick={() =>
																		void handleUserAction(
																			user,
																			{
																				status: "active",
																				maxOrgs: draft.maxOrgs,
																				maxActiveDispatches: draft.maxActiveDispatches,
																				maxPersonalRoles: draft.maxPersonalRoles,
																				canDispatchAi: draft.canDispatchAi,
																			},
																			`已审核通过 ${user.displayName}`,
																		)
																	}
																>
																	审核通过
																</button>
															)}
															{user.status === "disabled" && (
																<button
																	type="button"
																	className="btn-pill-dark"
																	disabled={isBusy}
																	onClick={() =>
																		void handleUserAction(
																			user,
																			{ status: "active" },
																			`已重新启用 ${user.displayName}`,
																		)
																	}
																>
																	重新启用
																</button>
															)}
															{user.status !== "disabled" && !isSelf && (
																<button
																	type="button"
																	className="btn-inline"
																	disabled={isBusy}
																	onClick={() =>
																		void handleUserAction(
																			user,
																			{ status: "disabled" },
																			`已禁用账号 ${user.displayName} 并注销其所有会话`,
																		)
																	}
																>
																	禁用
																</button>
															)}
															{!isSelf && (
																<button
																	type="button"
																	className="btn-inline"
																	disabled={isBusy}
																	onClick={() =>
																		void handleUserAction(
																			user,
																			{
																				platformRole:
																					user.platformRole === "super_admin"
																						? "user"
																						: "super_admin",
																			},
																			user.platformRole === "super_admin"
																				? `已将 ${user.displayName} 降为普通用户`
																				: `已授予 ${user.displayName} 超级管理员权限`,
																		)
																	}
																>
																	{user.platformRole === "super_admin" ? "取消超管" : "设为超管"}
																</button>
															)}
														</div>
													</div>

													<div className="admin-quota-row">
														<label className="admin-quota-field">
															<span>最多建组织数</span>
															<input
																type="number"
																min={0}
																max={100}
																className="input-field compact-number"
																value={draft.maxOrgs}
																onChange={(e) =>
																	setUserDrafts((prev) => ({
																		...prev,
																		[user.id]: { ...draft, maxOrgs: Number(e.target.value) || 0 },
																	}))
																}
															/>
														</label>
														<label className="admin-quota-field">
															<span>并发 AI 上限</span>
															<input
																type="number"
																min={0}
																max={20}
																className="input-field compact-number"
																value={draft.maxActiveDispatches}
																onChange={(e) =>
																	setUserDrafts((prev) => ({
																		...prev,
																		[user.id]: {
																			...draft,
																			maxActiveDispatches: Number(e.target.value) || 0,
																		},
																	}))
																}
															/>
														</label>
														<label className="admin-quota-field">
															<span>私有角色上限</span>
															<input
																type="number"
																min={0}
																max={100}
																className="input-field compact-number"
																value={draft.maxPersonalRoles}
																onChange={(e) =>
																	setUserDrafts((prev) => ({
																		...prev,
																		[user.id]: {
																			...draft,
																			maxPersonalRoles: Number(e.target.value) || 0,
																		},
																	}))
																}
															/>
														</label>
														<label className="admin-check-field">
															<input
																type="checkbox"
																checked={draft.canDispatchAi}
																onChange={(e) =>
																	setUserDrafts((prev) => ({
																		...prev,
																		[user.id]: { ...draft, canDispatchAi: e.target.checked },
																	}))
																}
															/>
															<span>允许直接派发 AI 执行</span>
														</label>
														<button
															type="button"
															className="btn-inline"
															disabled={isBusy}
															onClick={() =>
																void handleUserAction(
																	user,
																	{
																		maxOrgs: draft.maxOrgs,
																		maxActiveDispatches: draft.maxActiveDispatches,
																		maxPersonalRoles: draft.maxPersonalRoles,
																		canDispatchAi: draft.canDispatchAi,
																	},
																	`已保存 ${user.displayName} 的配额设置`,
																)
															}
														>
															保存配额
														</button>
													</div>
												</div>
											);
										})
									)}
								</div>
							</section>
						)}

						{activeTab === "settings" && (
							<section className="ui-section" aria-label="平台安全边界">
								<form className="ui-card admin-settings-form" onSubmit={(e) => void handleSaveSettings(e)}>
									<div>
										<h3 className="ui-card-title">全局默认模型</h3>
										<ModelPicker
											value={
												modelEdit === undefined
													? (overview.settings.defaultModelSelection ?? null)
													: modelEdit
											}
											onChange={setModelEdit}
											inheritLabel="使用 Pi 默认"
											inheritModel={catalog?.defaultModel}
											disabled={savingSettings}
										/>
									</div>
									<h2 className="ui-section-title">注册策略与多团队仓库边界</h2>
									<div className="admin-radio-group">
										{REGISTRATION_LABELS.map((item) => (
											<label key={item.value} className="admin-radio-card">
												<input
													type="radio"
													name="registrationMode"
													checked={registrationMode === item.value}
													onChange={() => setRegistrationMode(item.value)}
												/>
												<div>
													<strong>{item.label}</strong>
													<div className="muted-hint">{item.desc}</div>
												</div>
											</label>
										))}
									</div>

									<label className="auth-field-label">
										<span>多团队代码库克隆主目录（workspacesRoot）</span>
										<input
											className="input-field"
											value={workspacesRoot}
											onChange={(e) => setWorkspacesRoot(e.target.value)}
											placeholder="/var/pa-workspaces"
											required
										/>
										<span className="muted-hint">
											各组织通过 Git 地址克隆的项目将自动落盘至 `{"<主目录>/<组织Slug>/<仓库>"}
											`，避免跨组织目录越界。
										</span>
									</label>

									<label className="admin-check-field">
										<input
											type="checkbox"
											checked={allowLocalWorkspacePath}
											onChange={(e) => setAllowLocalWorkspacePath(e.target.checked)}
										/>
										<span>允许普通团队直接绑定服务器本地目录（始终拒绝 .data 与敏感运行目录）</span>
									</label>

									<label className="auth-field-label">
										<span>本地目录绑定白名单前缀（每行一个绝对路径，留空仅禁止内部敏感目录）</span>
										<textarea
											className="input-field admin-textarea"
											rows={3}
											value={allowlistText}
											onChange={(e) => setAllowlistText(e.target.value)}
											placeholder="/srv/repos&#10;/opt/team-projects"
										/>
									</label>

									<label className="admin-check-field">
										<input
											type="checkbox"
											checked={allowCommandPreviews}
											onChange={(e) => setAllowCommandPreviews(e.target.checked)}
										/>
										<span>允许组织管理员/成员执行命令型本地预览（生产多租户部署建议保持关闭）</span>
									</label>

									<label className="admin-check-field">
										<input
											type="checkbox"
											checked={systemOneEnabled}
											onChange={(e) => setSystemOneEnabled(e.target.checked)}
										/>
										<span>
											启用 System One（Jev）快速决策分类器（默认禁用；禁用时自动降级为本机 Pi
											决策与本地规则，所有业务正常推进；启用后需在「设置 → .env 密钥配置」配置
											TYPESAFE_API_KEY）
										</span>
									</label>

									<div className="admin-quota-row">
										<label className="admin-quota-field">
											<span>新用户默认建组织上限</span>
											<input
												type="number"
												min={0}
												max={100}
												className="input-field compact-number"
												value={defaultMaxOrgs}
												onChange={(e) => setDefaultMaxOrgs(Number(e.target.value) || 0)}
											/>
										</label>
										<label className="admin-quota-field">
											<span>新用户默认并发 AI 上限</span>
											<input
												type="number"
												min={0}
												max={20}
												className="input-field compact-number"
												value={defaultMaxActiveDispatches}
												onChange={(e) => setDefaultMaxActiveDispatches(Number(e.target.value) || 0)}
											/>
										</label>
										<label className="admin-quota-field">
											<span>新用户默认私有角色上限</span>
											<input
												type="number"
												min={0}
												max={100}
												className="input-field compact-number"
												value={defaultMaxPersonalRoles}
												onChange={(e) => setDefaultMaxPersonalRoles(Number(e.target.value) || 0)}
											/>
										</label>
									</div>

									<div className="actions-row compact">
										<button type="submit" className="btn-pill-dark" disabled={savingSettings}>
											{savingSettings ? "保存中…" : "保存平台配置"}
										</button>
									</div>
								</form>
							</section>
						)}

						{activeTab === "orgs" && (
							<section className="ui-section" aria-label="组织与运行中任务">
								<div className="ui-card">
									<h2 className="ui-section-title">运行中的 AI 任务（{overview.activeRuns.length}）</h2>
									{overview.activeRuns.length === 0 ? (
										<p className="ui-empty-note compact">当前没有正在执行的 AI 事项</p>
									) : (
										<div className="admin-user-list">
											{overview.activeRuns.map((run) => (
												<div key={run.matterId} className="admin-run-row">
													<div>
														<strong>{run.title}</strong>
														<div className="muted-hint">
															{run.label} · 始于 {new Date(run.startedAt).toLocaleTimeString()}
														</div>
													</div>
													<button
														type="button"
														className="btn-inline"
														onClick={() =>
															void onAbortMatter(run.matterId).then(
																() => onNotice("已请求中止任务"),
																(error: unknown) =>
																	onError(error instanceof Error ? error.message : String(error)),
															)
														}
													>
														紧急中止
													</button>
												</div>
											))}
										</div>
									)}
								</div>

								<div className="ui-card">
									<h2 className="ui-section-title">全部组织（{overview.organizations.length}）</h2>
									<div className="admin-user-list">
										{overview.organizations.map((org) => (
											<div key={org.id} className="admin-run-row">
												<div>
													<strong>{org.name}</strong>{" "}
													{org.isDefault && <span className="rsi-badge rsi-status-verified">默认</span>}
													<div className="muted-hint">
														Slug: {org.slug ?? org.id} · 主目录: {org.workspacesDir ?? "未设置"}
													</div>
												</div>
											</div>
										))}
									</div>
								</div>
							</section>
						)}

						{activeTab === "audit" && (
							<section className="ui-section" aria-label="安全审计日志">
								<div className="ui-card">
									<h2 className="ui-section-title">最近安全审计记录（{overview.auditLogs.length}）</h2>
									{overview.auditLogs.length === 0 ? (
										<p className="ui-empty-note compact">暂无审计记录</p>
									) : (
										<div className="admin-audit-list">
											{overview.auditLogs.map((entry) => (
												<div key={entry.id} className="admin-audit-row">
													<div className="admin-audit-head">
														<strong>{entry.action}</strong>
														<span className="muted-hint">
															{entry.actorEmail ?? entry.actorUserId ?? "system"} ·{" "}
															{new Date(entry.createdAt).toLocaleString()}
															{entry.ipAddress ? ` · ${entry.ipAddress}` : ""}
														</span>
													</div>
													<div className="muted-hint admin-audit-detail">
														target={entry.targetType}
														{entry.targetId ? `:${entry.targetId}` : ""}
														{entry.orgId ? ` · org=${entry.orgId}` : ""}
														{entry.detail ? ` · ${JSON.stringify(entry.detail)}` : ""}
													</div>
												</div>
											))}
										</div>
									)}
								</div>
							</section>
						)}
					</div>
				) : null}
			</div>
		</div>
	);
}
