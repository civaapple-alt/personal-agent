import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
	type AccessTokenDto,
	type AccessTokenScope,
	type AccountUserDto,
	type CollaboratorDto,
	changeAccountPassword,
	createAccessToken,
	listAccessTokens,
	type OrganizationDto,
	revokeAccessToken,
	type WorkspaceDto,
} from "../api.ts";
import {
	Badge,
	type BadgeTone,
	Button,
	Card,
	EmptyState,
	FieldGroup,
	Input,
	ModalDialog,
	PageShell,
	PaneHeader,
	Select,
	SettingsDisclosure,
} from "../primitives/index.ts";
import { cn } from "../utils/cn.ts";

function formatDateTime(iso: string): string {
	const parsed = Date.parse(iso);
	if (!Number.isFinite(parsed)) return iso;
	return new Date(parsed).toLocaleString("zh-CN", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});
}

export interface AccountViewProps {
	accountUser: AccountUserDto | null;
	currentUser: CollaboratorDto | null;
	authKind: "session" | "loopback" | null;
	requireAuth?: boolean | null;
	organizations: OrganizationDto[];
	workspaces: WorkspaceDto[];
	onSwitchOrLogout?: () => void;
	onNotice: (message: string) => void;
	onError: (message: string) => void;
}

function tokenStatus(token: AccessTokenDto): { label: string; tone: BadgeTone; active: boolean } {
	if (token.revokedAt) return { label: "已吊销", tone: "neutral", active: false };
	if (token.expiresAt && Date.parse(token.expiresAt) <= Date.now()) {
		return { label: "已过期", tone: "danger", active: false };
	}
	return { label: "有效", tone: "success", active: true };
}

export function AccountView({
	accountUser,
	currentUser,
	authKind,
	requireAuth,
	organizations,
	workspaces,
	onSwitchOrLogout,
	onNotice,
	onError,
}: AccountViewProps) {
	const [tokens, setTokens] = useState<AccessTokenDto[]>([]);
	const [loadingTokens, setLoadingTokens] = useState(true);
	const [showCreateModal, setShowCreateModal] = useState(false);
	const [tokenName, setTokenName] = useState("");
	const [tokenScope, setTokenScope] = useState<AccessTokenScope>("read");
	const [expiresPreset, setExpiresPreset] = useState<string>("30");
	const [orgScopeMode, setOrgScopeMode] = useState<"inherit" | "custom">("inherit");
	const [selectedOrgIds, setSelectedOrgIds] = useState<string[]>([]);
	const [workspaceScopeMode, setWorkspaceScopeMode] = useState<"inherit" | "custom">("inherit");
	const [selectedWorkspaceIds, setSelectedWorkspaceIds] = useState<string[]>([]);
	const [creatingToken, setCreatingToken] = useState(false);
	const [revokingId, setRevokingId] = useState<string | null>(null);
	const [createdSecret, setCreatedSecret] = useState<{ token: AccessTokenDto; rawToken: string } | null>(null);

	const [currentPassword, setCurrentPassword] = useState("");
	const [newPassword, setNewPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [changingPassword, setChangingPassword] = useState(false);

	const orgNameById = useMemo(() => new Map(organizations.map((org) => [org.id, org.name])), [organizations]);
	const workspaceById = useMemo(() => new Map(workspaces.map((ws) => [ws.id, ws])), [workspaces]);
	const selectableWorkspaces = useMemo(
		() =>
			orgScopeMode === "custom" && selectedOrgIds.length > 0
				? workspaces.filter((ws) => Boolean(ws.orgId && selectedOrgIds.includes(ws.orgId)))
				: workspaces,
		[workspaces, orgScopeMode, selectedOrgIds],
	);
	const activeTokens = useMemo(() => tokens.filter((t) => tokenStatus(t).active), [tokens]);
	const inactiveTokens = useMemo(() => tokens.filter((t) => !tokenStatus(t).active), [tokens]);

	const resetCreateForm = () => {
		setTokenName("");
		setTokenScope("read");
		setExpiresPreset("30");
		setOrgScopeMode("inherit");
		setSelectedOrgIds([]);
		setWorkspaceScopeMode("inherit");
		setSelectedWorkspaceIds([]);
	};

	const closeCreateModal = () => {
		if (creatingToken) return;
		setShowCreateModal(false);
	};

	const toggleOrgSelection = (orgId: string) => {
		setSelectedOrgIds((prev) => {
			const next = prev.includes(orgId) ? prev.filter((id) => id !== orgId) : [...prev, orgId];
			if (next.length > 0) {
				setSelectedWorkspaceIds((prevWs) =>
					prevWs.filter((wsId) => {
						const ws = workspaceById.get(wsId);
						return Boolean(ws?.orgId && next.includes(ws.orgId));
					}),
				);
			}
			return next;
		});
	};

	const toggleWorkspaceSelection = (workspaceId: string) => {
		setSelectedWorkspaceIds((prev) =>
			prev.includes(workspaceId) ? prev.filter((id) => id !== workspaceId) : [...prev, workspaceId],
		);
	};

	const loadTokens = useCallback(async () => {
		setLoadingTokens(true);
		try {
			const res = await listAccessTokens();
			setTokens(res.tokens ?? []);
		} catch (err) {
			onError(err instanceof Error ? err.message : "加载访问令牌失败");
		} finally {
			setLoadingTokens(false);
		}
	}, [onError]);

	useEffect(() => {
		void loadTokens();
	}, [loadTokens]);

	const handleCreateToken = async (e: FormEvent) => {
		e.preventDefault();
		const trimmed = tokenName.trim();
		if (!trimmed) {
			onError("请填写访问令牌名称");
			return;
		}
		if (orgScopeMode === "custom" && selectedOrgIds.length === 0) {
			onError("已选择限制组织范围，请至少勾选一个组织或切回默认范围");
			return;
		}
		if (workspaceScopeMode === "custom" && selectedWorkspaceIds.length === 0) {
			onError("已选择限制工作区范围，请至少勾选一个工作区或切回默认范围");
			return;
		}
		setCreatingToken(true);
		try {
			const expiresInDays = expiresPreset === "never" ? null : Number(expiresPreset);
			const res = await createAccessToken({
				name: trimmed,
				scope: tokenScope,
				allowedOrgIds: orgScopeMode === "custom" ? selectedOrgIds : null,
				allowedWorkspaceIds: workspaceScopeMode === "custom" ? selectedWorkspaceIds : null,
				expiresInDays,
			});
			setCreatedSecret(res);
			setTokens((prev) => [res.token, ...prev]);
			resetCreateForm();
			setShowCreateModal(false);
			onNotice(`已生成访问令牌「${res.token.name}」，请立即复制保存`);
		} catch (err) {
			onError(err instanceof Error ? err.message : "生成访问令牌失败");
		} finally {
			setCreatingToken(false);
		}
	};

	const handleRevokeToken = async (token: AccessTokenDto) => {
		setRevokingId(token.id);
		try {
			await revokeAccessToken(token.id);
			const revokedAt = new Date().toISOString();
			setTokens((prev) => prev.map((item) => (item.id === token.id ? { ...item, revokedAt } : item)));
			if (createdSecret?.token.id === token.id) {
				setCreatedSecret(null);
			}
			onNotice(`已吊销访问令牌「${token.name}」`);
		} catch (err) {
			onError(err instanceof Error ? err.message : "吊销访问令牌失败");
		} finally {
			setRevokingId(null);
		}
	};

	const copyText = async (text: string, label: string) => {
		try {
			await navigator.clipboard.writeText(text);
			onNotice(`已复制${label}`);
		} catch {
			onError("无法访问剪贴板，请手动选中复制");
		}
	};

	const handleChangePassword = async (e: FormEvent) => {
		e.preventDefault();
		if (newPassword.length < 8) {
			onError("新密码长度至少需要 8 位");
			return;
		}
		if (newPassword !== confirmPassword) {
			onError("两次输入的新密码不一致");
			return;
		}
		setChangingPassword(true);
		try {
			await changeAccountPassword({ currentPassword, newPassword });
			setCurrentPassword("");
			setNewPassword("");
			setConfirmPassword("");
			onNotice("密码已更新，其他登录会话已失效");
		} catch (err) {
			onError(err instanceof Error ? err.message : "修改密码失败");
		} finally {
			setChangingPassword(false);
		}
	};

	const displayName = accountUser?.displayName ?? currentUser?.name ?? "本地所有者";
	const email = accountUser?.email ?? "owner@localhost";
	const roleLabel =
		accountUser?.platformRole === "super_admin"
			? "超级管理员"
			: currentUser?.permissionRole === "owner"
				? "本机所有者"
				: "团队成员";
	const authModeLabel =
		authKind === "loopback"
			? "本机个人版（loopback 免登录）"
			: requireAuth
				? "团队版账号会话（PA_REQUIRE_AUTH=1）"
				: "账号会话";
	const origin = typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:4310";
	const exampleCliCommand = createdSecret
		? `PA_TOKEN=${createdSecret.rawToken} node .agents/skills/pa-matter-retrospective/scripts/inspect-matter.mjs ${origin}/#/chats/<matterId> --sessions`
		: "";
	const scopeSummary =
		orgScopeMode === "inherit" && workspaceScopeMode === "inherit"
			? "默认继承当前账号的组织与工作区范围"
			: [
					orgScopeMode === "custom" ? `组织：已选 ${selectedOrgIds.length} 个` : "组织：继承账号",
					workspaceScopeMode === "custom" ? `工作区：已选 ${selectedWorkspaceIds.length} 个` : "工作区：继承账号",
				].join(" · ");

	const renderTokenRow = (token: AccessTokenDto) => {
		const st = tokenStatus(token);
		return (
			<div
				key={token.id}
				className={cn(
					"flex items-center justify-between gap-3 px-3 py-2.5 border border-line rounded-md bg-sidebar flex-wrap",
					!st.active && "opacity-65",
				)}
			>
				<div className="min-w-0 flex-1 flex flex-col gap-1">
					<div className="flex items-center gap-2 flex-wrap">
						<strong className="text-sm font-semibold text-ink">{token.name}</strong>
						<code className="font-mono text-xs text-ink-muted">{token.tokenPrefix}…</code>
						<Badge tone={token.scope === "read" ? "success" : "warn"}>
							{token.scope === "read" ? "只读" : "完整"}
						</Badge>
						<Badge tone={st.tone} dot>
							{st.label}
						</Badge>
					</div>
					<div className="flex items-center flex-wrap gap-1.5 text-micro text-ink-muted">
						<span>
							组织：
							{token.allowedOrgIds?.length
								? token.allowedOrgIds.map((id) => orgNameById.get(id) ?? id).join("、")
								: "继承账号范围"}
						</span>
						<span>·</span>
						<span>
							工作区：
							{token.allowedWorkspaceIds?.length
								? token.allowedWorkspaceIds.map((id) => workspaceById.get(id)?.name ?? id).join("、")
								: "继承账号范围"}
						</span>
					</div>
					<div className="flex items-center flex-wrap gap-1.5 text-micro text-ink-muted">
						<span>创建于 {formatDateTime(token.createdAt)}</span>
						<span>·</span>
						<span>{token.expiresAt ? `过期于 ${formatDateTime(token.expiresAt)}` : "永不过期"}</span>
						<span>·</span>
						<span>{token.lastUsedAt ? `最近使用 ${formatDateTime(token.lastUsedAt)}` : "尚未使用"}</span>
					</div>
				</div>
				{st.active && (
					<div className="flex items-center gap-2 shrink-0">
						<Button
							variant="secondary"
							size="xs"
							disabled={revokingId === token.id}
							onClick={() => void handleRevokeToken(token)}
						>
							{revokingId === token.id ? "吊销中…" : "吊销"}
						</Button>
					</div>
				)}
			</div>
		);
	};

	return (
		<PageShell maxWidth="wide">
			<PaneHeader
				title="个人账号"
				subtitle="当前登录身份、个人访问令牌（Access Token）与账号安全"
				actions={
					onSwitchOrLogout && (
						<Button variant="secondary" size="sm" onClick={onSwitchOrLogout}>
							{authKind === "loopback" ? "切换账号" : "退出登录"}
						</Button>
					)
				}
			/>

			<div className="mt-4 flex flex-col gap-5">
				<section className="flex flex-col gap-2.5" aria-label="账号信息">
					<div className="flex items-center justify-between gap-2 flex-wrap">
						<h2 className="m-0 text-md font-semibold text-ink">账号信息</h2>
						<Badge tone="success" dot>
							{roleLabel}
						</Badge>
					</div>
					<Card padding="md">
						<div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
							<div className="bg-sidebar border border-line rounded-md px-3 py-2 flex flex-col gap-0.5 min-w-0">
								<span className="text-micro font-semibold text-ink-muted">显示名称</span>
								<span className="text-xs text-ink leading-normal break-words">{displayName}</span>
							</div>
							<div className="bg-sidebar border border-line rounded-md px-3 py-2 flex flex-col gap-0.5 min-w-0">
								<span className="text-micro font-semibold text-ink-muted">账号邮箱</span>
								<span className="text-xs text-ink font-mono leading-normal break-all">{email}</span>
							</div>
							<div className="bg-sidebar border border-line rounded-md px-3 py-2 flex flex-col gap-0.5 min-w-0">
								<span className="text-micro font-semibold text-ink-muted">当前认证方式</span>
								<span className="text-xs text-ink leading-normal break-words">{authModeLabel}</span>
							</div>
							{accountUser && (
								<div className="bg-sidebar border border-line rounded-md px-3 py-2 flex flex-col gap-0.5 min-w-0">
									<span className="text-micro font-semibold text-ink-muted">配额与能力</span>
									<span className="text-xs text-ink leading-normal break-words">
										组织 {accountUser.maxOrgs} · 并发 {accountUser.maxActiveDispatches} · 个人角色{" "}
										{accountUser.maxPersonalRoles} · {accountUser.canDispatchAi ? "可调度 AI" : "只读协作"}
									</span>
								</div>
							)}
						</div>
					</Card>
				</section>

				<section className="flex flex-col gap-2.5" aria-label="访问令牌">
					<div className="flex items-center justify-between gap-2 flex-wrap">
						<h2 className="m-0 text-md font-semibold text-ink">访问令牌（Access Token）</h2>
						<div className="flex items-center gap-2">
							<Button variant="secondary" size="sm" onClick={() => void loadTokens()} disabled={loadingTokens}>
								{loadingTokens ? "刷新中…" : "刷新"}
							</Button>
							<Button
								variant="primary"
								size="sm"
								onClick={() => {
									resetCreateForm();
									setShowCreateModal(true);
								}}
							>
								+ 新建访问令牌
							</Button>
						</div>
					</div>

					<Card padding="md" className="flex flex-col gap-3.5">
						<p className="m-0 text-xs text-ink-muted leading-normal">
							用于 CLI 或复盘脚本通过{" "}
							<code className="font-mono text-xs bg-subtle px-1 py-0.5 rounded-xs">
								Authorization: Bearer &lt;token&gt;
							</code>{" "}
							访问接口。默认继承当前账号的组织与工作区权限，也可在新建时按需收窄范围。
						</p>

						{createdSecret && (
							<output className="border border-line-strong bg-sidebar rounded-md p-3 flex flex-col gap-2">
								<div className="flex items-center justify-between gap-2.5 flex-wrap">
									<div className="flex items-center gap-2 flex-wrap">
										<strong className="text-sm text-ink">新令牌「{createdSecret.token.name}」已生成</strong>
										<Badge tone={createdSecret.token.scope === "read" ? "success" : "warn"}>
											{createdSecret.token.scope === "read" ? "只读" : "完整权限"}
										</Badge>
									</div>
									<Button variant="secondary" size="xs" onClick={() => setCreatedSecret(null)}>
										我已保存
									</Button>
								</div>
								<p className="m-0 text-xs text-ink-muted">明文仅展示这一次，刷新或关闭后将无法再次查看。</p>
								<div className="flex flex-col sm:flex-row sm:items-center gap-2">
									<code className="flex-1 min-w-0 px-2.5 py-1.5 rounded-sm border border-line bg-surface font-mono text-xs overflow-x-auto whitespace-nowrap">
										{createdSecret.rawToken}
									</code>
									<Button
										variant="primary"
										size="xs"
										onClick={() => void copyText(createdSecret.rawToken, " Access Token")}
									>
										复制 Token
									</Button>
								</div>
								<div className="flex flex-col sm:flex-row sm:items-center gap-2">
									<code className="flex-1 min-w-0 px-2.5 py-1.5 rounded-sm border border-line bg-surface font-mono text-xs overflow-x-auto whitespace-nowrap">
										{exampleCliCommand}
									</code>
									<Button
										variant="secondary"
										size="xs"
										onClick={() => void copyText(exampleCliCommand, "复盘命令")}
									>
										复制复盘命令
									</Button>
								</div>
							</output>
						)}

						<div className="flex flex-col gap-2 pt-2 border-t border-line">
							{loadingTokens ? (
								<p className="m-0 py-2 text-xs text-ink-muted">正在加载访问令牌…</p>
							) : activeTokens.length === 0 ? (
								<EmptyState
									compact
									title="暂无有效访问令牌"
									description="点击右上角「+ 新建访问令牌」生成一个只读令牌即可用于复盘与查询。"
								/>
							) : (
								activeTokens.map(renderTokenRow)
							)}
						</div>

						{inactiveTokens.length > 0 && (
							<SettingsDisclosure summary={`查看已吊销或已过期的令牌（${inactiveTokens.length}）`}>
								<div className="flex flex-col gap-2">{inactiveTokens.map(renderTokenRow)}</div>
							</SettingsDisclosure>
						)}
					</Card>
				</section>

				{authKind === "session" && accountUser && (
					<section className="flex flex-col gap-2.5" aria-label="账号安全">
						<h2 className="m-0 text-md font-semibold text-ink">账号安全</h2>
						<Card padding="md">
							<SettingsDisclosure summary="修改登录密码" className="border-t-0 pt-0">
								<div className="mt-1 flex flex-col gap-3">
									<p className="m-0 text-xs text-ink-muted leading-normal">
										修改密码后，其他设备上的网页会话会被自动登出；已创建的访问令牌不受影响，可按需在上方单独吊销。
									</p>
									<form className="flex flex-col gap-3" onSubmit={(e) => void handleChangePassword(e)}>
										<div className="grid grid-cols-1 md:grid-cols-3 gap-3">
											<FieldGroup label="当前密码" htmlFor="account-pwd-current">
												<Input
													id="account-pwd-current"
													type="password"
													name="currentPassword"
													autoComplete="current-password"
													value={currentPassword}
													onChange={(e) => setCurrentPassword(e.target.value)}
													required
												/>
											</FieldGroup>
											<FieldGroup label="新密码（至少 8 位）" htmlFor="account-pwd-new">
												<Input
													id="account-pwd-new"
													type="password"
													name="newPassword"
													autoComplete="new-password"
													minLength={8}
													value={newPassword}
													onChange={(e) => setNewPassword(e.target.value)}
													required
												/>
											</FieldGroup>
											<FieldGroup label="确认新密码" htmlFor="account-pwd-confirm">
												<Input
													id="account-pwd-confirm"
													type="password"
													name="confirmPassword"
													autoComplete="new-password"
													minLength={8}
													value={confirmPassword}
													onChange={(e) => setConfirmPassword(e.target.value)}
													required
												/>
											</FieldGroup>
										</div>
										<div className="flex items-center gap-2">
											<Button type="submit" variant="primary" size="sm" disabled={changingPassword}>
												{changingPassword ? "更新中…" : "更新密码"}
											</Button>
										</div>
									</form>
								</div>
							</SettingsDisclosure>
						</Card>
					</section>
				)}
			</div>

			<ModalDialog
				open={showCreateModal}
				title="新建访问令牌"
				subtitle="生成后明文仅显示一次，服务端仅保存 SHA-256 哈希"
				size="md"
				closeDisabled={creatingToken}
				onClose={closeCreateModal}
				footer={
					<div className="flex items-center gap-2">
						<Button variant="secondary" size="sm" onClick={closeCreateModal} disabled={creatingToken}>
							取消
						</Button>
						<Button
							type="submit"
							form="create-access-token-form"
							variant="primary"
							size="sm"
							disabled={creatingToken}
						>
							{creatingToken ? "生成中…" : "生成 Access Token"}
						</Button>
					</div>
				}
			>
				<form
					id="create-access-token-form"
					className="flex flex-col gap-3"
					onSubmit={(e) => void handleCreateToken(e)}
				>
					<FieldGroup label="令牌名称" htmlFor="create-token-name">
						<Input
							id="create-token-name"
							type="text"
							name="tokenName"
							autoComplete="off"
							placeholder="例如：复盘脚本 / 本机 CLI"
							maxLength={80}
							value={tokenName}
							onChange={(e) => setTokenName(e.target.value)}
							required
						/>
					</FieldGroup>

					<div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
						<FieldGroup label="权限范围" htmlFor="create-token-scope">
							<Select
								id="create-token-scope"
								value={tokenScope}
								onChange={(e) => setTokenScope(e.target.value as AccessTokenScope)}
							>
								<option value="read">只读（推荐：仅允许 GET 查询）</option>
								<option value="full">完整权限（与当前账号一致）</option>
							</Select>
						</FieldGroup>
						<FieldGroup label="有效期" htmlFor="create-token-expiry">
							<Select
								id="create-token-expiry"
								value={expiresPreset}
								onChange={(e) => setExpiresPreset(e.target.value)}
							>
								<option value="7">7 天</option>
								<option value="30">30 天</option>
								<option value="90">90 天</option>
								<option value="365">365 天</option>
								<option value="never">永不过期</option>
							</Select>
						</FieldGroup>
					</div>

					<SettingsDisclosure summary={`组织与工作区访问范围（${scopeSummary}）`}>
						<div className="mt-1 p-3 border border-line rounded-md bg-sidebar flex flex-col gap-2.5">
							<div className="flex flex-col gap-1.5">
								<span className="text-micro font-semibold text-ink-muted">组织访问范围</span>
								<div className="flex items-center gap-1.5 flex-wrap">
									<Button
										variant={orgScopeMode === "inherit" ? "primary" : "secondary"}
										size="xs"
										aria-pressed={orgScopeMode === "inherit"}
										onClick={() => {
											setOrgScopeMode("inherit");
											setSelectedOrgIds([]);
										}}
									>
										默认（继承当前账号）
									</Button>
									{organizations.length > 0 && (
										<Button
											variant={orgScopeMode === "custom" ? "primary" : "secondary"}
											size="xs"
											aria-pressed={orgScopeMode === "custom"}
											onClick={() => setOrgScopeMode("custom")}
										>
											指定组织
										</Button>
									)}
								</div>
								{orgScopeMode === "custom" && (
									<div className="flex items-center gap-1.5 flex-wrap">
										{organizations.map((org) => {
											const checked = selectedOrgIds.includes(org.id);
											return (
												<Button
													key={org.id}
													variant={checked ? "primary" : "secondary"}
													size="xs"
													aria-pressed={checked}
													onClick={() => toggleOrgSelection(org.id)}
												>
													{checked ? "✓ " : ""}
													{org.name}
												</Button>
											);
										})}
									</div>
								)}
							</div>

							<div className="flex flex-col gap-1.5">
								<span className="text-micro font-semibold text-ink-muted">工作区访问范围</span>
								<div className="flex items-center gap-1.5 flex-wrap">
									<Button
										variant={workspaceScopeMode === "inherit" ? "primary" : "secondary"}
										size="xs"
										aria-pressed={workspaceScopeMode === "inherit"}
										onClick={() => {
											setWorkspaceScopeMode("inherit");
											setSelectedWorkspaceIds([]);
										}}
									>
										默认（继承当前账号）
									</Button>
									{selectableWorkspaces.length > 0 && (
										<Button
											variant={workspaceScopeMode === "custom" ? "primary" : "secondary"}
											size="xs"
											aria-pressed={workspaceScopeMode === "custom"}
											onClick={() => setWorkspaceScopeMode("custom")}
										>
											指定工作区
										</Button>
									)}
								</div>
								{workspaceScopeMode === "custom" && (
									<div className="flex items-center gap-1.5 flex-wrap">
										{selectableWorkspaces.length === 0 ? (
											<span className="text-xs text-ink-muted">所选组织下暂无可见工作区</span>
										) : (
											selectableWorkspaces.map((ws) => {
												const checked = selectedWorkspaceIds.includes(ws.id);
												const orgLabel = ws.orgId ? orgNameById.get(ws.orgId) : undefined;
												return (
													<Button
														key={ws.id}
														variant={checked ? "primary" : "secondary"}
														size="xs"
														aria-pressed={checked}
														onClick={() => toggleWorkspaceSelection(ws.id)}
													>
														{checked ? "✓ " : ""}
														{orgLabel ? `${orgLabel} / ${ws.name}` : ws.name}
													</Button>
												);
											})
										)}
									</div>
								)}
							</div>
						</div>
					</SettingsDisclosure>
				</form>
			</ModalDialog>
		</PageShell>
	);
}
