import { type FormEvent, useState } from "react";
import {
	disableRuntimePstack,
	enableRuntimePstack,
	type RuntimeBaseInfoDto,
	type RuntimeOverviewDto,
} from "../api/runtime.ts";

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
	const [pending, setPending] = useState<"enable" | "disable" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const path = input ?? pstack.root ?? "";

	const changePstack = async (action: "enable" | "disable") => {
		if (pending) return;
		setPending(action);
		setError(null);
		try {
			const result = action === "enable" ? await enableRuntimePstack(path.trim()) : await disableRuntimePstack();
			if (onOverviewChange) onOverviewChange(result.overview);
			else await onRefresh();
			setInput(null);
			onNotice?.(action === "enable" ? "已启用 pstack 方法包" : "已停用 pstack 方法包");
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
					<p className="muted-hint">
						在服务主机用 <code>pi install git:github.com/backnotprop/pstack</code> 安装，再用 <code>pi list</code>{" "}
						查看安装路径。
					</p>
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
