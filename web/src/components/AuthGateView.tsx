interface AuthGateViewProps {
	status: "checking" | "unauthenticated";
	permissionRequired: boolean;
	authError: string | null;
	authTokenInput: string;
	onTokenInputChange: (value: string) => void;
	onSubmitInvite: (token: string) => void;
	onRestoreOwner: () => void;
}

/** Fullscreen gate shown during session verification or restricted LAN invite authentication. */
export function AuthGateView({
	status,
	permissionRequired,
	authError,
	authTokenInput,
	onTokenInputChange,
	onSubmitInvite,
	onRestoreOwner,
}: AuthGateViewProps) {
	if (status === "checking") {
		return (
			<div className="auth-gate-shell">
				<div className="auth-gate-card">
					<div className="brand-mark">PA</div>
					<h1>正在连接团队协同工作台...</h1>
					<p className="muted-hint">正在校验访问身份与工作台状态</p>
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
						<h1>加入受限协同工作台</h1>
						<p className="muted-hint">
							当前服务运行在内网协同模式，需要团队所有者分享的个人邀请链接或口令方可加入讨论。
						</p>
					</div>
				</div>
				{authError && <div className="approval-card">{authError}</div>}
				<form
					className="auth-gate-form"
					onSubmit={(e) => {
						e.preventDefault();
						onSubmitInvite(authTokenInput);
					}}
				>
					<input
						className="input-field"
						value={authTokenInput}
						onChange={(e) => onTokenInputChange(e.target.value)}
						placeholder="粘贴邀请口令（如 inv_xxx）..."
					/>
					<button type="submit" className="btn-pill-dark" disabled={!authTokenInput.trim()}>
						进入协同房间
					</button>
				</form>
				{!permissionRequired && (
					<button type="button" className="btn-inline" onClick={onRestoreOwner}>
						退出失效的协同体验，返回本机所有者视图
					</button>
				)}
			</div>
		</div>
	);
}
