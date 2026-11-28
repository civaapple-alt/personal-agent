import { useEffect, useState } from "react";
import type { ModelSelection } from "../api/models.ts";
import type { AdminOverviewPayload, AdminUserRowDto, PlatformRole, RegistrationMode, UserStatus } from "../api.ts";
import { ModelPicker, useModelCatalog } from "../components/ModelPicker.tsx";
import {
	Badge,
	type BadgeTone,
	Banner,
	Button,
	Card,
	EmptyState,
	FieldGroup,
	Input,
	PageShell,
	PaneHeader,
	Tabs,
	Textarea,
} from "../primitives/index.ts";
import { cn } from "../utils/cn.ts";

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

const USER_STATUS_TONE: Record<UserStatus, BadgeTone> = {
	active: "success",
	pending_review: "warn",
	disabled: "danger",
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
		<PageShell maxWidth="wide">
			<PaneHeader
				title="超级管理员控制台"
				subtitle="统一管理用户审核与配额、代码库克隆主目录、注册策略、运行中 AI 任务与安全审计日志"
				actions={
					<Button variant="secondary" size="sm" onClick={() => void onRefresh()} disabled={loading}>
						{loading ? "刷新中…" : "刷新总览"}
					</Button>
				}
			/>

			<Tabs
				variant="underline"
				className="mt-3"
				ariaLabel="管理员控制台模块"
				value={activeTab}
				onChange={(id) => setActiveTab(id as AdminSectionTab)}
				items={[
					{
						id: "users",
						label: `用户审核与配额（${users.length}${pendingCount > 0 ? ` · ${pendingCount} 待审` : ""}）`,
					},
					{ id: "settings", label: "平台安全边界" },
					{ id: "orgs", label: `组织与运行任务（${overview?.activeRuns.length ?? 0}）` },
					{ id: "audit", label: "安全审计日志" },
				]}
			/>

			{error && (
				<Banner tone="danger" className="mt-3">
					{error}
				</Banner>
			)}

			{!overview && loading ? (
				<Card padding="md" className="mt-4">
					<p className="m-0 text-xs text-ink-muted">正在加载管理员总览...</p>
				</Card>
			) : overview ? (
				<div className="mt-4 flex flex-col gap-4">
					{activeTab === "users" && (
						<section className="flex flex-col gap-3" aria-label="用户审核与配额">
							<div className="flex items-center justify-between gap-3 flex-wrap">
								<h2 className="m-0 text-md font-semibold text-ink">平台账号与配额</h2>
								<Tabs
									variant="pill"
									size="sm"
									ariaLabel="账号状态筛选"
									value={userFilter}
									onChange={(id) => setUserFilter(id as UserStatusFilter)}
									items={[
										{ id: "all", label: "全部" },
										{ id: "pending_review", label: USER_STATUS_LABEL.pending_review },
										{ id: "active", label: USER_STATUS_LABEL.active },
										{ id: "disabled", label: USER_STATUS_LABEL.disabled },
									]}
								/>
							</div>

							<div className="flex flex-col gap-2.5">
								{visibleUsers.length === 0 ? (
									<EmptyState compact title="当前筛选条件下暂无账号" />
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
											<Card key={user.id} padding="md" className="flex flex-col gap-2.5">
												<div className="flex items-start justify-between gap-2.5 flex-wrap">
													<div className="min-w-0">
														<div className="flex items-center gap-2 flex-wrap">
															<strong className="text-sm font-semibold text-ink">
																{user.displayName}
															</strong>
															<span className="text-xs text-ink-muted">{user.email}</span>
															<Badge tone={USER_STATUS_TONE[user.status]} dot>
																{USER_STATUS_LABEL[user.status]}
															</Badge>
															{user.platformRole === "super_admin" && (
																<Badge tone="accent">超级管理员</Badge>
															)}
															{isSelf && <Badge tone="info">当前我</Badge>}
														</div>
														<div className="mt-1 text-xs text-ink-muted">
															已创建组织 {user.ownedOrgCount} 个 · 所属组织 {user.orgMemberships.length}{" "}
															个
															{user.lastLoginAt
																? ` · 最近登录 ${new Date(user.lastLoginAt).toLocaleString()}`
																: ""}
														</div>
													</div>
													<div className="flex items-center gap-2 flex-wrap shrink-0">
														{user.status === "pending_review" && (
															<Button
																variant="primary"
																size="xs"
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
															</Button>
														)}
														{user.status === "disabled" && (
															<Button
																variant="primary"
																size="xs"
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
															</Button>
														)}
														{user.status !== "disabled" && !isSelf && (
															<Button
																variant="inline"
																size="xs"
																className="text-danger-text"
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
															</Button>
														)}
														{!isSelf && (
															<Button
																variant="inline"
																size="xs"
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
															</Button>
														)}
													</div>
												</div>

												<div className="flex items-end gap-3 flex-wrap pt-2.5 border-t border-dashed border-line">
													<FieldGroup label="最多建组织数" htmlFor={`quota-orgs-${user.id}`}>
														<Input
															id={`quota-orgs-${user.id}`}
															type="number"
															size="sm"
															min={0}
															max={100}
															className="w-24"
															value={draft.maxOrgs}
															onChange={(e) =>
																setUserDrafts((prev) => ({
																	...prev,
																	[user.id]: { ...draft, maxOrgs: Number(e.target.value) || 0 },
																}))
															}
														/>
													</FieldGroup>
													<FieldGroup label="并发 AI 上限" htmlFor={`quota-dispatches-${user.id}`}>
														<Input
															id={`quota-dispatches-${user.id}`}
															type="number"
															size="sm"
															min={0}
															max={20}
															className="w-24"
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
													</FieldGroup>
													<FieldGroup label="私有角色上限" htmlFor={`quota-roles-${user.id}`}>
														<Input
															id={`quota-roles-${user.id}`}
															type="number"
															size="sm"
															min={0}
															max={100}
															className="w-24"
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
													</FieldGroup>
													<label className="inline-flex items-center gap-1.5 text-xs text-ink cursor-pointer h-7">
														<input
															type="checkbox"
															className="accent-accent"
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
													<Button
														variant="inline"
														size="xs"
														className="h-7"
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
													</Button>
												</div>
											</Card>
										);
									})
								)}
							</div>
						</section>
					)}

					{activeTab === "settings" && (
						<section aria-label="平台安全边界">
							<Card padding="md">
								<form className="flex flex-col gap-3.5" onSubmit={(e) => void handleSaveSettings(e)}>
									<div className="flex flex-col gap-2">
										<h3 className="m-0 text-sm font-semibold text-ink">全局默认模型</h3>
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
									<h2 className="m-0 pt-2 border-t border-line text-md font-semibold text-ink">
										注册策略与多团队仓库边界
									</h2>
									<div className="flex flex-col gap-2">
										{REGISTRATION_LABELS.map((item) => (
											<label
												key={item.value}
												className={cn(
													"flex items-start gap-2.5 px-3 py-2.5 rounded-md border cursor-pointer transition-colors",
													registrationMode === item.value
														? "border-accent bg-accent-soft/40"
														: "border-line bg-sidebar hover:bg-hover/60",
												)}
											>
												<input
													type="radio"
													name="registrationMode"
													className="mt-0.5 accent-accent"
													checked={registrationMode === item.value}
													onChange={() => setRegistrationMode(item.value)}
												/>
												<div className="min-w-0">
													<strong className="text-sm text-ink font-semibold">{item.label}</strong>
													<div className="mt-0.5 text-xs text-ink-muted leading-normal">{item.desc}</div>
												</div>
											</label>
										))}
									</div>

									<FieldGroup
										label="多团队代码库克隆主目录（workspacesRoot）"
										htmlFor="admin-workspaces-root"
										hint={`各组织通过 Git 地址克隆的项目将自动落盘至 <主目录>/<组织Slug>/<仓库>，避免跨组织目录越界。`}
									>
										<Input
											id="admin-workspaces-root"
											value={workspacesRoot}
											onChange={(e) => setWorkspacesRoot(e.target.value)}
											placeholder="/var/pa-workspaces"
											required
										/>
									</FieldGroup>

									<label className="inline-flex items-center gap-2 text-xs text-ink cursor-pointer">
										<input
											type="checkbox"
											className="accent-accent"
											checked={allowLocalWorkspacePath}
											onChange={(e) => setAllowLocalWorkspacePath(e.target.checked)}
										/>
										<span>允许普通团队直接绑定服务器本地目录（始终拒绝 .data 与敏感运行目录）</span>
									</label>

									<FieldGroup
										label="本地目录绑定白名单前缀（每行一个绝对路径，留空仅禁止内部敏感目录）"
										htmlFor="admin-workspace-allowlist"
									>
										<Textarea
											id="admin-workspace-allowlist"
											rows={3}
											mono
											value={allowlistText}
											onChange={(e) => setAllowlistText(e.target.value)}
											placeholder={"/srv/repos\n/opt/team-projects"}
										/>
									</FieldGroup>

									<label className="inline-flex items-center gap-2 text-xs text-ink cursor-pointer">
										<input
											type="checkbox"
											className="accent-accent"
											checked={allowCommandPreviews}
											onChange={(e) => setAllowCommandPreviews(e.target.checked)}
										/>
										<span>允许组织管理员/成员执行命令型本地预览（生产多租户部署建议保持关闭）</span>
									</label>

									<label className="inline-flex items-start gap-2 text-xs text-ink cursor-pointer leading-normal">
										<input
											type="checkbox"
											className="mt-0.5 accent-accent"
											checked={systemOneEnabled}
											onChange={(e) => setSystemOneEnabled(e.target.checked)}
										/>
										<span>
											启用 System One（Jev）快速决策分类器（默认禁用；禁用时自动降级为本机 Pi
											决策与本地规则，所有业务正常推进；启用后需在「设置 → .env 密钥配置」配置
											TYPESAFE_API_KEY）
										</span>
									</label>

									<div className="flex items-end gap-3 flex-wrap pt-2.5 border-t border-dashed border-line">
										<FieldGroup label="新用户默认建组织上限" htmlFor="admin-default-orgs">
											<Input
												id="admin-default-orgs"
												type="number"
												size="sm"
												min={0}
												max={100}
												className="w-24"
												value={defaultMaxOrgs}
												onChange={(e) => setDefaultMaxOrgs(Number(e.target.value) || 0)}
											/>
										</FieldGroup>
										<FieldGroup label="新用户默认并发 AI 上限" htmlFor="admin-default-dispatches">
											<Input
												id="admin-default-dispatches"
												type="number"
												size="sm"
												min={0}
												max={20}
												className="w-24"
												value={defaultMaxActiveDispatches}
												onChange={(e) => setDefaultMaxActiveDispatches(Number(e.target.value) || 0)}
											/>
										</FieldGroup>
										<FieldGroup label="新用户默认私有角色上限" htmlFor="admin-default-roles">
											<Input
												id="admin-default-roles"
												type="number"
												size="sm"
												min={0}
												max={100}
												className="w-24"
												value={defaultMaxPersonalRoles}
												onChange={(e) => setDefaultMaxPersonalRoles(Number(e.target.value) || 0)}
											/>
										</FieldGroup>
									</div>

									<div className="flex items-center gap-2 pt-1">
										<Button type="submit" variant="primary" size="sm" disabled={savingSettings}>
											{savingSettings ? "保存中…" : "保存平台配置"}
										</Button>
									</div>
								</form>
							</Card>
						</section>
					)}

					{activeTab === "orgs" && (
						<section className="flex flex-col gap-3.5" aria-label="组织与运行中任务">
							<Card padding="md" className="flex flex-col gap-3">
								<h2 className="m-0 text-md font-semibold text-ink">
									运行中的 AI 任务（{overview.activeRuns.length}）
								</h2>
								{overview.activeRuns.length === 0 ? (
									<EmptyState compact title="当前没有正在执行的 AI 事项" />
								) : (
									<div className="flex flex-col gap-2">
										{overview.activeRuns.map((run) => (
											<div
												key={run.matterId}
												className="flex items-center justify-between gap-2.5 flex-wrap px-3 py-2 rounded-sm border border-line bg-sidebar"
											>
												<div className="min-w-0">
													<strong className="text-sm text-ink">{run.title}</strong>
													<div className="mt-0.5 text-xs text-ink-muted">
														{run.label} · 始于 {new Date(run.startedAt).toLocaleTimeString()}
													</div>
												</div>
												<Button
													variant="danger"
													size="xs"
													onClick={() =>
														void onAbortMatter(run.matterId).then(
															() => onNotice("已请求中止任务"),
															(error: unknown) =>
																onError(error instanceof Error ? error.message : String(error)),
														)
													}
												>
													紧急中止
												</Button>
											</div>
										))}
									</div>
								)}
							</Card>

							<Card padding="md" className="flex flex-col gap-3">
								<h2 className="m-0 text-md font-semibold text-ink">
									全部组织（{overview.organizations.length}）
								</h2>
								<div className="flex flex-col gap-2">
									{overview.organizations.map((org) => (
										<div
											key={org.id}
											className="flex items-center justify-between gap-2.5 flex-wrap px-3 py-2 rounded-sm border border-line bg-sidebar"
										>
											<div className="min-w-0">
												<div className="flex items-center gap-2 flex-wrap">
													<strong className="text-sm text-ink">{org.name}</strong>
													{org.isDefault && <Badge tone="success">默认</Badge>}
												</div>
												<div className="mt-0.5 text-xs text-ink-muted font-mono break-all">
													Slug: {org.slug ?? org.id} · 主目录: {org.workspacesDir ?? "未设置"}
												</div>
											</div>
										</div>
									))}
								</div>
							</Card>
						</section>
					)}

					{activeTab === "audit" && (
						<section aria-label="安全审计日志">
							<Card padding="md" className="flex flex-col gap-3">
								<h2 className="m-0 text-md font-semibold text-ink">
									最近安全审计记录（{overview.auditLogs.length}）
								</h2>
								{overview.auditLogs.length === 0 ? (
									<EmptyState compact title="暂无审计记录" />
								) : (
									<div className="flex flex-col gap-2">
										{overview.auditLogs.map((entry) => (
											<div key={entry.id} className="px-3 py-2 rounded-sm border border-line bg-sidebar">
												<div className="flex items-center justify-between gap-2.5 flex-wrap text-xs">
													<strong className="font-mono text-ink">{entry.action}</strong>
													<span className="text-ink-muted">
														{entry.actorEmail ?? entry.actorUserId ?? "system"} ·{" "}
														{new Date(entry.createdAt).toLocaleString()}
														{entry.ipAddress ? ` · ${entry.ipAddress}` : ""}
													</span>
												</div>
												<div className="mt-1 text-micro font-mono text-ink-muted break-words">
													target={entry.targetType}
													{entry.targetId ? `:${entry.targetId}` : ""}
													{entry.orgId ? ` · org=${entry.orgId}` : ""}
													{entry.detail ? ` · ${JSON.stringify(entry.detail)}` : ""}
												</div>
											</div>
										))}
									</div>
								)}
							</Card>
						</section>
					)}
				</div>
			) : null}
		</PageShell>
	);
}
