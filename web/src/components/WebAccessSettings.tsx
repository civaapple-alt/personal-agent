import { useState } from "react";
import {
	configureRuntimeWebAccess,
	installRuntimeWebAccess,
	type RuntimeBaseInfoDto,
	type RuntimeOverviewDto,
} from "../api/runtime.ts";

export function WebAccessSettings({
	base,
	onRefresh,
	onOverviewChange,
	onNotice,
	onError,
}: {
	base: RuntimeBaseInfoDto;
	onRefresh: () => Promise<void>;
	onOverviewChange?: (overview: RuntimeOverviewDto) => void;
	onNotice?: (message: string) => void;
	onError?: (message: string) => void;
}) {
	const { installedVersion, roles } = base.webAccess;
	const [draft, setDraft] = useState<string[] | null>(null);
	const [pending, setPending] = useState<"install" | "save" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const selected = new Set(draft ?? roles.filter((role) => role.enabled).map((role) => role.id));
	const changed = roles.some((role) => selected.has(role.id) !== role.enabled);
	const canSave = changed && (Boolean(installedVersion) || selected.size === 0);

	async function update(action: "install" | "save") {
		setPending(action);
		setError(null);
		try {
			const { overview } =
				action === "install"
					? await installRuntimeWebAccess()
					: await configureRuntimeWebAccess(roles.filter((role) => selected.has(role.id)).map((role) => role.id));
			if (onOverviewChange) onOverviewChange(overview);
			else await onRefresh();
			setDraft(null);
			onNotice?.(action === "install" ? "pi-web-access 已安装，可以为岗位启用" : "网页检索权限已保存");
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			setError(message);
			onError?.(message);
		} finally {
			setPending(null);
		}
	}

	return (
		<div className="settings-pstack-panel">
			{installedVersion ? (
				<p className="muted-hint">Pi 已安装 v{installedVersion}。勾选岗位并保存后，下次运行生效。</p>
			) : (
				<div className="actions-row compact">
					<button
						type="button"
						className="btn-pill-outline"
						disabled={!base.available || pending !== null}
						onClick={() => void update("install")}
					>
						{pending === "install" ? "安装中…" : "通过 Pi 安装"}
					</button>
					<span className="muted-hint">
						也可在服务主机运行 <code>pi install npm:pi-web-access</code>，再刷新设置。
					</span>
				</div>
			)}
			{(installedVersion || roles.some((role) => role.enabled)) && (
				<form
					className="settings-pstack-setup"
					onSubmit={(event) => {
						event.preventDefault();
						if (canSave && !pending) void update("save");
					}}
				>
					<fieldset className="settings-web-access-roles" disabled={pending !== null}>
						<legend>允许网页检索的 AI 岗位</legend>
						{roles.map((role) => (
							<label key={role.id}>
								<input
									type="checkbox"
									checked={selected.has(role.id)}
									disabled={!installedVersion && !selected.has(role.id)}
									onChange={(event) =>
										setDraft(
											event.target.checked
												? [...selected, role.id]
												: [...selected].filter((id) => id !== role.id),
										)
									}
								/>
								{role.name}
							</label>
						))}
					</fieldset>
					<div className="actions-row compact">
						<button className="btn-pill-dark" type="submit" disabled={!canSave || pending !== null}>
							{pending === "save" ? "保存中…" : "保存岗位权限"}
						</button>
					</div>
				</form>
			)}
			{error && (
				<p role="alert" className="settings-ext-error">
					{error}
				</p>
			)}
		</div>
	);
}
