/** Copies a collaborator's invitation URL with LAN binding hint on loopback hosts. */
export async function copyCollaboratorInviteUrl(
	col: { name: string; token?: string },
	onNotice: (msg: string) => void,
) {
	if (!col.token) return;
	const inviteUrl = `${window.location.origin}/?invite=${encodeURIComponent(col.token)}`;
	try {
		await navigator.clipboard.writeText(inviteUrl);
		const localHint =
			window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost"
				? "（提示：本机启动时需设置 PA_HOST=0.0.0.0 并替换为局域网 IP 给同事访问）"
				: "";
		onNotice(`已复制「${col.name}」的邀请链接${localHint}`);
	} catch {
		onNotice(`邀请链接：${inviteUrl}`);
	}
}
