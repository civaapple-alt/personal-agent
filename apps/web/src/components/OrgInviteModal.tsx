import type { AccountUserDto, AuthSessionPayload, OrgInvitePreviewDto } from "../api/auth.ts";
import type { CollaboratorDto } from "../api/organizations.ts";
import { Button, ModalDialog } from "../primitives/index.ts";

interface OrgInviteModalProps {
	open: boolean;
	invitePreview: OrgInvitePreviewDto | null;
	inviteActionBusy: boolean;
	authKind: AuthSessionPayload["authKind"];
	accountUser: AccountUserDto | null;
	currentUser: CollaboratorDto | null;
	onClose: () => void;
	onSwitchAccount: (tab: "login" | "register") => Promise<void>;
	onAccept: () => Promise<void>;
}

export function OrgInviteModal({
	open,
	invitePreview,
	inviteActionBusy,
	authKind,
	accountUser,
	currentUser,
	onClose,
	onSwitchAccount,
	onAccept,
}: OrgInviteModalProps) {
	return (
		<ModalDialog
			open={open}
			title={
				invitePreview?.valid === false
					? "组织邀请链接提示"
					: invitePreview?.alreadyMember
						? `当前浏览器已登录「${accountUser?.displayName ?? currentUser?.name ?? "当前账号"}」`
						: `受邀加入组织「${invitePreview?.orgName ?? "目标组织"}」`
			}
			subtitle={
				invitePreview?.valid === false
					? (invitePreview.reason ?? "邀请链接无效或已过期")
					: authKind === "loopback"
						? "当前为本机免密视图，请切换或注册个人账号后再加入组织。"
						: invitePreview?.alreadyMember
							? `当前浏览器中的账号（${accountUser?.email ?? ""}）已是该组织成员；如需测试或为新同事注册账号加入，请先退出当前账号。`
							: `受邀加入组织「${invitePreview?.orgName ?? ""}」，你可以用当前已登录账号加入，或退出并注册新账号。`
			}
			size="sm"
			closeDisabled={inviteActionBusy}
			onClose={onClose}
			footer={
				invitePreview?.valid === false ? (
					<Button variant="primary" size="sm" onClick={onClose}>
						知道了
					</Button>
				) : authKind === "loopback" ? (
					<>
						<Button variant="secondary" size="sm" disabled={inviteActionBusy} onClick={onClose}>
							暂不处理
						</Button>
						<Button
							variant="inline"
							size="sm"
							disabled={inviteActionBusy}
							onClick={() => void onSwitchAccount("login")}
						>
							登录已有账号
						</Button>
						<Button
							variant="primary"
							size="sm"
							disabled={inviteActionBusy}
							onClick={() => void onSwitchAccount("register")}
						>
							注册新账号并加入
						</Button>
					</>
				) : invitePreview?.alreadyMember ? (
					<>
						<Button variant="secondary" size="sm" disabled={inviteActionBusy} onClick={onClose}>
							留在当前账号
						</Button>
						<Button
							variant="primary"
							size="sm"
							disabled={inviteActionBusy}
							onClick={() => void onSwitchAccount("register")}
						>
							退出并注册新成员
						</Button>
					</>
				) : (
					<>
						<Button variant="secondary" size="sm" disabled={inviteActionBusy} onClick={onClose}>
							暂不加入
						</Button>
						<Button
							variant="inline"
							size="sm"
							disabled={inviteActionBusy}
							onClick={() => void onSwitchAccount("register")}
						>
							退出并注册新账号
						</Button>
						<Button variant="primary" size="sm" disabled={inviteActionBusy} onClick={() => void onAccept()}>
							用当前账号加入
						</Button>
					</>
				)
			}
		>
			{invitePreview?.valid && !invitePreview.alreadyMember && accountUser && (
				<div className="text-xs text-ink-muted">
					当前账号：{accountUser.displayName}（{accountUser.email}）
				</div>
			)}
		</ModalDialog>
	);
}
