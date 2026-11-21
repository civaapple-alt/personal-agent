import { type FormEvent, useState } from "react";
import {
	disableRuntimePstack,
	enableRuntimePstack,
	installRuntimePstack,
	type RuntimeBaseInfoDto,
	type RuntimeOverviewDto,
} from "../api/runtime.ts";

const actionNotice = {
	install: "pstack 已安装，点击「启用」后可在 PA 中使用",
	enable: "已启用 pstack 方法包",
	disable: "已停用 pstack 方法包",
};

export function PstackSettings({
	base,
	canManage,
	onRefresh,
	onOverviewChange,
	onNotice,
	onError,
}: {
	base: RuntimeBaseInfoDto;
	canManage: boolean;
	onRefresh: () => Promise<void>;
	onOverviewChange?: (overview: RuntimeOverviewDto) => void;
	onNotice?: (message: string) => void;
	onError?: (message: string) => void;
}) {
	const { pstack, envFlags } = base;
	const [input, setInput] = useState<string | null>(null);
	const [pending, setPending] = useState<keyof typeof actionNotice | null>(null);
	const [error, setError] = useState<string | null>(null);
	const path = input ?? pstack.installedRoot ?? pstack.root ?? "";

	const changePstack = async (action: keyof typeof actionNotice) => {
		if (pending) return;
		setPending(action);
		setError(null);
		try {
			const installation = action === "install" ? await installRuntimePstack() : null;
			const result =
				installation ??
				(action === "enable" ? await enableRuntimePstack(path.trim()) : await disableRuntimePstack());
			if (onOverviewChange) onOverviewChange(result.overview);
			else await onRefresh();
			setInput(installation?.installedRoot ?? null);
			onNotice?.(actionNotice[action]);
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			setError(message);
			onError?.(message);
		} finally {
			setPending(null);
		}
	};

	const submitPath = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (path.trim()) void changePstack("enable");
	};

	return (
		<div className="settings-pstack-panel">
			{pstack.available && (
				<p className="muted-hint">
					<strong>v{pstack.version}</strong> · {pstack.skillCount} 项方法
				</p>
			)}
			{envFlags.pstackDirEnvConfigured ? (
				<p className="muted-hint">
					由 <code>PA_PSTACK_DIR</code> 指定。修改启动配置后重启服务。
				</p>
			) : canManage ? (
				<>
					<form className="settings-pstack-setup" onSubmit={submitPath}>
						<label htmlFor="pstack-package-path">pstack 方法包目录</label>
						<div className="settings-pstack-form-row">
							<input
								id="pstack-package-path"
								name="pstack-package-path"
								type="text"
								autoComplete="off"
								spellCheck={false}
								className="text-input"
								placeholder="粘贴 pi list 显示的绝对路径"
								value={path}
								onChange={(event) => setInput(event.target.value)}
								disabled={pending !== null}
							/>
							<button type="submit" className="btn-pill-dark" disabled={pending !== null || !path.trim()}>
								{pending === "enable" ? "校验中…" : "启用"}
							</button>
							{pstack.configured && (
								<button
									type="button"
									className="btn-pill-outline"
									onClick={() => void changePstack("disable")}
									disabled={pending !== null}
								>
									{pending === "disable" ? "停用中…" : "停用"}
								</button>
							)}
						</div>
					</form>
					{pstack.installedRoot ? (
						<p className="muted-hint">已检测到 Pi 全局安装的 pstack，并填入了安装目录。</p>
					) : !pstack.available && base.available ? (
						<div className="actions-row compact">
							<button
								type="button"
								className="btn-pill-outline"
								disabled={pending !== null}
								onClick={() => void changePstack("install")}
							>
								{pending === "install" ? "安装中…" : "安装 pstack"}
							</button>
							<span className="muted-hint">
								也可在服务主机运行 <code>pi install git:github.com/backnotprop/pstack</code>，安装后刷新设置。
							</span>
						</div>
					) : null}
				</>
			) : null}
			{pstack.root && (envFlags.pstackDirEnvConfigured || !canManage) && (
				<code className="mono-wrap">{pstack.root}</code>
			)}
			{error && (
				<p role="alert" className="settings-ext-error">
					{error}
				</p>
			)}
		</div>
	);
}
