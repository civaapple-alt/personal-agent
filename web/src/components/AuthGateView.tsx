import { useEffect, useState } from "react";
import type { AccountUserDto, OrgInvitePreviewDto, OrgMemberRole, RegistrationMode } from "../api.ts";

export interface AuthGateViewProps {
	status: "checking" | "unauthenticated";
	permissionRequired: boolean;
	needsAdminSetup: boolean;
	pendingApproval: boolean;
	registrationMode: RegistrationMode;
	accountUser: AccountUserDto | null;
	authError: string | null;
	orgInviteToken: string;
	invitePreview?: OrgInvitePreviewDto | null;
	preferredTab?: "login" | "register" | null;
	onSetupAdmin: (input: { email: string; password: string; displayName: string }) => Promise<void>;
	onLoginEmail: (input: { email: string; password: string; inviteToken?: string }) => Promise<void>;
	onRegisterEmail: (input: {
		email: string;
		password: string;
		displayName: string;
		inviteToken?: string;
	}) => Promise<void>;
	onRefreshSession: () => Promise<void>;
	onLogoutPending: () => Promise<void>;
	onRestoreOwner: () => void;
}

type AuthTab = "login" | "register";

const ORG_ROLE_LABEL: Record<OrgMemberRole, string> = {
	org_owner: "组织所有者",
	org_admin: "组织管理员",
	org_member: "普通成员",
	org_viewer: "只读访客",
};

/** Fullscreen gate shown for account setup, login/registration, admin review wait, or organization invitations. */
export function AuthGateView({
	status,
	permissionRequired,
	needsAdminSetup,
	pendingApproval,
	registrationMode,
	accountUser,
	authError,
	orgInviteToken,
	invitePreview = null,
	preferredTab = null,
	onSetupAdmin,
	onLoginEmail,
	onRegisterEmail,
	onRefreshSession,
	onLogoutPending,
	onRestoreOwner,
}: AuthGateViewProps) {
	const [activeTab, setActiveTab] = useState<AuthTab>(() => {
		if (preferredTab) return preferredTab;
		if (orgInviteToken) return "register";
		return "login";
	});
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [displayName, setDisplayName] = useState("");
	const [inviteInput, setInviteInput] = useState(orgInviteToken);
	const [submitting, setSubmitting] = useState(false);

	useEffect(() => {
		if (orgInviteToken) {
			setInviteInput(orgInviteToken);
			if (!preferredTab) {
				setActiveTab("register");
			}
		}
	}, [orgInviteToken, preferredTab]);

	useEffect(() => {
		if (preferredTab) {
			setActiveTab(preferredTab);
		}
	}, [preferredTab]);

	if (status === "checking") {
		return (
			<div className="auth-gate-shell">
				<div className="auth-gate-card">
					<div className="brand-mark">PA</div>
					<h1>正在连接团队协同工作台…</h1>
					<p className="muted-hint">正在校验访问身份与工作台状态</p>
				</div>
			</div>
		);
	}

	if (needsAdminSetup) {
		return (
			<div className="auth-gate-shell">
				<div className="auth-gate-card">
					<div className="auth-gate-head">
						<span className="brand-mark">PA</span>
						<div>
							<h1>初始化超级管理员账号</h1>
							<p className="muted-hint">
								当前服务首次启用团队权限模式，请先创建平台超级管理员账号以管理注册策略、组织配额与安全边界。
							</p>
						</div>
					</div>
					{authError && <div className="approval-card">{authError}</div>}
					<form
						className="auth-gate-form"
						onSubmit={(e) => {
							e.preventDefault();
							if (submitting) return;
							setSubmitting(true);
							void onSetupAdmin({ email, password, displayName }).finally(() => setSubmitting(false));
						}}
					>
						<label className="auth-field-label">
							<span>管理员显示名称</span>
							<input
								className="input-field"
								name="name"
								autoComplete="name"
								value={displayName}
								onChange={(e) => setDisplayName(e.target.value)}
								placeholder="例如：Alice（平台管理员）"
								required
							/>
						</label>
						<label className="auth-field-label">
							<span>管理员邮箱</span>
							<input
								className="input-field"
								type="email"
								name="email"
								autoComplete="email"
								spellCheck={false}
								value={email}
								onChange={(e) => setEmail(e.target.value)}
								placeholder="admin@company.com"
								required
							/>
						</label>
						<label className="auth-field-label">
							<span>登录密码（至少 8 位）</span>
							<input
								className="input-field"
								type="password"
								name="new-password"
								autoComplete="new-password"
								minLength={8}
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								placeholder="输入至少 8 位密码…"
								required
							/>
						</label>
						<button
							type="submit"
							className="btn-pill-dark"
							disabled={submitting || !email.trim() || password.length < 8 || !displayName.trim()}
						>
							{submitting ? "正在初始化…" : "创建超级管理员并进入工作台"}
						</button>
					</form>
				</div>
			</div>
		);
	}

	if (pendingApproval) {
		return (
			<div className="auth-gate-shell">
				<div className="auth-gate-card">
					<div className="auth-gate-head">
						<span className="brand-mark">PA</span>
						<div>
							<h1>账号待超级管理员审核</h1>
							<p className="muted-hint">
								账号 {accountUser?.email ?? ""} 已注册成功
								{invitePreview?.valid && invitePreview.orgName
									? `并已绑定受邀组织「${invitePreview.orgName}」`
									: ""}
								，当前平台处于「开放注册、管理员审核开通」模式。请等待管理员启用并配置配额后再进入。
							</p>
						</div>
					</div>
					{authError && <div className="approval-card">{authError}</div>}
					<div className="auth-actions-row">
						<button type="button" className="btn-pill-dark" onClick={() => void onRefreshSession()}>
							刷新审核状态
						</button>
						<button type="button" className="btn-inline" onClick={() => void onLogoutPending()}>
							退出当前账号
						</button>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="auth-gate-shell">
			<div className="auth-gate-card">
				<div className="auth-gate-head">
					<span className="brand-mark">PA</span>
					<div>
						<h1>Personal Agent 团队工作台</h1>
						<p className="muted-hint">
							{activeTab === "register"
								? registrationMode === "open_review"
									? "使用邮箱密码注册，注册后需超级管理员审核开通并分配配额。"
									: registrationMode === "invite_only"
										? "当前为仅邀请注册模式，请填写邮箱密码与组织邀请码。"
										: "使用邮箱和密码快速注册账号，可创建自己的组织与 AI 团队。"
								: "使用已注册的邮箱和密码登录，管理组织、仓库与 AI 事项。"}
						</p>
					</div>
				</div>

				<div className="auth-tab-strip" role="tablist" aria-label="认证方式">
					<button
						type="button"
						role="tab"
						aria-selected={activeTab === "login"}
						className={activeTab === "login" ? "auth-tab active" : "auth-tab"}
						onClick={() => setActiveTab("login")}
					>
						邮箱登录
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={activeTab === "register"}
						className={activeTab === "register" ? "auth-tab active" : "auth-tab"}
						onClick={() => setActiveTab("register")}
					>
						注册账号
					</button>
				</div>

				{inviteInput && (
					<output className="notice-banner" aria-live="polite">
						{invitePreview
							? invitePreview.valid
								? `受邀以「${ORG_ROLE_LABEL[invitePreview.orgRole ?? "org_member"]}」身份加入组织「${invitePreview.orgName}」，${activeTab === "register" ? "完成注册" : "登录"}后自动生效。`
								: `邀请提示：${invitePreview.reason ?? "该组织邀请链接无效或已过期"}`
							: `检测到组织邀请码，${activeTab === "register" ? "完成注册" : "登录"}后将自动加入对应组织。`}
					</output>
				)}
				{authError && <div className="approval-card">{authError}</div>}

				{activeTab === "login" && (
					<form
						className="auth-gate-form"
						onSubmit={(e) => {
							e.preventDefault();
							if (submitting) return;
							setSubmitting(true);
							void onLoginEmail({
								email,
								password,
								...(inviteInput.trim() ? { inviteToken: inviteInput.trim() } : {}),
							}).finally(() => setSubmitting(false));
						}}
					>
						<label className="auth-field-label">
							<span>邮箱</span>
							<input
								className="input-field"
								type="email"
								name="email"
								autoComplete="username"
								spellCheck={false}
								value={email}
								onChange={(e) => setEmail(e.target.value)}
								placeholder="member@company.com"
								required
							/>
						</label>
						<label className="auth-field-label">
							<span>密码</span>
							<input
								className="input-field"
								type="password"
								name="password"
								autoComplete="current-password"
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								placeholder="输入密码…"
								required
							/>
						</label>
						<button type="submit" className="btn-pill-dark" disabled={submitting || !email.trim() || !password}>
							{submitting ? "正在登录…" : "登录进入工作台"}
						</button>
					</form>
				)}

				{activeTab === "register" && (
					<form
						className="auth-gate-form"
						onSubmit={(e) => {
							e.preventDefault();
							if (submitting) return;
							setSubmitting(true);
							void onRegisterEmail({
								email,
								password,
								displayName,
								...(inviteInput.trim() ? { inviteToken: inviteInput.trim() } : {}),
							}).finally(() => setSubmitting(false));
						}}
					>
						<label className="auth-field-label">
							<span>显示名称</span>
							<input
								className="input-field"
								name="name"
								autoComplete="name"
								value={displayName}
								onChange={(e) => setDisplayName(e.target.value)}
								placeholder="例如：张工 / Leo"
								required
							/>
						</label>
						<label className="auth-field-label">
							<span>邮箱</span>
							<input
								className="input-field"
								type="email"
								name="email"
								autoComplete="email"
								spellCheck={false}
								value={email}
								onChange={(e) => setEmail(e.target.value)}
								placeholder="member@company.com"
								required
							/>
						</label>
						<label className="auth-field-label">
							<span>密码（至少 8 位）</span>
							<input
								className="input-field"
								type="password"
								name="new-password"
								autoComplete="new-password"
								minLength={8}
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								placeholder="至少 8 位密码…"
								required
							/>
						</label>
						<label className="auth-field-label">
							<span>组织邀请码（{registrationMode === "invite_only" ? "必填" : "选填"}）</span>
							<input
								className="input-field"
								name="invite"
								autoComplete="off"
								spellCheck={false}
								value={inviteInput}
								onChange={(e) => setInviteInput(e.target.value)}
								placeholder="orginv_…"
								required={registrationMode === "invite_only"}
							/>
						</label>
						<button
							type="submit"
							className="btn-pill-dark"
							disabled={
								submitting ||
								!displayName.trim() ||
								!email.trim() ||
								password.length < 8 ||
								(registrationMode === "invite_only" && !inviteInput.trim())
							}
						>
							{submitting ? "正在提交…" : "创建账号"}
						</button>
					</form>
				)}

				{!permissionRequired && (
					<button type="button" className="btn-inline" onClick={onRestoreOwner}>
						返回本机免密所有者视图
					</button>
				)}
			</div>
		</div>
	);
}
