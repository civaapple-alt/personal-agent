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
import { ModalDialog } from "../primitives/ModalDialog.tsx";

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

function tokenStatus(token: AccessTokenDto): { label: string; badgeClass: string; active: boolean } {
	if (token.revokedAt) return { label: "已吊销", badgeClass: "rsi-status-superseded", active: false };
	if (token.expiresAt && Date.parse(token.expiresAt) <= Date.now()) {
		return { label: "已过期", badgeClass: "rsi-status-rejected", active: false };
	}
	return { label: "有效", badgeClass: "rsi-status-verified", active: true };
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
			<div key={token.id} className={`token-row ${st.active ? "" : "is-inactive"}`}>
				<div className="token-row-main">
					<div className="ui-inline-head">
						<strong>{token.name}</strong>
						<code className="token-prefix">{token.tokenPrefix}…</code>
						<span
							className={`rsi-badge ${token.scope === "read" ? "rsi-status-verified" : "rsi-status-candidate"}`}
						>
							{token.scope === "read" ? "只读" : "完整"}
						</span>
						<span className={`rsi-badge ${st.badgeClass}`}>{st.label}</span>
					</div>
					<div className="token-row-meta">
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
					<div className="token-row-meta">
						<span>创建于 {formatDateTime(token.createdAt)}</span>
						<span>·</span>
						<span>{token.expiresAt ? `过期于 ${formatDateTime(token.expiresAt)}` : "永不过期"}</span>
						<span>·</span>
						<span>{token.lastUsedAt ? `最近使用 ${formatDateTime(token.lastUsedAt)}` : "尚未使用"}</span>
					</div>
				</div>
				{st.active && (
					<div className="actions-row compact">
						<button
							type="button"
							className="btn-pill-outline"
							disabled={revokingId === token.id}
							onClick={() => void handleRevokeToken(token)}
						>
							{revokingId === token.id ? "吊销中…" : "吊销"}
						</button>
					</div>
				)}
			</div>
		);
	};

	return (
		<div className="subpage-scroll">
			<div className="subpage-inner wide">
				<div className="pane-header-row">
					<div className="pane-header">
						<h1>个人账号</h1>
						<p>当前登录身份、个人访问令牌（Access Token）与账号安全</p>
					</div>
					{onSwitchOrLogout && (
						<div className="actions-row compact">
							<button type="button" className="btn-pill-outline" onClick={onSwitchOrLogout}>
								{authKind === "loopback" ? "切换账号" : "退出登录"}
							</button>
						</div>
					)}
				</div>

				<div className="ui-sections-stack">
					<section className="ui-section" aria-label="账号信息">
						<div className="ui-section-head">
							<h2 className="ui-section-title">账号信息</h2>
							<span className="rsi-badge rsi-status-verified">{roleLabel}</span>
						</div>
						<div className="ui-card settings-base-card">
							<div className="account-kv-grid">
								<div className="settings-kv-item">
									<span className="settings-kv-label">显示名称</span>
									<span className="settings-kv-value">{displayName}</span>
								</div>
								<div className="settings-kv-item">
									<span className="settings-kv-label">账号邮箱</span>
									<span className="settings-kv-value mono-wrap">{email}</span>
								</div>
								<div className="settings-kv-item">
									<span className="settings-kv-label">当前认证方式</span>
									<span className="settings-kv-value">{authModeLabel}</span>
								</div>
								{accountUser && (
									<div className="settings-kv-item">
										<span className="settings-kv-label">配额与能力</span>
										<span className="settings-kv-value">
											组织 {accountUser.maxOrgs} · 并发 {accountUser.maxActiveDispatches} · 个人角色{" "}
											{accountUser.maxPersonalRoles} · {accountUser.canDispatchAi ? "可调度 AI" : "只读协作"}
										</span>
									</div>
								)}
							</div>
						</div>
					</section>

					<section className="ui-section" aria-label="访问令牌">
						<div className="ui-section-head">
							<h2 className="ui-section-title">访问令牌（Access Token）</h2>
							<div className="actions-row compact">
								<button
									type="button"
									className="btn-pill-outline"
									onClick={() => void loadTokens()}
									disabled={loadingTokens}
								>
									{loadingTokens ? "刷新中…" : "刷新"}
								</button>
								<button
									type="button"
									className="btn-pill-dark"
									onClick={() => {
										resetCreateForm();
										setShowCreateModal(true);
									}}
								>
									+ 新建访问令牌
								</button>
							</div>
						</div>

						<div className="ui-card account-token-card">
							<p className="muted-hint">
								用于 CLI 或复盘脚本通过 <code>Authorization: Bearer &lt;token&gt;</code>{" "}
								访问接口。默认继承当前账号的组织与工作区权限，也可在新建时按需收窄范围。
							</p>

							{createdSecret && (
								<output className="token-secret-box">
									<div className="token-secret-head">
										<div className="ui-inline-head">
											<strong>新令牌「{createdSecret.token.name}」已生成</strong>
											<span
												className={`rsi-badge ${createdSecret.token.scope === "read" ? "rsi-status-verified" : "rsi-status-candidate"}`}
											>
												{createdSecret.token.scope === "read" ? "只读" : "完整权限"}
											</span>
										</div>
										<button type="button" className="btn-pill-outline" onClick={() => setCreatedSecret(null)}>
											我已保存
										</button>
									</div>
									<p className="muted-hint">明文仅展示这一次，刷新或关闭后将无法再次查看。</p>
									<div className="token-secret-row">
										<code className="token-secret-value">{createdSecret.rawToken}</code>
										<button
											type="button"
											className="btn-pill-dark"
											onClick={() => void copyText(createdSecret.rawToken, " Access Token")}
										>
											复制 Token
										</button>
									</div>
									<div className="token-secret-row">
										<code className="token-secret-cmd">{exampleCliCommand}</code>
										<button
											type="button"
											className="btn-pill-outline"
											onClick={() => void copyText(exampleCliCommand, "复盘命令")}
										>
											复制复盘命令
										</button>
									</div>
								</output>
							)}

							<div className="token-list">
								{loadingTokens ? (
									<p className="ui-empty-note compact">正在加载访问令牌…</p>
								) : activeTokens.length === 0 ? (
									<p className="ui-empty-note compact">
										暂无有效访问令牌。点击右上角「+ 新建访问令牌」生成一个只读令牌即可用于复盘与查询。
									</p>
								) : (
									activeTokens.map(renderTokenRow)
								)}
							</div>

							{inactiveTokens.length > 0 && (
								<details className="settings-details">
									<summary>查看已吊销或已过期的令牌（{inactiveTokens.length}）</summary>
									<div className="token-list-nested">{inactiveTokens.map(renderTokenRow)}</div>
								</details>
							)}
						</div>
					</section>

					{authKind === "session" && accountUser && (
						<section className="ui-section" aria-label="账号安全">
							<div className="ui-section-head">
								<h2 className="ui-section-title">账号安全</h2>
							</div>
							<div className="ui-card account-token-card">
								<details className="settings-details account-details-plain">
									<summary>修改登录密码</summary>
									<div className="account-details-body">
										<p className="muted-hint">
											修改密码后，其他设备上的网页会话会被自动登出；已创建的访问令牌不受影响，可按需在上方单独吊销。
										</p>
										<form className="account-token-form" onSubmit={(e) => void handleChangePassword(e)}>
											<div className="account-password-grid">
												<label className="auth-field-label">
													<span>当前密码</span>
													<input
														type="password"
														name="currentPassword"
														className="input-field"
														autoComplete="current-password"
														value={currentPassword}
														onChange={(e) => setCurrentPassword(e.target.value)}
														required
													/>
												</label>
												<label className="auth-field-label">
													<span>新密码（至少 8 位）</span>
													<input
														type="password"
														name="newPassword"
														className="input-field"
														autoComplete="new-password"
														minLength={8}
														value={newPassword}
														onChange={(e) => setNewPassword(e.target.value)}
														required
													/>
												</label>
												<label className="auth-field-label">
													<span>确认新密码</span>
													<input
														type="password"
														name="confirmPassword"
														className="input-field"
														autoComplete="new-password"
														minLength={8}
														value={confirmPassword}
														onChange={(e) => setConfirmPassword(e.target.value)}
														required
													/>
												</label>
											</div>
											<div className="actions-row compact">
												<button type="submit" className="btn-pill-dark" disabled={changingPassword}>
													{changingPassword ? "更新中…" : "更新密码"}
												</button>
											</div>
										</form>
									</div>
								</details>
							</div>
						</section>
					)}
				</div>
			</div>

			<ModalDialog
				open={showCreateModal}
				title="新建访问令牌"
				subtitle="生成后明文仅显示一次，服务端仅保存 SHA-256 哈希"
				size="md"
				closeDisabled={creatingToken}
				onClose={closeCreateModal}
				footer={
					<div className="actions-row compact">
						<button
							type="button"
							className="btn-pill-outline"
							onClick={closeCreateModal}
							disabled={creatingToken}
						>
							取消
						</button>
						<button
							type="submit"
							form="create-access-token-form"
							className="btn-pill-dark"
							disabled={creatingToken}
						>
							{creatingToken ? "生成中…" : "生成 Access Token"}
						</button>
					</div>
				}
			>
				<form
					id="create-access-token-form"
					className="account-token-form"
					onSubmit={(e) => void handleCreateToken(e)}
				>
					<label className="auth-field-label">
						<span>令牌名称</span>
						<input
							type="text"
							name="tokenName"
							className="input-field"
							autoComplete="off"
							placeholder="例如：复盘脚本 / 本机 CLI"
							maxLength={80}
							value={tokenName}
							onChange={(e) => setTokenName(e.target.value)}
							required
						/>
					</label>

					<div className="token-modal-pair">
						<label className="auth-field-label">
							<span>权限范围</span>
							<select
								className="input-field"
								value={tokenScope}
								onChange={(e) => setTokenScope(e.target.value as AccessTokenScope)}
							>
								<option value="read">只读（推荐：仅允许 GET 查询）</option>
								<option value="full">完整权限（与当前账号一致）</option>
							</select>
						</label>
						<label className="auth-field-label">
							<span>有效期</span>
							<select
								className="input-field"
								value={expiresPreset}
								onChange={(e) => setExpiresPreset(e.target.value)}
							>
								<option value="7">7 天</option>
								<option value="30">30 天</option>
								<option value="90">90 天</option>
								<option value="365">365 天</option>
								<option value="never">永不过期</option>
							</select>
						</label>
					</div>

					<details className="settings-details">
						<summary>组织与工作区访问范围（{scopeSummary}）</summary>
						<div className="token-scope-box">
							<div className="token-scope-row">
								<span className="settings-kv-label">组织访问范围</span>
								<div className="actions-row compact">
									<button
										type="button"
										className={`choice-chip ${orgScopeMode === "inherit" ? "active" : ""}`}
										onClick={() => {
											setOrgScopeMode("inherit");
											setSelectedOrgIds([]);
										}}
									>
										默认（继承当前账号）
									</button>
									{organizations.length > 0 && (
										<button
											type="button"
											className={`choice-chip ${orgScopeMode === "custom" ? "active" : ""}`}
											onClick={() => setOrgScopeMode("custom")}
										>
											指定组织
										</button>
									)}
								</div>
								{orgScopeMode === "custom" && (
									<div className="actions-row compact">
										{organizations.map((org) => {
											const checked = selectedOrgIds.includes(org.id);
											return (
												<button
													key={org.id}
													type="button"
													className={`choice-chip ${checked ? "active" : ""}`}
													onClick={() => toggleOrgSelection(org.id)}
												>
													{checked ? "✓ " : ""}
													{org.name}
												</button>
											);
										})}
									</div>
								)}
							</div>

							<div className="token-scope-row">
								<span className="settings-kv-label">工作区访问范围</span>
								<div className="actions-row compact">
									<button
										type="button"
										className={`choice-chip ${workspaceScopeMode === "inherit" ? "active" : ""}`}
										onClick={() => {
											setWorkspaceScopeMode("inherit");
											setSelectedWorkspaceIds([]);
										}}
									>
										默认（继承当前账号）
									</button>
									{selectableWorkspaces.length > 0 && (
										<button
											type="button"
											className={`choice-chip ${workspaceScopeMode === "custom" ? "active" : ""}`}
											onClick={() => setWorkspaceScopeMode("custom")}
										>
											指定工作区
										</button>
									)}
								</div>
								{workspaceScopeMode === "custom" && (
									<div className="actions-row compact">
										{selectableWorkspaces.length === 0 ? (
											<span className="muted-hint">所选组织下暂无可见工作区</span>
										) : (
											selectableWorkspaces.map((ws) => {
												const checked = selectedWorkspaceIds.includes(ws.id);
												const orgLabel = ws.orgId ? orgNameById.get(ws.orgId) : undefined;
												return (
													<button
														key={ws.id}
														type="button"
														className={`choice-chip ${checked ? "active" : ""}`}
														onClick={() => toggleWorkspaceSelection(ws.id)}
													>
														{checked ? "✓ " : ""}
														{orgLabel ? `${orgLabel} / ${ws.name}` : ws.name}
													</button>
												);
											})
										)}
									</div>
								)}
							</div>
						</div>
					</details>
				</form>
			</ModalDialog>
		</div>
	);
}
